#!/bin/sh
# SessionStart wrapper for the CatWrangler hook.
#
# The hook itself is Node (session-start.mjs). If Node is missing, invoking it
# directly leaves the user with a bare "node: command not found" (or nothing at
# all) and a session that silently skipped the CatWrangler bootstrap. This
# wrapper turns that into an explicit, actionable notice on the hook's own
# stdout JSON channel:
#
#   systemMessage      → shown to the USER in the transcript
#   additionalContext  → tells the MODEL the bootstrap did not run
#
# It also mirrors each notice to stderr, which is what Claude Code surfaces for
# a failed hook, so the reason is visible under `claude --debug` too.
#
# Always exits 0: a hook failure must never block the session.
#
# Requires a POSIX shell — macOS, Linux, WSL, or Windows with Git for Windows
# (Claude Code runs hooks through Git Bash there).
#
# Shared by every host AND by both hook events. $1 names the Node hook adapter to
# run and $2 the hook event it serves, both defaulting to the Claude Code
# SessionStart case so an existing hooks.json entry keeps working unchanged:
#
#   sh session-start.sh                                            → session-start.mjs (Claude Code)
#   sh session-start.sh session-start-codex.mjs                    → the Codex adapter
#   sh session-start.sh subagent-start.mjs       SubagentStart     → Claude Code, sub-agent spawn
#   sh session-start.sh subagent-start-codex.mjs SubagentStart     → Codex, sub-agent spawn
#
# The event name is not cosmetic. Codex pins hookEventName to a per-event `const`
# in its output schema, so a fallback below that echoed SessionStart into a
# SubagentStart hook would be rejected exactly like an unknown field — and the
# rejection reads as the same opaque parse error, on the path that only runs when
# something is already broken.
#
# Only the adapter differs per host; every notice below is host-neutral.

set -u
EVENT="${2:-SessionStart}"

# Prefer an injected plugin root; hooks resolve relative paths against the
# process working directory, which is the session's cwd, not the plugin's.
# CATWRANGLER_PLUGIN_ROOT is our own override, honored first so a host we have
# not met can be pointed at the right place without a code change. Falling back
# to `dirname "$0"` covers running this by hand and any host that invokes the
# wrapper by its full path — which is the normal case, so the env vars are
# belt-and-braces rather than load-bearing.
# Codex sets PLUGIN_ROOT and CLAUDE_PLUGIN_ROOT; there is no CODEX_PLUGIN_ROOT.
if [ -n "${CATWRANGLER_PLUGIN_ROOT:-}" ]; then
  DIR="$CATWRANGLER_PLUGIN_ROOT/scripts"
elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  DIR="$CLAUDE_PLUGIN_ROOT/scripts"
elif [ -n "${PLUGIN_ROOT:-}" ]; then
  DIR="$PLUGIN_ROOT/scripts"
else
  DIR=$(dirname "$0")
fi
HOOK="$DIR/${1:-session-start.mjs}"

# Emit a hook JSON payload. $1 = user notice, $2 = model context. Both are
# plain prose here (no quotes/backslashes), so literal interpolation is safe.
# additionalContext MUST sit inside hookSpecificOutput with a matching
# hookEventName — at the top level Claude Code ignores it, and the hook looks
# like it worked because systemMessage still reaches the user.
# A literal two-character \n in these strings is exactly what JSON wants, and
# %b (not %s) expands it to a real newline on the stderr copy.
#
# The user notice is carried only by SessionStart. A broken install is worth
# saying loudly, but it is worth saying ONCE: SubagentStart fires per spawn, so a
# fan-out would repeat the same notice ten times under a session that already
# reported it. The sub-agent path keeps the model context — which is per-context
# and therefore not a repeat — and keeps the stderr copy above, so `--debug`
# still shows every occurrence.
emit() {
  printf '%b\n' "$1" >&2
  if [ "$EVENT" = "SessionStart" ]; then
    printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}' "$1" "$EVENT" "$2"
  else
    printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}' "$EVENT" "$2"
  fi
  exit 0
}

NO_NODE_USER='\n\nCatWrangler plugin: Node.js was not found on PATH, so the session bootstrap did not run.\n  - Install Node 18+ (https://nodejs.org, or: brew install node / nvm install --lts), then start a new session.\n  - Until then, connect manually by calling the catwrangler MCP server init_session tool.'
NO_NODE_MODEL="The CatWrangler $EVENT hook could not run because Node.js is not installed on PATH, so the usual workspace bootstrap (project menu + init_session instruction) was skipped. Tell the user Node 18+ is required for the CatWrangler plugin hook. You can still work: call the catwrangler MCP server init_session tool yourself and follow the protocol it returns."

if ! command -v node >/dev/null 2>&1; then
  emit "$NO_NODE_USER" "$NO_NODE_MODEL"
fi

if [ ! -f "$HOOK" ]; then
  emit '\n\nCatWrangler plugin: the session bootstrap script is missing from the plugin directory.\n  - The session bootstrap did not run — reinstall the plugin.' \
       "The CatWrangler $EVENT hook script is missing, so the workspace bootstrap was skipped. Call the catwrangler MCP server init_session tool yourself and follow the protocol it returns."
fi

# Git Bash hands this script POSIX-form paths (`/c/Users/...`). A native
# `node.exe` reads the leading `/` as the current drive root and fails to find
# the script, so convert first. `cygpath` is a Git Bash builtin, absent on
# macOS/Linux, where this is a no-op. Runs after the -f test above, which wants
# the shell's own path form.
if command -v cygpath >/dev/null 2>&1; then
  case "$HOOK" in
    /*) HOOK=$(cygpath -w "$HOOK") ;;
  esac
fi

# Hand stdin (the hook payload) straight through, capturing stdout so a failed
# run can be reported instead of vanishing.
OUT=$(node "$HOOK" 2>/dev/null)
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  emit '\n\nCatWrangler plugin: the session bootstrap hook failed to run under Node.\n  - Node may be too old — Node 18+ is required. Check with: node --version\n  - The session continues without the CatWrangler project menu.' \
       "The CatWrangler $EVENT hook exited with an error, so the workspace bootstrap was skipped. Call the catwrangler MCP server init_session tool yourself and follow the protocol it returns."
fi

# Never hand the host empty stdout: Codex reads it as invalid JSON. The adapters
# already emit `{}` when they have nothing to say; this covers any path that does
# not reach them.
if [ -z "$OUT" ]; then
  OUT='{}'
fi

printf '%s' "$OUT"
exit 0
