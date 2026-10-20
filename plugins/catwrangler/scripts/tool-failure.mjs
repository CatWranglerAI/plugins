#!/usr/bin/env node
/**
 * CatWrangler PostToolUseFailure hook - Claude Code adapter (cw:d-4453).
 *
 * Thin like its siblings: lib/tool-failure.mjs decides whether a failed
 * CatWrangler call deserves a note and words it. This file only wires in Claude
 * Code's payload, the clock, this computer's sleep log, and the plugin's data
 * directory, where "one note per cause" is remembered across hook runs.
 *
 * It prints `{}` (no note) for almost every failure; see the lib for when not.
 */

import { buildToolFailureNote, readSleepLog, noteStore } from '../lib/tool-failure.mjs';
import { readHookPayload, emitPostToolUseFailure } from '../lib/hook.mjs';

try {
  const payload = readHookPayload();
  const note = payload.is_interrupt ? null : buildToolFailureNote({
    toolName: payload.tool_name,
    error: payload.error,
    durationMs: payload.duration_ms,
    sessionId: payload.session_id,
    nowMs: Date.now(),
    sleepLog: readSleepLog,
    store: noteStore(process.env.CLAUDE_PLUGIN_DATA),
  });
  emitPostToolUseFailure(note ? { additionalContext: note } : null);
} catch {
  // A hook must never crash the session, and a failed call must not gain a
  // broken-hook notice on top: say nothing.
  process.stdout.write('{}');
}
