#!/usr/bin/env bash
# usage: run-log.sh <label> <command> [args...]   run the command, append its output to the run's log, exit with its status
#        run-log.sh <label> -                     append standard input to the run's log
# The log is $ARTIFACTS_DIR/run.log. Output is collected first and appended under a lock, so entries from
# nodes that run at once stay whole.
set -uo pipefail
label=${1:?usage: run-log.sh <label> <command>... | run-log.sh <label> -}
shift
log="${ARTIFACTS_DIR:?ARTIFACTS_DIR is not set}/run.log"
out=$(mktemp)
if [ "${1:-}" = - ]; then cat > "$out"; status=0; else "$@" > "$out" 2>&1 < /dev/null; status=$?; fi
exec 8>> "$log"
flock 8
printf '== %s %s (exit %s)\n' "$(date -u +%H:%M:%S)" "$label" "$status" >&8
cat "$out" >&8
printf '\n' >&8
rm -f "$out"
exit "$status"
