#!/usr/bin/env node
/**
 * .catwrangler CRUD for the /catwrangler:connect skill. Deterministic, no network — the
 * model owns all server interaction (listing available, connecting); this script
 * owns only the local file so JSON shape/formatting/dedup are never left to the
 * model.
 *
 * Subcommands (all print a single JSON object on stdout):
 *   list                                        → { ok, exists, path, server, projects }
 *   add    --slug S [--name N] [--desc D] [--server U] [--mcp-url M]
 *   remove --slug S
 * Common option: --dir DIR (defaults to CWD).
 *
 * Exit 0 with { ok: true } on success; exit 1 with { ok: false, error } on failure.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The plugin bundles the MCP server entry, so the endpoint is already known
 * here — read it rather than making the caller pass --server/--mcp-url. Without
 * this a file created by `add` gets empty server/mcp_url, and every consumer
 * falls back to a generic "the CatWrangler MCP server".
 *
 * Resolved from this script's own location (skills/connect/scripts → plugin
 * root), not from an env var, so it holds however the script is invoked.
 * Returns { server, mcpUrl } with empty strings when it cannot be determined —
 * this is a convenience default, never a hard requirement.
 */
function pluginDefaults() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const cfg = JSON.parse(readFileSync(join(here, '..', '..', '..', 'mcp-config.json'), 'utf8'));
    const servers = (cfg && cfg.mcpServers) || {};
    const entry = servers.catwrangler || servers[Object.keys(servers)[0]];
    const mcpUrl = (entry && typeof entry.url === 'string' && entry.url) || '';
    // The manifest's `server` is the origin; `mcp_url` is the endpoint.
    const server = mcpUrl.replace(/\/mcp\/?$/, '');
    return { server, mcpUrl };
  } catch {
    return { server: '', mcpUrl: '' };
  }
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  }
  return { cmd, opts };
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function fail(msg) {
  out({ ok: false, error: msg });
  process.exit(1);
}

/** A string option that was actually given a value (not a bare flag / absent). */
function val(opts, key) {
  const v = opts[key];
  return typeof v === 'string' && v.length ? v : null;
}

function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const dir = val(opts, 'dir') || process.cwd();
  const fp = join(dir, '.catwrangler');

  const load = () => {
    if (!existsSync(fp)) return null;
    let raw;
    try { raw = readFileSync(fp, 'utf8'); }
    catch (e) { fail('cannot read .catwrangler: ' + e.message); }
    try { return JSON.parse(raw); }
    catch { fail('.catwrangler is not valid JSON'); }
  };

  const save = (m) => {
    try { writeFileSync(fp, JSON.stringify(m, null, 2) + '\n'); }
    catch (e) { fail('cannot write .catwrangler: ' + e.message); }
  };

  const projectsOf = (m) => (Array.isArray(m && m.projects) ? m.projects : []);

  if (cmd === 'list') {
    const m = load();
    if (!m) return out({ ok: true, exists: false, path: fp, server: null, projects: [] });
    return out({
      ok: true,
      exists: true,
      path: fp,
      server: m.server || m.mcp_url || null,
      projects: projectsOf(m),
    });
  }

  if (cmd === 'add') {
    const slug = val(opts, 'slug');
    if (!slug) fail('add requires --slug');
    let m = load();
    if (!m) m = { version: 1, server: '', mcp_url: '', projects: [] };
    if (!Array.isArray(m.projects)) m.projects = [];

    // Fill top-level server/mcp_url only when currently empty: an explicit flag
    // wins, otherwise fall back to the endpoint the plugin already bundles.
    // Also backfills files written before this defaulting existed.
    const fallback = pluginDefaults();
    if (!m.server) m.server = val(opts, 'server') || fallback.server;
    if (!m.mcp_url) m.mcp_url = val(opts, 'mcp-url') || fallback.mcpUrl;

    const existing = m.projects.find((p) => p && p.slug === slug);
    let action;
    if (existing) {
      if (val(opts, 'name')) existing.name = val(opts, 'name');
      if (val(opts, 'desc')) existing.description = val(opts, 'desc');
      action = 'updated';
    } else {
      const entry = { slug };
      if (val(opts, 'name')) entry.name = val(opts, 'name');
      if (val(opts, 'desc')) entry.description = val(opts, 'desc');
      m.projects.push(entry);
      action = 'added';
    }
    save(m);
    return out({ ok: true, action, slug, projects: m.projects });
  }

  if (cmd === 'remove') {
    const slug = val(opts, 'slug');
    if (!slug) fail('remove requires --slug');
    const m = load();
    if (!m) fail('no .catwrangler in ' + dir);
    const before = projectsOf(m).length;
    m.projects = projectsOf(m).filter((p) => !(p && p.slug === slug));
    const action = m.projects.length < before ? 'removed' : 'noop';
    if (action === 'removed') save(m);
    return out({ ok: true, action, slug, projects: m.projects });
  }

  fail('unknown command: ' + (cmd || '(none)') + ' — use list | add | remove');
}

try {
  main();
} catch (e) {
  fail('unexpected: ' + (e && e.message ? e.message : String(e)));
}
