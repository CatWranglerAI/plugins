{{#claude}}---
description: Run CatWrangler work as a team of parallel worker agents, each its own OS process with its own server identity and branch — a working template for multi-agent delegation done right, and for knowing when not to
argument-hint: [optional: the work to run as a team, e.g. "the page-speed fixes" — defaults to the task under discussion]
---

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
{{/claude}}{{#codex}}---
name: catwrangler-catteam
description: Decide whether CatWrangler work benefits from parallel workers, then run ordinary isolated headless Codex processes whose separate MCP connections each call bare init_session and receive distinct peer identities and branches. Use when the user offers a team, asks for CatTeam, requests parallel agents, or a CatWrangler task naturally splits into independent outcomes.
---

# CatTeam

The user is offering a team, not requiring one. Use a team only when the work splits into independent deliverables. Say plainly when solo execution is better.

## Decide whether to fan out

Use workers when each can own a complete outcome without needing another worker's result mid-flight. Good candidates include unrelated fixes, a repeated pattern across independent pages, independent feature slices, and audits split by dimension.

Stay solo for one tightly coupled change, small work where briefing costs more than execution, work requiring active user conversation, or exploration whose definition of done is still unclear.

Split by outcome, never by file. CatWrangler supports concurrent branches and overlapping edits, including edits to the same file or line. File boundaries are not ownership boundaries. Before splitting, inspect the newest project decisions so workers do not duplicate an in-flight deliverable.

## Isolation is mandatory

Every worker must be a separate headless `codex exec` OS process with its own normal CatWrangler MCP connection. Each worker calls bare `init_session` itself. That ordinary `init_session` call is the identity-mint step: CatWrangler returns a distinct regular `agent_id` and branch for that peer worker. There is no separate CatTeam worker-mint endpoint.

The `parent_agent_id` field documented by the `init_session` schema belongs to CatWrangler's different, explicit sub-agent provisioning model. CatTeam does not use that model. Never pass `parent_agent_id`; CatTeam workers are independent top-level peers that merge directly to trunk through the normal CatWrangler gate.

An in-session subagent does not qualify because it can share the parent's MCP connection and collapse onto the parent's identity or branch. A shared local working directory is not the problem; the required isolation boundary is a separate Codex process with a separate MCP connection.

After launch, collect each worker's reported `agent_id` and prove they are distinct before trusting concurrent work. If any IDs repeat, stop the affected workers and report the identity failure.

## Authentication boundary — hard rule

The browser/Codex OAuth layer owns CatWrangler authentication. Let it authenticate normal MCP connections automatically.

Never retrieve, inspect, export, copy, or ask the user for underlying OAuth material. This includes macOS Keychain items, browser cookies or storage, OAuth access or refresh tokens, Codex credential files, and another process's bearer. Never invoke `security`, Keychain APIs, browser automation, filesystem inspection, or a manual OAuth refresh to obtain credentials for CatTeam.

Do not pre-mint identities or tokens in the parent process. Do not pass a parent token, worker token, or any bearer to a CatTeam worker. Each ordinary worker process uses the installed CatWrangler plugin and the browser/Codex-managed OAuth path, opens its own MCP connection, and calls bare `init_session` normally.

If a worker's normal authenticated MCP connection is unavailable, or bare `init_session` does not return an isolated identity, CatTeam is unavailable for that worker. Continue the work in the existing MCP session or report that parallel execution could not be started. Do not reinterpret this as a need for a special mint surface, bypass OAuth, fall back to raw credential access, or run a login flow on the user's behalf.

## Prepare each worker

For the target CatWrangler project:

1. Confirm the workspace is already connected to the target project through the installed CatWrangler plugin. Do not hand-author MCP entries or make an HTTP request that needs a parent OAuth bearer.
2. Create `/tmp/catteam-<run>/<worker>/` with `prompt.md` and `report.schema.json` for each unique worker handle such as `<team>-<worker>`.
3. Launch a separate ordinary Codex process for each worker using normal user/plugin configuration. Do not use `--ignore-user-config`, because that removes the installed CatWrangler plugin and its OAuth-managed connection.
4. Require each worker's first CatWrangler action to be its own bare `init_session` call for the exact project. Do not pass `parent_agent_id`.
5. Collect only the returned `agent_id` in the worker report. Do not request, parse, store, or pass session tokens.
6. Verify all reported worker IDs are distinct before accepting parallel results.

The worker needs no local project checkout. CatWrangler source, decisions, builds, and docs remain server-side.

## Launch isolated Codex workers

Resolve the absolute Codex path first with `which codex`. Launch all workers from the connected workspace in one shell operation as background processes and wait for every PID. Use the equivalent of:

```bash
cd "$CATTEAM_WORKSPACE" && \
  /absolute/path/to/codex exec \
    --skip-git-repo-check \
    --ephemeral \
    --approve-for-me \
    --dangerously-bypass-hook-trust \
    -C "$CATTEAM_WORKSPACE" \
    --output-schema /tmp/catteam-<run>/<worker>/report.schema.json \
    --output-last-message /tmp/catteam-<run>/<worker>/out.json \
    - < /tmp/catteam-<run>/<worker>/prompt.md \
      > /tmp/catteam-<run>/<worker>/events.jsonl \
      2> /tmp/catteam-<run>/<worker>/err.log &
```

Each OS process establishes its own MCP connection even though the workers start from the same connected workspace. Normal Codex/plugin configuration is intentional: it is what supplies the browser-managed OAuth connection. The agent must not inspect or copy that credential state.

Use `--dangerously-bypass-approvals-and-sandbox` only when automatic approval is insufficient and the isolated environment has been deliberately reviewed. It is not the default.

## Worker brief

Every `prompt.md` must stand alone because the worker has none of the parent conversation. Include:

- the exact project and outcome;
- the user's relevant words verbatim where they define success;
- decisions, files, types, and patterns to inspect first;
- behavior to preserve and explicit exclusions;
- the required CatWrangler protocol;
- terminal success criteria and the required report schema.

Use this protocol in the brief:

1. Call `init_session` first and bare for the exact target project. This call creates the worker's regular independent identity and branch. Never pass `parent_agent_id`. Use `reclaim_agent_id` only to recover this same worker after a connection/process failure.
2. Pass the returned `agent_id` as `_agent_id` on every later CatWrangler call.
3. Read every source file and decision the change depends on.
4. Register one decision for the deliverable when the gate protocol requires it.
5. Checkout, submit exact-match edits, merge with `sandbox_merge`, and follow the returned job until `done:true` or terminal failure.
6. Fix validation failures and re-merge. On a timeout, inspect server state before repeating a side effect.
7. Verify the claimed merge against trunk and, when applicable, the live HTTP surface.

The worker is a print-mode process. It must never finish by saying it is waiting for a job, notification, or another agent. It continues following the job in the same process until terminal state, then emits its report.

Use a JSON schema requiring these fields:

```json
{
  "deliverable": "string",
  "agent_id": "string",
  "merged_revision": "string or null",
  "what_shipped": "string",
  "verified": "string",
  "skipped_and_why": "string",
  "friction": "array",
  "decisions_registered": "array",
  "merged": "boolean",
  "success": "boolean",
  "follow_ups": "array"
}
```

## Shepherd and recover

- `out.json` containing valid schema-conforming JSON is the completion signal.
- A nonzero exit, missing/empty `out.json`, or invalid report means the worker died.
- Before relaunching, inspect CatWrangler state because the worker may have committed or merged before dying.
- Relaunch a fresh process through normal OAuth and have it call `init_session` with `reclaim_agent_id` set to the failed worker's exact `agent_id`. Tell it to reuse existing decisions and branch state rather than duplicate them.
- Never run two live processes with one identity.
- If normal OAuth plus `reclaim_agent_id` cannot resume the worker, stop that worker. Never recover it by reading Keychain, browser, Codex, or parent-session credentials.
- Do not pace merges to protect the server; CatWrangler's merge mutex handles serialization.

## Close the loop

1. Verify each claimed merge against trunk or the relevant decision status.
2. Verify user-visible behavior when the task requires it.
3. File every concrete follow-up in the backlog immediately.
4. Report outcomes and caveats in the user's language, not process mechanics.
5. Delete temporary prompts, schemas, and process logs after recovery is no longer needed. Keep no credentials or tokens in logs, reports, prompts, or durable docs.

Do not claim success from worker prose alone. The server and live surface are authoritative.
{{/codex}}
