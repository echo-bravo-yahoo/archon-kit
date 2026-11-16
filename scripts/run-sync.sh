#!/usr/bin/env bash
# usage: run-sync.sh <run-id> [commit...]
# Brings commits from the base branch into the worktree of a paused or failed `build` run, so a fix that
# landed on the base branch after the run started reaches the run's gates. The loop syncs with the base
# branch only when it ends, and a loop whose gates are red does not end.
#   with commits   cherry-picks each one with `git cherry-pick -x`, in the order given; a commit that
#                  is already in the branch is skipped
#   without        merges the run's fork-ref (the base branch) into the branch, when that merges cleanly
# A conflict leaves the branch where it was and names the conflicting files. Merging the whole base
# branch conflicts when other runs landed overlapping work, and cherry-picking only the fix does not.
# It never rebases: the run's state records commit ids that a rebase would orphan, and the lane checks
# compare against the base branch by name, so commits that come from it do not count as the run's own.
# It works on a run whose status is `paused` or `failed` and whose worktree has no uncommitted changes. The
# run id can be a prefix. Afterwards answer the pause to start the next round, or adopt the failed run.
set -uo pipefail

AH="${ARCHON_HOME:-$HOME/.archon}"
USAGE='usage: run-sync.sh <run-id> [commit...]'
die() { printf 'run-sync.sh: %s\n' "$*" >&2; exit 1; }

run=${1:-}
[ -n "$run" ] || { printf '%s\n' "$USAGE" >&2; exit 2; }
shift
[ -f "$AH/archon.db" ] || die "no Archon database at $AH/archon.db"

row=$(python3 -I - "$AH/archon.db" "$run" <<'PY'
import sqlite3, sys, urllib.parse

db, prefix = sys.argv[1:3]
c = sqlite3.connect("file:%s?mode=ro" % urllib.parse.quote(db), uri=True)
rows = c.execute(
    "select id, status, working_path, output_root, workflow_name from remote_agent_workflow_runs where id like ?",
    (prefix + "%",),
).fetchall()
if len(rows) != 1:
    sys.exit("run-sync.sh: run id %r matches %d runs" % (prefix, len(rows)))
print("\t".join("" if v is None else str(v) for v in rows[0]))
PY
) || exit 1
IFS=$'\t' read -r id status wt root workflow <<< "$row"

case "$status" in
  paused | failed) ;;
  *) die "run $id is $status; only a paused or failed run can take a sync, because the worktree of a running run is in use and a finished run needs none" ;;
esac
[ -e "$wt/.git" ] || die "the run's worktree $wt does not exist"
[ -z "$(git -C "$wt" status --porcelain)" ] || die "the worktree of run $id has uncommitted changes"
orig=$(git -C "$wt" rev-parse HEAD) || die "cannot read the branch in $wt"

conflicts() { git -C "$wt" diff --name-only --diff-filter=U | paste -sd, - | sed 's/,/, /g'; }

if [ "$#" -gt 0 ]; then
  for c in "$@"; do
    git -C "$wt" cat-file -e "$c^{commit}" 2> /dev/null || { git -C "$wt" reset -q --hard "$orig"; die "no commit $c in the repository; the branch is back at ${orig:0:7}"; }
    if git -C "$wt" merge-base --is-ancestor "$c" HEAD; then
      printf '%s is already in the branch\n' "$c"
      continue
    fi
    if ! git -C "$wt" cherry-pick -x "$c" > /dev/null 2>&1; then
      files=$(conflicts)
      git -C "$wt" cherry-pick --abort > /dev/null 2>&1
      if [ -n "$files" ]; then
        git -C "$wt" reset -q --hard "$orig"
        die "cherry-picking $c conflicts in: $files. The branch is back at ${orig:0:7}"
      fi
      printf '%s changes nothing in this branch, so it was skipped\n' "$c"
    fi
  done
else
  fork=$(ARTIFACTS_DIR="$root/artifacts/runs/$id" bash "$AH/scripts/state.sh" get fork-ref)
  [ -n "$fork" ] || die "run $id has no fork-ref in its state, so there is no base branch to merge; name the commits to bring in"
  if git -C "$wt" merge-base --is-ancestor "$fork" HEAD; then
    printf 'the branch already contains %s\n' "$fork"
    exit 0
  fi
  if ! git -C "$wt" merge --no-edit "$fork" > /dev/null 2>&1; then
    files=$(conflicts)
    git -C "$wt" merge --abort > /dev/null 2>&1
    die "merging $fork conflicts in: ${files:-no file listed}. The branch is back at ${orig:0:7}. Name the commit that fixes the failure: archon-kit run-sync $id <commit>"
  fi
fi

new=$(git -C "$wt" rev-list --count "$orig..HEAD")
printf 'run %s: %s commit(s) added to the branch\n' "$id" "$new"
git -C "$wt" log --format='  %h %s' "$orig..HEAD"
if [ "$status" = failed ]; then
  [ "$workflow" != build ] || printf 'Continue the run from this branch with: archon workflow run build --adopt %s --detach\n' "$id"
else
  printf 'Answer the pause to start the next round, for example: archon workflow respond %s rework "note"\n' "$id"
fi
