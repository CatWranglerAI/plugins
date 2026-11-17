---
name: catwrangler-catteam
description: Decide whether CatWrangler work benefits from parallel workers, then run ordinary isolated headless Codex processes whose separate MCP connections each call bare init_session and receive distinct peer identities and branches. Use when the user offers a team, asks for CatTeam, requests parallel agents, or a CatWrangler task naturally splits into independent outcomes.
---
<!-- GENERATED from src/skill-catteam.md for codex — edit the source, then run: node tools/build-skills.mjs -->

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

