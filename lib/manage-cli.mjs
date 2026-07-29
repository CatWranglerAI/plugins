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
 *   add    --slug S [--id I] [--org O] [--name N] [--desc D] [--server U] [--mcp-url M]
 *   remove --slug S [--org O]
 *
 * --id carries the server-assigned project id (the `id` field from
 * list_projects, shaped like `p-841207`). It is stored verbatim so `connect` can
 * feed it to init_session's `project_id` parameter — the unambiguous connection
 * key, since a slug is unique only within an org. It is optional, so files
 * written before it keep working.
 *
 * --org carries the org slug. Project slugs are unique only within an
 * organization, so --org is what disambiguates two orgs' same-named projects.
 * It is optional, so .catwrangler files written before it keep working.
 * Common option: --dir DIR (defaults to CWD).
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
