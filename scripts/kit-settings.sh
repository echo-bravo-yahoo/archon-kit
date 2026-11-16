#!/usr/bin/env bash
# usage: kit-settings.sh <key> [default]
#
# Reads one setting of the Archon kit from $ARCHON_HOME/kit.json (default ~/.archon/kit.json), a
# flat JSON object that belongs to the person who installed the kit. A string value prints bare
# and any other value prints as compact JSON. A missing file or key prints the default. A file
# that is not a valid JSON object is an error, so a typo does not fall back to the defaults.
# The keys:
#   workspace    the directory that holds the repositories runs may start work in (default $HOME/workspace)
#   run_env      an object of environment variables that every run the kit starts receives (default {})
#   scratch_dirs directory names whose untracked content never counts as work to save (default [])
#   done         workflow-done registry entries that apply to every repository (default {})
#   handoffs     hand-offs that any repository may offer; see docs/extending.md (default [])
#   plan_rules   path of a Markdown file of planning rules that build gives its planner (default none)
#   approach_check  true makes build ask for an approach before the full plan (default false)
set -uo pipefail

USAGE='usage: kit-settings.sh <key> [default]'
key=${1:?$USAGE}
if [ "$#" -ge 2 ]; then
  default=$2
else
  case "$key" in
    workspace) default=$HOME/workspace ;;
    run_env | done) default='{}' ;;
    scratch_dirs | handoffs) default='[]' ;;
    *) default= ;;
  esac
fi

spec=${ARCHON_HOME:-$HOME/.archon}/kit.json
[ -f "$spec" ] || { printf '%s\n' "$default"; exit 0; }
value=$(jq -r --arg k "$key" 'if type == "object" then (.[$k] // empty | if type == "string" then . else tojson end) else error("not an object") end' "$spec") \
  || { printf 'cannot read %s as a JSON object\n' "$spec" >&2; exit 1; }
printf '%s\n' "${value:-$default}"
