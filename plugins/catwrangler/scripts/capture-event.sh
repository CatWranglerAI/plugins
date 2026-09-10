#!/bin/sh
# Per-event capture hook for the CatWrangler activity feed (cw:d-3731).
#
# Wired as PostToolUse (matcher-scoped to CatWrangler MCP tools) and Stop on
# both hosts: sh "$ROOT/scripts/capture-event.sh" <host> <event>. The
# PostToolUse matcher is the workspace guard — it only ever fires when a
# CatWrangler tool actually ran (handoff B1). Stop fires on every turn, so its
# payload spools whenever capture is on and the daemon's correlation guard
# decides what becomes a voice event (cw:d-3767).
#
# This script is deliberately dumb (handoff B3): one flag-file test, one
# verbatim write of stdin into a one-file-per-event spool (maildir pattern —
# no append contention, safe accumulation while the daemon is down), and a
# cheap daemon ensure. All parsing, normalization, consent nuance, credential
# handling, and upload live in the Node daemon, which is NEVER awaited here.
#
# Consent (capture-at-source): with the flag file absent, nothing is written.
# The one exception is an init_session event, which is handed to the daemon IN
# MEMORY (stdin pipe, no disk) so consent can be re-evaluated by code that can
# read .catwrangler — if consent is off there too, the daemon discards it and
# writes nothing.
#
# Always exits 0 and always prints '{}': a capture failure must never block
# the session, and Codex rejects empty hook stdout as a parse error.

set -u
HOST="${1:-claude}"
EVENT="${2:-PostToolUse}"
STATE="${CATWRANGLER_ACTIVITY_DIR:-$HOME/.catwrangler/activity}"

# Same plugin-root resolution as session-start.sh: injected roots first,
# dirname fallback for hand-runs and full-path invocation.
if [ -n "${CATWRANGLER_PLUGIN_ROOT:-}" ]; then
  DIR="$CATWRANGLER_PLUGIN_ROOT/scripts"
elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  DIR="$CLAUDE_PLUGIN_ROOT/scripts"
elif [ -n "${PLUGIN_ROOT:-}" ]; then
  DIR="$PLUGIN_ROOT/scripts"
else
  DIR=$(dirname "$0")
fi

done_ok() { printf '{}'; exit 0; }

# Stop: request a prompt drain. The payload does NOT stop here — it continues
# into the spool below, carrying the turn-final assistant text the tool-scoped
# transcript tail cannot see (cw:d-3767).
if [ "$EVENT" = "Stop" ] && [ -f "$STATE/capture-enabled" ]; then
  : > "$STATE/flush-requested" 2>/dev/null || :
fi

# Read stdin once; JSON payloads carry no NULs, and the trailing newline
# command substitution strips is not part of the event.
PAYLOAD=$(cat 2>/dev/null || :)
[ -n "$PAYLOAD" ] || done_ok

# Ignition detection is a substring sniff, so scope it to PostToolUse: a Stop
# payload can mention init_session inside the assistant's own text.
IS_INIT=0
if [ "$EVENT" = "PostToolUse" ]; then
  case "$PAYLOAD" in
    *init_session*) IS_INIT=1 ;;
  esac
fi

ENABLED=0
[ -f "$STATE/capture-enabled" ] && ENABLED=1

if [ "$ENABLED" = 1 ]; then
  umask 077
  mkdir -p "$STATE/incoming" 2>/dev/null || done_ok
  # epoch-pid is unique (each hook invocation is its own process); the host
  # suffix lets the daemon stamp client provenance without guessing.
  printf '%s\n' "$PAYLOAD" > "$STATE/incoming/$(date +%s)-$$-$HOST.json" 2>/dev/null || :
fi

# Daemon ensure. init_session is the ignition point (project, agent, and the
# bootstrap grant are all in that one tool_response) and consent may have
# changed, so it always spawns; otherwise only revive a dead daemon when
# capture is on. kill -0 on a stale pidfile is the cheap liveness probe.
NEED=0
if [ "$IS_INIT" = 1 ]; then
  NEED=1
elif [ "$ENABLED" = 1 ]; then
  DPID=$(cat "$STATE/daemon.pid" 2>/dev/null || :)
  if [ -z "$DPID" ] || ! kill -0 "$DPID" 2>/dev/null; then NEED=1; fi
fi

if [ "$NEED" = 1 ] && [ -f "$DIR/resolve-node.sh" ] && [ -f "$DIR/activity-daemon.mjs" ]; then
  . "$DIR/resolve-node.sh"
  if NODE=$(resolve_node "$HOST"); then
    # Windows Git Bash hands POSIX paths to a native node.exe (see
    # session-start.sh); convert where cygpath exists.
    DAEMON="$DIR/activity-daemon.mjs"
    if command -v cygpath >/dev/null 2>&1; then
      case "$DAEMON" in /*) DAEMON=$(cygpath -w "$DAEMON") ;; esac
    fi
    if [ "$IS_INIT" = 1 ]; then
      # Ignite: payload rides the pipe, never the disk, so a consent-off
      # workspace stays clean. Everything is detached and redirected — a child
      # holding the hook's stdout would make the host wait for EOF.
      ( printf '%s' "$PAYLOAD" | "$NODE" "$DAEMON" ignite ) >/dev/null 2>&1 &
    else
      ( "$NODE" "$DAEMON" ensure </dev/null ) >/dev/null 2>&1 &
    fi
  fi
fi

done_ok
