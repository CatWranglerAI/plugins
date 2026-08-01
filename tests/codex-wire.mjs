#!/usr/bin/env node
/**
 * Codex SessionStart wire-shape check.
 *
 * Codex validates a hook's stdout against a strict schema and reports every
 * violation — unknown field, wrong type, empty output — as the same single line.
 * The contract is encoded here so a break names the field instead.
 *
 * The rules below are transcribed from the `session-start.command.output` JSON
 * Schema embedded in the Codex binary (0.146.0). Both objects are
 * `additionalProperties: false`, which is why Claude Code's `initialUserMessage`
 * could never be emitted to Codex.
 *
 * That strictness now does double duty. The plugin emits no opening turn on any
 * host, and the payload is built host-neutrally in lib/, so anything that
 * reintroduces the field reaches this check through the Codex adapter and fails
 * here by name — even though the field's only real host is Claude Code.
 *
 * Run: node tests/codex-wire.mjs        (invoked by tests/parity.sh)
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TOP = { continue: 'boolean', hookSpecificOutput: 'object', stopReason: 'string', suppressOutput: 'boolean', systemMessage: 'string' };
const NESTED = { additionalContext: 'string', hookEventName: 'string' };

/** Returns a list of violations; empty means Codex would accept this stdout. */
function violations(stdout) {
  // Empty stdout is a parse failure to Codex, not "no opinion".
  if (!stdout.trim()) return ['empty stdout (Codex parses this as invalid JSON)'];

  let doc;
  try {
    doc = JSON.parse(stdout);
  } catch (e) {
    return [`not JSON: ${e.message}`];
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return ['top level is not an object'];

  const bad = [];
  const check = (obj, allowed, where) => {
    for (const [k, v] of Object.entries(obj)) {
      if (!(k in allowed)) bad.push(`unknown field ${where}.${k}`);
      else if (v !== null && typeof v !== allowed[k]) bad.push(`${where}.${k} is ${typeof v}, want ${allowed[k]}`);
    }
  };
  check(doc, TOP, '');

  const h = doc.hookSpecificOutput;
  if (h && typeof h === 'object') {
    check(h, NESTED, '.hookSpecificOutput');
    // hookEventName is the schema's one required field, pinned to a const.
    if (h.hookEventName !== 'SessionStart') bad.push('.hookSpecificOutput.hookEventName must be "SessionStart"');
  }
  return bad;
}

// One workspace per registry shape the bootstrap branches on, so the check
// covers the full-instruction path as well as the quiet ones.
const work = mkdtempSync(join(tmpdir(), 'cw-wire-'));
for (const name of ['none', 'one', 'zero', 'bad']) mkdirSync(join(work, name));
writeFileSync(join(work, 'one/.catwrangler'), '{"version":1,"projects":[{"slug":"arcade","id":"p-1"}]}');
writeFileSync(join(work, 'zero/.catwrangler'), '{"version":1,"projects":[]}');
writeFileSync(join(work, 'bad/.catwrangler'), '{not json');

let failures = 0;
let checked = 0;
for (const fixture of ['none', 'one', 'zero', 'bad']) {
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    const payload = JSON.stringify({
      cwd: join(work, fixture),
      source,
      hook_event_name: 'SessionStart',
      model: 'gpt-5',
      permission_mode: 'default',
      session_id: 's-1',
      transcript_path: null,
    });
    // Through the shell wrapper — that is what Codex actually executes, so its
    // fallbacks and backstops are covered too, not just the Node adapter.
    const r = spawnSync('sh', [join(ROOT, 'scripts/session-start.sh'), 'session-start-codex.mjs'], {
      input: payload,
      encoding: 'utf8',
      cwd: ROOT,
    });
    checked++;
    const bad = violations(r.stdout || '');
    if (r.status !== 0) bad.push(`exit ${r.status} (a hook must always exit 0)`);
    if (bad.length) {
      failures++;
      console.log(`FAIL ${fixture}/${source}: ${bad.join('; ')}`);
    }
  }
}
rmSync(work, { recursive: true, force: true });

console.log(failures ? `FAIL codex wire (${failures}/${checked})` : `ok   codex wire (${checked} cases)`);
process.exitCode = failures ? 1 : 0;
