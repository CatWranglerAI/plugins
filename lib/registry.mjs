/**
 * `.catwrangler` registry core — host-neutral.
 *
 * Every read and write of the workspace registry lives here, as pure functions
 * that return plain objects and throw on failure. Nothing in this file touches
 * process.stdout, process.exit, or any host-specific API, so the same code backs
 * the Claude Code plugin and the Codex plugin. The CLI shell that turns these
 * into JSON-on-stdout is lib/manage-cli.mjs; the per-host skill entry points are
 * thin wrappers over that.
 *
 * The split exists because JSON shape, formatting, and dedup must never be left
 * to the model — and must not be reimplemented once per host, which is how two
 * ports drift into two subtly different file formats.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Thrown for every expected failure; the CLI layer renders these as { ok: false, error }. */
export class RegistryError extends Error {}

const fail = (msg) => {
  throw new RegistryError(msg);
};

/**
 * The plugin bundles its own MCP server entry, so the endpoint is already known
 * here — read it rather than making the caller pass --server/--mcp-url. Without
 * this a file created by `add` gets empty server/mcp_url, and every consumer
 * falls back to a generic "the CatWrangler MCP server".
 *
 * Reads whichever manifest the host uses, because the two disagree on shape:
 *   Claude Code  mcp-config.json  { "mcpServers": { "catwrangler": { url } } }
 *   Codex        .mcp.json        { "catwrangler": { url } }          (bare map)
 * Unwrapping `mcpServers` when present and treating the object as the map
 * otherwise covers both without the caller knowing which host it is on.
 *
 * Resolved from this file's own location (lib/ → plugin root), not from an env
 * var, so it holds however the script is invoked and on hosts that expose no
 * plugin-root variable at all. Returns empty strings when it cannot be
 * determined — this is a convenience default, never a hard requirement.
 */
export function pluginDefaults() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  for (const name of ['mcp-config.json', '.mcp.json']) {
    try {
      const cfg = JSON.parse(readFileSync(join(root, name), 'utf8'));
      const servers = (cfg && cfg.mcpServers) || cfg || {};
      const entry = servers.catwrangler || servers[Object.keys(servers)[0]];
      const mcpUrl = (entry && typeof entry.url === 'string' && entry.url) || '';
      if (!mcpUrl) continue;
      // The registry's `server` is the origin; `mcp_url` is the endpoint.
      return { server: mcpUrl.replace(/\/mcp\/?$/, ''), mcpUrl };
    } catch {
      // Missing or unreadable manifest — try the next name, then give up.
    }
  }
  return { server: '', mcpUrl: '' };
}

/** Absolute path to the registry file for a workspace directory. */
export const registryPath = (dir) => join(dir, '.catwrangler');

/** Parsed registry, or null when the workspace has none. Throws if present but unusable. */
export function readRegistry(dir) {
  const fp = registryPath(dir);
  if (!existsSync(fp)) return null;
  let raw;
  try {
    raw = readFileSync(fp, 'utf8');
  } catch (e) {
    fail('cannot read .catwrangler: ' + e.message);
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail('.catwrangler is not valid JSON');
  }
}

function writeRegistry(dir, m) {
  try {
    writeFileSync(registryPath(dir), JSON.stringify(m, null, 2) + '\n');
  } catch (e) {
    fail('cannot write .catwrangler: ' + e.message);
  }
}

const projectsOf = (m) => (Array.isArray(m && m.projects) ? m.projects : []);

/** Registered projects for this workspace. Never throws on a missing file. */
export function listRegistered(dir) {
  const m = readRegistry(dir);
  if (!m) return { ok: true, exists: false, path: registryPath(dir), server: null, projects: [] };
  return {
    ok: true,
    exists: true,
    path: registryPath(dir),
    server: m.server || m.mcp_url || null,
    projects: projectsOf(m),
  };
}

/**
 * Register a project, or refresh it in place when already present. Idempotent by
 * design: `connect` calls this on every successful init_session.
 *
 * opts: { slug, id?, org?, name?, desc?, useWhen?, server?, mcpUrl? }
 *
 * `useWhen` is the local routing note — see the `use_when` commentary below. It
 * is the one field here the server does not own, so unlike `desc` it is never
 * refreshed away by a later idempotent add that omits it.
 */
export function registerProject(dir, opts) {
  const { slug, org } = opts;
  if (!slug) fail('add requires --slug');

  let m = readRegistry(dir);
  if (!m) m = { version: 1, server: '', mcp_url: '', projects: [] };
  if (!Array.isArray(m.projects)) m.projects = [];

  // Fill top-level server/mcp_url only when currently empty: an explicit value
  // wins, otherwise fall back to the endpoint the plugin already bundles.
  // Also backfills files written before this defaulting existed.
  const fallback = pluginDefaults();
  if (!m.server) m.server = opts.server || fallback.server;
  if (!m.mcp_url) m.mcp_url = opts.mcpUrl || fallback.mcpUrl;

  // Project slugs are unique only WITHIN an org, so slug alone is not an identity
  // here. When org is given, match on (slug, org_slug) so a second org's
  // same-named project is a distinct entry rather than an overwrite. Without org,
  // fall back to slug-only matching, which keeps every pre-org entry working.
  const existing = m.projects.find((p) => p && p.slug === slug && (org ? p.org_slug === org : true));

  let action;
  if (existing) {
    if (opts.id) existing.id = opts.id;
    if (opts.name) existing.name = opts.name;
    if (opts.desc) existing.description = opts.desc;
    if (opts.useWhen) existing.use_when = opts.useWhen;
    if (org) existing.org_slug = org;
    action = 'updated';
  } else {
    const entry = { slug };
    if (opts.id) entry.id = opts.id;
    if (org) entry.org_slug = org;
    if (opts.name) entry.name = opts.name;
    if (opts.desc) entry.description = opts.desc;
    if (opts.useWhen) entry.use_when = opts.useWhen;
    m.projects.push(entry);
    action = 'added';
  }
  writeRegistry(dir, m);

  // Surface a slug now ambiguous in the local registry so the caller can render
  // both with their orgs rather than silently picking one.
  const ambiguous = m.projects.filter((p) => p && p.slug === slug).length > 1;
  return { ok: true, action, slug, ...(org ? { org_slug: org } : {}), ambiguous, projects: m.projects };
}

/** Unregister a project. Local menu only — never touches sessions or server access. */
export function unregisterProject(dir, opts) {
  const { slug, org } = opts;
  if (!slug) fail('remove requires --slug');
  const m = readRegistry(dir);
  if (!m) fail('no .catwrangler in ' + dir);
  const before = projectsOf(m).length;

  // Refuse to guess when the slug is ambiguous. Removing the wrong org's project
  // is silent and annoying to undo, so require the org instead.
  const matches = projectsOf(m).filter((p) => p && p.slug === slug);
  if (!org && matches.length > 1) {
    fail(
      `slug "${slug}" is registered in ${matches.length} orgs (` +
        matches.map((p) => p.org_slug || '(no org)').join(', ') +
        ') — pass --org to say which'
    );
  }

  m.projects = projectsOf(m).filter((p) => !(p && p.slug === slug && (org ? p.org_slug === org : true)));
  const action = m.projects.length < before ? 'removed' : 'noop';
  if (action === 'removed') writeRegistry(dir, m);
  return { ok: true, action, slug, ...(org ? { org_slug: org } : {}), projects: m.projects };
}
