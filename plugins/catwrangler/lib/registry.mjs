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

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
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
 *   Codex        codex-mcp.json   { "catwrangler": { url } }          (bare map)
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
  for (const name of ['mcp-config.json', 'codex-mcp.json']) {
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

/** True only for a real, readable regular file — a directory named `.catwrangler` is not a hit. */
const isRegistryFile = (fp) => {
  try {
    return statSync(fp).isFile();
  } catch {
    return false;
  }
};

/**
 * Find the `.catwrangler` that governs a directory.
 *
 * Sessions do not start at the top of a repo. Someone working in `repo/src/api`
 * gets the same shell and the same plugin as someone in `repo`, and before this
 * hunt existed only the second one was connected — the first looked like an
 * unconfigured directory and got nagged to run /catwrangler:connect in a
 * workspace that was already set up. So: walk up from `dir` to the filesystem
 * root, then fall back to the user's home directory.
 *
 * NEAREST WINS, and nothing merges. A repo's registry REPLACES the home one
 * rather than adding to it, which is the whole difference from how CLAUDE.md
 * files stack. The reason is that this file is a routing menu, not a pile of
 * instructions: merging would drop the home registry's projects into every repo
 * session, turning an unambiguous one-project workspace into a two-project
 * choice the model has to make on every task. A repo that says what it is
 * connected to is entitled to be believed.
 *
 * Home is therefore a FALLBACK, for directories no repo claims — scratch dirs,
 * `~/tmp`, anywhere someone happens to be standing. It is reached two ways: as
 * an ordinary ancestor (any cwd under `~`), or by the explicit check at the end
 * (a cwd outside `~` entirely, e.g. `/Volumes/Projects`). Both yield the same
 * file; `scope` distinguishes them because writes treat home differently — see
 * resolveWriteDir.
 *
 * Returns { dir, path, scope } or null. `scope` is:
 *   'cwd'      — the file is in `dir` itself (the pre-hunt behavior)
 *   'ancestor' — found by walking up
 *   'home'     — the home registry, reached from somewhere else
 */
export function findRegistry(dir) {
  const start = resolve(dir || '.');
  let home = '';
  try {
    home = homedir();
  } catch {
    // No home directory available (unusual, but not fatal) — ancestors only.
  }

  for (let d = start; ; ) {
    const fp = registryPath(d);
    if (isRegistryFile(fp)) {
      const scope = d === start ? 'cwd' : d === home ? 'home' : 'ancestor';
      return { dir: d, path: fp, scope };
    }
    const parent = dirname(d);
    if (parent === d) break; // filesystem root
    d = parent;
  }

  // A cwd outside the home tree never passes through it above.
  if (home && home !== start) {
    const fp = registryPath(home);
    if (isRegistryFile(fp)) return { dir: home, path: fp, scope: 'home' };
  }
  return null;
}

/**
 * The directory `add`/`remove` should write to, given where the user is.
 *
 * Reading walks up; writing follows it only so far. An ancestor's file IS this
 * workspace's registry, so connecting from `repo/src/api` updates `repo`'s file
 * rather than scattering a second one three levels down where nothing looks for
 * it.
 *
 * The home registry is the exception: it governs every unclaimed directory on
 * the machine, so `add` from some unrelated folder must not silently edit it.
 * There the write lands in cwd, creating a registry for the directory the user
 * is actually in. Editing the home file stays a deliberate act — stand in `~`
 * and it is just cwd, or pass --dir.
 */
export function resolveWriteDir(dir) {
  const start = resolve(dir || '.');
  const found = findRegistry(start);
  // scope 'home' means found at ~ FROM somewhere else; standing in ~ is 'cwd'.
  if (!found || found.scope === 'home') return start;
  return found.dir;
}

/** Parse one registry file by path. Throws if it exists but is unusable. */
export function readRegistryFile(fp) {
  let raw;
  try {
    raw = readFileSync(fp, 'utf8');
  } catch (e) {
    fail('cannot read ' + fp + ': ' + e.message);
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Name the file: with the hunt, the broken one may be several levels up and
    // "the .catwrangler" is no longer enough to identify it.
    fail(fp + ' is not valid JSON');
  }
}

/**
 * Parsed registry for exactly this directory — no hunt. Writes use this, because
 * the target directory has already been decided by resolveWriteDir.
 * Returns null when the directory has none.
 */
export function readRegistry(dir) {
  const fp = registryPath(dir);
  if (!existsSync(fp)) return null;
  return readRegistryFile(fp);
}

function writeRegistry(dir, m) {
  try {
    writeFileSync(registryPath(dir), JSON.stringify(m, null, 2) + '\n');
  } catch (e) {
    fail('cannot write .catwrangler: ' + e.message);
  }
}

const projectsOf = (m) => (Array.isArray(m && m.projects) ? m.projects : []);

/**
 * Registered projects for this workspace, hunting up from `dir` and then home.
 * Never throws on a missing file.
 *
 * `path` is the file that was actually found (or, when there is none, where one
 * would be created), and `scope` says how it was reached — 'cwd', 'ancestor',
 * 'home', or 'none'. Both matter to a caller rendering the answer: "connected to
 * arcade" is a different statement when the file lives three directories up or
 * in the user's home, and the skill has to be able to say which.
 *
 * `write_path` is where an `add` from here would land, which is NOT always the
 * file that was read — see resolveWriteDir.
 */
export function listRegistered(dir) {
  const found = findRegistry(dir);
  const writePath = registryPath(resolveWriteDir(dir));
  if (!found) {
    return { ok: true, exists: false, path: writePath, scope: 'none', write_path: writePath, server: null, projects: [] };
  }
  const m = readRegistryFile(found.path);
  return {
    ok: true,
    exists: true,
    path: found.path,
    scope: found.scope,
    write_path: writePath,
    server: m.server || m.mcp_url || null,
    projects: projectsOf(m),
  };
}

/**
 * Register a project, or refresh it in place when already present. Idempotent by
 * design: `connect` calls this on every successful init_session.
 *
 * opts: { slug, id?, org?, name?, desc?, useWhen?, webUrl?, server?, mcpUrl? }
 *
 * `useWhen` is the local routing note — see the `use_when` commentary below. It
 * is the one field here the server does not own, so unlike `desc` it is never
 * refreshed away by a later idempotent add that omits it.
 *
 * `webUrl` is the OPPOSITE case, and the distinction is worth keeping straight:
 * it is that project's CatWrangler UI/HTTP API origin, owned entirely by the
 * server and re-read on every refresh. It is per-project and NOT derivable from
 * the file's top-level `server`/`mcp_url` — those name the MCP endpoint, which
 * behind the shared lane is one URL for every project, while the web origin is
 * one per project. Nothing here composes it from a slug: an invented host would
 * be indistinguishable from a real one and is the server's to know.
 */
export function registerProject(dir, opts) {
  const { slug, org } = opts;
  if (!slug) fail('add requires --slug');

  // Update the registry that governs this directory, wherever it sits — never
  // shadow it with a new file in a subdirectory.
  dir = resolveWriteDir(dir);
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
    if (opts.webUrl) existing.web_url = opts.webUrl;
    if (org) existing.org_slug = org;
    action = 'updated';
  } else {
    const entry = { slug };
    if (opts.id) entry.id = opts.id;
    if (org) entry.org_slug = org;
    if (opts.name) entry.name = opts.name;
    if (opts.desc) entry.description = opts.desc;
    if (opts.useWhen) entry.use_when = opts.useWhen;
    if (opts.webUrl) entry.web_url = opts.webUrl;
    m.projects.push(entry);
    action = 'added';
  }
  writeRegistry(dir, m);

  // Surface a slug now ambiguous in the local registry so the caller can render
  // both with their orgs rather than silently picking one.
  const ambiguous = m.projects.filter((p) => p && p.slug === slug).length > 1;
  // `path` is not decoration: the write may have landed in a parent directory,
  // and a user told "connected" without being told where has no way to find it.
  return { ok: true, action, slug, ...(org ? { org_slug: org } : {}), ambiguous, path: registryPath(dir), projects: m.projects };
}

/** Unregister a project. Local menu only — never touches sessions or server access. */
export function unregisterProject(dir, opts) {
  const { slug, org } = opts;
  if (!slug) fail('remove requires --slug');

  const target = resolveWriteDir(dir);
  const m = readRegistry(target);
  if (!m) {
    // The only way to reach here with a registry in scope is the home fallback,
    // which writes deliberately refuse to touch. Say where it is instead of
    // reporting "not connected" about a project the user can plainly see.
    const found = findRegistry(dir);
    if (found) {
      fail(
        'no .catwrangler in ' + target + ' — the projects in scope here come from ' + found.path +
          ' (your home registry). Run this from ' + found.dir + ' to disconnect one.'
      );
    }
    fail('no .catwrangler in ' + target);
  }
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
  if (action === 'removed') writeRegistry(target, m);
  return { ok: true, action, slug, ...(org ? { org_slug: org } : {}), path: registryPath(target), projects: m.projects };
}
