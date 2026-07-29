---
description: Manage this workspace's CatWrangler projects — list available, register or remove them in this workspace (.catwrangler), and connect (init_session).
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/manage.mjs" *)
argument-hint: "[list|add|remove|connect] [slug]"
arguments: [verb, slug]
---

# /catwrangler:connect — manage CatWrangler projects for this workspace

You manage which CatWrangler projects this workspace knows about, and can connect
to one. Every project is in one or more of three states:

- **available** — reachable per the server (this user can access it)
- **registered** — recorded in this workspace's `.catwrangler` file (the registry)
- **connected** — you have called `init_session` for it in this session

They stack in that order in the common case, but they are independent: you can
connect to a project that was never registered, and registering one grants no
access it did not already have. Say **registered**, never "listed" — every
project `list` prints is listed, so that word cannot distinguish a state.

Arguments: `$verb` is `list` | `add` | `remove` | `connect`, and `$slug` is the
project slug. Either may be empty — an empty `$verb` means run the interactive
hub, and a verb that needs a slug without one means ask which project.

Currently registered projects in this workspace (`.catwrangler`):
!`node "${CLAUDE_SKILL_DIR}/scripts/manage.mjs" list`

## Dispatch on `$verb`

In the verb sections below, `<slug>` is `$slug` when the user supplied one, and
otherwise the project chosen in the hub or named in conversation.

Both `list` and the no-verb hub render the same thing — **the merged view**:

1. Take the registered projects (injected above).
2. Fetch **available** projects via `list_projects` (see "Listing available") and
   merge, marking each `● connected`, `✓ registered`, or `+ available`. Match on
   slug **and** `org_slug`, and show the org whenever a slug appears twice.

The merged view needs **no** existing connection — render what you can from
`.catwrangler` even with no server access, saying why the available half is
missing. The two verbs differ only in what happens after it is on screen.

**No verb — interactive hub:** render the merged view, then use
`AskUserQuestion` to let the user add one or more available→registered, remove
one or more registered, or connect to one. Carry out the choice via the verbs
below.

**`list`** — render the merged view and **stop**. It is read-only: no
`AskUserQuestion`, no follow-up offer, no changes to `.catwrangler`. A user who
types `list` asked what exists, not what to do about it; if they want to act
they will say so or run the bare hub.

**`add <slug>`** — register in `.catwrangler`, reusing the id/name/description/org
from the available list when you have it:
```
node "${CLAUDE_SKILL_DIR}/scripts/manage.mjs" add --slug "<slug>" --id "<id>" --org "<org_slug>" --name "<name>" --desc "<description>"
```
Pass `--id` whenever `list_projects` gave you one — it is what `connect` later
feeds to `init_session`, so capturing it now is what lets a registered project
connect unambiguously. Pass `--org` too — it is what keeps two orgs'
same-named projects as two entries instead of one overwriting the other. The
response echoes `ambiguous: true` when the registry ends up holding more than one
project with that slug; when it does, show the org next to each.
The script is idempotent (updates in place if already registered). Report the
result.
It fills the file's `server`/`mcp_url` from the endpoint the plugin already
bundles, so do **not** pass `--server`/`--mcp-url` unless the user names a
different server — those flags are an override, and a file created without them
is still complete.

**`remove <slug>`** — unregister from `.catwrangler` only; this does not touch any
live session or server access:
```
node "${CLAUDE_SKILL_DIR}/scripts/manage.mjs" remove --slug "<slug>"
```
If that slug is registered under more than one org the script refuses and names
the orgs rather than guessing; re-run with `--org "<org_slug>"`. Report the result.

**`connect <slug>`** — connect a session **and** register the project so it
persists:

1. Call the `catwrangler` MCP server's `init_session` for that project, passing
   the project's `id` as init_session's `project_id` parameter when you have one
   (from the `.catwrangler` entry or `list_projects`) — that pins the exact project rather
   than relying on a slug the server would have to disambiguate. Fall back to the
   slug only when no id is recorded. Then follow the protocol it returns — remember
   the returned `agent_id` and thread it as `_agent_id` on every later call, keep a
   separate agent_id per instance, and use the server's MCP tools (no local project
   source), exactly as at session start. Connecting does not require the project to
   be registered first.
2. Once `init_session` succeeds, register the project in `.catwrangler` with the
   same idempotent `add` the `add` verb uses, so the next session starts with it
   already registered and the session-start hook connects to it automatically —
   otherwise the first connect vanishes and the following session is surprised to
   find nothing configured:
   ```
   node "${CLAUDE_SKILL_DIR}/scripts/manage.mjs" add --slug "<slug>" --id "<id>"
   ```
   Carry `--id "<id>"`, `--org "<org_slug>"`, `--name "<name>"`, and
   `--desc "<description>"` whenever `list_projects` gave you them (see "Listing
   available") — the `id` is what lets the *next* session connect unambiguously,
   and `--org` keeps two orgs' same-named projects distinct. Skip this step only if
   the user explicitly asked for a one-off connection without registering it; `add`
   is idempotent, so re-registering an already-registered project just refreshes it.

## Listing available projects

Call the `catwrangler` MCP server's **`list_projects`** tool. It takes no
arguments and needs **no `init_session`** — that is the whole point of it, so
reach for it before connecting, not after. It returns:

```json
{ "user": "you@example.com", "count": 3,
  "projects": [
    { "id": "p-841207", "slug": "arcade", "name": "Arcade Platform",
      "org_slug": "pixel-arcade",
      "description": "Cross-game plane: accounts, coins, leaderboards." },
    { "id": "p-773915", "slug": "neon-racer", "name": "Neon Racer",
      "org_slug": "pixel-arcade" },
    { "id": "p-620384", "slug": "dungeon-cats", "name": "Dungeon Cats",
      "org_slug": "pixel-arcade" } ] }
```

- `id` is the server-assigned project id (opaque, shaped like `p-841207` — never
  derive it from the slug). **Carry it into `add`** and it becomes the connection
  key: `connect` feeds it to `init_session` as its `project_id` parameter, which
  pins the exact project without the slug's org-scoping ambiguity. Older servers
  may omit it; connect by slug then.
- `description` is optional — older projects have none. Show the name alone.
- `org_slug` is always present and **must be carried into `add`**: slugs are
  unique only within an org, so two orgs can both have an `arcade`. When the merged
  view shows a duplicated slug, render the org alongside it and ask which.
- There is deliberately no host on an entry. One connector maps to one project
  today, so the list tells the user what exists; it does not by itself let you
  reach another deployment.

If the tool is missing from this server, or returns `PROJECT_LIST_UNAVAILABLE`
(503, the control plane is unreachable), say so plainly and carry on with the
registered half + add/remove/connect, which all work without it. Do **not** present
an empty list as "you have no projects" — a failed lookup and genuinely having none are
different answers, and only the tool's own empty `projects: []` means the latter.

## Rules

- `.catwrangler` is a convenience cache, not the source of truth — the server is
  authoritative for what is reachable. If the user names a project not registered
  here, do not assume it is invalid; connect and let the server confirm.
- Editing `.catwrangler` only changes the local registry; it never grants or revokes
  server access.
- Never guess a connection target. If several registered/available projects
  plausibly match the user's task, ask which.
- `manage.mjs` needs Node. If any invocation fails with `node: command not found`
  (or the injected listing above is a command-not-found error), do not retry or
  hand-edit `.catwrangler`: tell the user the CatWrangler plugin requires Node 18+
  on `PATH` (https://nodejs.org, `brew install node`, or `nvm install --lts`) and
  that the same gap disables the session-start hook. `connect` still works without
  it — it only calls `init_session`.
