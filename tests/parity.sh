#!/usr/bin/env bash
#
# Parity harness for the plugin's two entry points.
#
# Everything the plugin actually does lives in lib/, shared by every host. Each
# host adds only a thin adapter. This script exercises one host's adapters
# end-to-end and diffs the transcript against a committed golden, so a change to
# lib/ that shifts behavior shows up as a diff instead of shipping.
#
# It is also the parity check between hosts: run it for each, and the outputs
# must match everywhere the hosts are supposed to agree. Where they legitimately
# differ — Codex cannot create an opening turn, so it emits no
# initialUserMessage — the difference is visible in the diff rather than assumed.
#
#   tests/parity.sh                 # check every host that has adapters
#   tests/parity.sh claude          # check one host
#   tests/parity.sh --update        # re-record goldens after an intended change
#
# Requires Node 18+, the same floor the plugin itself requires.

set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
GOLD="$ROOT/tests/golden"
UPDATE=0
HOSTS=()

for arg in "$@"; do
  case "$arg" in
    --update) UPDATE=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) HOSTS+=("$arg") ;;
  esac
done

# Adapter paths per host: "<manage.mjs> <session-start.mjs>". A host with no
# adapters yet is simply absent here.
adapters() {
  case "$1" in
    claude) echo "skills/connect/scripts/manage.mjs scripts/session-start.mjs" ;;
    codex)  echo "skills-codex/connect/scripts/manage.mjs scripts/session-start-codex.mjs" ;;
    *) return 1 ;;
  esac
}

[ ${#HOSTS[@]} -eq 0 ] && HOSTS=(claude codex)

# Workspace fixtures: one per registry shape the bootstrap branches on.
make_fixtures() {
  local w=$1
  mkdir -p "$w/fix/none" "$w/fix/one" "$w/fix/many" "$w/fix/zero" "$w/fix/bad"
  cat > "$w/fix/one/.catwrangler" <<'EOF'
{"version":1,"server":"https://mcp.catwrangler.ai","mcp_url":"https://mcp.catwrangler.ai/mcp","projects":[{"slug":"arcade","id":"p-841207","org_slug":"pixel","name":"Arcade Platform","description":"Cross-game plane."}]}
EOF
  cat > "$w/fix/many/.catwrangler" <<'EOF'
{"version":1,"server":"https://mcp.catwrangler.ai","projects":[{"slug":"arcade","id":"p-841207","name":"Arcade"},{"slug":"neon","id":"p-773915"},{"slug":"dungeon","description":"cats"},{"slug":"d4"},{"slug":"d5"}]}
EOF
  echo '{"version":1,"projects":[]}' > "$w/fix/zero/.catwrangler"
  echo '{not json'                   > "$w/fix/bad/.catwrangler"
}

# Absolute paths leak into `list` output and fixture arguments, so rewrite the
# scratch dir to a fixed token — otherwise the golden only matches on the
# machine that recorded it.
transcript() {
  local manage=$1 hook=$2 w=$3
  local d="$w/registry"
  rm -rf "$d"; mkdir -p "$d"

  # Registry CRUD: creation, org disambiguation, in-place refresh, the
  # ambiguous-remove refusal, and every error path.
  local specs=(
    "list --dir $d"
    "add --slug solo --dir $d"
    "add --slug arcade --id p-841207 --org pixel --name Arcade --desc Cross-game. --dir $d"
    "add --slug arcade --org neon --dir $d"
    "add --slug arcade --org pixel --name ArcadeV2 --dir $d"
    "list --dir $d"
    "remove --slug arcade --dir $d"
    "remove --slug arcade --org neon --dir $d"
    "remove --slug ghost --dir $d"
    "add --dir $d"
    "frobnicate --dir $d"
    "remove --slug x --dir $w/nonexistent"
  )
  for spec in "${specs[@]}"; do
    echo "--- manage $spec"
    node "$manage" $spec
    echo "exit=$?"
  done
  echo "--- registry file"
  cat "$d/.catwrangler"

  # Bootstrap: every registry shape against every session source.
  for f in none one many zero bad; do
    for src in startup resume clear compact fork; do
      echo "--- hook $f $src"
      echo "{\"cwd\":\"$w/fix/$f\",\"source\":\"$src\",\"hook_event_name\":\"SessionStart\"}" | node "$hook"
      echo "exit=$?"
    done
  done
  echo "--- hook empty stdin";   echo ''         | node "$hook"; echo "exit=$?"
  echo "--- hook garbage stdin"; echo 'not json' | node "$hook"; echo "exit=$?"
}

mkdir -p "$GOLD"
status=0
checked=0

for host in "${HOSTS[@]}"; do
  read -r manage hook <<<"$(adapters "$host")" || { echo "unknown host: $host" >&2; exit 2; }
  if [ ! -f "$manage" ] || [ ! -f "$hook" ]; then
    echo "skip $host — adapters not present yet"
    continue
  fi
  checked=$((checked + 1))

  work=$(mktemp -d)
  make_fixtures "$work"
  out=$(mktemp)
  transcript "$manage" "$hook" "$work" > "$out" 2>&1
  # Normalize the scratch path so the golden is machine-independent.
  sed -i.bak "s#$work#<WORK>#g" "$out" && rm -f "$out.bak"

  if [ "$UPDATE" = "1" ]; then
    cp "$out" "$GOLD/$host.txt"
    echo "recorded $host golden ($(wc -l < "$out" | tr -d ' ') lines)"
  elif [ ! -f "$GOLD/$host.txt" ]; then
    echo "FAIL $host — no golden; run tests/parity.sh --update"
    status=1
  elif diff -q "$GOLD/$host.txt" "$out" > /dev/null; then
    echo "ok   $host"
  else
    echo "FAIL $host"
    diff "$GOLD/$host.txt" "$out" | head -40
    status=1
  fi
  rm -rf "$work" "$out"
done

[ "$checked" = "0" ] && { echo "no hosts checked"; exit 2; }
exit $status
