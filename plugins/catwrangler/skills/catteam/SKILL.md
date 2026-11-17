---
description: Run CatWrangler work as a team of parallel worker agents, each its own OS process with its own server identity and branch — a working template for multi-agent delegation done right, and for knowing when not to
argument-hint: [optional: the work to run as a team, e.g. "the page-speed fixes" — defaults to the task under discussion]
---
<!-- GENERATED from src/skill-catteam.md for claude — edit the source, then run: node tools/build-skills.mjs -->

The user is offering you a team, not ordering one. This skill is the template for delegating CatWrangler work to parallel worker agents correctly. Whether to use it is **your call**: some work is genuinely better solo, and you should say so plainly when that's true.

## Step 0 — Decide whether a team helps

Team the work when it splits into **independent deliverables** — each worker can own a whole vertical slice (its own decision, its own files-to-read, its own merge) and none needs another's output mid-flight. Good candidates: a punch list of unrelated fixes, the same pattern applied across several pages, a feature whose bands/modules stand alone, an audit fanned out by dimension.

Stay solo when: the work is one tightly-coupled change; it's small enough that briefing a worker costs more than doing it; it needs mid-course conversation with the user; or it's exploratory — you don't yet know what "done" looks like well enough to write a brief. A brief you can't write crisply is the signal the work isn't ready to delegate.

**Split by OUTCOME, never by file.** You have a trained instinct — from git worlds — to partition work so no two agents touch the same file. **Override it here; it produces bad splits.** Different deliverables routinely need the same files (the shared shell, a common helper, the same route module), and that is fine: CatWrangler is built for concurrent agents. Each worker gets its own branch, the merge machinery reconciles simultaneous edits — including same-line — and conflict detection is about *semantic contradiction between decisions*, not file access. Every worker just works, editing whatever its deliverable needs, without knowing or caring who else is in those files. If your draft split has thoughts like "worker B shouldn't touch X because worker A owns it," the split is wrong — recut it by deliverable and let the files fall where they fall.

Before splitting, glance at the newest decisions on the graph (`search_decisions` sort=newest) to see what other agents are already building — that visibility exists so you don't duplicate someone's in-flight *work* (the deliverable, not the files). It informs; it never restricts.

## Step 1 — THE IRON RULE: every worker is its own OS process

**A worker is a separate headless `claude -p` process with its own MCP connection. Nothing else counts.** Not an in-session Agent-tool subagent. Not a Task-tool spawn. Not anything that runs inside YOUR Claude process.

**Why:** CatWrangler identity is **per-connection** (d-753/d-1993). Subagents inside your session share your single MCP connection, so the server gives every "worker" the SAME identity and branch, and a `sandbox_merge` by any of them ships everyone's half-finished work. This happened on 2026-08-10 (atc itch-143). Also never pass `parent_agent_id`: CatTeam workers are independent top-level peers, not sub-agents (parent branches are deleted after every merge).

**The shape that works:** each worker is an ordinary `claude -p` process launched from the connected workspace with the user's normal configuration, so it uses the **installed CatWrangler plugin and its OAuth connection**. Its first action is a bare `init_session` with the project's `project_id`. That call IS the identity mint: the server returns a distinct `agent_id` and branch for that worker (verified 2026-11-17 on Corbo: worker matcha-ade3 got its own id). Workers are peers that merge straight to trunk with **zero coordination with each other**. CatWrangler does the reconciling; that is the product.

## Step 2 — Spawn mechanics

**Authentication is the plugin's job. Hard rules:**
- **Do not pre-mint identities or tokens** in the parent. There is no CatTeam mint endpoint. The old `POST /api/sccs/pull-context` step is retired: on customer projects it requires auth, and with the parent's token it returns the PARENT's identity.
- **Do not pass any bearer** (yours, a worker's, a session token) to a worker. Do not hand-author `mcp.json` files or use `--strict-mcp-config`, which removes the installed plugin.
- **Never read, copy or export OAuth material** (Keychain, browser storage, credential files, another process's token).
- If a worker's normal connection fails or `init_session` does not return a distinct identity, CatTeam is unavailable for that worker: continue solo or report it. Do not invent a workaround.

**Per worker:**
1. Create `/tmp/catteam-<run>/<worker>/prompt.md` (the brief, template below). No credentials go in this folder.
2. Launch every worker of a wave in ONE shell call as a background task, one job per worker with `&`, then `wait`. Use the **absolute path** to `claude` (`which claude` first; background shells lack its PATH). Run from the connected workspace so the plugin config applies:
```
cd "<connected workspace>" && CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
  MCP_TIMEOUT=600000 MCP_TOOL_TIMEOUT=600000 \
  /abs/path/to/claude -p "$(cat /tmp/catteam-<run>/<worker>/prompt.md)" \
  --allowedTools "<CatWrangler tool prefix>*" \
  > /tmp/catteam-<run>/<worker>/out.json 2> /tmp/catteam-<run>/<worker>/err.log &
```
For `<CatWrangler tool prefix>`, copy the prefix your own CatWrangler tools carry in your tool list (it starts with `mcp__plugin_`); scope `--allowedTools` to the CatWrangler tools the worker needs. Do not use `--dangerously-skip-permissions`.
The two MCP timeout variables are load-bearing: without them a blocking `await_job` on a long merge dies at the default transport timeout and the print-mode worker exits early. A worker whose last line says it is "waiting" is dead, not waiting.
3. **Tripwire:** each worker's first report line is its `agent_id`. Collect them and prove they are all distinct, and different from yours, before trusting any concurrent work. If any repeat, stop those workers and report.

### The brief (prompt.md template)

Each brief must be self-contained — the worker has none of your conversation. Adapt this skeleton; the bracketed parts are where briefs are won or lost:

> You are implementing [WHAT] on the [PROJECT] via the installed CatWrangler plugin, following the full gate protocol yourself. Your first action: call `init_session` bare with `project_id: "[p-...]"` (never `parent_agent_id`), then print one line `AGENT_ID=<agent_id>`. Pass your `agent_id` as `_agent_id` on every call. MCP calls sometimes time out but still land server-side — on a timeout, verify state before repeating anything.
>
> THE TASK: [precise scope. Quote the user VERBATIM where their words define success — paraphrase drifts. Name the files you already know matter, the decisions/patterns to follow, the behaviors to preserve, and what is explicitly out of scope.]
>
> VERIFY ASSUMPTIONS FIRST: [what to read or query before designing — table fields, type shapes, whether a helper exists. "The DB/source is the truth; do not trust this brief's line numbers, they drift."]
>
> PROTOCOL, in order: read everything you'll touch → register ONE decision (title ≤100 chars, claim ≤500, summary ≤250; warrant must discuss alternatives; backing cites what you actually read; real falsifiable rebuttal_conditions) → sccs_write_checkout (declare brand-new paths via new_files) → sccs_submit_changes per file with exact-match edits copied from your reads → sandbox_merge → await_job to done:true or terminal failure; fix and re-merge on validation failures. The gate runs type-check and tests for you. To wait on an async job, use the platform's job-follow call re-issued each turn — never a poll loop, never `sleep`.
>
> RECOVERY RECIPES: PRE_MERGE_WC_AUDIT_FAILED naming an uncommitted file = a commit race left your edit in the working copy only — resubmit that file with a tiny comment-wording change so the bytes differ, then re-merge. A merge that reports success with deploy "unverified" is DONE — never re-merge; verify serving via /health or the next natural deploy. If a submit answers ALREADY_APPLIED but the merge audit still flags the file, same tiny-byte-change fix.
>
> YOU ARE A PRINT-MODE PROCESS: when your final message prints, you cease to exist — there are no wake-ups, no background watchers, no notifications. NEVER end your run "waiting" on a job; while a merge/build is running, keep re-issuing the job-follow/peek call in the same session until it reaches a terminal state, then verify, THEN emit your final JSON. A final message that says you are waiting for anything is a failed run.
>
> Your ENTIRE FINAL MESSAGE must be a single JSON object (it lands on stdout as your report): `{ "deliverable": "...", "agent_id": "...", "merged_revision": ..., "what_shipped": "...", "verified": "...", "skipped_and_why": "...", "friction": [{"what": "...", "error_verbatim": "...", "severity": "..."}], "decisions_registered": ["d-.."], "merged": true, "success": true, "follow_ups": ["..."] }` — raw facts over polish, and as much prose in the string fields as the content needs.

Sizing is yours: match worker count to the natural seams of the work, not to a quota. One excellent worker with a complete brief beats three with vague ones.

**Brief workers on outcomes, never on file territory.** Do not write "avoid touching X — another worker owns it" into any brief, and do not enumerate a worker's files as boundaries (name files as *pointers to read first*, not as fences). Do not tell workers about each other at all — no "another agent is building…", no coordination instructions. Each worker edits whatever its deliverable requires; overlapping edits across workers — even to the same lines — are the server's job to reconcile, and it does.

## Step 3 — Shepherd without hovering

- **Completion signal:** a worker's `out.json` turning non-empty. A non-zero exit, an empty `out.json`, or unparseable output = a dead worker (recover below). There are no idle notifications in this shape — the ground truth is the server: `search_decisions` (newest) for its registration, trunk reads for its files, the backlog for its filings, `sccs_status` under its identity for checkout state.
- **Recover a dead worker; don't drop or duplicate its milestone.** Check the server first (it may have registered its decision and committed partial work), then relaunch a fresh process whose brief says to call `init_session` with `reclaim_agent_id: "<dead worker's agent_id>"` and `project_id`, which reattaches the same identity and branch. Tell the relaunch to reuse any decision already registered for the deliverable. **Never run two live processes on one identity.**
- Merges serialize through the server's mutex on their own. Never pace, stagger, or hold workers back to "protect" the server — busy is its designed state.

## Step 4 — Close the loop

When reports arrive: **verify claimed merges against trunk** (read one shipped file, or check the decision's status) before telling the user anything is done. Then report in the user's language — outcomes and consequences, not agent mechanics. File every follow-up a worker surfaced into the backlog immediately so it survives the session, and record anything a worker discovered that future agents will trip on.

Workdirs hold only briefs and reports, no credentials; delete them when you no longer need the reports.

What goes in your report: what's live, what changed for the user, honest caveats (e.g. "verified by tests, not yet eyeballed in a browser"), and the follow-ups now tracked. What stays out: branch names, job ids, retries, and everything else the machinery already absorbed.

