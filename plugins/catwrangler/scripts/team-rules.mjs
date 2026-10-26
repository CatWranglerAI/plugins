#!/usr/bin/env node
/**
 * CatWrangler team-rules hook - PreToolUse and Stop, both hosts (cw:d-4664).
 *
 * Thin like its siblings: lib/team-rules.mjs decides, from the shared rule book,
 * whether a worker brief fences or queues work and whether a final message
 * holds work back. This file only maps that decision onto the hook contract the
 * two hosts share:
 *
 *   PreToolUse hit   exit 2, the message on stderr: the call is blocked and the
 *                    model reads why, so it rewrites the brief and retries
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

if (decision?.block) {
  process.stderr.write(`${decision.message}\n`);
  // exitCode, not exit(): stderr to a pipe is asynchronous, and exiting now
  // could cut the message the model needs in order to fix the brief.
  process.exitCode = 2;
} else {
  process.stdout.write(JSON.stringify(decision?.output || {}));
}
