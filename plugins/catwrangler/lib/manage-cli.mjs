/**
 * CLI shell over lib/registry.mjs — host-neutral.
 *
 * Owns argv parsing, the single-JSON-object-on-stdout contract, and exit codes.
 * The registry functions it calls are pure; everything that talks to the process
 * lives here, so both hosts' skill entry points are a one-line delegation and
 * neither can drift in output shape.
 *
 * Subcommands (all print a single JSON object on stdout). Note `list` here reads
 * the local registry only — it is not the skill's `list` verb, which merges these
 * registered projects with the server's available ones:
 *   list                                        → { ok, exists, path, server, projects }
 *   add    --slug S [--id I] [--org O] [--name N] [--desc D] [--use-when W]
 *                     [--web-url X] [--server U] [--mcp-url M]
 *   remove --slug S [--org O]
 *
 * --id carries the server-assigned project id (the `id` field from
 * list_projects, shaped like `p-841207`). It is stored verbatim so `connect` can
 * feed it to init_session's `project_id` parameter — the unambiguous connection
 * key, since a slug is unique only within an org. It is optional, so files
 * written before it keep working.
 *
 * --use-when carries the LOCAL routing note: one line saying when work belongs to
 * this project, in the user's own words. Everything else here mirrors the server;
 * this field does not, which is the point — it holds what the server cannot know
 * (how this user refers to the project, which of their concerns it owns). Because
 * `add` re-pulls --desc from the server on every refresh, a local note kept in
 * `description` would be clobbered; this one survives.
 *
 * --web-url carries that project's CatWrangler UI/HTTP API origin, as
 * `list_projects` reports it. It is per-project and is NOT the same thing as the
 * file's top-level --server/--mcp-url: those name the MCP endpoint, which behind
 * the shared lane is a single URL serving every project, whereas each project's
 * web surface has its own host. Server-owned like --desc, so a refresh re-reads
 * it; never composed locally from a slug.
 *
 * --org carries the org slug. Project slugs are unique only within an
 * organization, so --org is what disambiguates two orgs' same-named projects.
 * It is optional, so .catwrangler files written before it keep working.
 *
 * Common option: --dir DIR (defaults to CWD). It is the directory to look FROM,
 * not the file to use: every subcommand hunts up from there for the governing
 * `.catwrangler`, then falls back to the home one, so running from deep inside a
 * repo finds the repo's registry. `list` reports which file it read (`path`,
 * `scope`) and where a write would land (`write_path`); `add`/`remove` report the
 * file they wrote (`path`). See findRegistry/resolveWriteDir in registry.mjs for
 * why writes stop short of the home registry.
 *
 * Exit 0 with { ok: true } on success; exit 1 with { ok: false, error } on failure.
 */

import { listRegistered, registerProject, unregisterProject, RegistryError } from './registry.mjs';

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else {
      opts[key] = next;
      i++;
    }
  }
  return { cmd, opts };
}

/** A string option that was actually given a value (not a bare flag / absent). */
function val(opts, key) {
  const v = opts[key];
  return typeof v === 'string' && v.length ? v : null;
}

/**
 * Run the manage CLI. Writes one JSON object to stdout and exits — never
 * returns. Both hosts' skill scripts call this and nothing else.
 */
export function runManageCli(argv) {
  const out = (obj) => {
    process.stdout.write(JSON.stringify(obj));
    process.exit(obj && obj.ok === false ? 1 : 0);
  };

  try {
    const { cmd, opts } = parseArgs(argv);
    const dir = val(opts, 'dir') || process.cwd();

    if (cmd === 'list') return out(listRegistered(dir));

    if (cmd === 'add') {
      return out(
        registerProject(dir, {
          slug: val(opts, 'slug'),
          id: val(opts, 'id'),
          org: val(opts, 'org'),
          name: val(opts, 'name'),
          desc: val(opts, 'desc'),
          useWhen: val(opts, 'use-when'),
          webUrl: val(opts, 'web-url'),
          server: val(opts, 'server'),
          mcpUrl: val(opts, 'mcp-url'),
        })
      );
    }

    if (cmd === 'remove') {
      return out(unregisterProject(dir, { slug: val(opts, 'slug'), org: val(opts, 'org') }));
    }

    return out({ ok: false, error: 'unknown command: ' + (cmd || '(none)') + ' — use list | add | remove' });
  } catch (e) {
    if (e instanceof RegistryError) return out({ ok: false, error: e.message });
    return out({ ok: false, error: 'unexpected: ' + (e && e.message ? e.message : String(e)) });
  }
}
