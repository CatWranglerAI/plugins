/**
 * SessionStart hook plumbing — stdin in, host wire-shape out.
 *
 * Claude Code and Codex converged on the same SessionStart contract, which is
 * why this file is shared rather than forked:
 *
 *   stdin  = JSON: { cwd, source, session_id, hook_event_name, ... }
 *            `source` is startup | resume | clear | compact on both hosts
 *            (Claude Code adds `fork`).
 *   stdout = JSON: {
 *     systemMessage?: string,              // top-level: shown to the USER
 *     hookSpecificOutput?: {               // event-scoped: read by the MODEL
 *       hookEventName: "SessionStart",
 *       additionalContext?: string
 *     }
 *   }
 *   exit 0 always (a hook failure must never block the session)
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

/** Parse the hook payload, falling back to env/cwd when it is absent or malformed. */
export function readHookInput({ cwdEnvVar } = {}) {
  let input = {};
  try {
    const raw = readStdin();
    if (raw.trim()) input = JSON.parse(raw);
  } catch {
    // Malformed hook payload — fall back to env/cwd below.
  }
  const cwd = input.cwd || (cwdEnvVar && process.env[cwdEnvVar]) || process.cwd();
  return { cwd, source: input.source };
}

/**
 * Write the SessionStart wire shape and exit cleanly. Takes the flat
 * { additionalContext?, systemMessage? } from buildBootstrap and nests it as the
 * host expects.
 */
export function emitSessionStart(out) {
  const payload = {};
  if (!out) {
    // Nothing to say this session. "No opinion" still has to be stated: `{}` is
    // valid on both hosts, where empty output is not.
    write(payload);
    return;
  }

  if (out.systemMessage) payload.systemMessage = out.systemMessage;
  if (out.additionalContext) {
    payload.hookSpecificOutput = {
      hookEventName: 'SessionStart',
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
