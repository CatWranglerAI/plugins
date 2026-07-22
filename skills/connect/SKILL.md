---
description: Manage this workspace's CatWrangler projects — list available, add or remove them from this workspace (.catwrangler), and connect (init_session).
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/manage.mjs" *)
argument-hint: "[list|add|remove|connect] [slug]"
arguments: [verb, slug]
---

# /catwrangler:connect — manage CatWrangler projects for this workspace

You manage which CatWrangler projects this workspace knows about, and can connect
to one. Every project is in one or more of three states:

- **listed** — present in this workspace's `.catwrangler` file (the local menu)
- **available** — reachable per the server (this user can access it)
- **connected** — you have called `init_session` for it in this session

Arguments: `$verb` is `list` | `add` | `remove` | `connect`, and `$slug` is the
project slug. Either may be empty — an empty `$verb` means run the interactive
hub, and a verb that needs a slug without one means ask which project.

Currently listed projects in this workspace (`.catwrangler`):
!`node "${CLAUDE_SKILL_DIR}/scripts/manage.mjs" list`

## Dispatch on `$verb`

In the verb sections below, `<slug>` is `$slug` when the user supplied one, and
otherwise the project chosen in the hub or named in conversation.

**No verb — interactive hub:**
1. Show the listed projects (injected above) with their state.
2. Fetch **available** projects if you can (see "Listing available"), and merge —
   mark each `● connected`, `✓ listed`, or `+ available`.
3. Use `AskUserQuestion` to let the user add one or more available→listed, remove
   one or more listed, or connect to one. Then carry out the choice via the verbs
   below. This hub does **not** require an existing connection — show what you can
   from `.catwrangler` even with no server access.

**`list`** — show listed (injected above). If connected, also show available with
state markers. Never require a connection: with none, show listed only and note
that available-listing needs the server.

**`add <slug>`** — add to `.catwrangler`, reusing the name/description from the
available list when you have it:
```
node "${CLAUDE_SKILL_DIR}/scripts/manage.mjs" add --slug "<slug>" --name "<name>" --desc "<description>"
```
The script is idempotent (updates in place if already listed). Report the result.
It fills the file's `server`/`mcp_url` from the endpoint the plugin already
bundles, so do **not** pass `--server`/`--mcp-url` unless the user names a
different server — those flags are an override, and a file created without them
is still complete.

**`remove <slug>`** — delist from `.catwrangler` only; this does not touch any live
session or server access:
```
node "${CLAUDE_SKILL_DIR}/scripts/manage.mjs" remove --slug "<slug>"
```
Report the result.

**`connect <slug>`** — connect a session: call the `catwrangler` MCP server's
`init_session` for that project, then follow the protocol it returns — remember the
returned `agent_id` and thread it as `_agent_id` on every later call, keep a
separate agent_id per instance, and use the server's MCP tools (no local project
source), exactly as at session start. Connecting does not require the project to be
listed first.

## Listing available projects

Fetch the projects this user can reach from the server.

**Current limitation:** there is not yet a dedicated MCP tool that returns the
reachable-project menu without a session — that lands with the ATC projects
endpoint / `init_session` menu (`atc:d-819`). Until then: if you are already
connected, use what `init_session` returned; otherwise tell the user that
available-listing needs that server endpoint, and proceed with listed +
add/remove/connect, which all work today.

## Rules

- `.catwrangler` is a convenience cache, not the source of truth — the server is
  authoritative for what is reachable. If the user names a project not listed here,
  do not assume it is invalid; connect and let the server confirm.
- Editing `.catwrangler` only changes the local menu; it never grants or revokes
  server access.
- Never guess a connection target. If several listed/available projects plausibly
  match the user's task, ask which.
- `manage.mjs` needs Node. If any invocation fails with `node: command not found`
  (or the injected listing above is a command-not-found error), do not retry or
  hand-edit `.catwrangler`: tell the user the CatWrangler plugin requires Node 18+
  on `PATH` (https://nodejs.org, `brew install node`, or `nvm install --lts`) and
  that the same gap disables the session-start hook. `connect` still works without
  it — it only calls `init_session`.
