{{#claude}}---
description: Manage which CatWrangler projects this workspace is connected to — show what is connected and what is available, and connect or disconnect one.
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/manage.mjs" *)
argument-hint: "[list|add|remove] [slug]"
arguments: [verb, slug]
---{{/claude}}{{#codex}}---
name: catwrangler-connect
description: Manage which CatWrangler projects this workspace is connected to — show what is connected and what is available, and connect or disconnect one. Use when the user asks to connect to CatWrangler, switch projects, see which projects exist, or add/remove a project from this workspace.
---{{/codex}}

# /catwrangler:connect — manage CatWrangler projects for this workspace

You manage which CatWrangler projects this workspace is connected to. A project
is in exactly one of two states:

- **connected** — recorded in the `.catwrangler` that governs this directory, so
  every session started here reaches it automatically
- **available** — this user can reach it per the server, but this directory is
  not set up for it yet

That is the whole model the user needs. Connecting is a property of the
**workspace**, not something they do each session: once a project is connected it
stays connected, and sessions pick it up on their own.

"This workspace" is wider than the current directory. `manage.mjs` hunts for
`.catwrangler` the way Claude finds `CLAUDE.md`: the current directory first,
then each parent, then the user's home directory. The nearest one wins outright —
they do **not** merge, so a repo's registry replaces the home one rather than
adding to it. That is why a session started in `repo/src/api` is connected to
whatever `repo` is connected to, and it is why `list` reports a `path` and a
`scope` (`cwd`, `ancestor`, `home`, or `none`) alongside the projects.

Mention where the file lives only when `scope` is not `cwd`. In the current
directory it is the assumed case and saying it is noise; from a parent or from
home it is the answer to the question the user is about to ask, so give the path
with the result rather than making them ask for it.

Whether *this particular session* has already called `init_session` is a third
fact, and it is diagnostic detail rather than a state. Show it as an annotation
on a connected project (see "Active session"), never as a category of its own. A
user shown three states starts trying to work out which one they are supposed to
reach; there is no such goal, and inventing one is the confusion this command
exists to avoid.

Say **connected** — not "registered", not "listed". Every project `list` prints
is listed, so that word cannot distinguish anything, and "registered" describes
the file rather than what the user gets from it.

This invocation's verb: {{#claude}}`$verb`{{/claude}}{{#codex}}whatever the user asked for{{/codex}} — `list`, `add`, `remove`, or empty. Its
slug: {{#claude}}`$slug`{{/claude}}{{#codex}}the project the user named{{/codex}} — empty when no project was named. An empty verb
means run the interactive hub; a verb that needs a slug and has none means ask
which project.

Two things people type that are not verbs, both of which you should just handle:

- **A bare slug** (`/catwrangler:connect arcade`) means `add arcade`. Naming a
  project is the obvious way to ask for it; do not make them find the verb.
- **`connect`** is an old spelling of `add`. Accept it and do the work. Do not
  correct them, and do not explain that the verb went away — `/catwrangler:connect
  connect` was always redundant, and the fix for that is silence, not a lecture.

**First, read the workspace registry.** Every verb below builds on what it
returns, so run it before anything else:

```
node {{MANAGE}} list
```

{{#codex}}That path is relative to **this skill's own directory** — the `scripts/`
folder sitting beside this `SKILL.md` file, which is a different directory from
the plugin root's `scripts/`. Expand it against wherever you read this file from,
or hand `node` the absolute path.

{{/codex}}It prints one JSON object and needs no network. If it fails for any reason —
`node: command not found`, a non-zero exit, unparseable output — **stop and tell
the user**, per "When manage.mjs fails" below. Do not carry on as though the
workspace were empty: an unreadable registry and an empty one are different
answers, and only `"exists": false` means the latter.

## Dispatch on the verb

In the verb sections below, `<slug>` means the slug for this invocation —
{{#claude}}`$slug` when that is non-empty{{/claude}}{{#codex}}the one the user named{{/codex}}, and otherwise the project chosen in
the hub or named in conversation.

Both `list` and the no-verb hub render the same thing — **the merged view**:

1. Take the connected projects from the `list` command above.
2. Fetch **available** projects via `list_projects` (see "Listing available") and
   merge, marking each `● connected` or `+ available`. Match on slug **and**
   `org_slug`, and show the org whenever a slug appears twice.
3. Show each connected project's `use_when` when it has one — that is the line
   the user reads to check routing is right. See "Telling projects apart".
4. Annotate any project this session has an active `init_session` for — see
   "Active session". Secondary detail, after the state, never instead of it.
5. Show each project's `web_url` when it has one — it is the link the user came
   for on the occasions they want the UI rather than an agent. See "The project's
   web URL".

The merged view needs **no** existing connection — render what you can from
`.catwrangler` even with no server access, saying why the available half is
missing. The two verbs differ only in what happens after it is on screen.

**No verb — interactive hub:** render the merged view, then {{#claude}}use
`AskUserQuestion` to let the user{{/claude}}{{#codex}}ask the user to{{/codex}} connect one or more available projects, or
disconnect one or more connected ones. Carry out the choice via the verbs below.

**`list`** — render the merged view and **stop**. It is read-only: no
{{#claude}}`AskUserQuestion`, no follow-up offer{{/claude}}{{#codex}}follow-up question, no offer to act{{/codex}}, no changes to `.catwrangler`. A user who
types `list` asked what exists, not what to do about it; if they want to act
they will say so or run the bare hub.

**`add <slug>`** — connect this workspace to a project: **available → connected**.
There is no separate "connect" step; this verb is the whole of it, in three parts.

1. **Open it now.** Call the `catwrangler` MCP server's `init_session` for that
   project, passing its `id` as init_session's `project_id` parameter when you have
   one (from the `.catwrangler` entry or `list_projects`) — that pins the exact
   project rather than relying on a slug the server would have to disambiguate.
   Fall back to the slug only when no id is recorded.

   This comes first because it is the step that can fail. If `init_session` errors,
   **stop and report it — do not record the project**: a registry entry for a
   project the server will not open does not fix anything, it just moves the same
   failure into the user's next session. The exception is an explicit ask to record
   a project without opening it (offline, or setting up a workspace for later);
   honour that, and say plainly that it is untested.

2. **Adopt the session protocol below** for the rest of this session. Do not skip
   this because `init_session` already returned: the two are different halves of
   the same setup, and reading the protocol is what makes the connection usable.

3. **Record it**, so this is permanent and no future session has to repeat it:
   ```
   node {{MANAGE}} add --slug "<slug>" --id "<id>" --org "<org_slug>" --name "<name>" --desc "<description>" --web-url "<web_url>" --use-when "<routing note>"
   ```
   Carry `--id`, `--org`, `--name`, `--desc`, and `--web-url` whenever
   `list_projects` gave you them. `--id` is what lets the *next* session open the
   project unambiguously, `--org` is what keeps two orgs' same-named projects as two
   entries instead of one overwriting the other, and `--web-url` is what puts that
   project's UI and HTTP API in front of every future session — see "The project's
   web URL". The response echoes `ambiguous: true` when the file ends
   up holding more than one project with that slug; when it does, show the org next
   to each. The script is idempotent — running it for an already-connected project
   just refreshes the details.

   It fills the file's `server`/`mcp_url` from the endpoint the plugin already
   bundles, so do **not** pass `--server`/`--mcp-url` unless the user names a
   different server — those flags are an override, and a file written without them
   is still complete.

   **It picks the file, and it is not always the one in front of you.** An
   existing registry in a parent directory is updated in place — that is the
   workspace's registry, and dropping a second file into a subdirectory would
   shadow it. The one exception is the home registry: a project connected from
   somewhere else gets a **new** `.catwrangler` in the current directory instead,
   because `~/.catwrangler` governs every unclaimed directory on the machine and
   must not change because of work done in one of them. The response's `path` says
   which file was written; when it is not in the current directory, say so.

   That new file also **takes over** the directory, because nearest wins: the home
   registry's projects stop applying here. Tell the user, and if any of them
   mattered, `add` them here too — this is the one case where connecting a project
   quietly disconnects another.

If this `add` leaves the workspace with **two or more** projects, also settle how
sessions tell them apart — see "Telling projects apart". Do it now, while the user
is here and thinking about it.

Then report the result, and **tell the user it is permanent** — see "Say it is set
up". That is part of the verb, not a flourish on the end of it: skipping it is
what leaves people believing they have to do this again tomorrow.

**`remove <slug>`** — disconnect this workspace from a project: **connected →
available**. It edits `.catwrangler` and nothing else. It does not end a live
session, and it does not touch the user's access — the project goes back to
available, not away. Say that, so nobody reads it as losing something.
```
node {{MANAGE}} remove --slug "<slug>"
```
If that slug is connected under more than one org the script refuses and names the
orgs rather than guessing; re-run with `--org "<org_slug>"`. Report the result.

`remove` edits the same file `add` would, so it too refuses to touch the home
registry from elsewhere — it fails and names the file and the directory to run it
from. Pass that on as it stands: the projects are connected, just not here, and
the fix is to run the command from that directory (or `--dir` it) rather than
anything the user needs to repair.

## Telling projects apart

One connected project needs no disambiguation. Two or more do, every session, and
the session-start bootstrap is where that choice actually gets made — so what is
recorded here is what a future session has to work with.

Each project carries an optional **`use_when`**: one line saying when work belongs
to it, written in the user's own words. It is separate from `description` on
purpose. `description` comes from the server and says *what the project is*;
`use_when` is local and says *when to route here*, which is a different statement
and often not derivable from the first. It is also the only field an idempotent
`add` will not overwrite, so it is safe to keep a hand-written note in.

Two things belong in it, and the second is usually the more valuable:

- **What the project owns** — "anything shared across games: accounts, coins,
  leaderboards".
- **What the user calls it** — "they call this one the racer". The server cannot
  know this, and it is what makes "work on the racer" resolve without a question.

**When the workspace becomes ambiguous** — the `add` that takes it from one project
to two — propose a `use_when` for **both**, not just the new one. Adding the second
project is what made the first one ambiguous; leaving it bare only half-solves the
problem. Draft them from what you know (the descriptions, the org, what the user
just said) and ask the user to confirm or correct rather than making them compose
from nothing. If they would rather not bother, drop it — a `use_when` is worth
having, not worth insisting on. Later `add`s into an already-ambiguous workspace
need one only for the project being added.

**Keep it to one line.** It enters the context of every session started here.
Anything longer is a second CLAUDE.md that nobody is curating.

**Treat corrections as the real source.** When the user redirects you — "no, that's
the racer", "leaderboard work goes to the platform" — that sentence is a better
`use_when` than anything you would have drafted. Record it:
```
node {{MANAGE}} add --slug "<slug>" --use-when "<the corrected rule>"
```
`add` updates in place, and passing only `--slug` and `--use-when` leaves every
other field alone. This is the whole point of the field: a correction that is not
recorded is one the user has to repeat next session, and they will notice.

None of this replaces asking. When two projects still plausibly fit, ask which —
`use_when` exists to make that rare, not to license a guess.

## The project's web URL

Each project has a **`web_url`**: the origin of its CatWrangler UI and HTTP API.
`list_projects` reports it, `add` records it, and the session-start bootstrap puts
it in front of every future session started here. Carry it on every `add` you
have one for — a project connected without it is connected fine, just with the
one thing a session cannot work out for itself missing.

It cannot be derived locally, and this is the whole reason it is stored. The
file's top-level `server`/`mcp_url` name the **MCP** endpoint, which behind the
shared lane is one URL answering for every project; the web surface is one host
per project. So never compose a `web_url` from a slug, a host pattern, or the
MCP URL — take the server's value or leave the field out. A plausible-looking
host that does not exist is worse than none, because it is indistinguishable from
a real one until someone follows it.

**What it is for, and what it is not.** MCP remains how work gets done: source,
decisions, and history come through the server's tools, which are the path
through this project's gates. The URL is for the other occasions — handing the
user a link when they want to look at something in a browser, or reaching an HTTP
endpoint when a task genuinely needs one and no MCP tool covers it. It is not a
second way into the project's contents and never a reason to skip `init_session`.

`add` refreshes it from the server like `--desc`, and unlike `use_when` — the
server owns where the project answers, so a stale local copy is simply wrong.

## Active session

A connected project may or may not have been opened by *this* session — via the
session-start bootstrap, or an `add` you just ran. When it has, note it on that
project's row, after the state:

```
● connected   arcade (Arcade Platform)   · session active as "swift-otter"
              https://pixelarcade-arcade-dev.catwrangler.ai
+ available   neon-racer (Neon Racer)
```

Use the agent name when `init_session` gave you one, the `agent_id` when that is
all you have, and a bare "session active" when neither. Never promote this to a
state of its own, and never let it replace `● connected`: a project is connected
whether or not this session happens to have opened it, and that distinction is the
one the user is actually reading for.

When nothing is open, say nothing — an absent annotation is not a problem to
report. Sessions open projects when there is work to do, and a connected project
with no session is the normal resting state, not a job half done.

## The session protocol

In a workspace that was already connected to a project, these rules arrive
automatically at session start and you never see this section. `add` is the case
where they do not — the workspace had nothing connected when the session began,
so no bootstrap ran. **That is now — adopt them here, and hold to them for the
rest of the session:**

{{PROTOCOL}}

## Say it is set up

Once `add` succeeds, the workspace is connected for good, and saying so is part
of the job — not a nicety appended to it:

{{NO_RECONNECT}}

Put it in your own words, briefly, as part of reporting the result. Nothing in an
ordinary session will confirm it later — the hook is silent when it works — so
the moment they just ran the command is the only good moment to say it.

## Listing available projects

Call the `catwrangler` MCP server's **`list_projects`** tool. It takes no
arguments and needs **no `init_session`** — that is the whole point of it, so
reach for it before connecting, not after. It returns:

```json
{ "user": "you@example.com", "count": 3,
  "projects": [
    { "id": "p-841207", "slug": "arcade", "name": "Arcade Platform",
      "org_slug": "pixel-arcade",
      "description": "Cross-game plane: accounts, coins, leaderboards.",
      "web_url": "https://pixelarcade-arcade-dev.catwrangler.ai" },
    { "id": "p-773915", "slug": "neon-racer", "name": "Neon Racer",
      "org_slug": "pixel-arcade",
      "web_url": "https://pixelarcade-neon-racer-dev.catwrangler.ai" },
    { "id": "p-620384", "slug": "dungeon-cats", "name": "Dungeon Cats",
      "org_slug": "pixel-arcade" } ] }
```

- `id` is the server-assigned project id (opaque, shaped like `p-841207` — never
  derive it from the slug). **Carry it into `add`** and it becomes the connection
  key: `add` feeds it to `init_session` as its `project_id` parameter, which pins
  the exact project without the slug's org-scoping ambiguity. Older servers may
  omit it; connect by slug then.
- `description` is optional — older projects have none. Show the name alone.
- `org_slug` is always present and **must be carried into `add`**: slugs are
  unique only within an org, so two orgs can both have an `arcade`. When the merged
  view shows a duplicated slug, render the org alongside it and ask which.
- `web_url` is that project's CatWrangler UI and HTTP API origin — see "The
  project's web URL". Optional: a server predating it omits it, and so does an
  entry whose host the server cannot state.
- There is deliberately no **MCP** host on an entry, and `web_url` is not one.
  Every project answers MCP on the single URL this plugin already bundles, and the
  `id` is what selects between them; the web origin is per-project, which is why it
  is carried and the MCP host is not.

If the tool is missing from this server, or returns `PROJECT_LIST_UNAVAILABLE`
(503, the control plane is unreachable), say so plainly and carry on with the
connected half + add/remove, which all work without it. Do **not** present
an empty list as "you have no projects" — a failed lookup and genuinely having none are
different answers, and only the tool's own empty `projects: []` means the latter.

## Rules

- `.catwrangler` is a convenience cache, not the source of truth — the server is
  authoritative for what is reachable. If the user names a project that is not
  connected here, do not assume it is invalid; open it and let the server confirm.
- Editing `.catwrangler` only changes which projects this workspace is connected
  to; it never grants or revokes the user's access on the server.
- Never guess a connection target. If several connected/available projects
  plausibly match the user's task, ask which.

## When manage.mjs fails

A failed `manage.mjs` call is **never** something to swallow. The user ran this
command and is waiting on an answer; silence reads to them as the plugin being
broken with no explanation. Say what failed and what they can do, every time:

- **`node: command not found`** — the plugin requires Node 18+ on `PATH`. Point
  them at https://nodejs.org, `brew install node`, or `nvm install --lts`, and
  tell them the same gap disables the session-start hook, so this is worth fixing
  once rather than working around. You can still open a project for them in the
  meantime — `init_session` is an MCP call and needs no Node — it just will not
  stick past this session.
- **`<path> is not valid JSON`** — the file is corrupt, so this workspace cannot
  say what it is connected to. The error names the file; show them that path and
  offer to rebuild it by connecting their projects again. Read the path before you
  paraphrase — the hunt means it may be a parent directory's file, or the home
  one, and telling someone their current directory is broken sends them looking in
  the wrong place. Do not hand-edit it, and do not delete it without asking.
- **Anything else** — report the error text verbatim and stop.

Recovering the answer another way is welcome as long as you still report the
problem — if you can find a working `node` at an absolute path, use it and say
what you did. What is forbidden is the silent workaround, and one specific loud
one: never hand-edit `.catwrangler`. It is the file `manage.mjs` exists to own,
and writing it by hand while the script is failing is how a workspace ends up
with a registry no version of the plugin agrees with.

In every case the other half of the skill still works: `list_projects` and
`init_session` are MCP calls with no Node involved, so you can usually still show
the user what projects exist and open one for them, even when `.catwrangler` is
unreachable. Do that, and be explicit about which half failed — they got a working
session, but the workspace did not record it, so the next session will not have
it.
