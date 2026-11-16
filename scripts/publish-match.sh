#!/usr/bin/env bash
# usage: publish-match.sh <base> <head>
#
# Prints, as a compact JSON array, the `publish` hand-offs that the change between two refs
# triggers: one for each target of `publish` in the main checkout's .archon/build.json that has
# an `auto_paths` array and whose paths the diff `<base>...<head>` touches, less the files that
# match its `skip_paths`. Each entry is
#   { "workflow": "publish", "repo": "", "inputs": [{ "name": "target", "value": "<name>" }], "note": "changed <first path>" }
# The array is [] when nothing matches or no target is declared. A missing argument exits 2 and a
# git failure, such as an unknown ref, exits 1 with git's message.
set -uo pipefail

USAGE='usage: publish-match.sh <base> <head>'
base=${1:-}
head=${2:-}
if [ -z "$base" ] || [ -z "$head" ]; then printf '%s\n' "$USAGE" >&2; exit 2; fi

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
common=$(git rev-parse --path-format=absolute --git-common-dir) || exit 1
main=$(dirname "$common")
targets=$(cd "$main" && "$here/build-settings.sh" publish) || exit 1
if ! printf '%s' "$targets" | jq -e 'type == "array"' > /dev/null 2>&1; then
  printf '[]\n'
  exit 0
fi

out='[]'
while IFS= read -r target; do
  [ -n "$target" ] || continue
  name=$(printf '%s' "$target" | jq -r .name)
  specs=()
  while IFS= read -r p; do
    [ -z "$p" ] || specs+=(":(glob)$p")
  done < <(printf '%s' "$target" | jq -r '.auto_paths[] | select(type == "string")')
  [ "${#specs[@]}" -gt 0 ] || continue
  while IFS= read -r p; do
    [ -z "$p" ] || specs+=(":(exclude,glob)$p")
  done < <(printf '%s' "$target" | jq -r '(.skip_paths // [])[] | select(type == "string")')
  changed=$(git diff --name-only "$base...$head" -- "${specs[@]}") || exit 1
  [ -n "$changed" ] || continue
  first=$(printf '%s\n' "$changed" | head -n 1)
  out=$(printf '%s' "$out" | jq -c --arg n "$name" --arg f "$first" \
    '. + [{workflow: "publish", repo: "", inputs: [{name: "target", value: $n}], note: ("changed " + $f)}]')
done < <(printf '%s' "$targets" | jq -c '.[] | select(type == "object" and (.name | type) == "string" and (.auto_paths | type) == "array")')
printf '%s\n' "$out"
