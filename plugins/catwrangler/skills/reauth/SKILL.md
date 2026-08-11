---
description: Restore CatWrangler MCP authentication after terminal OAuth expiry.
allowed-tools: Bash(command -v claude) Bash(claude mcp login plugin:catwrangler:catwrangler)
---
<!-- GENERATED from src/skill-reauth.md for claude — edit the source, then run: node tools/build-skills.mjs -->

# /catwrangler:reauth — restore terminal MCP authentication

Use this skill only after CatWrangler MCP reports terminal OAuth expiry, such as `credential_expired` or `invalid_grant`, and normal `reclaim_agent_id` recovery did not repair it. Do not run it at SessionStart, for an ordinary `AUTH_REQUIRED` response, or for a transient/retryable failure.

Resolve this host's CLI executable on `PATH`; do not assume a hard-coded installation path. If it is not found, stop and tell the user which CLI is missing.

Run:

```
<resolved-claude-path> mcp login plugin:catwrangler:catwrangler
```


The command may open a browser. The agent starts the command itself; ask the human only to complete the browser sign-in. Once the command succeeds, retry the failed MCP operation. If login fails or the browser step is not completed, report the failure and do not create a new CatWrangler identity as a workaround.
