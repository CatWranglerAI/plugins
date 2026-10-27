#!/usr/bin/env node
/**
 * CatWrangler team-rules hook - Stop, both hosts (cw:d-4664, cw:d-4743).
 *
 * Thin like its siblings: lib/team-rules.mjs decides, from the shared rule book,
 * whether a final message holds work back. This file only maps that decision
 * onto the hook contract the two hosts share:
 *
 *   Stop hit         stdout {decision:"block", reason}, exit 0: the turn goes on
 *   anything else    stdout {}, exit 0
 *
 * Any internal error is "anything else". A broken hook must never block work.
 * That includes a lib that will not load, which is why the imports sit inside
 * the guard rather than at the top of the file.
 */

let decision = null;
try {
  const { decideTeamRules } = await import('../lib/team-rules.mjs');
  const { readHookPayload } = await import('../lib/hook.mjs');
  decision = decideTeamRules(readHookPayload());
} catch {
  decision = null;
}

process.stdout.write(JSON.stringify(decision?.output || {}));
