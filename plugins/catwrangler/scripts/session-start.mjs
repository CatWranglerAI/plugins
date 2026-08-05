#!/usr/bin/env node
/**
 * CatWrangler SessionStart hook — Claude Code adapter.
 *
 * All behavior lives in lib/: bootstrap.mjs decides what to say, hook.mjs owns
 * the stdin/stdout contract. This file supplies only what is specific to Claude
 * Code — its project-directory env var. The Codex adapter is the same three
 * lines without it.
 */

import { buildBootstrap } from '../lib/bootstrap.mjs';
import { readHookInput, emitSessionStart } from '../lib/hook.mjs';

try {
  const { cwd, source } = readHookInput({ cwdEnvVar: 'CLAUDE_PROJECT_DIR' });
  emitSessionStart(buildBootstrap({ cwd, source }));
} catch {
  // Absolute backstop — a hook must never crash the session. `{}` rather than
  // silence, matching the Codex adapter.
  process.stdout.write('{}');
}
