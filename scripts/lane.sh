#!/usr/bin/env bash
# usage: lane.sh list [--set <name>]
#        lane.sh check [--set <name>] [--allow-empty] [--exclude <path>]... (--since <ref> | <base>) <in|out>
#        lane.sh stage <stage> [<writable-path>...]
#        lane.sh unstage [--verify]
#        lane.sh verify [--provider <claude|codex>]...
#        lane.sh providers
#        lane.sh stages
#
# list and check read a path set from .archon/lanes.json (default set: "tests"), which makes this
# the only reader of lanes.json. The "docs" set defaults to **/*.md when lanes.json declares none.
#   list          prints the declared globs as git pathspecs and compares nothing
#   check         compares what a stage changed with the set. `in` requires every changed path to
#                 be inside the set and `out` requires none to be. --allow-empty lets a stage that
#                 changed nothing pass instead of failing with "this stage changed nothing".
#                 What changed is everything since <base>, a commit, or since the commit where
#                 HEAD left <ref> (--since, which is the git merge-base). Both count uncommitted
#                 and untracked files. A rebase rewrites commits but not where a branch left its
#                 base branch, so --since keeps its answer when a recorded commit would not.
#                 --exclude <path> leaves a path out of what changed, such as the brief that
#                 `intake` commits on a run's branch; a trailing slash names a directory, and an
#                 empty value is ignored.
# stage and unstage record which build stage is running, and the paths outside the worktree it
# may also write, in the worktree's git directory, where lane-hook.mjs reads them. stage also
# records `snapshot`, the id of a git tree that holds the whole working tree at that moment
# (committed, staged, unstaged and untracked files alike, ignored files left out).
#   unstage --verify  ends the stage and then compares a new snapshot with the recorded one, so
#                     it sees every write whichever tool made it and ignores work that was
#                     already uncommitted when the stage began. It fails (exit 1) naming the
#                     paths that the stage was not allowed to write. A marker with no snapshot
#                     (an older lane.sh wrote it) or no marker passes.
#   verify            fails when nothing enforces the lanes while a stage runs: the repository
#                     registers lane-hook.mjs in .claude/settings.json, a Codex config or hooks
#                     file (in the repository or under $CODEX_HOME) mentions it, or build.json
#                     sets "lane_enforcement": "check", which leaves the stage-end check alone.
#                     With --provider, each named provider needs its own registration (claude:
#                     .claude/settings.json; codex: a Codex config or hooks file), so a Claude
#                     registration cannot stand in on a Codex run; a provider the kit has no
#                     hook for fails unless "lane_enforcement" is "check". Without --provider any
#                     one registration is enough. A registration is not proof that the provider
#                     runs the hook: Codex skips a hook it has not been told to trust.
#   providers         prints the provider that the confined stages run on, which is the provider
#                     bound to the medium tier in this run's stored configuration (the Archon
#                     database, found through ARTIFACTS_DIR). It prints nothing, and succeeds, when
#                     the run cannot be found.
#   stages            prints each stage's lane set and mode, one tab-separated line each.
# Exits 0 on success, 1 when a lane is undeclared or a check fails, 2 on a usage error.
set -uo pipefail

USAGE='usage: lane.sh list [--set <name>] | check [--set <name>] [--allow-empty] [--exclude <path>]... (--since <ref> | <base>) <in|out> | stage <stage> [<path>...] | unstage [--verify] | verify [--provider <claude|codex>]... | providers | stages'

# Read loop plus a counter rather than mapfile or ${#PS[@]}: macOS ships bash 3.2, where an
# empty array expansion under `set -u` is an unbound-variable error.
load_set() {
  SPEC=".archon/lanes.json"
  [ -f "$SPEC" ] || { printf 'no %s; this repository declares no lanes\n' "$SPEC" >&2; exit 1; }
  PS=(); N=0
  while IFS= read -r g; do
    [ -n "$g" ] && { PS+=(":(glob)$g"); N=$((N + 1)); }
  done < <(jq -r --arg k "$SET" '.[$k] // [] | .[]' "$SPEC")
  if [ "$N" -eq 0 ] && [ "$SET" = docs ]; then PS=(":(glob)**/*.md"); N=1; fi
  [ "$N" -gt 0 ] || { printf 'lanes.json declares no "%s" globs\n' "$SET" >&2; exit 1; }
}

# The lane set and the mode that each build stage is held to. lane-hook.mjs holds the same table
# as STAGES, and lane.test.mjs checks that the two agree.
stage_rule() {
  case "$1" in
    tests | repair) printf 'tests\tin\n' ;;
    implement) printf 'tests\tout\n' ;;
    sync_fix) printf 'protected\tout\n' ;;
    *) return 1 ;;
  esac
}

# The model tier that every confined stage of build.yaml runs on. `providers` reads the provider
# bound to this tier from the run's stored configuration, and lane.test.mjs checks the stage
# nodes against it.
STAGE_TIER=medium

# The id of a tree that holds the working tree: a copy of the index, with everything that git add
# -A would stage, written as a tree. The real index and the repository are left as they were.
snapshot_tree() {
  local top idx tree
  top=$(git rev-parse --show-toplevel) || return 1
  idx=$(mktemp "${TMPDIR:-/tmp}/lane-index.XXXXXX") || return 1
  cp "$(git rev-parse --git-path index)" "$idx" 2> /dev/null || rm -f "$idx"
  tree=$(cd "$top" && GIT_INDEX_FILE=$idx git add -A > /dev/null 2>&1 && GIT_INDEX_FILE=$idx git write-tree 2> /dev/null)
  rm -f "$idx"
  [ -n "$tree" ] || return 1
  printf '%s\n' "$tree"
}

# Paths that a dependency install rewrites, which no stage is blamed for.
is_lockfile() {
  case "${1##*/}" in
    package-lock.json | yarn.lock | pnpm-lock.yaml | bun.lock | bun.lockb | Cargo.lock | poetry.lock | uv.lock | go.sum) return 0 ;;
    *) return 1 ;;
  esac
}

take_set() {
  SET=tests
  ALLOW_EMPTY=0
  SINCE=""
  SINCE_GIVEN=0
  EXCLUDES=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --set) SET="${2:?$USAGE}"; shift 2 ;;
      --allow-empty) ALLOW_EMPTY=1; shift ;;
      --since) SINCE_GIVEN=1; SINCE="${2:-}"; shift $(( $# > 1 ? 2 : 1 )) ;;
      --exclude) [ $# -ge 2 ] || { printf '%s\n' "$USAGE" >&2; exit 2; }
                 [ -z "$2" ] || EXCLUDES+=("$2"); shift 2 ;;
      *) break ;;
    esac
  done
  REST=("$@")
}

# Copies the lines of standard input that name none of the excluded paths. An exclusion that ends
# in a slash names a directory.
drop_excluded() {
  local line x skip
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    skip=0
    for x in ${EXCLUDES[@]+"${EXCLUDES[@]}"}; do
      case "$x" in
        */) case "$line" in "$x"*) skip=1 ;; esac ;;
        *) [ "$line" != "$x" ] || skip=1 ;;
      esac
    done
    [ "$skip" = 1 ] || printf '%s\n' "$line"
  done
}

cmd=${1:-}
[ -n "$cmd" ] || { printf '%s\n' "$USAGE" >&2; exit 2; }
shift

case "$cmd" in
  list)
    take_set "$@"
    [ "${#REST[@]}" -eq 0 ] || { printf '%s\n' "$USAGE" >&2; exit 2; }
    load_set
    printf '%s\n' "${PS[@]}"
    ;;
  check)
    take_set "$@"
    if [ "$SINCE_GIVEN" = 1 ]; then
      [ -n "$SINCE" ] || { printf 'lane.sh: --since needs a ref\n' >&2; exit 2; }
      MODE="${REST[0]:?$USAGE}"
      BASE=$(git merge-base HEAD "$SINCE" 2> /dev/null) \
        || { printf 'lane.sh: cannot find where HEAD left %s, so what the branch changed cannot be listed\n' "$SINCE" >&2; exit 1; }
    else
      BASE="${REST[0]:?$USAGE}"
      MODE="${REST[1]:?$USAGE}"
    fi
    load_set
    changed() { git diff --name-only "$BASE"..HEAD -- "$@"; git ls-files -mo --exclude-standard -- "$@"; }
    ALL=$(changed | sort -u | drop_excluded)
    [ -n "$ALL" ] || { [ "$ALLOW_EMPTY" = 1 ] && exit 0; printf 'this stage changed nothing\n' >&2; exit 1; }
    IN=$(changed "${PS[@]}" | sort -u | drop_excluded)
    OUT=$(comm -23 <(printf '%s\n' "$ALL") <(printf '%s\n' "$IN"))
    case "$MODE" in
      in)  [ -z "$OUT" ] && exit 0
           printf 'this stage wrote outside the %s lane:\n%s\n' "$SET" "$OUT" >&2 ;;
      out) [ -z "$IN" ] && exit 0
           printf 'this stage wrote inside the %s lane:\n%s\n' "$SET" "$IN" >&2 ;;
      *)   printf 'unknown mode "%s"\n' "$MODE" >&2 ;;
    esac
    exit 1
    ;;
  stage)
    stage=${1:?$USAGE}; shift
    marker=$(git rev-parse --git-path archon-stage) || exit 1
    snap=$(snapshot_tree) || { printf 'lane.sh: cannot snapshot the working tree, so the %s stage cannot start\n' "$stage" >&2; exit 1; }
    jq -n --arg stage "$stage" --arg snapshot "$snap" '{stage: $stage, allow: $ARGS.positional, snapshot: $snapshot}' --args "$@" > "$marker"
    ;;
  unstage)
    verify=0
    if [ "${1:-}" = "--verify" ]; then verify=1; shift; fi
    [ "$#" -eq 0 ] || { printf '%s\n' "$USAGE" >&2; exit 2; }
    marker=$(git rev-parse --git-path archon-stage) || exit 1
    if [ "$verify" = 0 ]; then rm -f "$marker"; exit 0; fi
    [ -f "$marker" ] || exit 0
    body=$(cat "$marker")
    # The marker goes first, so a failed check cannot leave a marker that confines later sessions.
    rm -f "$marker"
    stage=$(printf '%s' "$body" | jq -r '.stage // empty' 2> /dev/null) || stage=""
    old=$(printf '%s' "$body" | jq -r '.snapshot // empty' 2> /dev/null) || old=""
    if [ -z "$stage" ] || [ -z "$old" ]; then
      printf 'lane.sh: the stage marker has no snapshot, so what the stage wrote was not checked\n' >&2
      exit 0
    fi
    rule=$(stage_rule "$stage") || { printf 'lane.sh: stage %s has no lane to check\n' "$stage" >&2; exit 0; }
    SET=$(printf '%s' "$rule" | cut -f1)
    MODE=$(printf '%s' "$rule" | cut -f2)
    if [ "$SET" = protected ] && ! jq -e '(.protected // []) | length > 0' .archon/lanes.json > /dev/null 2>&1; then exit 0; fi
    load_set
    new=$(snapshot_tree) || { printf 'lane.sh: cannot snapshot the working tree, so the %s stage was not checked\n' "$stage" >&2; exit 1; }
    top=$(git rev-parse --show-toplevel) || exit 1
    allow=$(printf '%s' "$body" | jq -r '.allow[]?' 2> /dev/null || true)
    ALL=""
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      if is_lockfile "$p"; then continue; fi
      skip=0
      while IFS= read -r a; do
        [ -n "$a" ] || continue
        case "$top/$p" in "$a" | "$a"/*) skip=1 ;; esac
      done <<< "$allow"
      [ "$skip" = 1 ] || ALL="$ALL$p"$'\n'
    done < <(git -c core.quotepath=off diff-tree -r --name-only --no-renames "$old" "$new" | LC_ALL=C sort -u)
    ALL=${ALL%$'\n'}
    [ -n "$ALL" ] || exit 0
    IN=$(git -c core.quotepath=off diff-tree -r --name-only --no-renames "$old" "$new" -- "${PS[@]}" | LC_ALL=C sort -u)
    case "$MODE" in
      in)
        OUT=$(comm -23 <(printf '%s\n' "$ALL") <(printf '%s\n' "$IN"))
        [ -z "$OUT" ] && exit 0
        printf 'the %s stage wrote outside the %s lane:\n%s\n' "$stage" "$SET" "$OUT" >&2
        ;;
      out)
        HIT=$(comm -12 <(printf '%s\n' "$ALL") <(printf '%s\n' "$IN"))
        [ -z "$HIT" ] && exit 0
        printf 'the %s stage wrote inside the %s lane:\n%s\n' "$stage" "$SET" "$HIT" >&2
        ;;
    esac
    exit 1
    ;;
  stages)
    for st in tests repair implement sync_fix; do
      printf '%s\t%s\n' "$st" "$(stage_rule "$st")"
    done
    ;;
  providers)
    db="${ARCHON_HOME:-$HOME/.archon}/archon.db"
    [ -n "${ARTIFACTS_DIR:-}" ] && [ -r "$db" ] || exit 0
    python3 -I - "$db" "$(basename "$ARTIFACTS_DIR")" "$STAGE_TIER" 2> /dev/null <<'PY' || exit 0
import json
import sqlite3
import sys
import urllib.parse

db, run, tier = sys.argv[1:4]
try:
    conn = sqlite3.connect("file:%s?mode=ro" % urllib.parse.quote(db), uri=True)
    row = conn.execute("select metadata from remote_agent_workflow_runs where id = ?", (run,)).fetchone()
    meta = json.loads(row[0]) if row and row[0] else {}
except Exception:
    sys.exit(0)


def aliases(source):
    return (source or {}).get("aliases") or {}


effective = (meta.get("model_bindings") or {}).get("effective") or {}
profile = (meta.get("ai_configuration") or {}).get("baseAiProfile") or {}
provider = (aliases(effective).get(tier) or aliases(profile).get(tier) or {}).get("provider") or ""
if provider:
    print(provider)
PY
    ;;
  verify)
    PROVIDERS=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --provider) PROVIDERS+=("${2:?$USAGE}"); shift 2 ;;
        *) printf '%s\n' "$USAGE" >&2; exit 2 ;;
      esac
    done
    top=$(git rev-parse --show-toplevel)
    if [ "$(jq -r '.lane_enforcement // empty' "$top/.archon/build.json" 2> /dev/null)" = check ]; then exit 0; fi
    claude_registered() {
      jq -e '[.hooks.PreToolUse[]?.hooks[]?.command // empty | select(contains("lane-hook.mjs"))] | length > 0' "$top/.claude/settings.json" > /dev/null 2>&1
    }
    codex_registered() {
      local f codex_home=${CODEX_HOME:-$HOME/.codex}
      for f in "$top/.codex/config.toml" "$top/.codex/hooks.json" "$codex_home/config.toml" "$codex_home/hooks.json"; do
        if [ -f "$f" ] && grep -q 'lane-hook\.mjs' "$f"; then return 0; fi
      done
      return 1
    }
    if [ "${#PROVIDERS[@]}" -eq 0 ]; then
      if claude_registered || codex_registered; then exit 0; fi
      printf 'this repository does not enforce the lanes while a stage runs, so build would run its stages unconfined: register lane-hook.mjs in .claude/settings.json (Claude) or in a Codex config or hooks file, or set "lane_enforcement": "check" in .archon/build.json to rely on the check at the end of each stage\n' >&2
      exit 1
    fi
    missing=""
    for p in "${PROVIDERS[@]}"; do
      case "$p" in
        claude) claude_registered || missing="$missing  lane-hook.mjs is not registered for claude: add it to .claude/settings.json"$'\n' ;;
        codex) codex_registered || missing="$missing  lane-hook.mjs is not registered for codex: run archon-kit hooks install codex, or add it to the repository's .codex/config.toml"$'\n' ;;
        *) missing="$missing  the kit has no lane hook for $p"$'\n' ;;
      esac
    done
    [ -n "$missing" ] || exit 0
    printf 'build would run a stage on a provider that nothing confines while it runs:\n%sRegister the hook, or set "lane_enforcement": "check" in .archon/build.json to rely on the check at the end of each stage\n' "$missing" >&2
    exit 1
    ;;
  *) printf 'unknown command %s\n%s\n' "$cmd" "$USAGE" >&2; exit 2 ;;
esac
