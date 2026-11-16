#!/usr/bin/env bash
# usage: state.sh set <key> <value>   append key=value to the run's state file
#        state.sh get <key>           print the last value set for the key, or nothing
# The file is $ARTIFACTS_DIR/state. A key is lowercase letters, digits and dashes; a value is one line.
set -uo pipefail
USAGE='usage: state.sh set <key> <value> | state.sh get <key>'
cmd=${1:-}; key=${2:-}
[ -n "$key" ] || { printf '%s\n' "$USAGE" >&2; exit 2; }
case "$key" in *[!a-z0-9-]*) printf 'bad key: %s\n' "$key" >&2; exit 2 ;; esac
file="${ARTIFACTS_DIR:?ARTIFACTS_DIR is not set}/state"
case "$cmd" in
  set)
    value=${3-}
    case "$value" in *$'\n'*) printf 'a value is one line\n' >&2; exit 2 ;; esac
    ( flock 9; printf '%s=%s\n' "$key" "$value" >&9 ) 9>> "$file" ;;
  get)
    [ -f "$file" ] || exit 0
    awk -F= -v k="$key" '$1 == k { v = substr($0, length(k) + 2) } END { if (v != "") print v }' "$file" ;;
  *) printf '%s\n' "$USAGE" >&2; exit 2 ;;
esac
