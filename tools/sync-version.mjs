#!/usr/bin/env node
/**
 * Write the version in VERSION into every manifest that has to carry it.
 *
 * The plugin ships three manifests, one per surface it is installed from:
 *
 *   .claude-plugin/plugin.json       the Claude Code plugin itself
 *   .claude-plugin/marketplace.json  the marketplace entry that lists it
 *   .codex-plugin/plugin.json        the Codex plugin
 *
 * They are separate documents on purpose — each host describes the plugin in its
 * own words, and Codex additionally declares keywords, hooks and interface. The
 * one thing they must never disagree about is which version shipped, because
 * that is what an installed copy reports and what a release is identified by.
 *
 * So VERSION is the single place the number is written by hand, and this script
 * copies it into the three manifests. Only the version field is generated;
 * everything else in each manifest stays hand-authored.
 *
 *   node tools/sync-version.mjs           # write VERSION into all three
 *   node tools/sync-version.mjs --check   # verify they agree (exit 1 if not)
 *
 * --check runs as part of tests/parity.sh, so a manifest left behind by a
 * version bump fails the suite instead of shipping a copy that misreports itself.
 *
 * To release: edit VERSION, run this script, commit the four files together.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_FILE = join(ROOT, 'VERSION');

/** Semver, with optional prerelease and build metadata. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Each manifest and where its version lives. The marketplace nests its entry
 * under plugins[], so the location is a function rather than a field name.
 */
const MANIFESTS = [
  { rel: '.claude-plugin/plugin.json', label: 'claude plugin', at: (m) => m?.version },
  { rel: '.claude-plugin/marketplace.json', label: 'marketplace', at: (m) => m?.plugins?.[0]?.version },
  { rel: '.codex-plugin/plugin.json', label: 'codex plugin', at: (m) => m?.version },
];

/**
 * Matches the version field as written, capturing its punctuation so a rewrite
 * preserves the file's own spacing.
 *
 * The rewrite is deliberately textual rather than parse-and-reserialize: these
 * manifests are hand-edited, and round-tripping them through a JSON serializer
 * would silently restyle whatever the author wrote. Replacing one field touches
 * one line.
 */
const VERSION_FIELD = /("version"\s*:\s*)"([^"]*)"/g;

function fail(message) {
  console.error(`sync-version: ${message}`);
  process.exit(1);
}

function readText(path, what) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    fail(`cannot read ${what} (${err.code || err.message})`);
  }
}

function readDeclaredVersion() {
  const version = readText(VERSION_FILE, 'VERSION').trim();
  if (!SEMVER.test(version)) {
    fail(`VERSION is not a version number: ${JSON.stringify(version)}`);
  }
  return version;
}

/**
 * Replace the single version field in `text`.
 *
 * Refuses when there is not exactly one, rather than guessing which to rewrite:
 * a manifest that grows a second version field is a change this script must be
 * taught about, not one it should silently pick a winner for.
 */
function rewriteVersion(text, next, rel) {
  const found = text.match(VERSION_FIELD);
  if (!found || found.length !== 1) {
    fail(`${rel} has ${found ? found.length : 0} version fields; expected exactly 1`);
  }
  return text.replace(VERSION_FIELD, `$1"${next}"`);
}

const check = process.argv.includes('--check');
const declared = readDeclaredVersion();

/**
 * Nothing is written until every manifest has been read, parsed and rewritten
 * successfully.
 *
 * Writing as we go would mean a refusal partway through — a manifest that grew a
 * second version field, say — leaves the earlier ones already bumped and the
 * later ones not, which is a worse starting point than the one the command was
 * given. The natural response to a loud error is to fix the named file and run
 * again, not to go looking for what was half-written.
 */
const pending = [];
let stale = 0;

for (const { rel, label, at } of MANIFESTS) {
  const path = join(ROOT, rel);
  const text = readText(path, rel);

  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (err) {
    fail(`${rel} is not valid JSON: ${err.message}`);
  }

  const current = at(manifest);
  if (typeof current !== 'string') {
    fail(`${rel} has no version where one is expected`);
  }

  if (current === declared) {
    console.log(check ? `ok    ${label}` : `ok    ${label} (already ${declared})`);
    continue;
  }

  if (check) {
    console.error(`STALE ${rel} — says ${current}, VERSION says ${declared}; run: node tools/sync-version.mjs`);
    stale++;
    continue;
  }

  const updated = rewriteVersion(text, declared, rel);

  // Read the result back rather than trusting the substitution: the check that
  // matters is what a host will parse out of the file, not what was written.
  let after;
  try {
    after = at(JSON.parse(updated));
  } catch (err) {
    fail(`rewriting ${rel} produced invalid JSON: ${err.message}`);
  }
  if (after !== declared) {
    fail(`rewriting ${rel} did not take effect (still ${after})`);
  }

  pending.push({ path, label, updated });
}

if (check) {
  process.exit(stale ? 1 : 0);
}

for (const { path, label, updated } of pending) {
  writeFileSync(path, updated);
  console.log(`wrote ${label} → ${declared}`);
}
