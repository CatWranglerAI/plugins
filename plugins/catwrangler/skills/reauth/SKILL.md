---
description: Restore CatWrangler MCP authentication after terminal OAuth expiry, including from a phone when this machine's browser is out of reach.
allowed-tools: Bash(command -v claude) Bash(claude mcp login plugin:catwrangler:catwrangler) Bash(sh "${CLAUDE_SKILL_DIR}/../../scripts/remote-login.sh" claude *)
argument-hint: "[remote]"
arguments: [mode]
---
<!-- GENERATED from src/skill-reauth.md for claude — edit the source, then run: node tools/build-skills.mjs -->

# /catwrangler:reauth — restore terminal MCP authentication

Use this skill only after CatWrangler MCP reports terminal OAuth expiry, such as `credential_expired` or `invalid_grant`, and normal `reclaim_agent_id` recovery did not repair it. Do not run it at SessionStart, for an ordinary `AUTH_REQUIRED` response, or for a transient/retryable failure.

If this invocation's mode, `$mode`, is `remote`, or the human asks to sign in from their phone, go straight to "Signing in from a phone" below.

Resolve this host's CLI executable on `PATH`; do not assume a hard-coded installation path. If it is not found, stop and tell the user which CLI is missing.

Run:

```
<resolved-claude-path> mcp login plugin:catwrangler:catwrangler
```


The command may open a browser. The agent starts the command itself; ask the human only to complete the browser sign-in. The login requires an interactive terminal: if the command fails immediately with something like `stdin isn't a terminal`, this harness has no TTY — give the human the exact command to run in their own terminal, and continue once they report it succeeded. If the human cannot reach this machine's browser or terminal (for example, they are driving this session remotely), use "Signing in from a phone" below instead. Once the command succeeds, retry the failed MCP operation. If login fails or the browser step is not completed, report the failure and do not create a new CatWrangler identity as a workaround.

## Signing in from a phone

This works on macOS and Linux; on Windows, only the standard login above is available. The host's own login command still runs on this machine and saves the credential; the human approves the sign-in on their phone, and a helper passes that approval back to the login command.

1. Start the sign-in:

   ```
   sh "${CLAUDE_SKILL_DIR}/../../scripts/remote-login.sh" claude start
   ```

   It finishes within a minute and prints one line.
   - `CW_LOGIN_ACTION: …`: send the human everything after `CW_LOGIN_ACTION: `, exactly as written, as a message of its own. It asks them to open a link and check a four-character confirmation code. Do not shorten, reformat or summarize the link.
   - `CW_LOGIN_FAILED: …`: go to step 4.

2. Wait for the approval:

   ```
   sh "${CLAUDE_SKILL_DIR}/../../scripts/remote-login.sh" claude wait
   ```

   Each run waits up to 100 seconds and prints one line.
   - `CW_LOGIN_PENDING: …`: the sign-in has not been approved yet. Run `wait` again. Do not run `start` again: that makes the link you already sent useless. The approval window is about 10 minutes.
   - `CW_LOGIN_DONE: …`: go to step 3.
   - `CW_LOGIN_FAILED: …`: go to step 4.

3. Retry the failed MCP operation. This session picks up the new credential by itself, with no restart. If it still fails with the same expiry, tell the human and suggest they restart this session.

4. If the sign-in fails, tell the human what the line says, including the standard login command it names. Do not create a new CatWrangler identity, and do not try another way to sign in.
