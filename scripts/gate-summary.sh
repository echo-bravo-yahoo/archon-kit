#!/usr/bin/env bash
# usage: gate-summary.sh failed <gate-report.md>
#        gate-summary.sh not-run <gate-report.md> <set-name>
# Reads the table that run-gates.sh writes to gate-report.md, one row for each gate that ran.
#   failed   prints the command of each gate whose row says FAILED, one per line.
#   not-run  prints each command of the set (as `run-gates.sh <set> --list` lists it) that has no
#            row, because an ordered gate before it failed and ended the run.
# Only the table is read, so a failing gate's quoted output cannot add a row.
set -uo pipefail

USAGE='usage: gate-summary.sh failed <gate-report.md> | gate-summary.sh not-run <gate-report.md> <set-name>'
cmd=${1:-}
report=${2:-}
[ -n "$cmd" ] && [ -n "$report" ] || { printf '%s\n' "$USAGE" >&2; exit 2; }
[ -f "$report" ] || { printf 'gate-summary.sh: no such file: %s\n' "$report" >&2; exit 1; }

# One "<passed|failed><TAB><command>" line for each row of the table.
rows() {
  awk '
    /^\| --- \| --- \|$/ { in_table = 1; next }
    in_table && /^\| `/ {
      line = $0
      if (line ~ /` \| \*\*FAILED\*\* \|$/) { status = "failed"; sub(/` \| \*\*FAILED\*\* \|$/, "", line) }
      else if (line ~ /` \| passed \|$/) { status = "passed"; sub(/` \| passed \|$/, "", line) }
      else next
      sub(/^\| `/, "", line)
      printf "%s\t%s\n", status, line
      next
    }
    in_table { exit }
  ' "$report"
}

case "$cmd" in
  failed)
    rows | awk -F '\t' '$1 == "failed"' | cut -f2-
    ;;
  not-run)
    set_name=${3:-}
    [ -n "$set_name" ] || { printf '%s\n' "$USAGE" >&2; exit 2; }
    ran=$(mktemp)
    trap 'rm -f "$ran"' EXIT
    rows | cut -f2- > "$ran"
    here=$(cd "$(dirname "$0")" && pwd)
    bash "$here/run-gates.sh" "$set_name" --list | while IFS= read -r gate; do
      grep -qxF -- "$gate" "$ran" || printf '%s\n' "$gate"
    done
    ;;
  *)
    printf '%s\n' "$USAGE" >&2
    exit 2
    ;;
esac
