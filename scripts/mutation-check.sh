#!/usr/bin/env bash
# usage: mutation-check.sh <mutations.json> <report.md>
#        mutation-check.sh --schema
# Proves that tests which already pass are not vacuous. It applies every mutation in
# <mutations.json> at once, runs the `tests` gate set once with --keep-going, and scores each
# mutation by whether its fail_pattern appears in the output. It then restores the tree and
# writes <report.md>. Reads ARTIFACTS_DIR, and must start from a clean checkout.
# stdout is one word: `caught` when every mutation was caught, `retry` otherwise. It exits 1
# only for a fault another round cannot fix: a coverage-bug.md, a dirty tree, or a tree that
# did not restore. It also records `mutation-status` in the run's state file, as `caught` only when
# every mutation was caught. Its scratch files live in a temporary directory that the script
# removes on exit; only <report.md> and the gate logs in $ARTIFACTS_DIR/gates remain.
set -uo pipefail

if [ "${1:-}" = --schema ]; then
  cat <<'EOF'
mutations.json is a JSON array of at most 12 objects with these string fields:
  id            a unique short name
  test          the test file that pins the behaviour
  file          a tracked source file outside the tests lane
  from          text that occurs exactly once in `file`
  to            a replacement that breaks the behaviour the test pins
  fail_pattern  an extended regular expression for the line the test runner prints when that
                test fails, such as `✖ <exact test title>`. It must not match anything the
                passing run prints.
Cover every test you wrote. The check applies all mutations at once and runs the tests once,
so give each mutation its own function or branch.
EOF
  exit 0
fi

USAGE='usage: mutation-check.sh <mutations.json> <report.md> | --schema'
MUT="${1:?$USAGE}"
REPORT="${2:?$USAGE}"
ART="${ARTIFACTS_DIR:?ARTIFACTS_DIR is not set}"
RUNGATES="${ARCHON_HOME:-$HOME/.archon}/scripts/run-gates.sh"
STATE="${ARCHON_HOME:-$HOME/.archon}/scripts/state.sh"
LANE="${ARCHON_HOME:-$HOME/.archon}/scripts/lane.sh"

# Absolute paths first: the script works from the repository root.
case "$MUT" in /*) ;; *) MUT="$PWD/$MUT" ;; esac
case "$REPORT" in /*) ;; *) REPORT="$PWD/$REPORT" ;; esac
cd "$(git rev-parse --show-toplevel)" || exit 1

LOGDIR="$ART/gates"

ARTIFACTS_DIR="$ART" "$STATE" set mutation-status ''
if [ -f "$ART/coverage-bug.md" ]; then
  printf 'the mutation stage found a bug in the source:\n' >&2
  cat "$ART/coverage-bug.md" >&2
  exit 1
fi

SCRATCH=$(mktemp -d) || exit 1
MUTATED="$SCRATCH/files.txt"
RESULTS="$SCRATCH/results.tsv"
BAD="$SCRATCH/bad.tsv"
CLEAN_LOG="$SCRATCH/clean.log"
MUT_LOG="$SCRATCH/mutated.log"
CLEAN_GATES="$SCRATCH/clean-gates.txt"
MUT_GATES="$SCRATCH/mutated-gates.txt"

# Locale C keeps sed and grep from choking on bytes that are not valid text.
strip_ansi() { LC_ALL=C sed -E $'s/\033\\[[0-9;]*[A-Za-z]//g'; }
logs() { cat "$LOGDIR"/*.log 2> /dev/null | strip_ansi; }

# Puts back every file the mutations touched. The tree started clean, so the index copy is the
# original.
restore() {
  [ -s "$MUTATED" ] || return 0
  while IFS= read -r f; do git checkout -q -- "$f" 2> /dev/null; done < "$MUTATED"
  : > "$MUTATED"
}
# restore first: it reads $MUTATED, which lives in $SCRATCH.
trap 'restore; rm -rf "$SCRATCH"' EXIT
trap 'exit 130' INT HUP
trap 'exit 143' TERM

retry_with() {
  { printf '# Mutation check\n\n%s\n' "$1"
    if [ -n "${2-}" ] && [ -f "$2" ]; then printf '\n~~~~\n'; tail -c 6000 "$2"; printf '\n~~~~\n'; fi
  } > "$REPORT"
  printf 'mutation check: %s\n' "$1" >&2
  printf 'retry\n'
  exit 0
}

if ! jq -e . "$MUT" > /dev/null 2>&1; then
  retry_with "mutations.json is missing or is not valid JSON. It must be written as follows.

$(bash "$0" --schema)"
fi
if ! jq -e '
  def s: type == "string" and length > 0;
  type == "array" and length >= 1 and length <= 12
  and all(.[]; type == "object" and (.id | s) and (.test | s) and (.file | s) and (.from | s)
              and (.to | type == "string") and (.fail_pattern | s and (contains("\n") | not)))
  and ((map(.id) | unique | length) == length)
' "$MUT" > /dev/null 2>&1; then
  retry_with "mutations.json does not match the schema. It must be written as follows.

$(bash "$0" --schema)"
fi

if [ -n "$(git status --porcelain)" ]; then
  printf 'the checkout has uncommitted changes, so the mutations cannot be applied and undone safely:\n' >&2
  git status --porcelain >&2
  exit 1
fi

rm -rf "$LOGDIR"
if ! bash "$RUNGATES" tests > "$CLEAN_GATES" 2>&1; then
  retry_with "The tests fail on the unmodified code, so this is not coverage work. The failing gate's output:" "$CLEAN_GATES"
fi
logs > "$CLEAN_LOG"

N=$(jq length "$MUT")

# A fail_pattern that matches what the passing run prints would count every mutation as caught.
: > "$BAD"
i=0
while [ "$i" -lt "$N" ]; do
  pat=$(jq -r --argjson i "$i" '.[$i].fail_pattern' "$MUT")
  LC_ALL=C grep -aEq -- "$pat" "$CLEAN_LOG"
  case $? in
    0) printf '%s\tfail_pattern matches the output of the passing run, so it cannot show a failure\n' "$i" >> "$BAD" ;;
    1) ;;
    *) printf '%s\tfail_pattern is not a valid extended regular expression\n' "$i" >> "$BAD" ;;
  esac
  i=$((i + 1))
done

# Every edit is checked against the original text before any file is written. The file list is
# written first, so the EXIT trap can restore a file even if the write loop fails.
python3 -I - "$MUT" "$BAD" "$RESULTS" "$MUTATED" >&2 << 'PY'
import json, os, subprocess, sys

mut_path, bad_path, results_path, files_path = sys.argv[1:5]
muts = json.load(open(mut_path, encoding="utf-8"))
bad = {}
for line in open(bad_path, encoding="utf-8"):
    idx, _, reason = line.rstrip("\n").partition("\t")
    bad[int(idx)] = reason

root = os.path.realpath(".")
tracked = set(subprocess.run(["git", "ls-files", "-z"], capture_output=True, check=True)
              .stdout.decode("utf-8", "surrogateescape").split("\0"))

def occurrences(text, needle):
    n, at = 0, text.find(needle)
    while at != -1:
        n += 1
        at = text.find(needle, at + 1)
    return n

results, plan, texts = [], {}, {}
for idx, m in enumerate(muts):
    def reject(reason):
        results.append((idx, "invalid", reason))
    if idx in bad:
        reject(bad[idx]); continue
    f = os.path.normpath(m["file"])
    if os.path.isabs(f) or f.startswith("..") or "\n" in f:
        reject("file must be a path inside the repository"); continue
    if f not in tracked:
        reject("file is not a tracked file"); continue
    if os.path.islink(f) or not os.path.realpath(f).startswith(root + os.sep):
        reject("file is a symbolic link or resolves outside the repository"); continue
    if f not in texts:
        try:
            texts[f] = open(f, "rb").read().decode("utf-8")
        except (OSError, UnicodeDecodeError):
            reject("file cannot be read as UTF-8 text"); continue
    text = texts[f]
    n = occurrences(text, m["from"])
    if n != 1:
        reject("from occurs %d times in the file, not once" % n); continue
    if m["from"] == m["to"]:
        reject("from and to are the same"); continue
    start = text.index(m["from"])
    end = start + len(m["from"])
    clash = [x for x in plan.get(f, []) if start < x[1] and x[0] < end]
    if clash:
        reject("overlaps the edit of mutation %s" % muts[clash[0][3]]["id"]); continue
    plan.setdefault(f, []).append((start, end, m["to"], idx))
    results.append((idx, "applied", ""))

with open(files_path, "w", encoding="utf-8") as fh:
    for f in plan:
        fh.write(f + "\n")
for f, edits in plan.items():
    text = texts[f]
    for start, end, to, _ in sorted(edits, reverse=True):
        text = text[:start] + to + text[end:]
    with open(f, "wb") as fh:
        fh.write(text.encode("utf-8"))
with open(results_path, "w", encoding="utf-8") as fh:
    for idx, status, reason in results:
        fh.write("%d\t%s\t%s\n" % (idx, status, reason.replace("\t", " ").replace("\n", " ")))
PY
py=$?
[ "$py" -eq 0 ] || { printf 'the mutations could not be applied (python exit %s)\n' "$py" >&2; exit 1; }

check_clean() {
  restore
  if [ -n "$(git status --porcelain)" ]; then
    printf 'the tree did not restore after the mutations:\n' >&2
    git status --porcelain >&2
    exit 1
  fi
}

APPLIED=$(grep -c "$(printf '\tapplied\t')" "$RESULTS" || true)
if [ "${APPLIED:-0}" -gt 0 ]; then
  if ! lane_out=$(bash "$LANE" check --allow-empty HEAD out 2>&1); then
    check_clean
    retry_with "A mutation edits the tests lane, which mutations may not touch. $lane_out"
  fi
  rm -rf "$LOGDIR"
  bash "$RUNGATES" tests --keep-going > "$MUT_GATES" 2>&1
  logs > "$MUT_LOG"
fi
check_clean

esc() { printf '%s' "$1" | sed -e 's/|/\\|/g'; }

# A mutation is caught when the runner printed the failure line its fail_pattern describes.
CAUGHT=0
ROWS=""
i=0
while [ "$i" -lt "$N" ]; do
  IFS=$'\t' read -r mid mtest mfile < <(jq -r --argjson i "$i" '.[$i] | [.id, .test, .file] | @tsv' "$MUT")
  pat=$(jq -r --argjson i "$i" '.[$i].fail_pattern' "$MUT")
  line=$(awk -F'\t' -v i="$i" '$1 == i' "$RESULTS")
  IFS=$'\t' read -r _ st reason <<< "$line"
  if [ "$st" = applied ]; then
    if LC_ALL=C grep -aEq -- "$pat" "$MUT_LOG"; then
      res=caught; CAUGHT=$((CAUGHT + 1))
    else
      res="survived: no line of the test output matched \`$pat\`"
    fi
  else
    res="invalid: $reason"
  fi
  ROWS="$ROWS| $(esc "$mid") | $(esc "$mtest") | $(esc "$mfile") | $(esc "$res") |
"
  i=$((i + 1))
done

{
  printf '# Mutation check\n\n%s of %s caught.\n\n' "$CAUGHT" "$N"
  printf '| id | test | file | result |\n| --- | --- | --- | --- |\n%s' "$ROWS"
  if [ "$CAUGHT" -ne "$N" ] && [ -f "$MUT_GATES" ]; then
    printf '\n## Output of the run with every mutation applied\n\n~~~~\n'
    tail -c 6000 "$MUT_GATES"
    printf '\n~~~~\n'
  fi
} > "$REPORT"

printf 'mutation check: %s of %s caught\n' "$CAUGHT" "$N" >&2
if [ "$CAUGHT" -eq "$N" ]; then
  ARTIFACTS_DIR="$ART" "$STATE" set mutation-status caught
  printf 'caught\n'
else
  printf 'retry\n'
fi
