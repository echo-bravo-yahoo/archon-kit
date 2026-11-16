#!/usr/bin/env bash
# usage: start-run.sh candidates [--also build]
#        start-run.sh check [--also build] <proposal.json|->
#        start-run.sh start [--strict] [--retries N] <checked.json> <sha> [message-file]
#        start-run.sh run <workflow> [--input k=v]... [--adopt <run-id>] [message]
#
# Owns every way one Archon run starts another. The workflows a plan or a research report may
# propose are the `handoffs` array in the main checkout's .archon/build.json, each entry
#   { "workflow": "deploy-staging", "use_when": "...", "ask": ["service"], "optional": ["region"], "pass_ref": true }
# where `ask` names the inputs the proposer must supply, `optional` names inputs the proposer
# may supply and need not, and `pass_ref` has the new run receive the delivered commit as its
# `ref` input.
#
# A global hand-off is an entry of the same shape in `handoffs` of $ARCHON_HOME/kit.json, with a
# `repo` that names a repository under the workspace:
#   { "workflow": "publish-docs", "repo": "site", "use_when": "...", "ask": [] }
# It is available to every repository when <workspace>/<repo>/.archon/workflows/<workflow>/<workflow>.yaml
# exists, and it starts in that repository without `ref`. A hand-off that the current repository
# declares itself replaces a global one of the same name. The workspace is START_RUN_WORKSPACE, else
# `workspace` in kit.json, else ~/workspace.
#
#   candidates  prints one sentence for each workflow that may be proposed. --also build adds
#               `build` first when it can start in this repository (`build_ready`), for findings
#               that call for a change to the repository's own files, then a `build in <name>`
#               line for each other repository under the workspace where `build` can start, then
#               one line for each available global hand-off.
#               In a git repository that declares no `check-later` of its own, a `check-later`
#               line comes last, for a claim that only a later look can confirm.
#   check       reads a JSON array of { workflow, repo, inputs: [{name, value}], note } from the
#               file, or from standard input when the argument is `-`, and prints it without the
#               entries whose workflow is not declared (and is neither `build` nor, under
#               --also build, an available global hand-off, nor, in a git repository,
#               `check-later`), whose input names are not its `ask` and `optional` names (and
#               omit an `ask` name), or whose `repo`
#               names anything but a repository that `build` can start in, and without repeats
#               and entries past the fifth. An entry for `build`, declared or not, may also carry
#               the optional input `interactive`, whose only valid value is `yes`: it starts the
#               build with an implementer that may ask the owner questions while it builds. `repo`
#               is empty for this repository, and always empty for a global hand-off (a `repo`
#               naming the hand-off's own repository is accepted and emptied). A `check-later` that the repository does not declare asks for
#               `when` and `claim`; `when` has to be an instant that due-instant.sh accepts and
#               `claim` cannot be empty. One line on stderr names each removal. An unreadable
#               proposal prints [].
#   start       starts each entry of a checked array through `run`, with `ref=<sha>` where the
#               declaration says pass_ref. An entry with a `repo` starts in that repository under
#               the workspace, and a global hand-off that this repository does not declare starts
#               in the repository its entry names; neither passes `ref`, because `ref` names a
#               commit of this repository. The message is the entry's note, or the message file's text when one
#               is given, followed by the note under a `## Scope of this run` heading when the
#               note is not empty, except that a `check-later` gets no message, because the
#               workflow ignores it. It prints one line for each entry and exits 0
#               even when an entry did not start, because a build's change has already been
#               delivered; --strict exits 1 instead. --retries N tries each entry up to N times
#               (default 1), sleeping START_RUN_RETRY_SLEEP seconds (default 2) between tries.
#               A `publish` key in build.json (targets with `name` and `use_when`) gives the
#               repository a `publish` hand-off that asks for `target` and passes `ref`, unless
#               `handoffs` declares `publish` itself; check drops a target the key does not name.
#   run         starts one detached run from the main checkout, so Archon cuts the new run's
#               worktree itself, and prints its run id. The environment variables in `run_env` of
#               kit.json are set for the run. When ARTIFACTS_DIR names a run's artifacts directory
#               (its basename is the run id), the new run starts with that run's config layer, so a
#               hand-off started by a run that was given --config uses the same provider and models.
#               Unless the run adopts another, it also passes --base <branch> when the repository
#               names its base branch locally: `base` in build.json, else the branch origin/HEAD
#               names, else main or master when origin has it. Archon then does not ask the remote
#               for the default branch, a call that it abandons after 10 s. Archon rejects --adopt
#               together with --base, so an adopting run gets no --base.
set -uo pipefail

USAGE='usage: start-run.sh candidates [--also build] | check [--also build] <proposal.json|-> | start [--strict] [--retries N] <checked.json> <sha> [message-file] | run <workflow> [--input k=v]... [--adopt <run-id>] [message]'
INTERACTIVE_NOTE='Optional: interactive=yes, when the work cannot finish without the owner trying something and reporting back partway, such as trying a build on a device.'
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ -n "${START_RUN_WORKSPACE:-}" ]; then
  WS=$START_RUN_WORKSPACE
else
  WS=$("$here/kit-settings.sh" workspace) || exit 1
fi
# shellcheck disable=SC2088
case "$WS" in
  '~') WS=$HOME ;;
  '~/'*) WS=$HOME/${WS#'~/'} ;;
esac

main_worktree() {
  local common
  common=$(git rev-parse --path-format=absolute --git-common-dir) || return 1
  dirname "$common"
}

# The declared array, or [] when the file lacks one or holds something else.
declared() {
  local main out
  main=$(main_worktree) || { printf '[]\n'; return 0; }
  out=$(cd "$main" && "$here/build-settings.sh" handoffs) || { printf '[]\n'; return 0; }
  if printf '%s' "$out" | jq -e 'type == "array"' > /dev/null 2>&1; then
    out=$(printf '%s' "$out" | jq -c .)
  else
    printf 'start-run: handoffs in build.json is not an array; ignoring it\n' >&2
    out='[]'
  fi
  local targets
  targets=$(publish_targets "$main")
  if [ "$(printf '%s' "$targets" | jq 'length')" -gt 0 ] \
    && ! printf '%s' "$out" | jq -e 'map(select(.workflow == "publish")) | length > 0' > /dev/null 2>&1; then
    out=$(printf '%s' "$out" | jq -c --argjson t "$targets" '. + [{workflow: "publish", pass_ref: true, ask: ["target"],
      use_when: ($t | map("\(.name): \(.use_when // "the owner asks for it")") | join("; "))}]')
  fi
  printf '%s\n' "$out"
}

# The publish targets of build.json in the main checkout $1 that have a string name, as a JSON array.
publish_targets() {
  local raw
  raw=$(cd "$1" && "$here/build-settings.sh" publish) || { printf '[]\n'; return 0; }
  if printf '%s' "$raw" | jq -e 'type == "array"' > /dev/null 2>&1; then
    printf '%s' "$raw" | jq -c 'map(select(type == "object" and (.name | type) == "string"))'
  else
    printf 'start-run: publish in build.json is not an array; ignoring it\n' >&2
    printf '[]\n'
  fi
}

# The global hand-offs (kit.json `handoffs`) that can start now, as a JSON array: the entry names a
# workflow file that exists in its repository under the workspace, and the repository named in $1
# (the declared array) does not declare the same workflow.
global_handoffs() {
  local declared=${1:-[]} raw entry wf repo out=""
  raw=$("$here/kit-settings.sh" handoffs) || { printf '[]\n'; return 0; }
  if ! printf '%s' "$raw" | jq -e 'type == "array"' > /dev/null 2>&1; then
    printf 'start-run: handoffs in kit.json is not an array; ignoring it\n' >&2
    printf '[]\n'
    return 0
  fi
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    wf=$(printf '%s' "$entry" | jq -r .workflow)
    repo=$(printf '%s' "$entry" | jq -r .repo)
    if [ "$wf" = build ] || [ "$wf" = check-later ]; then
      printf 'start-run: ignoring the kit.json hand-off %s: that name is built in\n' "$wf" >&2
    elif printf '%s' "$declared" | jq -e --arg w "$wf" 'map(select(.workflow == $w)) | length > 0' > /dev/null 2>&1; then
      :
    elif [ -f "$WS/$repo/.archon/workflows/$wf/$wf.yaml" ]; then
      out="$out$entry"$'\n'
    fi
  done < <(printf '%s' "$raw" | jq -c '.[]
    | select(type == "object" and (.workflow | type) == "string" and (.repo | type) == "string")
    | select((.workflow | test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and (.repo | test("^[A-Za-z0-9][A-Za-z0-9._-]*$")))')
  printf '%s' "$out" | jq -s -c .
}

# Succeeds when `build` would pass its start-up checks in <dir>: the four that its
# `gates_declared` and `lanes_declared` nodes make.
build_ready() {
  ( cd "$1" && bash "$here/run-gates.sh" feature --list && bash "$here/run-gates.sh" tests --list \
    && bash "$here/lane.sh" list && bash "$here/lane.sh" verify ) > /dev/null 2>&1
}

# The name of each other repository under the workspace that `build` can start in, one per line.
ready_repos() {
  local self d name
  self=$(basename "$(main_worktree 2> /dev/null)")
  for d in "$WS"/*/; do
    name=$(basename "$d")
    [ -d "$d/.git" ] || continue
    [ "$name" != "$self" ] || continue
    if build_ready "$d"; then printf '%s\n' "$name"; fi
  done
}

take_also() {
  ALSO=false
  if [ "${1:-}" = "--also" ]; then
    [ "${2:-}" = build ] || { printf '%s\n' "$USAGE" >&2; exit 2; }
    ALSO=true
    shift 2
  fi
  REST=("$@")
}

# Prints the branch to cut a new run's worktree from, or nothing when the repository in <dir> does not
# say. It reads only local state: `base` in build.json, else the branch origin/HEAD names, else main or
# master when origin has it. Without --base, Archon asks the remote for its default branch and abandons
# the call after 10 s, which fails the launch on a slow connection. A build.json that cannot be read is
# an error here, as it is for `build`.
base_branch() {
  local dir=$1 b cand
  b=$(cd "$dir" && "$here/build-settings.sh" base '') || return 1
  if [ -z "$b" ]; then
    b=$(git -C "$dir" symbolic-ref -q --short refs/remotes/origin/HEAD 2> /dev/null || true)
    b=${b#origin/}
  fi
  if [ -z "$b" ]; then
    for cand in main master; do
      if git -C "$dir" show-ref --verify -q "refs/remotes/origin/$cand"; then
        b=$cand
        break
      fi
    done
  fi
  printf '%s\n' "$b"
}

do_run() {
  local wf=${1:?$USAGE} main out id base
  shift
  local args=() msg="" adopting=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --input) args+=("$1" "${2:?$USAGE}"); shift 2 ;;
      --adopt) args+=("$1" "${2:?$USAGE}"); adopting=true; shift 2 ;;
      *) msg=$1; shift ;;
    esac
  done
  main=$(main_worktree) || { printf 'start-run: not inside a git repository\n' >&2; return 1; }
  local envs=() kv run_id
  while IFS= read -r kv; do
    [ -z "$kv" ] || envs+=("$kv")
  done < <("$here/kit-settings.sh" run_env | jq -r 'if type == "object" then to_entries[] | select(.key | test("^[A-Za-z_][A-Za-z0-9_]*$")) | "\(.key)=\(.value | tostring)" else empty end' 2> /dev/null)
  # A run's artifacts directory is named by its run id, which `--config-from-run` accepts (and
  # rejects when it is unknown, so a directory that is not a run's is not passed).
  if [ -n "${ARTIFACTS_DIR:-}" ]; then
    run_id=$(basename "$ARTIFACTS_DIR")
    if printf '%s' "$run_id" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
      args+=(--config-from-run "$run_id")
    fi
  fi
  # Archon refuses --adopt and --base together: an adopting run reuses the adopted worktree or cuts a
  # fresh one from the adopted run's branch.
  if ! $adopting; then
    base=$(base_branch "$main") || return 1
    [ -z "$base" ] || args+=(--base "$base")
  fi
  if [ -n "$msg" ]; then
    out=$(cd "$main" && env ${envs[@]+"${envs[@]}"} archon workflow run "$wf" --detach ${args[@]+"${args[@]}"} "$msg" < /dev/null 2>&1)
  else
    out=$(cd "$main" && env ${envs[@]+"${envs[@]}"} archon workflow run "$wf" --detach ${args[@]+"${args[@]}"} < /dev/null 2>&1)
  fi
  local status=$?
  id=$(printf '%s\n' "$out" | sed -n 's/^Run id: //p' | head -n 1)
  if [ "$status" -ne 0 ] || [ -z "$id" ]; then
    printf 'archon did not start %s:\n%s\n' "$wf" "$out" >&2
    return 1
  fi
  printf '%s\n' "$id"
}

cmd=${1:-}
[ -n "$cmd" ] || { printf '%s\n' "$USAGE" >&2; exit 2; }
shift

case "$cmd" in
  candidates)
    take_also "$@"
    [ "${#REST[@]}" -eq 0 ] || { printf '%s\n' "$USAGE" >&2; exit 2; }
    if [ "$ALSO" = true ]; then
      if main=$(main_worktree 2> /dev/null) && build_ready "$main"; then
        printf "build — use when the work changes the repository's own files; it cannot change files outside this repository. Inputs to supply: none. %s\n" "$INTERACTIVE_NOTE"
      fi
      while IFS= read -r name; do
        [ -z "$name" ] || printf "build in %s — use when the work changes %s's own files, and set repo to %s. Inputs to supply: none. %s\n" "$name" "$name" "$name" "$INTERACTIVE_NOTE"
      done < <(ready_repos)
    fi
    decl=$(declared)
    if [ "$ALSO" = true ]; then
      global_handoffs "$decl" | jq -r '.[] | "\(.workflow) — use when \((.use_when // "the owner asks for it") | sub("\\.$"; "")). It starts in the \(.repo) repository, not in this one. Inputs to supply: \((.ask // []) | if length == 0 then "none" else join(", ") end).\((.optional // []) | if length == 0 then "" else " Optional: " + join(", ") + "." end)"'
    fi
    printf '%s' "$decl" | jq -r '.[] | "\(.workflow) — use when \(.use_when // "the owner asks for it"). Inputs to supply: \((.ask // []) | if length == 0 then "none" else join(", ") end).\((.optional // []) | if length == 0 then "" else " Optional: " + join(", ") + "." end)"'
    # Only in a git repository: a folder project holds a path-exclusive lock for as long as
    # the check waits.
    if main_worktree > /dev/null 2>&1 && ! printf '%s' "$decl" | jq -e 'map(select(.workflow == "check-later")) | length > 0' > /dev/null 2>&1; then
      printf 'check-later — use when the work leaves a claim that only a later look can confirm, such as that a fix held, a migration finished or a deprecation was removed. Give when as a relative time such as +7 days, which counts from when the follow-up starts, and a claim that can be checked from the repository. Inputs to supply: when, claim.\n'
    fi
    ;;

  check)
    take_also "$@"
    file=${REST[0]:?$USAGE}
    if [ "$file" = - ]; then input=$(cat); else input=$(cat "$file" 2> /dev/null || true); fi
    if ! printf '%s' "$input" | jq -e 'type == "array"' > /dev/null 2>&1; then
      printf 'start-run: the proposal is not a JSON array; using none\n' >&2
      printf '[]\n'
      exit 0
    fi
    decl=$(declared)
    pubnames=null
    if main=$(main_worktree 2> /dev/null); then
      targets=$(publish_targets "$main" 2> /dev/null)
      if [ "$(printf '%s' "$targets" | jq 'length')" -gt 0 ] \
        && ! (cd "$main" && "$here/build-settings.sh" handoffs) | jq -e 'type == "array" and any(.[]; .workflow == "publish")' > /dev/null 2>&1; then
        pubnames=$(printf '%s' "$targets" | jq -c 'map(.name)')
      fi
    fi
    repos='[]'
    globals='[]'
    cl=false
    if main_worktree > /dev/null 2>&1; then cl=true; fi
    if [ "$ALSO" = true ]; then
      repos=$(ready_repos | jq -R . | jq -sc .)
      globals=$(global_handoffs "$decl")
    fi
    self=$(basename "$(main_worktree 2> /dev/null)")
    kept=""
    count=0
    seen=$'\n'
    # At most five entries, and no repeat of an entry already kept: one report must not start an
    # unbounded number of runs, or two runs on the same repository for the same brief. The key
    # includes the inputs, so a hand-off for two fragments is not a repeat.
    while IFS=$'\t' read -r kind payload; do
      case "$kind" in
        drop) printf 'start-run: %s\n' "$payload" >&2 ;;
        ok)
          key=$(printf '%s' "$payload" | jq -c '[.workflow, .repo, .inputs]')
          wf=$(printf '%s' "$payload" | jq -r .workflow)
          when=$(printf '%s' "$payload" | jq -r '[.inputs[] | select(.name == "when") | .value][0] // empty')
          if [ "$wf" = check-later ] && [ -n "$when" ] && ! why=$("$here/due-instant.sh" "$when" 2>&1 > /dev/null); then
            printf 'start-run: dropped check-later: when "%s": %s\n' "$when" "$why" >&2
          elif [[ "$seen" == *$'\n'"$key"$'\n'* ]]; then
            printf 'start-run: dropped %s: already proposed\n' "$wf" >&2
          elif [ "$count" -ge 5 ]; then
            printf 'start-run: dropped %s: at most five follow-ups\n' "$wf" >&2
          else
            seen="$seen$key"$'\n'
            count=$((count + 1))
            kept="$kept$payload"$'\n'
          fi
          ;;
      esac
    done < <(printf '%s' "$input" | jq -r --argjson decl "$decl" --argjson also "$ALSO" \
        --argjson repos "$repos" --argjson globals "$globals" --argjson cl "$cl" --arg self "$self" --argjson pubnames "$pubnames" '
      .[] | . as $e
      | if ($e | type) != "object" or ($e.workflow | type) != "string" then
          "drop\tdropped an entry with no workflow name"
        else
          (($e.repo // "") | if type == "string" then . else "" end) as $given
          | ($decl | map(select(.workflow == $e.workflow)) | first) as $d
          | (if $d == null then ($globals | map(select(.workflow == $e.workflow)) | first) else null end) as $g
          | (if $given == $self or ($g != null and $given == $g.repo) then "" else $given end) as $repo
          | if $repo != "" and $e.workflow != "build" then
              "drop\tdropped \($e.workflow) in \($repo): only build runs in another repository"
            elif $repo != "" and ($repos | map(select(. == $repo)) | length) == 0 then
              "drop\tdropped build in \($repo): build cannot run there"
            elif $d == null and ((($also and ($e.workflow == "build" or $g != null)) or ($e.workflow == "check-later" and $cl)) | not) then
              "drop\tdropped \($e.workflow): the repository declares no such hand-off"
            else
              (if $d != null then ($d.ask // []) elif $g != null then ($g.ask // []) elif $e.workflow == "check-later" then ["when", "claim"] else [] end) as $ask
              | (($e.inputs // []) | if type == "array" then . else [] end
                 | map(select(type == "object" and (.name | type) == "string"))) as $in
              | ($in | map(.name)) as $names
              | ($ask + (if $d != null then ($d.optional // []) elif $g != null then ($g.optional // []) else [] end) + (if $e.workflow == "build" then ["interactive"] else [] end)) as $allowed
              | ($in | map(select(.name == "when" or .name == "claim") | ((.value // "") | tostring | gsub("\\s"; "")))) as $vals
              | if (($names - $allowed) | length) > 0 then
                  "drop\tdropped \($e.workflow): it takes no input \(($names - $allowed) | join(", "))"
                elif (($ask - $names) | length) > 0 then
                  "drop\tdropped \($e.workflow): it needs the input \(($ask - $names) | join(", "))"
                elif $e.workflow == "publish" and $pubnames != null and ($in | any(.name == "target" and (((.value // "") | tostring) as $v | ($pubnames | index($v)) == null))) then
                  "drop\tdropped publish: no target named \(($in | map(select(.name == "target") | ((.value // "") | tostring)) | first))"
                elif $e.workflow == "build" and ($in | any(.name == "interactive" and ((.value // "") | tostring) != "yes")) then
                  "drop\tdropped build: interactive must be yes"
                elif $d == null and $e.workflow == "check-later" and ($vals | any(. == "")) then
                  "drop\tdropped check-later: when and claim cannot be empty"
                else
                  "ok\t" + ({workflow: $e.workflow,
                             repo: $repo,
                             inputs: ($in | map({name, value: ((.value // "") | tostring)})),
                             note: (($e.note // "") | tostring)} | tojson)
                end
            end
        end')
    printf '%s' "$kept" | jq -s -c .
    ;;

  start)
    strict=0
    retries=1
    while [ $# -gt 0 ]; do
      case "$1" in
        --strict) strict=1; shift ;;
        --retries)
          retries=${2:-}
          case "$retries" in
            ''|*[!0-9]*|0) printf 'start-run: --retries takes an integer of at least 1\n%s\n' "$USAGE" >&2; exit 2 ;;
          esac
          shift 2
          ;;
        *) break ;;
      esac
    done
    file=${1:?$USAGE}
    sha=${2:?$USAGE}
    msgfile=${3:-}
    jq -e 'type == "array"' "$file" > /dev/null 2>&1 || { printf 'start-run: %s is not a JSON array\n' "$file" >&2; exit 1; }
    decl=$(declared)
    globals=$(global_handoffs "$decl")
    failed=0
    errf=$(mktemp)
    while IFS= read -r entry; do
      wf=$(printf '%s' "$entry" | jq -r .workflow)
      repo=$(printf '%s' "$entry" | jq -r '.repo // ""')
      dir=.
      if [ -n "$repo" ]; then
        dir="$WS/$repo"
      else
        grepo=$(printf '%s' "$globals" | jq -r --arg w "$wf" 'map(select(.workflow == $w)) | first.repo // empty')
        if [ -n "$grepo" ]; then dir="$WS/$grepo"; fi
      fi
      args=()
      if [ "$dir" = . ] && printf '%s' "$decl" | jq -e --arg w "$wf" 'map(select(.workflow == $w and .pass_ref == true)) | length > 0' > /dev/null 2>&1; then
        args+=(--input "ref=$sha")
      fi
      while IFS= read -r kv; do
        [ -z "$kv" ] || args+=(--input "$kv")
      done < <(printf '%s' "$entry" | jq -r '.inputs[]? | "\(.name)=\(.value)"')
      note=$(printf '%s' "$entry" | jq -r '.note // ""')
      if [ "$wf" = check-later ]; then
        msg=""
      elif [ -n "$msgfile" ]; then
        msg=$(cat "$msgfile")
        if [ -n "$note" ]; then msg=$(printf '%s\n\n## Scope of this run\n\n%s' "$msg" "$note"); fi
      else
        msg=$note
      fi
      # do_run starts from the main worktree of the directory it is in.
      attempt=0
      id=""
      while [ "$attempt" -lt "$retries" ] && [ -z "$id" ]; do
        [ "$attempt" -eq 0 ] || sleep "${START_RUN_RETRY_SLEEP:-2}"
        attempt=$((attempt + 1))
        : > "$errf"
        if [ -n "$msg" ]; then
          id=$(cd "$dir" && do_run "$wf" ${args[@]+"${args[@]}"} "$msg" 2> "$errf")
        else
          id=$(cd "$dir" && do_run "$wf" ${args[@]+"${args[@]}"} 2> "$errf")
        fi
      done
      if [ -n "$id" ]; then
        printf 'started %s, run %s\n' "$wf" "$id"
      else
        failed=1
        printf 'did not start %s: %s\n' "$wf" "$(head -n 3 "$errf" | tr '\n' ' ')"
      fi
    done < <(jq -c '.[]' "$file")
    rm -f "$errf"
    [ "$failed" -eq 0 ] || [ "$strict" -eq 0 ] || exit 1
    ;;

  run)
    do_run "$@"
    ;;

  *) printf 'unknown command %s\n%s\n' "$cmd" "$USAGE" >&2; exit 2 ;;
esac
