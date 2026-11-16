#!/usr/bin/env bash
# usage: base-gates.sh
# Runs the repository's `feature` gate set on the commit where the run's branch left the base branch,
# before the run changes anything, and exits 1 when a gate fails there. A gate that is red on the base
# cannot be made green by anything the run does, so the run ends at once and spends no model tokens.
#
# Prints one word and records it as the `base-gates` key in the run's state:
#   green    every gate passed on the base commit
#   cached   an earlier run already found this commit green
#   skipped  .archon/build.json sets "base_gates" to "off" (or false)
#   unknown  the check could not run, so the run goes on without it
# On a red base it prints the failing gates and their output to standard error and exits 1.
#
# The gates run in a throwaway worktree under $ARTIFACTS_DIR/base, so a gate that rewrites tracked files
# cannot dirty the run's own tree. Only a green result is cached, in $ARCHON_HOME/base-gates/<repo>/,
# so a failure caused by the environment or by a flaky test is looked at again on the next run.
set -uo pipefail

S="${ARCHON_HOME:-$HOME/.archon}/scripts"
AH="${ARCHON_HOME:-$HOME/.archon}"
art="${ARTIFACTS_DIR:?ARTIFACTS_DIR is not set}"
st="$S/state.sh"

finish() { "$st" set base-gates "$1"; printf '%s\n' "$1"; exit 0; }
unknown() { printf 'base-gates.sh: %s; the run goes on without the base check\n' "$1" >&2; finish unknown; }

# The setting is read from the main checkout, because the run's own tree can predate it.
main=$(bash "$S/build-settings.sh" --main-worktree) || unknown "cannot find the main worktree"
if [ -f "$main/.archon/build.json" ]; then
  mode=$(jq -r 'if type != "object" then error("not an object") elif has("base_gates") then (.base_gates | tostring) else "on" end' "$main/.archon/build.json") \
    || { printf 'base-gates.sh: cannot read %s as a JSON object\n' "$main/.archon/build.json" >&2; exit 2; }
else
  mode=on
fi
case "$mode" in
  on | true) ;;
  off | false) finish skipped ;;
  *) printf 'base-gates.sh: "base_gates" in .archon/build.json must be "on" or "off", not "%s"\n' "$mode" >&2; exit 2 ;;
esac

# The commit the branch left the base branch at; a fresh run is still on it. An adopted run's branch
# is ahead of it, and the gates must not run on the adopted run's own commits.
fork=$("$st" get fork-ref)
base=
[ -z "$fork" ] || base=$(git merge-base HEAD "$fork" 2> /dev/null)
[ -n "$base" ] || base=$(git rev-parse HEAD) || unknown "cannot read HEAD"

git cat-file -e "$base:.archon/gates.json" 2> /dev/null || unknown "the base commit has no .archon/gates.json"
repo=$(bash "$S/build-settings.sh" --repo) || unknown "cannot name the repository"
cache="$AH/base-gates/$repo/$base.green"
if [ -f "$cache" ]; then finish cached; fi

mkdir -p "$art/base"
tree="$art/base/tree"
rm -rf "$tree"
git worktree add --detach -q "$tree" "$base" 2> /dev/null || unknown "cannot check out the base commit"
cleanup() {
  git worktree remove --force "$tree" > /dev/null 2>&1
  rm -rf "$tree"
  git worktree prune > /dev/null 2>&1
}
trap cleanup EXIT

rm -f "$art/base/gate-report.md"
( cd "$tree" && ARTIFACTS_DIR="$art/base" bash "$S/run-gates.sh" feature --keep-going ) > "$art/base/gates.out" 2>&1
status=$?
[ ! -f "$art/base/gate-report.md" ] || bash "$S/run-log.sh" base-gates - < "$art/base/gate-report.md"

if [ "$status" -eq 0 ]; then
  mkdir -p "$(dirname "$cache")" && : > "$cache"
  finish green
fi

failed=
[ ! -f "$art/base/gate-report.md" ] || failed=$(bash "$S/gate-summary.sh" failed "$art/base/gate-report.md")
if [ -z "$failed" ]; then
  unknown "the gates did not run on the base commit ($(tail -n 1 "$art/base/gates.out"))"
fi

"$st" set base-gates red
{
  printf 'The base commit is red, so this run cannot succeed. Before the run changes anything, these gates fail on %s:\n' "$(git rev-parse --short "$base")"
  printf '%s\n' "$failed" | sed 's/^/  /'
  printf 'Fix them on the base branch and start the run again. To run without this check, set "base_gates": "off" in .archon/build.json.\n'
  printf 'The gates'"'"' output follows, and is also in %s.\n\n' "$art/base/gate-report.md"
  cat "$art/base/gate-report.md"
} >&2
exit 1
