# CatWrangler — Claude Code and Codex plugin

Onboards your coding agent to a CatWrangler workspace with **no URL typing and no
hand-written CLAUDE.md**. Installing the plugin does two things:

1. **Registers the CatWrangler MCP server** (bundled — the user never types a URL).
2. **Injects the CatWrangler bootstrap protocol at session start**, read from a
   `.catwrangler` file in the workspace: the reachable-project menu, the mandatory
   `init_session` call, the `agent_id`/`_agent_id` discipline (kept separate per
   instance, recoverable on reconnect), and the no-local-source rule (use MCP
   tools, not `Read`/`Grep`/`cat`). This is the deterministic, app-less
   replacement for the CLAUDE.md bootstrap mandate.

## Layout

The repo root is the plugin root **for both hosts** — one tree, two manifests.
Everything that is not a manifest, an MCP config, or a hook entry is shared:

```
plugins/                                 ← repo root (github.com/CatWranglerAI/plugins)
│
│   ── shared: one copy, both hosts ──
├── lib/                                 ← everything the plugin actually does
│   ├── registry.mjs                     ← .catwrangler read/write, pure functions
│   ├── manage-cli.mjs                   ← argv → JSON stdout, exit codes
│   ├── bootstrap.mjs                    ← what SessionStart tells the model
│   └── hook.mjs                         ← SessionStart stdin/stdout contract
├── src/skill-connect.md                 ← the ONE source for both SKILL.md files
├── tools/build-skills.mjs               ← renders src/ → each host's SKILL.md
├── scripts/session-start.sh             ← wrapper: reports a missing/broken Node
├── tests/parity.sh                      ← golden transcripts; proves the hosts agree
├── examples/sample.catwrangler          ← what the /connect flow generates
│
│   ── Claude Code ──
├── .claude-plugin/
│   ├── marketplace.json                 ← lists the plugin (source "./")
│   └── plugin.json                      ← manifest (bundles the MCP server)
├── mcp-config.json                      ← MCP entry, {mcpServers:{…}}, ms timeout
├── hooks/hooks.json                     ← SessionStart → session-start.sh
├── scripts/session-start.mjs            ← adapter (~3 lines over lib/)
├── skills/connect/SKILL.md              ← GENERATED from src/
│   └── scripts/manage.mjs               ← entry point; delegates to lib/
│
│   ── Codex ──
├── .codex-plugin/plugin.json            ← manifest (skills → ./skills-codex/)
├── .mcp.json                            ← MCP entry, bare map, seconds timeout
├── hooks.json                           ← SessionStart → session-start.sh
├── scripts/session-start-codex.mjs      ← adapter (~3 lines over lib/)
└── skills-codex/connect/SKILL.md        ← GENERATED from src/
    └── scripts/manage.mjs               ← entry point; delegates to lib/
```

**Why one tree.** Claude Code and Codex converged on nearly the same extension
surface: the same `skills/<name>/SKILL.md` layout, and a SessionStart hook whose
output uses the same `hookSpecificOutput.additionalContext` fields. What differs
is the manifest, the MCP config shape, and a few host-specific escape hatches.
Codex's manifest lets a plugin point `skills` anywhere, so both plugins can be
rooted here and share `lib/` as a single copy — rooting Codex in a subdirectory
would force `lib/` to be duplicated, because a plugin install copies its root.

**Why the SKILL.md files are generated.** They are the one thing that genuinely
must exist twice: `${CLAUDE_SKILL_DIR}` and Claude Code's `` !`command` ``
output-injection have no Codex equivalent. Symlinking is not an option — git
stores a symlink as its path string, and a Windows checkout without
`core.symlinks` (the default absent Developer Mode) writes a regular file
*containing that path*, so the customer gets a SKILL.md whose entire content is
`../../skills/…` and no error anywhere. Both copies are rendered from
`src/skill-connect.md`; `tests/parity.sh` fails if either is stale.

**What differs between the hosts at runtime.** Exactly one thing, and it is
verified rather than assumed: Codex documents that SessionStart injects developer
context only and cannot create user turns, so its adapter drops
`initialUserMessage`. `tests/parity.sh` records a transcript per host, and every
line that differs between them is that dropped opening turn — nothing else.
Practically, an interactive Codex session gets the identical bootstrap; a
headless one gets the instruction without a forced first turn.

## Install

**Claude Code:**

```shell
/plugin marketplace add CatWranglerAI/plugins
/plugin install catwrangler@catwrangler
/reload-plugins
```

**Codex:** `/plugins`, then install from the marketplace. Start a new session
before using the bundled skill or tools — Codex does not hot-reload plugins.

Then drop a `.catwrangler` file (copy `examples/sample.catwrangler`) into a test
directory, start a session there, and the hook fires.

Test either hook directly without installing:

```shell
printf '{"cwd":"<dir-with-.catwrangler>","source":"startup"}' \
  | sh scripts/session-start.sh                        # Claude Code
printf '{"cwd":"<dir-with-.catwrangler>","source":"startup"}' \
  | sh scripts/session-start.sh session-start-codex.mjs   # Codex
```

Run the full suite — both hosts' transcripts plus the SKILL.md staleness check —
with `tests/parity.sh`. After an intentional change, re-record with
`tests/parity.sh --update` and review the golden diff.

Simulate a machine without Node (should print an install notice, exit 0):

```shell
printf '{"cwd":"<dir-with-.catwrangler>","source":"startup"}' \
  | env PATH=/usr/bin:/bin sh scripts/session-start.sh
```

## The `.catwrangler` file

A per-workspace descriptor the CatWrangler `/connect` flow generates (projected
from the server's per-user reachable-project list). JSON:

```json
{
  "version": 1,
  "server": "https://example.catwrangler.ai",
  "mcp_url": "https://example.catwrangler.ai/mcp",
  "org": "acme",
  "projects": [
    { "id": "p-105562", "slug": "storefront", "org_slug": "acme",
      "name": "Storefront", "description": "…what it is/does…" }
  ]
}
```

Each project's `id` (shaped like `p-105562`) is the server-assigned key the
`/connect` flow passes to `init_session` as its `project_id` parameter to pin the
exact project; `slug`, `org_slug`, `name`, and `description` come from
`list_projects`. Entries written before ids were captured have none and connect by
slug.

It is a **convenience cache, not the source of truth.** The hook tells the model
to fall back to `init_session` (the server) whenever the user references a project
not registered here. This is deliberate: a stale local file must never override live
server access, and project identity must never be inferred from the local
environment.

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
| No `.catwrangler` | One-line notice: not connected here, run `/catwrangler:connect`. Only on real session starts, not `clear`/`compact`. No model instruction (nothing to connect to) |
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

Codex splits the same concern into two fields, **in seconds**, so `.mcp.json`
carries `tool_timeout_sec: 600` — the direct equivalent of Claude's 600000ms, and
for the same reason — plus `startup_timeout_sec: 120`. Codex defaults those to 60
and 10, both far too low here. Startup is deliberately *not* 600: Claude's single
timer covers connect and calls alike, but splitting them means a dead endpoint
would hang for ten minutes before failing. 120s is generous for a cold start plus
an OAuth token refresh while still failing fast when the server is simply down.

**Confinement** is by file-presence: the plugin does real work (the project menu
+ `init_session` instruction) only where a `.catwrangler` exists, so a user-global
install never bootstraps the wrong project — no directory allowlist needed.
Elsewhere it emits at most a single "not connected — run `/catwrangler:connect`"
line on session start. (Project-scoped install also works; see Scopes.)

## Managing projects — `/catwrangler:connect`

One skill manages this workspace's project registry and connects sessions. Every
project is **available** (reachable per the server), **registered** (recorded in
`.catwrangler`), or **connected** (`init_session` called this session). They
normally stack in that order, but they are independent: you can connect to a
project that was never registered, and registering one grants no access it did
not already have.

```
/catwrangler:connect                 # interactive hub: show state, then add/remove/connect
/catwrangler:connect list            # read-only: show every project and its state
/catwrangler:connect add <slug>      # register a project in .catwrangler (idempotent)
/catwrangler:connect remove <slug>   # unregister from .catwrangler (does not touch sessions)
/catwrangler:connect connect <slug>  # init_session for that project, then register it (persists) + follow protocol
```

`list` and the bare hub render the same view; `list` just stops there instead of
offering to change anything.

The skill drives all server interaction and the `AskUserQuestion` prompts; the
bundled `manage.mjs` owns every `.catwrangler` read/write, so JSON shape,
dedup-by-slug, and unknown-field preservation are deterministic (the model never
hand-edits the file). `manage.mjs` references itself via `${CLAUDE_SKILL_DIR}` and
does no network I/O.

`list available` calls the server's `list_projects` MCP tool, which needs no
`init_session` — the menu is available before you connect to anything. Entries
carry `slug`, `name`, `org_slug`, and an optional `description`. They carry no
host: one connector still maps to one project, so the list tells you what exists
rather than letting you reach another deployment.

Because project slugs are unique only within an organization, `.catwrangler`
entries carry `org_slug`, and `add`/`remove` take `--org` to disambiguate two
orgs' same-named projects.

## Scopes

- **Project scope** (`--scope project`, committed to the repo's `.claude/settings.json`)
  loads the plugin only in that repo. MCP servers it declares go through the same
  per-server approval as a project `.mcp.json`, and it loads only after the
  workspace trust dialog.
- **User scope** loads everywhere; the `.catwrangler`-presence check keeps it inert
  outside CatWrangler workspaces.

## The bundled MCP server

`mcp-config.json` carries the CatWrangler MCP endpoint, so the user never types a
URL. If your workspace is served from a different host, point that entry at your
own `/mcp` endpoint — everything else in the plugin is host-agnostic.

Plugins are Claude Code only. In the Claude and ChatGPT apps the same project
menu arrives server-side through the CatWrangler connector.
