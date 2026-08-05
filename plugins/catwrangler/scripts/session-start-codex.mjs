#!/usr/bin/env node
/**
 * CatWrangler SessionStart hook — Codex adapter.
 *
 * The mirror of session-start.mjs. All behavior lives in lib/; this file states
 * only what is specific to Codex.
 *
 * Codex documents that SessionStart injects developer context only and cannot
 * create user turns, and validates stdout strictly enough to reject a field that
 * tried. That no longer constrains anything: the plugin injects context on every
 * host and starts a turn on none, so the two adapters emit the same payload and
 * differ only in where cwd comes from.
 *
 * Codex exposes no documented CLAUDE_PROJECT_DIR equivalent, so cwd comes from
 * the hook payload, which Codex does supply, with process.cwd() as the backstop.
 */

import { buildBootstrap } from '../lib/bootstrap.mjs';
import { readHookInput, emitSessionStart } from '../lib/hook.mjs';

try {
  const { cwd, source } = readHookInput();
  emitSessionStart(buildBootstrap({ cwd, source }));
} catch {
  // Absolute backstop — a hook must never crash the session. `{}` rather than
  // silence, because Codex reads empty stdout as invalid JSON.
  process.stdout.write('{}');
}
