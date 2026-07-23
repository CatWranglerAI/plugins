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
2. Fetch **available** projects via `list_projects` (see "Listing available"), and
   merge — mark each `● connected`, `✓ listed`, or `+ available`. Match on
   slug **and** `org_slug`, and show the org whenever a slug appears twice.
3. Use `AskUserQuestion` to let the user add one or more available→listed, remove
   one or more listed, or connect to one. Then carry out the choice via the verbs
   below. This hub does **not** require an existing connection — show what you can
   from `.catwrangler` even with no server access.

**`list`** — show listed (injected above), then call `list_projects` and show
available with state markers. This needs no connection; if the tool is
unavailable, show listed only and say why.

**`add <slug>`** — add to `.catwrangler`, reusing the name/description/org from
the available list when you have it:
```
node "${CLAUDE_SKILL_DIR}/scripts/manage.mjs" add --slug "<slug>" --org "<org_slug>" --name "<name>" --desc "<description>"
```
Pass `--org` whenever `list_projects` gave you one — it is what keeps two orgs'
same-named projects as two entries instead of one overwriting the other. The
response echoes `ambiguous: true` when the resulting menu has more than one
project with that slug; when it does, show the org next to each.
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
If that slug is listed under more than one org the script refuses and names the
orgs rather than guessing; re-run with `--org "<org_slug>"`. Report the result.

**`connect <slug>`** — connect a session **and** list the project so it persists:

1. Call the `catwrangler` MCP server's `init_session` for that project, then
   follow the protocol it returns — remember the returned `agent_id` and thread it
   as `_agent_id` on every later call, keep a separate agent_id per instance, and
   use the server's MCP tools (no local project source), exactly as at session
   start. Connecting does not require the project to be listed first.
2. Once `init_session` succeeds, add the project to `.catwrangler` with the same
   idempotent `add` the `add` verb uses, so the next session starts with it
   already listed and the session-start hook connects to it automatically —
   otherwise the first connect vanishes and the following session is surprised to
   find nothing configured:
   ```
   node "${CLAUDE_SKILL_DIR}/scripts/manage.mjs" add --slug "<slug>"
   ```
   Carry `--org "<org_slug>"`, `--name "<name>"`, and `--desc "<description>"` too
   whenever `list_projects` gave you them (see "Listing available") — `--org` in
   particular is what keeps two orgs' same-named projects distinct. Skip this step
   only if the user explicitly asked for a one-off connection without listing it;
   `add` is idempotent, so listing an already-listed project just refreshes it.

## Listing available projects

Call the `catwrangler` MCP server's **`list_projects`** tool. It takes no
arguments and needs **no `init_session`** — that is the whole point of it, so
reach for it before connecting, not after. It returns:

```json
{ "user": "you@example.com", "count": 2,
  "projects": [ { "slug": "dev", "name": "CatWrangler dev",
                  "org_slug": "catwrangler", "description": "…" } ] }
```

- `description` is optional — older projects have none. Show the name alone.
- `org_slug` is always present and **must be carried into `add`**: slugs are
  unique only within an org, so two orgs can both have a `dev`. When the merged
  menu shows a duplicated slug, render the org alongside it and ask which.
- There is deliberately no host on an entry. One connector maps to one project
  today, so the list tells the user what exists; it does not by itself let you
  reach another deployment.

If the tool is missing from this server, or returns `PROJECT_LIST_UNAVAILABLE`
(503, the control plane is unreachable), say so plainly and carry on with listed
+ add/remove/connect, which all work without it. Do **not** present an empty
list as "you have no projects" — a failed lookup and genuinely having none are
different answers, and only the tool's own empty `projects: []` means the latter.

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
