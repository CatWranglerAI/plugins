/**
 * cw:d-4453: what to tell an agent when a CatWrangler call got no reply.
 *
 * Only the client can see a missing reply, so this runs as a PostToolUseFailure
 * hook. A missing reply does not mean the call failed: the server keeps running a
 * call when the reply is lost (a sleeping laptop, a dropped connection). Without
 * being told, an agent guesses, usually "the server hung", and may repeat a call
 * that already changed something.
 *
 * The hook must not become context noise, so it says nothing unless the note
 * changes what the agent should do next:
 *   - errors the server sent back explain themselves: silent;
 *   - a quick no-reply on a read-only call is just retried: silent;
 *   - a gateway timeout on a read-only call names itself in its own error: silent;
 *   - it speaks when the computer slept during the call, when the call changes
 *     something (naming the check to run before repeating it), or when the client
 *     itself gave up on a read-only call after waiting 2+ minutes;
 *   - one note per cause: per sleep episode, per mutating tool per 10 minutes,
 *     per long-wait per 10 minutes.
 *
 * Host-neutral: the adapter supplies the payload, the clock, the sleep log and
 * the dedupe store, so everything here is testable without a host.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LONG_WAIT_MS = 120_000;
const MIN_SLEEP_MS = 60_000;
const REPEAT_WINDOW_MS = 10 * 60_000;

/** `mcp__plugin_catwrangler-internal_catwrangler-internal__sandbox_exec` -> `sandbox_exec`. */
export function shortToolName(toolName) {
  const name = String(toolName || '');
  const at = name.lastIndexOf('__');
  return at >= 0 ? name.slice(at + 2) : name;
}

/**
 * Did the call fail because no reply arrived, rather than because the server
 * answered with an error? A structured server error (it carries a `code`)
 * already says what happened and what to do, so it is never a no-reply.
 */
export function isNoReply(error) {
  return noReplyKind(error) !== null;
}

/**
 * Why no reply arrived, or null when the server did answer:
 *   'idle'     - the client gave up waiting (no response or progress);
 *   'gateway'  - the gateway in front of CatWrangler stopped waiting (502/503/504
 *                page); the server may still be working on the call;
 *   'dropped'  - the connection failed (fetch failed, reset, DNS).
 */
export function noReplyKind(error) {
  const text = String(error || '');
  if (/"code"\s*:\s*"/.test(text)) return null;
  if (/sent no response or progress/i.test(text)) return 'idle';
  if (/\b50[234]\b[^\n]*(gateway|service unavailable|time-?out)/i.test(text)) return 'gateway';
  if (/\bfetch failed\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|other side closed/i.test(text)) return 'dropped';
  if (/operation timed out|request timed out|connection (dropped|closed|lost|reset)/i.test(text)) return 'dropped';
  return null;
}

/** Tools that only read: running them again is always safe. */
export function isReadOnly(tool) {
  return /^(read_|grep_|list_|search_|get_|query_|graph_|diff_|branch_log|docs_read|docs_list|docs_status|help$|sccs_status|sandbox_exec$|await_job$|validate_branch$|in_flight_tests$|backlog_get$|backlog_list$|sccs_write_checkout$)/.test(tool)
    || /_(status|log|list|measurements)$/.test(tool);
}

/** For a call that changes something: the check that tells whether it already happened. */
export function checkBeforeRepeating(tool) {
  if (tool === 'sandbox_merge') return 'Call sandbox_merge again with the same admission_key: it returns the existing merge instead of merging twice.';
  if (tool === 'sccs_submit_changes') return 'Read the file to see whether the edit landed before submitting it again.';
  if (tool === 'register_decision') return 'Search decisions for its title before registering again, or it may be registered twice.';
  if (tool === 'update_decision') return 'Look the decision up to see whether the change landed before repeating it.';
  if (tool === 'init_session') return 'Do not repeat a bare init_session; reclaim with reclaim_agent_id instead.';
  if (tool === 'docs_write') return 'Read the document to see whether the write landed before repeating it.';
  if (/^(build_deploy|promote_to_prod|deploy_infra|cold_restart|rollback|tag_release)$/.test(tool)) {
    return 'Check whether it started (its job or deployment status) before starting another.';
  }
  if (/^(send_message|email)$/.test(tool)) return 'It may already have been sent; check before sending it again.';
  return 'Check whether it took effect before repeating it.';
}

function minutes(ms) {
  return ms < LONG_WAIT_MS ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`;
}

/**
 * Sleep within [startMs, endMs] from `pmset -g log` lines such as
 *   2026-10-13 17:24:43 -0400 Sleep               \tEntering Sleep state ...
 * Returns { asleepMs, from, to } in the log's local wall-clock time, or null
 * when the computer was awake (or asleep for under a minute).
 */
export function sleepDuring(log, startMs, endMs) {
  const events = [];
  for (const line of String(log || '').split('\n')) {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):(\d{2}) ([+-]\d{2})(\d{2}) (Sleep|Wake|DarkWake)\s*\t/.exec(line);
    if (!m) continue;
    const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}${m[4]}:${m[5]}`);
    if (Number.isFinite(t)) events.push({ t, sleep: m[6] === 'Sleep', clock: m[2] });
  }
  events.sort((a, b) => a.t - b.t);
  let asleepMs = 0;
  let from = null;
  let to = null;
  let sleptAt = null;
  for (const e of events) {
    if (e.sleep) {
      if (!sleptAt) sleptAt = e;
      continue;
    }
    if (!sleptAt) continue;
    const overlap = Math.min(e.t, endMs) - Math.max(sleptAt.t, startMs);
    if (overlap > 0) {
      asleepMs += overlap;
      from = from ?? sleptAt.clock;
      to = e.clock;
    }
    sleptAt = null;
  }
  return asleepMs >= MIN_SLEEP_MS ? { asleepMs, from, to } : null;
}

/** Recent sleep/wake lines from this Mac's power log; '' anywhere else or on any failure. */
export function readSleepLog() {
  if (process.env.CW_SLEEP_LOG_FILE) {
    try { return readFileSync(process.env.CW_SLEEP_LOG_FILE, 'utf8'); } catch { return ''; }
  }
  if (process.platform !== 'darwin') return '';
  try {
    // The full log is several MB; keep only the sleep/wake lines, newest last.
    return execFileSync('/bin/sh', ['-c', "pmset -g log 2>/dev/null | grep -E ' (Sleep|Wake|DarkWake) ' | tail -n 800"], {
      encoding: 'utf8', timeout: 4000, maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

/** Remembers which causes were already noted, so one cause produces one note. */
export function noteStore(dataDir) {
  const file = dataDir ? join(dataDir, 'tool-failure-notes.json') : null;
  let seen = {};
  if (file) {
    try { seen = JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { seen = {}; }
  }
  return {
    wasNoted(key, nowMs, windowMs) {
      const at = seen[key];
      return typeof at === 'number' && (windowMs === Infinity || nowMs - at < windowMs);
    },
    note(key, nowMs) {
      seen[key] = nowMs;
      if (!file) return;
      for (const [k, at] of Object.entries(seen)) if (nowMs - at > 24 * 3600_000) delete seen[k];
      try {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(`${file}.tmp`, JSON.stringify(seen));
        renameSync(`${file}.tmp`, file);
      } catch {
        // Dedupe is best effort; never fail the hook over it.
      }
    },
  };
}

/**
 * The note for one failed call, or null to stay silent.
 * input: { toolName, error, durationMs, sessionId, nowMs, sleepLog, store }
 */
export function buildToolFailureNote(input) {
  const { error, durationMs, sessionId, nowMs, store } = input;
  const kind = noReplyKind(error);
  if (!kind) return null;
  const tool = shortToolName(input.toolName);
  const waited = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  const readOnly = isReadOnly(tool);
  // A call shorter than the minimum sleep cannot contain one, so skip the log read.
  const sleep = waited + 5000 >= MIN_SLEEP_MS
    ? sleepDuring(typeof input.sleepLog === 'function' ? input.sleepLog() : input.sleepLog, nowMs - waited - 5000, nowMs)
    : null;
  const session = sessionId || 'session';

  // Speak only when the note changes what to do next. A read-only call is simply
  // retried, so it earns a note only when the client sat waiting for minutes (the
  // case that gets misdiagnosed as a hung server); a gateway timeout already says
  // what happened in its own error.
  let key;
  let window;
  if (sleep) { key = `${session}:sleep:${sleep.from}-${sleep.to}`; window = Infinity; }
  else if (!readOnly) { key = `${session}:mutating:${tool}`; window = REPEAT_WINDOW_MS; }
  else if (kind === 'idle' && waited >= LONG_WAIT_MS) { key = `${session}:long-wait`; window = REPEAT_WINDOW_MS; }
  else return null;
  if (store?.wasNoted(key, nowMs, window)) return null;
  store?.note(key, nowMs);

  const after = waited ? ` after ${minutes(waited)}` : '';
  let why;
  if (sleep) {
    why = `This computer was asleep for about ${minutes(sleep.asleepMs)} during the call (${sleep.from}-${sleep.to} local time), so the reply was lost; the call itself may have finished on the server.`;
  } else if (kind === 'gateway') {
    why = 'The gateway in front of CatWrangler stopped waiting; the call may still be running or may have finished on the server.';
  } else if (kind === 'idle') {
    why = 'No sleep was recorded on this computer, so the reply was lost in transit; the call itself may have finished on the server.';
  } else {
    why = 'The connection to CatWrangler dropped, so it is unknown whether the call reached the server.';
  }
  const next = readOnly ? `${tool} only reads, so running it again is safe.` : checkBeforeRepeating(tool);
  return `CatWrangler: ${tool} got no reply${after}. ${why} ${next}`;
}
