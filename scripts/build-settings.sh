#!/usr/bin/env bash
# usage: build-settings.sh <key> [default]
#        build-settings.sh --repo
#        build-settings.sh --main-worktree
#        build-settings.sh --design-dir <slug>
#
# Reads the settings the `build` workflow takes from the repository it runs in:
# .archon/build.json in the current checkout, an optional flat JSON object. A key prints its
# value, or the default (empty when none is given) when the file or the key is missing. A
# file that is not valid JSON is an error, so a typo does not fall back to the defaults.
# A key whose value is not a string prints it as compact JSON. Four keys have a built-in
# default that applies when the call gives none: `base` (main), `deliver` (land),
# `handoffs` ([]) and `publish` ([]).
# `report_cmd` (a command that replaces the report page builder) and `report_plugin` (a repository-relative
# ES module that adds to the kit's page) have no default.
# --main-worktree prints the path of the repository's main worktree and --repo its basename,
# which is also the directory name under ~/.archon/designs/ that holds the run's reports.
# --design-dir <slug> prints ~/.archon/designs/<repo>/<slug>, where one design's reports live.
# None of the three needs a build.json. The main-worktree expression is the one research.yaml
# uses.
set -uo pipefail

USAGE='usage: build-settings.sh <key> [default] | --repo | --main-worktree | --design-dir <slug>'

main_worktree() {
  local common
  common=$(git rev-parse --path-format=absolute --git-common-dir) || return 1
  dirname "$common"
}

case "${1:?$USAGE}" in
  --main-worktree) main_worktree ;;
  --repo) wt=$(main_worktree) || exit 1; basename "$wt" ;;
  --design-dir)
    slug=${2:?$USAGE}
    wt=$(main_worktree) || exit 1
    printf '%s/designs/%s/%s\n' "${ARCHON_HOME:-$HOME/.archon}" "$(basename "$wt")" "$slug"
    ;;
  -*) printf '%s\n' "$USAGE" >&2; exit 2 ;;
  *)
    key=$1
    if [ "$#" -ge 2 ]; then
      default=$2
    else
      case "$key" in
        base) default=main ;;
        deliver) default=land ;;
        handoffs) default='[]' ;;
        publish) default='[]' ;;
        *) default= ;;
      esac
    fi
    spec=.archon/build.json
    [ -f "$spec" ] || { printf '%s\n' "$default"; exit 0; }
    value=$(jq -r --arg k "$key" 'if type == "object" then (.[$k] // empty | if type == "string" then . else tojson end) else error("not an object") end' "$spec") \
      || { printf 'cannot read %s as a JSON object\n' "$spec" >&2; exit 1; }
    printf '%s\n' "${value:-$default}"
    ;;
esac
