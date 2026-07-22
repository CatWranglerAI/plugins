# CatWrangler — Claude Code plugin (PoC)

Onboards Claude Code to a CatWrangler workspace with **no URL typing and no
hand-written CLAUDE.md**. Installing the plugin does two things:

1. **Registers the CatWrangler MCP server** (bundled — the user never types a URL).
2. **Injects the CatWrangler bootstrap protocol at session start**, read from a
   `.catwrangler` file in the workspace: the reachable-project menu, the mandatory
   `init_session` call, the `agent_id`/`_agent_id` discipline (kept separate per
   instance, recoverable on reconnect), and the no-local-source rule (use MCP
   tools, not `Read`/`Grep`/`cat`). This is the deterministic, app-less
   replacement for the CLAUDE.md bootstrap mandate.

This is a proof-of-concept validating the *method* (plugin + SessionStart hook +
`.catwrangler` menu). It intentionally does **not** depend on the deferred
single-URL router work — see "Production notes" below. Corresponds to
`atc:d-819`.

## Layout

The repo root is both the marketplace and the single plugin (`source: "./"`):

```
plugins/                                 ← repo root (catwranglerai/plugins)
├── .claude-plugin/
│   ├── marketplace.json                 ← lists the plugin (source "./")
│   └── plugin.json                      ← plugin manifest (bundles the MCP server)
├── mcp-config.json                      ← the CatWrangler MCP server entry
├── hooks/hooks.json                     ← SessionStart → session-start.sh
├── scripts/session-start.sh             ← wrapper: reports a missing/broken Node
├── scripts/session-start.mjs            ← the hook (injects the bootstrap protocol)
├── skills/connect/                      ← /catwrangler:connect: manage workspace projects
│   ├── SKILL.md
│   └── scripts/manage.mjs               ← deterministic .catwrangler CRUD
└── examples/sample.catwrangler          ← what the /connect flow generates
```

## Try it locally

```shell
/plugin marketplace add ./catwrangler-plugin
/plugin install catwrangler@catwrangler
/reload-plugins
```

Then drop a `.catwrangler` file (copy `examples/sample.catwrangler`) into a test
directory, start a session there, and the hook fires.

Test the hook directly without installing:

```shell
printf '{"cwd":"<dir-with-.catwrangler>","source":"startup"}' \
  | sh scripts/session-start.sh
```

Simulate a machine without Node (should print an install notice, exit 0):

```shell
printf '{"cwd":"<dir-with-.catwrangler>","source":"startup"}' \
  | env PATH=/usr/bin:/bin sh scripts/session-start.sh
```

## The `.catwrangler` file

A per-workspace descriptor the CatWrangler `/connect` flow generates (projected
from ATC's per-user reachable-project list). JSON:

```json
{
  "version": 1,
  "server": "https://dev.catwrangler.ai",
  "mcp_url": "https://dev.catwrangler.ai/mcp",
  "org": "catwrangler",
  "projects": [
    { "slug": "dev", "name": "CatWrangler Dev", "description": "…what it is/does…" }
  ]
}
```

It is a **convenience cache, not the source of truth.** The hook tells the model
to fall back to `init_session` (the server) whenever the user references a project
not listed here. This is deliberate: a stale local file must never override live
server access (the failure mode behind the pool-122 identity incident).

## How the hook behaves

SessionStart fires **before MCP servers connect**, so the hook never inspects
auth/connection state — it only *injects the instruction* and lets the model act
once MCP is up.

| Situation | Behavior |
|---|---|
| `.catwrangler` present, ≥1 project | Injects the menu + `init_session` instruction; shows the user a one-line notice |
| Non-interactive run (`claude -p`) | Also supplies an opening turn — connect, then summarize what's new — so a headless session never starts work unconnected. Interactive sessions ignore it; not sent on `clear`/`compact` |
| `.catwrangler` present, 1 project | Instructs a deterministic connect to that project |
| `.catwrangler` present, 0 projects | Instructs the model to fetch the list from `init_session` |
| No `.catwrangler` | **Silent no-op** — safe to install user-global |
| `.catwrangler` malformed | User-visible notice, no crash |
| Node.js not on `PATH` | User-visible "install Node 18+" notice + a model-facing note that the bootstrap was skipped; session continues |
| Node present but the hook errors | Same shape, pointing at `node --version` |

## Requirements

- **Node.js 18+** on `PATH`. The hook and the `/catwrangler:connect` skill are
  Node scripts. Claude Code itself no longer ships Node, so it may be missing —
  if it is, both tell you so and the session continues without the project menu.
- **A POSIX shell.** macOS, Linux, and WSL have one. On Windows, install
  [Git for Windows](https://git-scm.com/downloads/win); Claude Code uses Git Bash
  for hooks and for the Bash tool this plugin's skill needs.

**Tool timeout.** `mcp-config.json` sets `"timeout": 600000` (10 minutes) on the
server entry. Without it, an HTTP MCP server gets a 60-second per-request timer,
and CatWrangler tools that run a build, a merge, or an LLM gate — `build_deploy`,
`sandbox_merge`, `await_job`, `register_decision` — routinely exceed that. The
work still completes on the server when a client gives up, so the symptom is a
false failure, and retrying a call that actually succeeded can duplicate it.
Progress notifications do not extend the timer. Note that this value is also a
floor on the idle timeout, so a genuinely stuck call takes 10 minutes to abort
rather than the default 5.

**Confinement** is by file-presence: the plugin acts only where a `.catwrangler`
exists, so a user-global install stays quiet in every other project — no
directory allowlist needed. (Project-scoped install also works; see Scopes.)

## Managing projects — `/catwrangler:connect`

One skill manages this workspace's project menu and connects sessions. Every
project is **listed** (in `.catwrangler`), **available** (reachable per the
server), or **connected** (`init_session` called this session).

```
/catwrangler:connect                 # interactive hub: show state, then add/remove/connect
/catwrangler:connect add <slug>      # add a project to .catwrangler (idempotent)
/catwrangler:connect remove <slug>   # delist from .catwrangler (does not touch sessions)
/catwrangler:connect connect <slug>  # init_session for that project, then follow protocol
```

The skill drives all server interaction and the `AskUserQuestion` prompts; the
bundled `manage.mjs` owns every `.catwrangler` read/write, so JSON shape,
dedup-by-slug, and unknown-field preservation are deterministic (the model never
hand-edits the file). `manage.mjs` references itself via `${CLAUDE_SKILL_DIR}` and
does no network I/O.

**Known gap:** `list available` needs a server capability that doesn't exist yet —
a reachable-project menu returned without a full session (the ATC projects endpoint
/ `init_session` menu, `atc:d-819`). Until it lands, `list`/`add`/`remove`/`connect`
work; available-listing falls back to what `init_session` returned, or tells the
user it needs that endpoint. The `/connect` flow that generates `.catwrangler` is
the eventual writer of the same data.

## Scopes

- **Project scope** (`--scope project`, committed to the repo's `.claude/settings.json`)
  loads the plugin only in that repo. MCP servers it declares go through the same
  per-server approval as a project `.mcp.json`, and it loads only after the
  workspace trust dialog.
- **User scope** loads everywhere; the `.catwrangler`-presence check keeps it inert
  outside CatWrangler workspaces.

## Production notes (out of PoC scope)

- **MCP URL.** `mcp-config.json` hardcodes `https://dev.catwrangler.ai/mcp` for the
  demo. Per-tenant hostnames make the plugin content tenant-specific; the durable
  fix is the deferred single-URL router (identity in the token, project via
  `init_session`) — at which point one published plugin serves everyone.
- **`.catwrangler` generation.** Generated by `/connect`, same path that already
  writes CLAUDE.md, projected from `GET /api/orgs` + `/api/orgs/:orgId/projects`.
  The per-project `description` field is the one addition ATC still needs.
- **The app.** Plugins are Claude-Code-only. The Claude/ChatGPT app gets the same
  menu server-side via the connector + `init_session`'s fail-closed response.
