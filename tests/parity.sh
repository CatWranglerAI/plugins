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
# must match everywhere the hosts are supposed to agree — which, since the
# plugin dropped its injected opening turn, is everywhere. The two goldens are
# byte-identical in their hook sections; `diff tests/golden/*.txt` is the check,
# and any host-specific behavior that creeps back in shows up there.
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
#
# Two homes, because the hunt ends at the home directory and the fixtures need
# both answers: `home-empty` is the machine where nothing is connected globally
# (so a directory with no registry above it really is unconnected), `home-reg`
# holds one (so the home fallback fires). Every invocation below sets HOME to one
# of them — never the real one, or the goldens would record whether the person
# running the suite happens to have a ~/.catwrangler.
make_fixtures() {
  local w=$1
  mkdir -p "$w/home-empty" "$w/home-reg"
  echo '{"version":1,"server":"https://mcp.catwrangler.ai","projects":[{"slug":"global","id":"p-000001","name":"Global"}]}' > "$w/home-reg/.catwrangler"
  # Ancestor hunt: the registry is at fix/nested, the session starts three deep.
  mkdir -p "$w/fix/nested/src/api/handlers"
  cat > "$w/fix/nested/.catwrangler" <<'EOF'
{"version":1,"server":"https://mcp.catwrangler.ai","projects":[{"slug":"arcade","id":"p-841207","org_slug":"pixel","name":"Arcade Platform","description":"Cross-game plane."}]}
EOF
  mkdir -p "$w/fix/none" "$w/fix/one" "$w/fix/many" "$w/fix/zero" "$w/fix/bad" "$w/fix/routed"
  cat > "$w/fix/one/.catwrangler" <<'EOF'
{"version":1,"server":"https://mcp.catwrangler.ai","mcp_url":"https://mcp.catwrangler.ai/mcp","projects":[{"slug":"arcade","id":"p-841207","org_slug":"pixel","name":"Arcade Platform","description":"Cross-game plane.","web_url":"https://pixel-arcade-dev.catwrangler.ai"}]}
EOF
  # `many` deliberately carries NO web_url on any entry: it is the fixture that
  # proves the bootstrap stays silent about web URLs when nothing has one,
  # rather than emitting the explanatory paragraph unconditionally.
  cat > "$w/fix/many/.catwrangler" <<'EOF'
{"version":1,"server":"https://mcp.catwrangler.ai","projects":[{"slug":"arcade","id":"p-841207","name":"Arcade"},{"slug":"neon","id":"p-773915"},{"slug":"dungeon","description":"cats"},{"slug":"d4"},{"slug":"d5"}]}
EOF
  # Two projects with local routing notes, one without: the disambiguation path,
  # including how it degrades for an entry that never got a use_when. The same
  # fixture covers web_url's mixed case — two entries have one and `plain` does
  # not, so the per-project line has to be conditional while the explanatory
  # paragraph still fires once for the workspace.
  cat > "$w/fix/routed/.catwrangler" <<'EOF'
{"version":1,"server":"https://mcp.catwrangler.ai","projects":[{"slug":"arcade","id":"p-841207","name":"Arcade","description":"Cross-game plane.","use_when":"coins, accounts, leaderboards — anything shared across games","web_url":"https://pixel-arcade-dev.catwrangler.ai"},{"slug":"neon","id":"p-773915","use_when":"the racing game itself; they call it \"the racer\"","web_url":"https://pixel-neon-dev.catwrangler.ai"},{"slug":"plain","id":"p-620384"}]}
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
  # Default for everything below; the home-fallback cases override it inline.
  # The hunt reads HOME, so leaving the real one in place would record the
  # runner's own ~/.catwrangler (or absence of one) in the golden.
  export HOME="$w/home-empty"
  # Same hazard from the other side: the Claude adapter falls back to
  # CLAUDE_PROJECT_DIR when a payload carries no cwd, and running this suite from
  # inside a Claude Code session would supply one.
  unset CLAUDE_PROJECT_DIR

  # Registry CRUD: creation, org disambiguation, in-place refresh, the
  # ambiguous-remove refusal, and every error path. The three solo adds after the
  # first are the survival check for the fields set one at a time — set use_when,
  # then web_url, then refresh the entry with NEITHER flag; the final registry
  # dump proves an add that omits a field does not clear it.
  local specs=(
    "list --dir $d"
    "add --slug solo --dir $d"
    "add --slug solo --use-when shared-plumbing --dir $d"
    "add --slug solo --web-url https://solo-dev.catwrangler.ai --dir $d"
    "add --slug solo --name SoloV2 --dir $d"
    "add --slug arcade --id p-841207 --org pixel --name Arcade --desc Cross-game. --web-url https://pixel-arcade-dev.catwrangler.ai --dir $d"
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

  # The hunt, on the write side. What matters here is not that `list` finds a
  # parent's registry but that `add` UPDATES it instead of shadowing it with a
  # second file three directories down — so the file listing is the assertion.
  local h="$w/hunt"
  rm -rf "$h"; mkdir -p "$h/repo/src/api" "$h/loose" "$h/loose2"
  echo '{"version":1,"projects":[{"slug":"repo-proj","id":"p-500001"}]}' > "$h/repo/.catwrangler"
  for spec in \
    "list --dir $h/repo/src/api" \
    "add --slug deep --dir $h/repo/src/api" \
    "remove --slug deep --dir $h/repo/src/api" \
    "list --dir $h/loose"
  do
    echo "--- hunt $spec"
    node "$manage" $spec
    echo "exit=$?"
  done

  # Same commands with a home registry in scope: it is READ from anywhere, and
  # never written from anywhere but itself — `add` lands in cwd, `remove` refuses
  # and says where the projects actually live.
  for spec in \
    "list --dir $h/loose" \
    "add --slug fromhome --dir $h/loose" \
    "remove --slug global --dir $h/loose2" \
    "list --dir $w/home-reg" \
    "remove --slug global --dir $w/home-reg"
  do
    echo "--- hunt(home) $spec"
    HOME="$w/home-reg" node "$manage" $spec
    echo "exit=$?"
  done
  echo "--- hunt files"
  find "$h" -name .catwrangler | sort

  # Bootstrap: every registry shape against every session source.
  for f in none one many routed zero bad; do
    for src in startup resume clear compact fork; do
      echo "--- hook $f $src"
      echo "{\"cwd\":\"$w/fix/$f\",\"source\":\"$src\",\"hook_event_name\":\"SessionStart\"}" | node "$hook"
      echo "exit=$?"
    done
  done
  # Bootstrap through the hunt. A session three directories inside a configured
  # repo must produce the connected bootstrap, not the not-connected nudge — the
  # whole reason the hunt exists.
  for src in startup clear; do
    echo "--- hook nested-subdir $src"
    echo "{\"cwd\":\"$w/fix/nested/src/api/handlers\",\"source\":\"$src\",\"hook_event_name\":\"SessionStart\"}" | node "$hook"
    echo "exit=$?"
  done

  # Home fallback: the SAME directory that reports not-connected above, run on a
  # machine whose home directory has a registry. The diff between these two is
  # the fallback's entire behavior.
  for src in startup clear; do
    echo "--- hook home-fallback $src"
    echo "{\"cwd\":\"$w/fix/none\",\"source\":\"$src\",\"hook_event_name\":\"SessionStart\"}" | HOME="$w/home-reg" node "$hook"
    echo "exit=$?"
  done
  # A directory with its own registry ignores the home one — nearest wins, no merge.
  echo "--- hook nearest-wins startup"
  echo "{\"cwd\":\"$w/fix/one\",\"source\":\"startup\",\"hook_event_name\":\"SessionStart\"}" | HOME="$w/home-reg" node "$hook"
  echo "exit=$?"

  # No usable payload: cwd is the fallback, so run these from a fixture rather
  # than the repo — otherwise the hunt walks the checkout's real ancestors and
  # the golden records whatever happens to be above it on this machine.
  echo "--- hook empty stdin";   (cd "$w/fix/none" && echo ''         | node "$ROOT/$hook"); echo "exit=$?"
  echo "--- hook garbage stdin"; (cd "$w/fix/none" && echo 'not json' | node "$ROOT/$hook"); echo "exit=$?"
}

mkdir -p "$GOLD"
status=0
checked=0

# Both SKILL.md files are generated from src/skill-connect.md. Editing a
# generated copy directly would survive review and ship, so the staleness check
# runs as part of the suite rather than on the honor system.
if [ "$UPDATE" = "1" ]; then
  node tools/build-skills.mjs > /dev/null && echo "ok   skills (regenerated)"
else
  if node tools/build-skills.mjs --check > /dev/null 2>&1; then
    echo "ok   skills"
  else
    echo "FAIL skills — generated SKILL.md is out of sync with src/skill-connect.md"
    node tools/build-skills.mjs --check 2>&1 | grep STALE
    status=1
  fi
fi

# All three manifests carry the version, and an installed copy reports whichever
# one its host read. A bump that updated some of them and not others would ship a
# plugin that misreports itself, so VERSION is the single source and the manifests
# are checked against it here.
if [ "$UPDATE" = "1" ]; then
  node tools/sync-version.mjs > /dev/null && echo "ok   version (synced)"
else
  if node tools/sync-version.mjs --check > /dev/null 2>&1; then
    echo "ok   version"
  else
    echo "FAIL version — a manifest disagrees with VERSION"
    node tools/sync-version.mjs --check 2>&1 | grep -E 'STALE|sync-version:'
    status=1
  fi
fi

# The goldens prove the adapters match their recorded behavior; they say nothing
# about whether a host will ACCEPT it. Codex validates hook stdout strictly, so
# the wire shape is checked against its schema separately.
if node tests/codex-wire.mjs; then :; else status=1; fi

# scripts/manage.mjs is the plugin-root alias, there because agents resolve the
# skill's relative path against the root and land on it. Nothing below covers it
# — the golden transcripts run each host's own skill-directory entry point — so
# it is exactly the file that rots unnoticed when lib/ moves. Check the one thing
# it promises: same command, same bytes, same exit code as the real entry point.
alias_check() {
  local d out_a out_b rc_a rc_b
  d=$(mktemp -d)
  out_a=$(node scripts/manage.mjs list --dir "$d" 2>&1); rc_a=$?
  out_b=$(node skills-codex/connect/scripts/manage.mjs list --dir "$d" 2>&1); rc_b=$?
  rm -rf "$d"
  if [ "$out_a" = "$out_b" ] && [ "$rc_a" = "$rc_b" ]; then
    echo "ok   root alias"
  else
    echo "FAIL root alias — scripts/manage.mjs diverged from the skill entry point"
    echo "  root:  exit=$rc_a $out_a"
    echo "  skill: exit=$rc_b $out_b"
    return 1
  fi
}
if alias_check; then :; else status=1; fi

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
  # Normalize the scratch path so the golden is machine-independent. The
  # /private form first: macOS resolves the symlinked temp root when a process
  # actually cd's there, so the same directory reaches the transcript both ways.
  sed -i.bak -e "s#/private$work#<WORK>#g" -e "s#$work#<WORK>#g" "$out" && rm -f "$out.bak"

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
