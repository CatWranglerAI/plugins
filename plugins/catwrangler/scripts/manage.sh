#!/bin/sh
# Workspace-management launcher. Runtime selection is shared with hook startup.

set -u

HOST=${1:-}
case "$HOST" in
  claude|codex) shift ;;
  *)
    printf '%s\n' 'CatWrangler plugin: manage.sh requires an explicit claude or codex host.' >&2
    exit 2
    ;;
esac

case "$0" in
  */*) DIR=${0%/*} ;;
  *) DIR=. ;;
esac

if [ ! -f "$DIR/resolve-node.sh" ]; then
  printf '%s\n' 'CatWrangler plugin: the Node.js runtime resolver is missing; reinstall the plugin.' >&2
  exit 1
fi

. "$DIR/resolve-node.sh"
NODE=$(resolve_node "$HOST") || {
  if [ "$HOST" = codex ]; then
    printf '%s\n' 'CatWrangler plugin: no compatible Node.js 18+ runtime was found. Codex Desktop automatically checks its compatible bundled runtime; standalone Codex CLI/IDE may require Node 18+ on PATH. Install Node 18+ or make an existing installation visible to the non-interactive login profile, then retry.' >&2
  else
    printf '%s\n' 'CatWrangler plugin: no compatible Node.js 18+ runtime was found on PATH. Claude Code may require Node 18+; install it or make an existing installation visible to the non-interactive login profile, then retry.' >&2
  fi
  exit 1
}

exec "$NODE" "$DIR/manage.mjs" "$@"
