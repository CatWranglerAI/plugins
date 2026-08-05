#!/usr/bin/env node
/**
 * CatWrangler SubagentStart hook — Codex adapter.
 *
 * The mirror of subagent-start.mjs. All behavior lives in lib/; this file states
 * only what is specific to Codex.
 *
 * Codex's subagent-start.command.output schema is byte-for-byte its SessionStart
 * one with the hookEventName const changed, so the same strictness applies:
 * unknown fields are rejected and empty stdout is a parse error rather than "no
 * opinion". Both rules are honored in lib/hook.mjs, which is why this adapter
 * has nothing to add.
 *
 * Codex exposes no documented CLAUDE_PROJECT_DIR equivalent, so cwd comes from
 * the hook payload, which Codex does supply, with process.cwd() as the backstop.
 */

import { buildSubagentBootstrap } from '../lib/bootstrap.mjs';
import { readHookInput, emitSubagentStart } from '../lib/hook.mjs';

try {
  const { cwd } = readHookInput();
  emitSubagentStart(buildSubagentBootstrap({ cwd }));
} catch {
  // Absolute backstop — a hook must never crash the session. `{}` rather than
  // silence, because Codex reads empty stdout as invalid JSON.
  process.stdout.write('{}');
}
