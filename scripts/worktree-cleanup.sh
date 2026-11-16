#!/usr/bin/env bash
#
# worktree-cleanup.sh - scan a repo's git worktrees for cleanup eligibility;
# remove specific worktrees once a caller (a person or an agent) has
# confirmed which ones to delete.
#
# Usage:
#   worktree-cleanup.sh scan [<repo>]
#   worktree-cleanup.sh remove [--discard-dirty] [--discard-unlanded] <path> [<path> ...]
#
# Repo-agnostic: resolves the main checkout via `git rev-parse
# --git-common-dir`. `scan` reads the repo from its argument (default: the
# current directory) and `remove` reads it from each worktree path, so neither
# depends on where it runs.
#
# Scratch directories: `scratch_dirs` in $ARCHON_HOME/kit.json (default none)
# names directories whose content never counts as uncommitted work.

set -u

die() { echo "worktree-cleanup.sh: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  worktree-cleanup.sh scan [<repo>]
  worktree-cleanup.sh remove [--discard-dirty] [--discard-unlanded] <path> [<path> ...]

scan    Emit a JSON array on stdout, one object per non-primary worktree of
        <repo>, which is any directory inside that repo's main checkout or one
        of its worktrees (default: the current directory):
        path, branch, head, locked, prunable, merged, ahead_of_main,
        unlanded_commits, dirty, dirty_files, diff, scratch_dirs
        (the directories that kit.json's scratch_dirs names, at any depth).
        ahead_of_main counts the branch's commits whose patch is missing from
        main (git cherry), and merged is true when that count is 0, so a
        rebase of main does not hide a landed branch. unlanded_commits lists
        those commits as {sha, subject}.

remove  Remove the given worktree path(s), each from the repo it belongs to,
        so the current directory does not matter. A worktree with uncommitted
        changes outside the scratch directories is kept unless --discard-dirty
        is given. Removal is plain `git worktree remove`, retrying with --force
        only if that fails (untracked scratch content). Then `git branch -d`;
        if that refuses only because main was rebased or the commits were
        cherry-picked under new SHAs (git cherry finds no missing patch),
        `git branch -D`. A branch with a patch missing from main survives the
        worktree removal unless --discard-unlanded is given. Every branch
        deletion prints the branch's old tip, so it can be restored with
        `git branch <name> <sha>`.
EOF
}

command -v jq >/dev/null 2>&1 || die "jq is required"

# The scratch directory names, one array element each. kit-settings.sh sits beside this script
# (or beside the file a symlink to it names).
SCRATCH=()
settings="$(dirname "$(readlink -f "$0")")/kit-settings.sh"
if [ -x "$settings" ]; then
  names=$("$settings" scratch_dirs 2>/dev/null | jq -r 'if type == "array" then .[] | strings else empty end' 2>/dev/null) || names=""
  while IFS= read -r name; do
    case "$name" in
      "" | */* | . | ..) ;;
      *) SCRATCH+=("$name") ;;
    esac
  done <<< "$names"
fi

[ $# -ge 1 ] || { usage >&2; exit 1; }
cmd="$1"; shift
case "$cmd" in -h|--help) usage; exit 0 ;; esac

# Point REPO at the main checkout of the repo containing directory $1. The
# common dir comes back relative to $1 (../.git from a subdirectory), so
# resolve it from there.
set_repo() {
  local common
  common=$(cd "$1" 2>/dev/null && git rev-parse --git-common-dir 2>/dev/null) || return 1
  REPO=$(cd "$1" && cd "$(dirname "$common")" && pwd)
}

find_main_branch() {
  if git -C "$REPO" rev-parse --verify main >/dev/null 2>&1; then
    echo main
  elif git -C "$REPO" rev-parse --verify master >/dev/null 2>&1; then
    echo master
  else
    # Repos whose integration branch has another name (e.g. development): use what the main checkout has checked out.
    git -C "$REPO" symbolic-ref --quiet --short HEAD ||
      die "could not find main or master branch in $REPO, and its main checkout has a detached HEAD"
  fi
}

# Count the commits on $2 whose patch is missing from $1. Matching by patch-id
# rather than SHA means commits that a rebase of $1 or a cherry-pick
# (worktree-land) copied under new SHAs still count as landed.
# Fails when git cherry does, so an unreadable branch is never reported landed;
# `|| true` keeps a count of 0 (grep -c exits 1) from reading as failure.
unlanded_count() {
  local out
  out=$(git -C "$REPO" cherry "$1" "$2" 2>/dev/null) || return 1
  printf '%s\n' "$out" | grep -c '^+' || true
}

# JSON array of {sha, subject} for the commits on $2 whose patch is missing
# from $1. `git cherry -v` prints "+ <sha> <subject>" for each one.
unlanded_commits_json() {
  git -C "$REPO" cherry -v "$1" "$2" 2>/dev/null |
    jq -R -s 'split("\n")
      | map(select(startswith("+ "))
        | capture("^\\+ (?<sha>[0-9a-f]+)( (?<subject>.*))?$")
        | {sha: .sha[0:7], subject: (.subject // "")})'
}

# Porcelain status lines for worktree $1, minus scratch directory content.
real_dirty_lines() {
  local out name
  out=$(git -C "$1" status --porcelain 2>/dev/null) || return 0
  for name in ${SCRATCH[@]+"${SCRATCH[@]}"}; do
    out=$(printf '%s\n' "$out" | grep -vF -e "$name/" || true)
  done
  printf '%s\n' "$out" | grep -v '^$' || true
}

scan_one() {
  local path="$1" branch="$2" locked="$3" prunable="$4" main_branch="$5"

  local merged=false ahead=0 unlanded unlanded_json='[]'
  if [ -n "$branch" ] && [ -d "$path" ]; then
    if unlanded=$(unlanded_count "$main_branch" "$branch"); then
      ahead=$unlanded
      if [ "$ahead" = 0 ]; then
        merged=true
      else
        unlanded_json=$(unlanded_commits_json "$main_branch" "$branch")
      fi
    fi
  fi

  local dirty=false diff_text="" dirty_files_json='[]'
  if [ -d "$path" ]; then
    local real_dirty
    real_dirty=$(real_dirty_lines "$path")
    if [ -n "$real_dirty" ]; then
      dirty=true
      diff_text=$(git -C "$path" diff HEAD 2>/dev/null)
    fi
    dirty_files_json=$(printf '%s\n' "$real_dirty" | jq -R -s 'split("\n") | map(select(length > 0))')
  fi

  local scratch_json='[]'
  if [ -d "$path" ]; then
    local scratch_dirs
    scratch_dirs=""
    if [ "${#SCRATCH[@]}" -gt 0 ]; then
      local find_args=() name
      for name in "${SCRATCH[@]}"; do
        [ "${#find_args[@]}" -eq 0 ] || find_args+=(-o)
        find_args+=(-name "$name")
      done
      scratch_dirs=$(find "$path" -type d \( "${find_args[@]}" \) 2>/dev/null)
    fi
    if [ -n "$scratch_dirs" ]; then
      scratch_json=$(printf '%s\n' "$scratch_dirs" | while IFS= read -r sd; do
        [ -n "$sd" ] || continue
        local count bytes samples
        count=$(find "$sd" -type f 2>/dev/null | wc -l | tr -d ' ')
        bytes=$(find "$sd" -type f -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')
        samples=$(find "$sd" -type f 2>/dev/null | head -8 | while IFS= read -r f; do basename "$f"; done | jq -R -s 'split("\n") | map(select(length > 0))')
        jq -n --arg path "$sd" --argjson count "${count:-0}" --argjson bytes "${bytes:-0}" --argjson samples "$samples" \
          '{path:$path, file_count:$count, total_bytes:$bytes, sample_files:$samples}'
      done | jq -s '.')
    fi
  fi

  local head_sha
  head_sha=$(git -C "$path" rev-parse HEAD 2>/dev/null || echo "")

  # The diff, the commit list and the file list have no size limit, but a command-line argument
  # does (128 KB on Linux), so they reach jq as files and the small values as arguments.
  local tmp rc
  tmp=$(mktemp -d) || return 1
  printf '%s' "$diff_text" > "$tmp/diff"
  printf '%s' "$unlanded_json" > "$tmp/unlanded_commits"
  printf '%s' "$dirty_files_json" > "$tmp/dirty_files"
  printf '%s' "$scratch_json" > "$tmp/scratch_dirs"
  jq -n \
    --arg path "$path" --arg branch "$branch" --arg head "$head_sha" \
    --argjson locked "$locked" --argjson prunable "$prunable" \
    --argjson merged "$merged" --argjson ahead "$ahead" --argjson dirty "$dirty" \
    --slurpfile unlanded_commits "$tmp/unlanded_commits" \
    --slurpfile dirty_files "$tmp/dirty_files" --rawfile diff "$tmp/diff" \
    --slurpfile scratch_dirs "$tmp/scratch_dirs" \
    '{path:$path, branch:$branch, head:$head, locked:$locked, prunable:$prunable,
      merged:$merged, ahead_of_main:$ahead, unlanded_commits:$unlanded_commits[0],
      dirty:$dirty, dirty_files:$dirty_files[0],
      diff:($diff | sub("\n+$"; "")), scratch_dirs:$scratch_dirs[0]}'
  rc=$?
  rm -rf "$tmp"
  return $rc
}

cmd_scan() {
  [ $# -le 1 ] || die "scan takes at most one argument, a directory inside the repo"
  set_repo "${1:-.}" || die "not inside a git repository: ${1:-.}"
  local main_branch
  main_branch=$(find_main_branch) || exit 1  # die inside $(...) only exits the subshell

  local path="" branch="" locked=false prunable=false is_first=true
  local entries=()

  flush() {
    [ -n "$path" ] || return 0
    if $is_first; then
      is_first=false
    else
      # A worktree that cannot be described is left out, and that is said, so it does not vanish.
      local entry
      if entry=$(scan_one "$path" "$branch" "$locked" "$prunable" "$main_branch") && [ -n "$entry" ]; then
        entries+=("$entry")
      else
        echo "worktree-cleanup.sh: could not scan $path, leaving it out" >&2
      fi
    fi
    path=""; branch=""; locked=false; prunable=false
  }

  while IFS= read -r line; do
    case "$line" in
      "worktree "*) flush; path="${line#worktree }" ;;
      "branch refs/heads/"*) branch="${line#branch refs/heads/}" ;;
      "locked"*) locked=true ;;
      "prunable"*) prunable=true ;;
    esac
  done < <(git -C "$REPO" worktree list --porcelain; echo)
  flush

  printf '%s\n' "${entries[@]:-}" | jq -s 'map(select(. != null))'
}

cmd_remove() {
  local discard_dirty=false discard_unlanded=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --discard-dirty) discard_dirty=true; shift ;;
      --discard-unlanded) discard_unlanded=true; shift ;;
      --) shift; break ;;
      -*) die "unknown option: $1" ;;
      *) break ;;
    esac
  done
  [ $# -ge 1 ] || die "remove requires at least one worktree path"
  local main_branch

  for path in "$@"; do
    if [ ! -d "$path" ]; then
      # A deleted directory cannot name its repo, so prune the repo containing the current directory.
      set_repo . || { echo "worktree-cleanup.sh: $path does not exist and the current directory is not in a git repository, cannot prune" >&2; continue; }
      echo "worktree-cleanup.sh: $path does not exist, pruning stale registration" >&2
      git -C "$REPO" worktree prune
      continue
    fi

    set_repo "$path" || { echo "worktree-cleanup.sh: $path is not inside a git repository, skipping" >&2; continue; }
    main_branch=$(find_main_branch) || continue  # find_main_branch already printed why

    local branch
    branch=$(git -C "$path" branch --show-current 2>/dev/null || echo "")

    if [ "$(cd "$path" && pwd)" = "$(pwd)" ]; then
      cd "$REPO" || die "cannot cd to $REPO before removing $path"
    fi

    local real_dirty
    real_dirty=$(real_dirty_lines "$path")
    if [ -n "$real_dirty" ] && ! $discard_dirty; then
      echo "worktree-cleanup.sh: $path has uncommitted changes${SCRATCH[*]:+ outside the scratch directories}, not removed (pass --discard-dirty to delete them):" >&2
      printf '%s\n' "$real_dirty" | sed 's/^/    /' >&2
      continue
    fi

    echo "Removing $path..."
    if ! git -C "$REPO" worktree remove "$path" 2>/dev/null; then
      echo "  plain remove failed (dirty/untracked content) - retrying with --force" >&2
      git -C "$REPO" worktree remove --force "$path" || { echo "  failed to remove $path" >&2; continue; }
    fi

    if [ -n "$branch" ]; then
      local tip unlanded
      tip=$(git -C "$REPO" rev-parse --short "$branch" 2>/dev/null || echo "")
      unlanded=$(unlanded_count "$main_branch" "$branch") || unlanded=""
      if git -C "$REPO" branch -d "$branch" >/dev/null 2>&1; then
        echo "  removed branch $branch (was $tip)"
      elif [ "$unlanded" = 0 ] && git -C "$REPO" branch -D "$branch" >/dev/null 2>&1; then
        echo "  removed branch $branch (was $tip; its patches are in $main_branch under new SHAs)"
      elif $discard_unlanded && git -C "$REPO" branch -D "$branch" >/dev/null 2>&1; then
        echo "  discarded branch $branch (was $tip, ${unlanded:-an unknown number of} commits without a matching patch in $main_branch); restore with: git branch $branch $tip"
      else
        echo "  branch $branch (tip $tip) not deleted, not merged into $main_branch - pass --discard-unlanded to delete it" >&2
      fi
    fi
  done
}

case "$cmd" in
  scan) cmd_scan "$@" ;;
  remove) cmd_remove "$@" ;;
  *) usage >&2; die "unknown command: $cmd" ;;
esac
