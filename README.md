# CatWrangler — Claude Code and Codex plugin

Onboards your coding agent to a CatWrangler workspace with **no URL typing and no
hand-written CLAUDE.md**. Installing the plugin does two things:

1. **Registers the CatWrangler MCP server** (bundled — the user never types a URL).
2. **Injects the CatWrangler bootstrap protocol at session start**, read from a
   `.catwrangler` file — found from the current directory, any parent, or your
   home directory — carrying the reachable-project menu, the mandatory
   `init_session` call, the `agent_id`/`_agent_id` discipline (kept separate per
   instance, recoverable on reconnect), and the no-local-source rule (use MCP
   tools, not `Read`/`Grep`/`cat`). This is the deterministic, app-less
   replacement for the CLAUDE.md bootstrap mandate.

Connect a workspace once, with `/catwrangler:connect`, and every session started
there picks the project up on its own from then on.

## Layout

The repo root is the plugin root **for both hosts** — one tree, two manifests.
Everything that is not a manifest, an MCP config, or a hook entry is shared:

```
plugins/                                 ← repo root (github.com/CatWranglerAI/plugins)
│
│   ── shared: one copy, both hosts ──
├── lib/                                 ← everything the plugin actually does
│   ├── registry.mjs                     ← .catwrangler find/read/write, pure functions
│   ├── manage-cli.mjs                   ← argv → JSON stdout, exit codes
│   ├── bootstrap.mjs                    ← what SessionStart tells the model
│   ├── protocol.mjs                     ← the session rules BOTH paths deliver
│   └── hook.mjs                         ← SessionStart stdin/stdout contract
├── src/skill-connect.md                 ← the ONE source for both SKILL.md files
├── tools/build-skills.mjs               ← renders src/ → each host's SKILL.md
├── scripts/session-start.sh             ← wrapper: reports a missing/broken Node
├── scripts/manage.mjs                   ← alias for the skills' entry point below
├── tests/parity.sh                      ← golden transcripts; proves the hosts agree
├── tests/codex-wire.mjs                 ← proves Codex will accept the hook's stdout
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
├── .codex-plugin/plugin.json            ← manifest (points skills/hooks below)
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
must exist twice: Claude Code's `${CLAUDE_SKILL_DIR}` and its `$verb`/`$slug`
argument substitution have no Codex equivalent. Symlinking is not an option — git
stores a symlink as its path string, and a Windows checkout without
`core.symlinks` (the default absent Developer Mode) writes a regular file
*containing that path*, so the customer gets a SKILL.md whose entire content is
`../../skills/…` and no error anywhere. Both copies are rendered from
`src/skill-connect.md`; `tests/parity.sh` fails if either is stale.

**What differs between the hosts at runtime.** Nothing, and that is verified
rather than assumed: `tests/parity.sh` records a transcript per host, and the
hook output in them is identical. The plugin injects context and never starts a
turn, on any host — a session gets the bootstrap instruction attached to whatever
the user actually opened it to do, and connects as part of doing that. Claude
Code does offer `initialUserMessage`, which manufactures an opening turn; the
plugin deliberately does not use it (see `lib/bootstrap.mjs`), because it fired
on every startup, resume, and fork and opened sessions with an unrequested
catch-up briefing.

**What the Codex side depends on.** Four things, each load-bearing:

- `.codex-plugin/plugin.json` declares `"hooks": "./hooks.json"`. Undeclared,
  Codex reads `hooks/hooks.json` — Claude Code's.
- Codex validates hook stdout strictly and rejects unknown fields — the reason
  `initialUserMessage` could only ever have gone to Claude Code, and now the
  guard that catches it if it comes back.
- Empty stdout is a parse error there, so a hook with nothing to say emits `{}`.
- Codex sets `PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT`, so `hooks.json` reads
  `${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}`.

`tests/codex-wire.mjs` checks the emitted shape against Codex's
`session-start.command.output` schema, so a field it would reject fails by name
in the suite instead.

Codex also asks once before running a plugin's hooks, and again after the hook
config changes; until it is accepted the hook does not run. `codex exec` skips an
unaccepted hook rather than prompting, so accept it in an interactive session.

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

Run the full suite — both hosts' transcripts, the Codex wire-shape check, and the
SKILL.md staleness check — with `tests/parity.sh`. After an intentional change, re-record with
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
  "server": "https://mcp.catwrangler.ai",
  "mcp_url": "https://mcp.catwrangler.ai/mcp",
  "org": "pixel-arcade",
  "projects": [
    { "id": "p-841207", "slug": "arcade", "org_slug": "pixel-arcade",
      "name": "Arcade Platform", "description": "…what it is/does…",
      "web_url": "https://pixelarcade-arcade-dev.catwrangler.ai",
      "use_when": "…when work belongs here, in your words…" }
  ]
}
```

Each project's `id` (shaped like `p-841207`) is the server-assigned key the
`/connect` flow passes to `init_session` as its `project_id` parameter to pin the
exact project; `slug`, `org_slug`, `name`, `description`, and `web_url` come from
`list_projects`. Entries written before ids were captured have none and connect by
slug.

Note the two URLs are not the same kind of thing. The top-level `mcp_url` is where
agents connect, and one endpoint answers for every project you can reach — the
`id` is what picks between them. Each project's `web_url` is its own CatWrangler
UI and HTTP API, one host per project. See "The project's web address" below.

### Where it is looked for

Sessions start wherever the work is, so the file is found the way `CLAUDE.md` is:
the current directory, then each parent up to the filesystem root, then the user's
home directory. A session in `repo/src/api` is connected to whatever `repo` is
connected to.

**The nearest one wins, and they do not merge.** A repo's registry replaces the
home one rather than adding to it — this file is a routing menu, and merging would
drop your global projects into every repo session as choices the model has to make
on each task. `~/.catwrangler` is a fallback for directories no project claims,
not a base layer.

Writes follow the same path with one stop short. `add`/`remove` update an
ancestor's file in place — that *is* this workspace's registry, and writing a
second copy into a subdirectory would shadow it. They will not write the home
registry from elsewhere, because it governs every unclaimed directory on the
machine; connecting a project from some unrelated folder creates a `.catwrangler`
*there* instead. To edit the home one, run the command from your home directory
(or pass `--dir`).

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
| `.catwrangler` in a parent, or in `~` | Same as above — it governs this directory. The notice names the file, since it is not where the user is standing |
| No `.catwrangler` anywhere above | One-line notice: not connected here, run `/catwrangler:connect`. Only on real session starts, not `clear`/`compact`. No model instruction (nothing to connect to) |
| `.catwrangler` malformed | User-visible notice naming the file, no crash |
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

One skill manages which projects this workspace is connected to. A project is
**connected** (recorded in `.catwrangler`, so every session started here reaches
it automatically) or **available** (reachable per the server, not set up here
yet). Two states, and that is all there is to it.

```
/catwrangler:connect                 # interactive hub: show state, then connect/disconnect
/catwrangler:connect list            # read-only: show every project and its state
/catwrangler:connect add <slug>      # connect this workspace to a project (available → connected)
/catwrangler:connect remove <slug>   # disconnect it (connected → available; access unaffected)
/catwrangler:connect <slug>          # bare slug — same as `add <slug>`
```

`list` and the bare hub render the same view; `list` just stops there instead of
offering to change anything.

Connecting is something you do to a **workspace**, not to a session. You do it
once; sessions started there open the project on their own afterwards. Nothing
here needs running again unless you want to connect another project or disconnect
one.

Where a session already has a project open, the listing notes it on that row —
`· session active as "swift-otter"`. It is there to answer "what am I attached to
right now", and a connected project with no session is perfectly normal.

The skill drives all server interaction and the `AskUserQuestion` prompts; the
bundled `manage.mjs` owns every `.catwrangler` read/write, so JSON shape,
dedup-by-slug, and unknown-field preservation are deterministic (the model never
hand-edits the file). It does no network I/O.

Each host's skill carries its own copy of that entry point, because each host
names it differently: Claude Code substitutes `${CLAUDE_SKILL_DIR}`, and Codex
takes a path relative to the skill's directory. That second form is easy to
resolve against the plugin root instead — so `scripts/manage.mjs` at the root is
an alias for the same CLI, and the wrong guess costs nothing. All three paths run
one implementation in `lib/`, and the registry they edit is found by hunting from
the working directory, never from the script's own location.

The available half of the listing comes from the server's `list_projects` tool,
which needs no `init_session` — so you can see what exists before connecting
anything. Entries
carry `slug`, `name`, `org_slug`, an optional `description`, and an optional
`web_url`. They carry no *MCP* host, because there is nothing to choose: every
project answers on the one endpoint this plugin already bundles.

Because project slugs are unique only within an organization, `.catwrangler`
entries carry `org_slug`, and `add`/`remove` take `--org` to disambiguate two
orgs' same-named projects.

### Telling two projects apart

Connect a second project and sessions now have a choice to make at startup. Each
entry can carry a **`use_when`** — one line, in your words, saying when work
belongs to that project:

```json
{ "slug": "arcade", "name": "Arcade Platform",
  "description": "Cross-game plane: accounts, coins, leaderboards.",
  "use_when": "anything shared across games — accounts, coins, leaderboards. I call this the platform." }
```

It is separate from `description` deliberately. `description` comes from the
server and says what the project *is*; `use_when` says when to *route* there,
which is often not the same thing — and it is the one field a refresh will never
overwrite, so a note you write by hand stays written.

`/catwrangler:connect` offers to set these the moment a second project makes the
workspace ambiguous, and updates them when you correct a wrong guess — so telling
it "no, that's the racer" fixes the next session too, rather than only this one.
Projects without a `use_when` still work; sessions just fall back to the
description, and ask you when it is genuinely unclear.

### The project's web address

Most of the time you talk to a project through its agent, but not always — some
things are quicker to look at, and some are easier to hit as an HTTP request.
Each entry carries a **`web_url`**: the address of that project's CatWrangler UI
and API.

```json
{ "slug": "arcade", "name": "Arcade Platform",
  "web_url": "https://pixelarcade-arcade-dev.catwrangler.ai" }
```

Connecting records it, and every session started in the workspace afterwards
begins knowing it — so "open the arcade project" or "check that over the API" is
something you can just say, without going to find the address first. In a
workspace with several projects each keeps its own, so the right one comes back.

It does not change how the work gets done: sessions still read code, decisions,
and history through the server's tools, which is the path that respects the
project's gates. The address is for the browser tab and the odd API call.

It comes from the server and is refreshed whenever you connect, so if a project
moves, reconnecting picks up the new address. The plugin never guesses one — a
project whose address the server does not report simply has no `web_url`, and
everything else about it works as before.

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
