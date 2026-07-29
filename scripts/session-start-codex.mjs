#!/usr/bin/env node
/**
 * CatWrangler SessionStart hook — Codex adapter.
 *
 * The mirror of session-start.mjs. All behavior lives in lib/; this file states
 * only what is specific to Codex.
 *
 * The one difference that matters: `supportsInitialUserMessage` is false. Codex
 * documents that SessionStart injects developer context only and cannot create
 * user turns, so the opening turn Claude Code uses to make a headless `claude -p`
 * run connect before it starts work has no equivalent here. Passing false drops
 * the field deliberately rather than emitting one the host silently ignores —
 * the gap is real, and a reader of this file should be able to see it.
 *
 * Practically: an interactive Codex session still gets the full bootstrap
 * instruction through additionalContext, exactly as Claude Code does. A
 * non-interactive Codex run gets the instruction but nothing forcing a first
 * turn, so it connects when the model acts on that context rather than
 * unconditionally.
 *
 * Codex exposes no documented CLAUDE_PROJECT_DIR equivalent, so cwd comes from
 * the hook payload, which Codex does supply, with process.cwd() as the backstop.
 */

import { buildBootstrap } from '../lib/bootstrap.mjs';
import { readHookInput, emitSessionStart } from '../lib/hook.mjs';

try {
  const { cwd, source } = readHookInput();
  emitSessionStart(buildBootstrap({ cwd, source }), { supportsInitialUserMessage: false });
} catch {
  // Absolute backstop — a hook must never crash the session.
  process.exit(0);
}
