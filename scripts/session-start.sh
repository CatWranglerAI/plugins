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

set -u

# Prefer the injected plugin root; hooks resolve relative paths against the
# process working directory, which is the session's cwd, not the plugin's.
# `dirname "$0"` is the fallback for running this script by hand.
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  DIR="$CLAUDE_PLUGIN_ROOT/scripts"
else
  DIR=$(dirname "$0")
fi
HOOK="$DIR/session-start.mjs"

# Emit a hook JSON payload. $1 = user notice, $2 = model context. Both are
# plain prose here (no quotes/backslashes), so literal interpolation is safe.
# additionalContext MUST sit inside hookSpecificOutput with a matching
# hookEventName — at the top level Claude Code ignores it, and the hook looks
# like it worked because systemMessage still reaches the user.
# A literal two-character \n in these strings is exactly what JSON wants, and
# %b (not %s) expands it to a real newline on the stderr copy.
emit() {
  printf '%b\n' "$1" >&2
  printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}' "$1" "$2"
  exit 0
}

NO_NODE_USER='\n\nCatWrangler plugin: Node.js was not found on PATH, so the session bootstrap did not run.\n  - Install Node 18+ (https://nodejs.org, or: brew install node / nvm install --lts), then start a new session.\n  - Until then, connect manually by calling the catwrangler MCP server init_session tool.'
NO_NODE_MODEL='The CatWrangler SessionStart hook could not run because Node.js is not installed on PATH, so the usual workspace bootstrap (project menu + init_session instruction) was skipped. Tell the user Node 18+ is required for the CatWrangler plugin hook. You can still work: call the catwrangler MCP server init_session tool yourself and follow the protocol it returns.'

if ! command -v node >/dev/null 2>&1; then
  emit "$NO_NODE_USER" "$NO_NODE_MODEL"
fi

if [ ! -f "$HOOK" ]; then
  emit '\n\nCatWrangler plugin: session-start.mjs is missing from the plugin directory.\n  - The session bootstrap did not run — reinstall the plugin.' \
       'The CatWrangler SessionStart hook script is missing, so the workspace bootstrap was skipped. Call the catwrangler MCP server init_session tool yourself and follow the protocol it returns.'
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
       'The CatWrangler SessionStart hook exited with an error, so the workspace bootstrap was skipped. Call the catwrangler MCP server init_session tool yourself and follow the protocol it returns.'
fi

printf '%s' "$OUT"
exit 0
