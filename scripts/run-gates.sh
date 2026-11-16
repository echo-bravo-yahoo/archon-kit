#!/usr/bin/env bash
# usage: run-gates.sh <set-name> [--list] [--keep-going] [--clean-tree]
# Reads .archon/gates.json from the current checkout and runs one named set.
# --list prints the set's commands and exits 0 without running them.
# --keep-going runs every ordered gate even after one fails, so one pass reports every failure.
# --clean-tree fails the run when the tree has uncommitted or untracked files after the gates; ignored paths do not count.
# Exits 0 when every gate passed, 1 otherwise. A missing set is a failure.
set -uo pipefail

USAGE='usage: run-gates.sh <set-name> [--list] [--keep-going] [--clean-tree]'
SET="${1:?$USAGE}"
shift
LIST=0; KEEP=0; CLEAN=0
for a in "$@"; do
  case "$a" in
    --list) LIST=1 ;;
    --keep-going) KEEP=1 ;;
    --clean-tree) CLEAN=1 ;;
    *) printf '%s\n' "$USAGE" >&2; exit 2 ;;
  esac
done
SPEC=".archon/gates.json"
REPORT="${ARTIFACTS_DIR:-/tmp}/gate-report.md"

if [ ! -f "$SPEC" ]; then
  printf 'no %s in this repository; it declares no gates\n' "$SPEC" >&2
  exit 1
fi
if ! jq -e --arg s "$SET" '.[$s]' "$SPEC" >/dev/null 2>&1; then
  printf 'no gate set "%s" in %s\n' "$SET" "$SPEC" >&2
  exit 1
fi

# Read loops rather than mapfile: macOS ships bash 3.2.
PAR=(); while IFS= read -r l; do [ -n "$l" ] && PAR+=("$l"); done \
  < <(jq -r --arg s "$SET" '.[$s].parallel // [] | .[]' "$SPEC")
ORD=(); while IFS= read -r l; do [ -n "$l" ] && ORD+=("$l"); done \
  < <(jq -r --arg s "$SET" '.[$s].ordered  // [] | .[]' "$SPEC")

if [ "${#PAR[@]}" -eq 0 ] && [ "${#ORD[@]}" -eq 0 ]; then
  printf 'gate set "%s" is empty\n' "$SET" >&2
  exit 1
fi

if [ "$LIST" = 1 ]; then
  printf '%s\n' ${PAR[@]+"${PAR[@]}"} ${ORD[@]+"${ORD[@]}"}
  exit 0
fi

LOGDIR="${ARTIFACTS_DIR:-/tmp}/gates"
mkdir -p "$LOGDIR"
failed=0
: > "$REPORT"
printf '| gate | result |\n| --- | --- |\n' >> "$REPORT"

# Only failing gates' logs are collected. Dumping every non-empty log would put a
# passing gate's stdout under a "failing output" heading, which the fix prompt and
# the PR body both read as the cause.
FAILCMD=(); FAILLOG=()

# Parallel gates first, all of them, so one pass reports every failure.
pids=()
for i in "${!PAR[@]}"; do
  ( eval "${PAR[$i]}" ) > "$LOGDIR/par-$i.log" 2>&1 &
  pids+=("$!")
done
for i in "${!pids[@]}"; do
  if wait "${pids[$i]}"; then
    printf '| `%s` | passed |\n' "${PAR[$i]}" >> "$REPORT"
  else
    printf '| `%s` | **FAILED** |\n' "${PAR[$i]}" >> "$REPORT"
    FAILCMD+=("${PAR[$i]}"); FAILLOG+=("$LOGDIR/par-$i.log")
    failed=1
  fi
done

# Ordered gates after, stopping at the first failure unless --keep-going: a failed build makes
# everything downstream of it meaningless.
for i in "${!ORD[@]}"; do
  if ( eval "${ORD[$i]}" ) > "$LOGDIR/ord-$i.log" 2>&1; then
    printf '| `%s` | passed |\n' "${ORD[$i]}" >> "$REPORT"
  else
    printf '| `%s` | **FAILED** |\n' "${ORD[$i]}" >> "$REPORT"
    FAILCMD+=("${ORD[$i]}"); FAILLOG+=("$LOGDIR/ord-$i.log")
    failed=1
    [ "$KEEP" = 1 ] || break
  fi
done

DIRTY=""
if [ "$CLEAN" = 1 ]; then
  if DIRTY=$(git status --porcelain --untracked-files=all 2>/dev/null); then
    if [ -z "$DIRTY" ]; then
      printf '| `clean working tree` | passed |\n' >> "$REPORT"
    else
      printf '| `clean working tree` | **FAILED** |\n' >> "$REPORT"
      failed=1
      printf '%s\n' "$DIRTY" >&2
    fi
  else
    printf 'run-gates.sh: --clean-tree needs a git repository\n' >&2
    printf '| `clean working tree` | **FAILED** |\n' >> "$REPORT"
    failed=1
  fi
fi

if [ "$failed" -ne 0 ]; then
  for i in "${!FAILLOG[@]}"; do
    printf '\n### Output of failing gate `%s`\n\n```\n' "${FAILCMD[$i]}" >> "$REPORT"
    tail -c 2000 "${FAILLOG[$i]}" 2>/dev/null >> "$REPORT"
    printf '\n```\n' >> "$REPORT"
  done
  if [ -n "$DIRTY" ]; then
    printf '\n### Uncommitted changes after the gates\n\n```\n%s\n```\n\nCommit these files or remove them. Ignored paths are not listed.\n' "$DIRTY" >> "$REPORT"
  fi
fi
cat "$REPORT"
exit "$failed"
