#!/usr/bin/env node
/**
 * Codex hook wire-shape check — SessionStart and SubagentStart.
 *
 * Codex validates a hook's stdout against a strict schema and reports every
 * violation — unknown field, wrong type, empty output — as the same single line.
 * The contract is encoded here so a break names the field instead.
 *
 * The rules below are transcribed from the `session-start.command.output` and
 * `subagent-start.command.output` JSON Schemas embedded in the Codex binary
 * (0.146.0). They are the same schema twice: identical field sets, both objects
 * `additionalProperties: false`, differing only in the `const` pinning
 * hookEventName. That const is why the event is a parameter of every case here
 * rather than a constant in the checker — echoing the wrong name is rejected
 * exactly like an unknown field, and the two events share a shell wrapper that
 * has to get it right from an argument.
 *
 * The strictness does double duty. The plugin emits no opening turn on any host,
 * and the payload is built host-neutrally in lib/, so anything that reintroduces
 * Claude Code's `initialUserMessage` reaches this check through the Codex
 * adapter and fails here by name — even though the field's only real host is
 * Claude Code.
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

/**
 * Returns a list of violations; empty means Codex would accept this stdout.
 * `event` is the hookEventName const this output is required to carry.
 */
function violations(stdout, event) {
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
    if (h.hookEventName !== event) bad.push(`.hookSpecificOutput.hookEventName is ${JSON.stringify(h.hookEventName)}, must be "${event}"`);
  }
  return bad;
}

// One workspace per registry shape the bootstrap branches on, so the check
// covers the full-instruction path as well as the quiet ones.
const work = mkdtempSync(join(tmpdir(), 'cw-wire-'));
for (const name of ['none', 'one', 'many', 'zero', 'bad']) mkdirSync(join(work, name));
writeFileSync(join(work, 'one/.catwrangler'), '{"version":1,"projects":[{"slug":"arcade","id":"p-1"}]}');
writeFileSync(join(work, 'many/.catwrangler'), '{"version":1,"projects":[{"slug":"arcade","id":"p-1"},{"slug":"neon","id":"p-2","use_when":"the racer"}]}');
writeFileSync(join(work, 'zero/.catwrangler'), '{"version":1,"projects":[]}');
writeFileSync(join(work, 'bad/.catwrangler'), '{not json');

const FIXTURES = ['none', 'one', 'many', 'zero', 'bad'];

/**
 * The payload each event actually delivers, per its `.command.input` schema.
 * SessionStart varies over `source`; SubagentStart has none and varies over
 * `agent_type` instead, which is also what its matcher matches.
 */
const CASES = [
  {
    event: 'SessionStart',
    adapter: 'session-start-codex.mjs',
    variants: ['startup', 'resume', 'clear', 'compact'],
    payload: (cwd, source) => ({
      cwd,
      source,
      hook_event_name: 'SessionStart',
      model: 'gpt-5',
      permission_mode: 'default',
      session_id: 's-1',
      transcript_path: null,
    }),
  },
  {
    event: 'SubagentStart',
    adapter: 'subagent-start-codex.mjs',
    variants: ['general', 'explore'],
    payload: (cwd, agentType) => ({
      agent_id: 'a-1',
      agent_type: agentType,
      cwd,
      hook_event_name: 'SubagentStart',
      model: 'gpt-5',
      permission_mode: 'default',
      session_id: 's-1',
      transcript_path: null,
      turn_id: 't-1',
    }),
  },
];

let failures = 0;
let checked = 0;

const run = (adapter, event, payload, label, extra = () => []) => {
  // Through the shell wrapper — that is what Codex actually executes, so its
  // fallbacks and backstops are covered too, not just the Node adapter.
  const r = spawnSync('sh', [join(ROOT, 'scripts/session-start.sh'), adapter, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: ROOT,
  });
  checked++;
  const bad = violations(r.stdout || '', event);
  if (r.status !== 0) bad.push(`exit ${r.status} (a hook must always exit 0)`);
  bad.push(...extra(r.stdout || ''));
  if (bad.length) {
    failures++;
    console.log(`FAIL ${label}: ${bad.join('; ')}`);
  }
};

for (const { event, adapter, variants, payload } of CASES) {
  for (const fixture of FIXTURES) {
    for (const variant of variants) {
      run(adapter, event, payload(join(work, fixture), variant), `${event} ${fixture}/${variant}`);
    }
  }
}

// The wrapper's failure path, which only runs when the install is already
// broken and so is the one least likely to be noticed by hand. It has to carry
// the right event const — it used to hardcode SessionStart, which Codex would
// have rejected on a sub-agent spawn — and, per this plugin's no-broadcast rule,
// must not attach a user notice to a per-spawn event.
run('does-not-exist.mjs', 'SubagentStart', CASES[1].payload(join(work, 'one'), 'general'), 'SubagentStart missing-adapter fallback', (stdout) => {
  const bad = [];
  let doc = {};
  try { doc = JSON.parse(stdout); } catch { return ['fallback output is not JSON']; }
  if (!doc.hookSpecificOutput?.additionalContext) bad.push('fallback dropped additionalContext, so the sub-agent is told nothing');
  if (doc.systemMessage) bad.push('fallback emitted systemMessage on a per-spawn event');
  return bad;
});
// The same path on SessionStart keeps its user notice — that is the case the
// wrapper exists for, and the assertion that the branch above is a real
// distinction rather than a silent loss.
run('does-not-exist.mjs', 'SessionStart', CASES[0].payload(join(work, 'one'), 'startup'), 'SessionStart missing-adapter fallback', (stdout) => {
  let doc = {};
  try { doc = JSON.parse(stdout); } catch { return ['fallback output is not JSON']; }
  return doc.systemMessage ? [] : ['fallback lost the user notice a broken install depends on'];
});

rmSync(work, { recursive: true, force: true });

console.log(failures ? `FAIL codex wire (${failures}/${checked})` : `ok   codex wire (${checked} cases)`);
process.exitCode = failures ? 1 : 0;
