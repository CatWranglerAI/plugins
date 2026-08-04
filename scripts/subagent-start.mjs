#!/usr/bin/env node
/**
 * CatWrangler SubagentStart hook — Claude Code adapter.
 *
 * The sibling of session-start.mjs, and thin for the same reason: all behavior
 * lives in lib/, so this file supplies only what is specific to Claude Code —
 * its project-directory env var.
 *
 * Claude Code fires SubagentStart with { agent_id, agent_type } and folds the
 * returned additionalContext into the SUB-AGENT's context, not the parent's,
 * which is the whole point: the sub-agent is a fresh context that never saw the
 * SessionStart bootstrap.
 */

import { buildSubagentBootstrap } from '../lib/bootstrap.mjs';
import { readHookInput, emitSubagentStart } from '../lib/hook.mjs';

try {
  const { cwd } = readHookInput({ cwdEnvVar: 'CLAUDE_PROJECT_DIR' });
  emitSubagentStart(buildSubagentBootstrap({ cwd }));
} catch {
  // Absolute backstop — a hook must never crash the session. `{}` rather than
  // silence, matching the Codex adapter.
  process.stdout.write('{}');
}
