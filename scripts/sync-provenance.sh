#!/usr/bin/env bash
# usage: sync-provenance.sh <base> <pre>
#
# Run in a worktree after a rebase onto <base> finished, with <pre> the branch tip before it.
# The merge stage may write the protected set and the three .archon/*.json files, provided it
# only keeps lines that one of the two sides already had. This prints each guarded file that
# holds a line which is in neither <pre>'s version nor <base>'s version of the file, one path
# per line. The guarded files are .archon/gates.json, .archon/lanes.json, .archon/build.json
# and the globs of the `protected` set in .archon/lanes.json (none when it declares no set).
# A binary guarded file passes only when it equals its blob at <pre> or <base>.
# Exits 0 when no file fails, 1 when some do, 2 on a usage error.
set -uo pipefail

USAGE='usage: sync-provenance.sh <base> <pre>'
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
[ "$#" -eq 2 ] || { printf '%s\n' "$USAGE" >&2; exit 2; }
base=$1
pre=$2

specs=(":(glob).archon/gates.json" ":(glob).archon/lanes.json" ":(glob).archon/build.json")
while IFS= read -r g; do
  [ -n "$g" ] && specs+=("$g")
done < <(bash "$here/lane.sh" list --set protected 2> /dev/null)

failed=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  git cat-file -e "HEAD:$f" 2> /dev/null || continue
  numstat=$(git diff --numstat --no-renames "$base" HEAD -- "$f")
  case "$numstat" in
    -*)
      blob=$(git rev-parse "HEAD:$f")
      if [ "$blob" != "$(git rev-parse "$pre:$f" 2> /dev/null)" ] && [ "$blob" != "$(git rev-parse "$base:$f" 2> /dev/null)" ]; then
        printf '%s\n' "$f"
        failed=1
      fi
      continue
      ;;
  esac
  # The awk skips the ---/+++ header lines because they come before the first hunk header.
  added=$(git diff --no-color -U0 --no-renames "$base" HEAD -- "$f" | awk '/^@@/ { h = 1; next } h && /^\+/ { print substr($0, 2) }')
  [ -n "$added" ] || continue
  if printf '%s\n' "$added" | grep -Fxvf <({ git show "$pre:$f"; git show "$base:$f"; } 2> /dev/null) > /dev/null; then
    printf '%s\n' "$f"
    failed=1
  fi
done < <(git diff --name-only --no-renames "$base" HEAD -- "${specs[@]}")

exit "$failed"
