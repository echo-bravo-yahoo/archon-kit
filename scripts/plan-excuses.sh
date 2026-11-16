#!/usr/bin/env bash
# usage: plan-excuses.sh has <node> | lines | more-tests
# Reads the excuses the planner recorded in $ARTIFACTS_DIR/spec-approved.json. A missing or unreadable file means none.
set -uo pipefail
USAGE='usage: plan-excuses.sh has <node> | lines | more-tests'
f="${ARTIFACTS_DIR:?ARTIFACTS_DIR is not set}/spec-approved.json"
case "${1:?$USAGE}" in
  has) n=${2:?$USAGE}; jq -e --arg n "$n" '.excuses[]? | select(.node == $n)' "$f" > /dev/null 2>&1 ;;
  lines) jq -r '.excuses[]? | "Excused \(.node): \(.reason)"' "$f" 2> /dev/null || true ;;
  more-tests) jq -e '.excuses[]? | select(.node == "implement" or .node == "mutation_cycle")' "$f" > /dev/null 2>&1 ;;
  *) printf '%s\n' "$USAGE" >&2; exit 2 ;;
esac
