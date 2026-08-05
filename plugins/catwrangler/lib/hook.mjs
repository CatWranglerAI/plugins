/**
 * Hook plumbing — stdin in, host wire-shape out.
 *
 * Claude Code and Codex converged on the same contract, which is why this file
 * is shared rather than forked. Two events run through it, and they differ only
 * in the name they must echo back:
 *
 *   stdin  = JSON: { cwd, source, session_id, hook_event_name, ... }
 *            SessionStart: `source` is startup | resume | clear | compact on
 *            both hosts (Claude Code adds `fork`).
 *            SubagentStart: `agent_id` + `agent_type` instead, and no `source`.
 *   stdout = JSON: {
 *     systemMessage?: string,              // top-level: shown to the USER
 *     hookSpecificOutput?: {               // event-scoped: read by the MODEL
 *       hookEventName: "SessionStart" | "SubagentStart",
 *       additionalContext?: string
 *     }
 *   }
 *   exit 0 always (a hook failure must never block the session)
 *
 * hookEventName is a `const` in Codex's schema per event, not a free string, so
 * echoing the wrong one is rejected exactly like an unknown field. That is why
 * the emitters below are named per event rather than taking the name from the
 * payload: a mismatched or missing `hook_event_name` on stdin would otherwise
 * become malformed stdout.
 *
 * Codex validates that stdout strictly: unknown fields are rejected, and empty
 * output is a parse error rather than "no opinion". Two rules follow — emit only
 * the fields above, and always emit something.
 *
 * The nesting matters: additionalContext is only read inside hookSpecificOutput
 * with a matching hookEventName. Emitted at the top level it is silently
 * ignored — the user still sees systemMessage, so the hook looks like it worked
 * while the model never receives the bootstrap instruction.
 *
 * Claude Code accepts one field Codex does not — `initialUserMessage`, which
 * CREATES an opening turn rather than annotating the user's. The plugin does not
 * emit it on either host: see lib/bootstrap.mjs for why. The consequence here is
 * that the payload is identical everywhere, so there is no per-host gate in this
 * file and nothing for a host to silently drop.
 */

import { readFileSync } from 'node:fs';

/** Read all of stdin synchronously; tolerate an empty/absent payload. */
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Parse the hook payload, falling back to env/cwd when it is absent or
 * malformed. `source` is SessionStart's; `agentType` is SubagentStart's. Each
 * event leaves the other undefined, and neither builder is required to use it.
 */
export function readHookInput({ cwdEnvVar } = {}) {
  let input = {};
  try {
    const raw = readStdin();
    if (raw.trim()) input = JSON.parse(raw);
  } catch {
    // Malformed hook payload — fall back to env/cwd below.
  }
  const cwd = input.cwd || (cwdEnvVar && process.env[cwdEnvVar]) || process.cwd();
  return { cwd, source: input.source, agentType: input.agent_type };
}

/**
 * Write the SessionStart wire shape and exit cleanly. Takes the flat
 * { additionalContext?, systemMessage? } from buildBootstrap and nests it as the
 * host expects.
 */
export function emitSessionStart(out) {
  emitHookOutput('SessionStart', out);
}

/**
 * The SubagentStart mirror, over buildSubagentBootstrap.
 *
 * Same envelope, and deliberately the same code path: the events are identical
 * on the wire but for the event name, so a second emitter would exist only to
 * drift. What differs is upstream — that builder returns no systemMessage, so
 * nothing here has to suppress one.
 */
export function emitSubagentStart(out) {
  emitHookOutput('SubagentStart', out);
}

/** Shared envelope writer. `hookEventName` is the only per-event difference. */
function emitHookOutput(hookEventName, out) {
  const payload = {};
  if (!out) {
    // Nothing to say. "No opinion" still has to be stated: `{}` is valid on both
    // hosts, where empty output is not.
    write(payload);
    return;
  }

  if (out.systemMessage) payload.systemMessage = out.systemMessage;
  if (out.additionalContext) {
    payload.hookSpecificOutput = {
      hookEventName,
      additionalContext: out.additionalContext,
    };
  }
  write(payload);
}

/**
 * Write the payload and return, letting Node exit on its own. No process.exit()
 * after the write: stdout to a pipe is asynchronous, so exiting can truncate it
 * and leave the host with half a JSON document. Nothing holds the event loop
 * open — stdin was read synchronously — so returning exits 0 once it flushes.
 */
function write(payload) {
  process.stdout.write(JSON.stringify(payload));
}
