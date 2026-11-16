#!/usr/bin/env bash
# usage: uninstall.sh
#
# Removes the files that install.sh recorded in $ARCHON_HOME/kit-installed.json (default
# ~/.archon), the archon-kit link, and the directories that are left empty. It keeps config.yaml,
# kit.json and everything else under $ARCHON_HOME, and it removes nothing the record does not list.
set -euo pipefail

AH=${ARCHON_HOME:-$HOME/.archon}
RECORD=$AH/kit-installed.json
[ -f "$RECORD" ] || { printf 'uninstall.sh: %s does not exist, so there is nothing to remove\n' "$RECORD" >&2; exit 1; }
command -v jq > /dev/null 2>&1 || { printf 'uninstall.sh: jq is required\n' >&2; exit 1; }

n=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if [ -e "$f" ] || [ -L "$f" ]; then
    rm -f -- "$f"
    n=$((n + 1))
  fi
done < <(jq -r '.files[]?' "$RECORD")
find "$AH/workflows/kit" "$AH/scripts" "$AH/profiles" "$AH/kit" -type d -empty -delete 2> /dev/null || true
rmdir "$AH/workflows" 2> /dev/null || true
rm -f "$RECORD"
printf 'removed %d file(s); config.yaml and kit.json are kept\n' "$n"
