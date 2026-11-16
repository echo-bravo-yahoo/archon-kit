#!/usr/bin/env bash
# usage: due-instant.sh <when>
#
# Prints <when> as an ISO-8601 UTC instant (2026-11-03T09:00:00Z) and exits 0, or says why not
# on stderr and exits 1. <when> is such an instant already, or a GNU date expression such as
# '+7 days' or 'next monday 09:00', which counts from now. An instant that is not in the future
# fails. The `due` node of check-later and `start-run.sh check` both call it, so a proposal is
# judged by the rule the run applies when it starts.
set -euo pipefail

spec=${1:?usage: due-instant.sh <when>}
case "$spec" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z) at="$spec" ;;
  *)
    # A relative time needs GNU date's -d. macOS and the BSDs ship a date without it, and Homebrew's coreutils installs GNU date as gdate.
    d='date'
    if command -v gdate > /dev/null 2>&1; then d=gdate; fi
    if ! "$d" -u -d @0 > /dev/null 2>&1; then
      printf 'relative times need GNU date (macOS: brew install coreutils, which provides gdate); pass an ISO-8601 instant such as 2026-11-03T09:00:00Z\n' >&2
      exit 1
    fi
    at=$("$d" -u -d "$spec" +%Y-%m-%dT%H:%M:%SZ)
    ;;
esac
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# ISO-8601 UTC sorts lexicographically, so the future check needs no date
# parsing and the ISO path stays portable off Linux.
[ "$at" \> "$now" ] || { printf 'instant %s is not in the future (now %s)\n' "$at" "$now" >&2; exit 1; }
printf '%s\n' "$at"
