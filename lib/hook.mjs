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
 *       additionalContext?: string,
 *       initialUserMessage?: string        // CLAUDE CODE ONLY — see below
 *     }
 *   }
 *   exit 0 always (a hook failure must never block the session)
 *
 * The nesting matters: additionalContext is only read inside hookSpecificOutput
 * with a matching hookEventName. Emitted at the top level it is silently
 * ignored — the user still sees systemMessage, so the hook looks like it worked
 * while the model never receives the bootstrap instruction.
 *
 * The one real divergence is `initialUserMessage`. Claude Code uses it to CREATE
 * an opening turn, which is what makes a non-interactive `claude -p` run connect
 * before it starts work. Codex documents that SessionStart cannot inject user
 * turns at all, so its adapter opts out and headless Codex sessions rely on
 * additionalContext alone. That is a real capability gap, not a porting detail:
 * do not paper over it by emitting the field anyway.
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
 * { additionalContext?, systemMessage?, initialUserMessage? } from
 * buildBootstrap and nests it as the host expects.
 *
 * `supportsInitialUserMessage` gates the opening turn — pass false on hosts that
 * cannot create one, and the field is dropped rather than emitted and ignored.
 */
export function emitSessionStart(out, { supportsInitialUserMessage = false } = {}) {
  if (!out || (!out.additionalContext && !out.systemMessage)) process.exit(0);

  const openingTurn = supportsInitialUserMessage ? out.initialUserMessage : null;

  const payload = {};
  if (out.systemMessage) payload.systemMessage = out.systemMessage;
  if (out.additionalContext || openingTurn) {
    payload.hookSpecificOutput = { hookEventName: 'SessionStart' };
    if (out.additionalContext) payload.hookSpecificOutput.additionalContext = out.additionalContext;
    if (openingTurn) payload.hookSpecificOutput.initialUserMessage = openingTurn;
  }
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}
