/**
 * The per-machine activity-capture daemon (cw:d-3731, handoff §B4).
 *
 * One instance per machine per OS user, across host surfaces; an atomic
 * pidfile guards the concurrent-spawn race and ensure-on-event + idle-exit
 * makes supervision self-healing — a lost daemon costs an idle timeout, not
 * correctness.
 *
 * Lifecycle: the sh hook pipes an init_session PostToolUse payload to
 * `ignite` (consent is evaluated HERE, by code that can read .catwrangler,
 * before anything persists) or spawns `ensure` to revive a dead daemon over
 * an accumulating spool. The daemon normalizes spool files, drains voice —
 * the transcript tail plus the Stop payload's turn-final text, both at level
 * "full" only — batches, uploads
 * to the project's own origin, deletes acknowledged files, and exits after a
 * quiet period. When credentials lapse it parks the spool and waits for the
 * next init_session (handoff §C8) — no retry storms, no model involvement.
 */

import {
  readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync,
  openSync, closeSync, statSync, existsSync, mkdirSync, appendFileSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  ensureStateDirs, paths, resolveCapture, setEnabledFlag,
  saveCredential, loadCredential, dropCredential, stateDir,
} from './config.mjs';
import { normalizePostToolUse, extractIgnition, spillFilePath } from './spool.mjs';
import { stopVoice, tailTranscript } from './voice.mjs';

const IDLE_EXIT_MS = 3 * 60 * 1000;
const POLL_MS = 1500;
/** SDD §13.3: a parked spool must not grow without bound. */
const SPOOL_FILE_CEILING = 5000;
const REJECTED_FILE_CEILING = 1000;
/** Backoff after a park (no credential / network down) and after an explicit
 * instance-flag 403 — a parked origin must not be re-hammered every poll. */
const PARK_BACKOFF_MS = 60 * 1000;
const PARK_BACKOFF_DISABLED_MS = 5 * 60 * 1000;
const FILE_SEQ_MAP_CAP = 200;
const LOG_MAX_BYTES = 512 * 1024;
/** Local session-state retention: mtime refreshes on every saveSession, so
 * this is "session inactive this long". A pruned session re-ignites via the
 * reclaim init_session PostToolUse (fresh grant included); only events spooled
 * before that re-ignition would be shed as unroutable, and only for a session
 * silent this long. */
const SESSION_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** In-memory per-origin park state; a daemon restart just retries once. */
const parkedUntil = new Map();
const REFRESH_MARGIN_MS = 2 * 60 * 60 * 1000;
const MAX_BATCH = 100;
const SPILL_READ_CAP = 4 * 1024 * 1024;
const UNROUTABLE_FILE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Bounded plain-text activity log at <state>/daemon.log: ignition, drain,
 * upload, and park outcomes plus server reject reasons — the visibility
 * surface for "what is the daemon digesting and sending". Counts and reasons
 * only; never tokens, grants, or event payloads. Rotates once to daemon.log.1
 * at the size cap.
 */
function logLine(msg) {
  try {
    const file = join(stateDir(), 'daemon.log');
    try { if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`); } catch { /* fresh */ }
    appendFileSync(file, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
  } catch { /* diagnostics never break capture */ }
}

// ── pidfile ──────────────────────────────────────────────────────────────────

function acquirePidfile() {
  ensureStateDirs();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(paths.pidfile(), 'wx', 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      // Exists: is the holder alive?
      let pid = NaN;
      try { pid = Number(readFileSync(paths.pidfile(), 'utf8').trim()); } catch { /* torn */ }
      if (Number.isFinite(pid) && pid > 0) {
        try { process.kill(pid, 0); return false; } catch { /* stale */ }
      }
      try { unlinkSync(paths.pidfile()); } catch { /* raced */ }
    }
  }
  return false;
}

function releasePidfile() {
  try {
    if (Number(readFileSync(paths.pidfile(), 'utf8').trim()) === process.pid) unlinkSync(paths.pidfile());
  } catch { /* already gone */ }
}

// ── per-session state ────────────────────────────────────────────────────────

function sessionFile(sessionId) {
  return join(paths.sessions(), `${String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)}.json`);
}

function loadSession(sessionId) {
  try { return JSON.parse(readFileSync(sessionFile(sessionId), 'utf8')); } catch { return null; }
}

function saveSession(sessionId, state) {
  const file = sessionFile(sessionId);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, file);
}

// ── workspace enablement (machine flag = any workspace on) ───────────────────

function workspacesFile() { return join(stateDir(), 'workspaces.json'); }

function recordWorkspaceLevel(registryPath, level) {
  let map = {};
  try { map = JSON.parse(readFileSync(workspacesFile(), 'utf8')); } catch { /* fresh */ }
  map[registryPath] = level;
  writeFileSync(workspacesFile(), JSON.stringify(map, null, 2), { mode: 0o600 });
  const anyOn = Object.values(map).some((l) => l && l !== 'off');
  setEnabledFlag(anyOn ? 'full' : 'off');
}

// ── ignition ─────────────────────────────────────────────────────────────────

/** Delete session-state files whose last touch is older than the retention
 * window — the client-side counterpart of the server's segment sweep. */
function sweepSessionState() {
  let pruned = 0;
  try {
    for (const name of readdirSync(paths.sessions())) {
      if (!name.endsWith('.json')) continue;
      const file = join(paths.sessions(), name);
      try {
        if (Date.now() - statSync(file).mtimeMs > SESSION_STATE_MAX_AGE_MS) {
          unlinkSync(file);
          pruned++;
        }
      } catch { /* raced */ }
    }
  } catch { /* sessions dir missing */ }
  if (pruned > 0) logLine(`sweep: pruned ${pruned} session-state file(s) inactive > 7d`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Handle one init_session payload delivered over stdin: evaluate consent at
 * source, record the session's routing, exchange the bootstrap grant, and —
 * only when consent allows — spool the payload for normal processing.
 */
async function ignite(payloadText) {
  let payload;
  try { payload = JSON.parse(payloadText); } catch { logLine('ignite: unparseable payload'); return; }
  let ext = extractIgnition(payload);
  if (!ext || !ext.grant) {
    // Claude Code spills an oversized tool_response to a tool-results file and
    // hands the hook only the notice string — init_session responses hit this
    // every time, so the grant is in the host's own spill file, not the
    // payload. Bounded read of that exact file only (spillFilePath enforces
    // the shape); the spilled content stays in memory — it is never spooled.
    const spill = spillFilePath(payload);
    if (spill) {
      try {
        if (statSync(spill).size <= SPILL_READ_CAP) {
          const full = JSON.parse(readFileSync(spill, 'utf8'));
          ext = extractIgnition({ ...payload, tool_response: full }) ?? ext;
        }
      } catch { /* absent or torn spill: continue with what the payload had */ }
    }
  }
  if (!ext) {
    // The sh hook's init_session detection is a cheap substring test, so any
    // CW tool result that merely MENTIONS init_session spawns an ignite too.
    // Those discards are routine; only a payload whose tool really was
    // init_session yielding nothing is worth a line.
    if (/init_session/.test(String(payload.tool_name ?? ''))) {
      logLine(`ignite: init_session payload had no grant/agent and no readable spill (session ${payload.session_id || 'unknown'})`);
    }
    return;
  }

  const capture = resolveCapture(payload.cwd, ext.project_id);
  if (!capture) { logLine(`ignite: no governing workspace for ${ext.project_id}`); return; }
  recordWorkspaceLevel(capture.registry_path, capture.level);
  logLine(`ignite: session ${payload.session_id || 'unknown'} project ${ext.project_id} consent ${capture.level} grant ${ext.grant ? 'present' : 'absent'}`);
  if (capture.level === 'off') return; // consent off: nothing persists, ever.

  const webUrl = capture.project && typeof capture.project.web_url === 'string'
    ? capture.project.web_url.replace(/\/$/, '') : null;
  if (!webUrl || !ext.project_id) return; // no routable origin: park quietly.

  const sessionId = typeof payload.session_id === 'string' && payload.session_id
    ? payload.session_id : 'unknown-session';
  const prior = loadSession(sessionId);
  saveSession(sessionId, {
    next_seq: prior ? prior.next_seq : 0,
    transcript_offset: prior ? prior.transcript_offset : 0,
    project_id: ext.project_id,
    web_url: webUrl,
    agent_id: ext.agent_id || (prior && prior.agent_id) || 'agent-unknown',
    level: capture.level,
    cwd: payload.cwd,
  });

  if (ext.grant) {
    try {
      const res = await fetch(webUrl + ext.exchange_path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant: ext.grant }),
      });
      if (res.ok) {
        const body = await res.json();
        saveCredential(webUrl, ext.project_id, {
          token: body.token,
          expires_at: body.expires_at,
          ...(body.binding ? { binding: body.binding } : {}),
        });
      }
      logLine(`ignite: exchange ${res.status} at ${webUrl}`);
    } catch { logLine(`ignite: exchange unreachable at ${webUrl}`); }
  }

  // Spool the ignition payload itself so the init_session call is captured.
  // Content-derived event ids make an sh-side double-spool a server-side no-op.
  ensureStateDirs();
  const file = join(paths.incoming(), `${Date.now()}-${process.pid}-ignite.json`);
  writeFileSync(file, payloadText, { mode: 0o600 });
}

// ── token upkeep ─────────────────────────────────────────────────────────────

async function freshToken(webUrl, projectId) {
  const cred = loadCredential(webUrl, projectId);
  if (!cred || typeof cred.token !== 'string') return null;
  if (typeof cred.expires_at === 'number' && cred.expires_at - Date.now() < REFRESH_MARGIN_MS) {
    try {
      const res = await fetch(`${webUrl}/api/agent-activity/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: cred.token }),
      });
      if (res.ok) {
        const body = await res.json();
        const next = { ...cred, token: body.token, expires_at: body.expires_at, ...(body.binding ? { binding: body.binding } : {}) };
        saveCredential(webUrl, projectId, next);
        return next;
      }
    } catch { /* keep the current token until it actually fails */ }
  }
  return cred;
}

// ── voice bundles ────────────────────────────────────────────────────────────

let bundleSeq = 0;

/** Voice events must survive an upload failure — the transcript offset and
 * the turn-final guard have already advanced when they are produced — so they
 * go to a durable pre-normalized bundle in the spool, picked up next pass. */
function writeVoiceBundle(sessionId, events) {
  const bundle = join(paths.incoming(), `${Date.now()}-${process.pid}-${bundleSeq++}-pren.json`);
  try {
    writeFileSync(bundle, JSON.stringify({ prenormalized: true, session_id: sessionId, events }), { mode: 0o600 });
  } catch { /* voice text lost only if the disk itself fails */ }
}

// ── drain + upload ───────────────────────────────────────────────────────────

function hostFromFileName(name) {
  const m = basename(name).match(/-(claude|codex)\.json$/);
  return m ? m[1] : undefined;
}

/** Move the oldest incoming files past the ceiling aside; delete rejected overflow. */
function enforceSpoolCeiling(names) {
  if (names.length > SPOOL_FILE_CEILING) {
    // Preserve the NEWEST first (SDD §13.3): oldest are shed to rejected/ so
    // the bytes survive locally for diagnosis without blocking the queue.
    for (const name of names.slice(0, names.length - SPOOL_FILE_CEILING)) {
      try { renameSync(join(paths.incoming(), name), join(paths.rejected(), name)); } catch { /* raced */ }
    }
    names = names.slice(names.length - SPOOL_FILE_CEILING);
  }
  try {
    const rejected = readdirSync(paths.rejected()).sort();
    for (const name of rejected.slice(0, Math.max(0, rejected.length - REJECTED_FILE_CEILING))) {
      try { unlinkSync(join(paths.rejected(), name)); } catch { /* raced */ }
    }
  } catch { /* rejected dir missing */ }
  return names;
}

async function drainOnce() {
  let names;
  try { names = readdirSync(paths.incoming()).filter((n) => n.endsWith('.json')).sort(); } catch { return 0; }
  if (names.length === 0) return 0;
  names = enforceSpoolCeiling(names);

  // batches: web_url → { projectId, events, files:Set }
  const batches = new Map();
  const touchedSessions = new Map();

  for (const name of names.slice(0, MAX_BATCH)) {
    const file = join(paths.incoming(), name);
    let payload;
    try { payload = JSON.parse(readFileSync(file, 'utf8')); } catch {
      try { renameSync(file, join(paths.rejected(), name)); } catch { /* full/raced */ }
      continue;
    }
    const sessionId = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : 'unknown-session';
    const sess = touchedSessions.get(sessionId) ?? loadSession(sessionId);
    if (!sess || !sess.web_url || !sess.project_id) {
      // No routing yet (ignition never happened or state was lost). A Stop
      // payload from a session the daemon never ignited is noise by
      // construction — ignition rides the init_session PostToolUse, so a
      // session whose voice matters has state before its first meaningful
      // Stop — and it carries turn-final text from what may be an unrelated
      // conversation, so it is deleted on sight rather than left to settle in
      // rejected/ (d-3782). Tool payloads keep the bounded hold: their
      // ignition may still be in flight.
      if (payload.hook_event_name === 'Stop') {
        try { unlinkSync(file); } catch { /* raced */ }
        continue;
      }
      try {
        if (Date.now() - statSync(file).mtimeMs > UNROUTABLE_FILE_MAX_AGE_MS) {
          renameSync(file, join(paths.rejected(), name));
        }
      } catch { /* raced */ }
      continue;
    }
    // Consent re-check per event against the owning workspace: revoked means
    // this file is discarded, not uploaded.
    const capture = resolveCapture(sess.cwd || payload.cwd, sess.project_id);
    if (!capture || capture.level === 'off') {
      try { unlinkSync(file); } catch { /* raced */ }
      continue;
    }
    sess.level = capture.level;
    if (!sess.client) sess.client = hostFromFileName(name);
    if ((parkedUntil.get(sess.web_url) ?? 0) > Date.now()) continue; // parked origin: leave files be.

    // Event envelopes carry the SERVER's project id from the exchange binding
    // (its documented purpose — the ingest project check compares against it);
    // the lane p-form the workspace knows stays the keyring/consent key.
    if (sess.wire_project_id === undefined) {
      const cred = loadCredential(sess.web_url, sess.project_id);
      sess.wire_project_id = cred && cred.binding && typeof cred.binding.project_id === 'string'
        ? cred.binding.project_id : null;
    }
    const wireProjectId = sess.wire_project_id ?? sess.project_id;

    const batch = batches.get(sess.web_url) ?? { projectId: sess.project_id, events: [], files: new Set(), sessions: new Set() };
    batch.sessions.add(sessionId);

    if (payload.prenormalized === true && Array.isArray(payload.events)) {
      // Durable voice-event bundle written by an earlier pass — already
      // normalized and sequenced; pass through untouched.
      batch.events.push(...payload.events);
      batch.files.add(file);
      batches.set(sess.web_url, batch);
      touchedSessions.set(sessionId, sess);
      continue;
    }

    // Stop (d-3767): the turn-final conclusion reaches the transcript only
    // after the last tool call, so the PostToolUse-driven tail structurally
    // misses it. Drain the payload into voice events; the file itself carries
    // nothing else and is spent like any other.
    if (payload.hook_event_name === 'Stop') {
      const voiceEvents = [];
      stopVoice(sess, wireProjectId, sessionId, payload, name, voiceEvents, logLine);
      if (voiceEvents.length > 0) writeVoiceBundle(sessionId, voiceEvents);
      batch.files.add(file);
      batches.set(sess.web_url, batch);
      touchedSessions.set(sessionId, sess);
      continue;
    }

    // Pin this file's sequence base so a retried upload re-produces the SAME
    // sequences (and, via tool_use_id seeding, the same event ids) — without
    // this, every parked retry burns fresh sequence numbers and registers
    // phantom gaps server-side.
    sess.file_seqs = sess.file_seqs || {};
    let seqBase = sess.file_seqs[name];
    const firstSeen = seqBase === undefined;
    if (firstSeen) seqBase = sess.next_seq;
    const ctx = {
      projectId: wireProjectId, agentId: sess.agent_id, client: sess.client,
      sourceName: name, seqBase,
    };
    const events = normalizePostToolUse(payload, ctx);
    if (events.length > 0 && firstSeen) {
      sess.file_seqs[name] = seqBase;
      sess.next_seq = seqBase + events.length;
      const keys = Object.keys(sess.file_seqs);
      if (keys.length > FILE_SEQ_MAP_CAP) {
        for (const k of keys.slice(0, keys.length - FILE_SEQ_MAP_CAP)) delete sess.file_seqs[k];
      }
    }
    batch.events.push(...events);
    // Tail state (offset, guard, sequences) mutates sess itself so the
    // saveSession below persists it (d-3767) — a copy re-reads the same
    // transcript region on every drain.
    const tailEvents = [];
    tailTranscript(sess, wireProjectId, sessionId, payload.transcript_path, tailEvents, logLine);
    if (tailEvents.length > 0) writeVoiceBundle(sessionId, tailEvents);
    batch.files.add(file);
    batches.set(sess.web_url, batch);
    touchedSessions.set(sessionId, sess);
  }

  for (const [sessionId, sess] of touchedSessions) saveSession(sessionId, sess);

  let uploaded = 0;
  for (const [webUrl, batch] of batches) {
    if (batch.events.length === 0) {
      // Nothing normalizable (e.g. non-CW payloads): the files are spent.
      for (const file of batch.files) { try { unlinkSync(file); } catch { /* raced */ } }
      continue;
    }
    const cred = await freshToken(webUrl, batch.projectId);
    if (!cred) {
      parkedUntil.set(webUrl, Date.now() + PARK_BACKOFF_MS);
      logLine(`park: no credential for ${webUrl} project=${batch.projectId} (${batch.events.length} events held)`);
      continue; // parked: files stay until the next init_session.
    }
    try {
      const body = gzipSync(Buffer.from(JSON.stringify({ events: batch.events.slice(0, MAX_BATCH) }), 'utf8'));
      const res = await fetch(`${webUrl}/api/agent-activity/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          Authorization: `Bearer ${cred.token}`,
        },
        body,
      });
      if (res.status === 401) {
        dropCredential(webUrl, batch.projectId);
        parkedUntil.set(webUrl, Date.now() + PARK_BACKOFF_MS);
        logLine(`park: 401 from ${webUrl} — credential dropped`);
        continue;
      }
      if (res.status === 403) {
        // Instance flag off: park with a long backoff — the next init_session
        // (or flag flip) is what un-parks, not this loop.
        parkedUntil.set(webUrl, Date.now() + PARK_BACKOFF_DISABLED_MS);
        logLine(`park: 403 from ${webUrl} — instance flag off`);
        continue;
      }
      if (!res.ok) { logLine(`upload: ${res.status} from ${webUrl}`); continue; }
      parkedUntil.delete(webUrl);
      let summary = null;
      try { summary = await res.json(); } catch { /* body optional */ }
      const accepted = summary && typeof summary.accepted === 'number' ? summary.accepted : batch.events.length;
      const duplicates = summary && typeof summary.duplicates === 'number' ? summary.duplicates : 0;
      const rejectedCount = summary && typeof summary.rejected_count === 'number' ? summary.rejected_count : 0;
      const reasons = summary && Array.isArray(summary.rejected)
        ? [...new Set(summary.rejected.map((r) => r && r.reason).filter(Boolean))].slice(0, 3) : [];
      logLine(`upload: ok ${webUrl} project=${batch.projectId} sessions=${[...batch.sessions].map((s) => String(s).slice(0, 12)).join(',')} events=${batch.events.length} accepted=${accepted} duplicates=${duplicates} rejected=${rejectedCount}${reasons.length ? ` reasons: ${reasons.join(' | ')}` : ''}`);
      if (accepted + duplicates === 0 && rejectedCount > 0) {
        // A wholesale rejection is a producer/validator disagreement — a design
        // bug to diagnose, not a retry candidate. Preserve the source files in
        // rejected/ (bounded by the ceiling sweep) instead of silently eating
        // the corpus.
        for (const file of batch.files) {
          try { renameSync(file, join(paths.rejected(), basename(file))); } catch { /* raced */ }
        }
        uploaded += batch.events.length; // progress for idle-exit purposes
        continue;
      }
      // Accepted or deduplicated server-side — the spool copy is spent. Partial
      // rejections are logged above; their files are spent too, and the server
      // counted them.
      for (const file of batch.files) { try { unlinkSync(file); } catch { /* raced */ } }
      uploaded += batch.events.length;
    } catch {
      // Offline: park the origin so the poll does not spin against a dead network.
      parkedUntil.set(webUrl, Date.now() + PARK_BACKOFF_MS);
      logLine(`park: ${webUrl} unreachable`);
    }
  }
  return uploaded;
}

// ── main ─────────────────────────────────────────────────────────────────────

export async function main(mode) {
  if (mode === 'ignite') {
    const payloadText = await readStdin();
    await ignite(payloadText);
    // A fresh ignition carries fresh credentials — clear any park verdicts so
    // the drain retries immediately (handoff §C8 recovery point).
    parkedUntil.clear();
  }
  if (!acquirePidfile()) return; // another daemon is live; it will drain.
  try {
    sweepSessionState();
    let lastWork = Date.now();
    for (;;) {
      let did = 0;
      try { did = await drainOnce(); } catch { /* never crash the loop */ }
      if (existsSync(paths.flushMarker())) {
        try { unlinkSync(paths.flushMarker()); } catch { /* raced */ }
        try { did += await drainOnce(); } catch { /* as above */ }
      }
      if (did > 0) lastWork = Date.now();
      if (Date.now() - lastWork > IDLE_EXIT_MS) return;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    releasePidfile();
  }
}
