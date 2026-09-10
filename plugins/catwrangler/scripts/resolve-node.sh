#!/bin/sh
# Shared Node.js resolver for the CatWrangler plugin.
#
# Usage: resolve_node <claude|codex>
# Prints one validated Node 18+ executable path. PATH candidates always win.
# Codex fallback is deliberately bounded to layouts derived from host-supplied
# PATH entries; it never scans, rewrites PATH, or persists a result.

node_is_compatible() {
  node_candidate=$1
  [ -f "$node_candidate" ] && [ -x "$node_candidate" ] || return 1
  node_version=$("$node_candidate" --version 2>/dev/null) || return 1
  case "$node_version" in
    v*) node_version=${node_version#v} ;;
  esac
  node_major=${node_version%%.*}
  case "$node_major" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$node_major" -ge 18 ] 2>/dev/null
}

print_compatible_node() {
  node_candidate=$1
  if node_is_compatible "$node_candidate"; then
    printf '%s\n' "$node_candidate"
    return 0
  fi
  return 1
}

resolve_node() {
  node_host=${1:-}
  node_path=${PATH-}

  # Walk PATH ourselves so a broken or pre-18 first hit cannot hide a later
  # compatible executable. Empty entries are ignored rather than treated as cwd.
  while [ -n "$node_path" ]; do
    case "$node_path" in
      *:*) node_entry=${node_path%%:*}; node_path=${node_path#*:} ;;
      *) node_entry=$node_path; node_path='' ;;
    esac
    [ -n "$node_entry" ] || continue
    for node_name in node node.exe; do
      if print_compatible_node "$node_entry/$node_name"; then
        return 0
      fi
    done
  done

  [ "$node_host" = codex ] || return 1

  # Codex Desktop currently contributes resource roots and dependency override
  # directories to PATH. Derive only the nearby packaged-runtime locations
  # associated with those known layouts. This is best-effort, not a host API.
  node_path=${PATH-}
  while [ -n "$node_path" ]; do
    case "$node_path" in
      *:*) node_entry=${node_path%%:*}; node_path=${node_path#*:} ;;
      *) node_entry=$node_path; node_path='' ;;
    esac
    [ -n "$node_entry" ] || continue

    case "$node_entry" in
      */Resources|*/resources)
        for node_candidate in \
          "$node_entry/cua_node/bin/node" \
          "$node_entry/cua_node/node.exe" \
          "$node_entry/cua_node/bin/node.exe"
        do
          if print_compatible_node "$node_candidate"; then
            return 0
          fi
        done
        ;;
      */dependencies/bin/override|*/dependencies/bin/fallback)
        node_dependencies=${node_entry%/bin/override}
        node_dependencies=${node_dependencies%/bin/fallback}
        for node_candidate in \
          "$node_dependencies/node/bin/node" \
          "$node_dependencies/node/node.exe" \
          "$node_dependencies/node/bin/node.exe"
        do
          if print_compatible_node "$node_candidate"; then
            return 0
          fi
        done
        ;;
    esac
  done

  return 1
}
