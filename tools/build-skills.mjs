#!/usr/bin/env node
/**
 * Render each host's SKILL.md from the single source in src/.
 *
 * Claude Code and Codex agree on the skill format — same
 * skills/<name>/SKILL.md layout, same YAML-frontmatter-plus-Markdown shape — so
 * the body is one file. They disagree on three small things, and only those are
 * host-conditional:
 *
 *   1. Frontmatter. Claude Code uses allowed-tools/argument-hint/arguments;
 *      Codex uses the Agent Skills standard name/description, where description
 *      is the trigger and so carries the "use when…" phrasing.
 *   2. How the skill names its own bundled script. Claude Code substitutes
 *      ${CLAUDE_SKILL_DIR}; Codex has no such variable and documents relative
 *      paths from the skill directory.
 *   3. The registry listing. Claude Code can inject a command's output into the
 *      prompt with !`…`; Codex has no equivalent, so its copy runs the command.
 *
 * Not everything substituted here is host-conditional. {{PROTOCOL}} and
 * {{NO_RECONNECT}} resolve to the same text for every host — they are pulled from
 * lib/protocol.mjs so the skill and the SessionStart hook state the session's
 * rules in one voice instead of two paraphrases that drift apart.
 *
 * Symlinking one file into both trees is NOT an option: git stores a symlink as
 * its path string, and a Windows checkout without core.symlinks (the default
 * absent Developer Mode) materializes it as a regular file *containing that
 * path*. The customer gets a SKILL.md whose entire content is "../../skills/…",
 * with no error. Generating is the honest version of the same idea.
 *
 *   node tools/build-skills.mjs           # write both SKILL.md files
 *   node tools/build-skills.mjs --check   # verify they match src/ (exit 1 if stale)
 *
 * --check is what keeps the two copies honest: tests/parity.sh runs it, so an
 * edit to a generated file that never made it back to src/ fails the suite
 * instead of silently surviving until the next release.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_PROTOCOL, NO_RECONNECT_NEEDED } from '../lib/protocol.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'src', 'skill-connect.md');

/**
 * The session protocol as a Markdown bullet list. Same text the SessionStart
 * hook injects, differing only in the rendering the surrounding document wants —
 * which is exactly why it is substituted here instead of retyped in the skill.
 * See lib/protocol.mjs for why both paths have to carry it.
 */
const PROTOCOL_BULLETS = SESSION_PROTOCOL.map((line) => `- ${line}`).join('\n');

/** Host-neutral tokens — the shared text every host's skill gets verbatim. */
const SHARED_TOKENS = {
  PROTOCOL: PROTOCOL_BULLETS,
  NO_RECONNECT: NO_RECONNECT_NEEDED,
};

const HOSTS = {
  claude: {
    out: join(ROOT, 'skills', 'connect', 'SKILL.md'),
    tokens: {
      // Claude Code resolves this to the skill's own directory at prompt time.
      MANAGE: '"${CLAUDE_SKILL_DIR}/scripts/manage.mjs"',
    },
  },
  codex: {
    out: join(ROOT, 'skills-codex', 'connect', 'SKILL.md'),
    tokens: {
      // Codex documents referencing bundled scripts by a path relative to the
      // skill directory. UNVERIFIED against a live install — if Codex resolves
      // these against the session cwd instead, this is the one token to change.
      MANAGE: 'scripts/manage.mjs',
    },
  },
};

const BANNER = (host) =>
  `<!-- GENERATED from src/skill-connect.md for ${host} — edit the source, then run: node tools/build-skills.mjs -->`;

/**
 * Insert the generated-file banner AFTER the YAML frontmatter.
 *
 * Frontmatter has to open on line 1 — a comment above it turns the whole block
 * into body text, and the host silently loses description/allowed-tools/name.
 * That failure is invisible in a diff review, so the placement is enforced here
 * rather than left to whoever edits the template.
 */
function withBanner(rendered, host) {
  const m = rendered.match(/^---\n[\s\S]*?\n---\n/);
  if (!m) throw new Error(`rendered ${host} skill has no leading frontmatter block`);
  return m[0] + BANNER(host) + '\n' + rendered.slice(m[0].length);
}

/**
 * Resolve {{#host}}…{{/host}} blocks and {{TOKEN}} substitutions.
 * Blocks for other hosts are removed entirely, including nothing else — the
 * surrounding text closes up exactly as written, so the source controls spacing.
 */
function render(src, host, tokens) {
  let out = src;
  for (const name of Object.keys(HOSTS)) {
    const block = new RegExp(`\\{\\{#${name}\\}\\}([\\s\\S]*?)\\{\\{/${name}\\}\\}`, 'g');
    out = out.replace(block, name === host ? '$1' : '');
  }
  for (const [key, value] of Object.entries(tokens)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  const leftover = out.match(/\{\{[^}]+\}\}/g);
  if (leftover) throw new Error(`unresolved token(s) for ${host}: ${leftover.join(', ')}`);
  return out;
}

const check = process.argv.includes('--check');
const src = readFileSync(SOURCE, 'utf8');
let stale = 0;

for (const [host, { out, tokens }] of Object.entries(HOSTS)) {
  const rendered = withBanner(render(src, host, { ...SHARED_TOKENS, ...tokens }), host);
  if (check) {
    const current = existsSync(out) ? readFileSync(out, 'utf8') : null;
    if (current !== rendered) {
      console.error(`STALE ${out} — run: node tools/build-skills.mjs`);
      stale++;
    } else {
      console.log(`ok    ${host}`);
    }
  } else {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, rendered);
    console.log(`wrote ${host} → ${out.slice(ROOT.length + 1)}`);
  }
}

process.exit(stale ? 1 : 0);
