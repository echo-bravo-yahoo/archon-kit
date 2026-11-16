#!/usr/bin/env bash
# usage: codex-lane-probe.sh [--provider codex|claude] [--keep]
#
# Runs one small agent through the lane hook and records what happened, so that the questions
# the kit cannot settle without the provider get answered: whether a PreToolUse hook fires inside
# an Archon node, what an apply_patch call and a shell call look like to a hook, which writes the
# hook refuses, and what the check at the end of the stage sees. The probe builds a throwaway
# repository under $HOME, runs a workflow of one agent node with `archon workflow run`, and
# writes a Markdown report to ~/codex-lane-probe-report-<UTC date>.md. Send that file to the
# maintainer.
#
#   --provider P  the provider that runs the agent: codex (the default) or claude. claude runs the
#                 same probe with the Claude hook, which checks this script on a host that has no
#                 Codex; it costs about two cents.
#   --keep        leave the probe repositories and artifacts in place. The report is always kept.
#
# With codex the probe runs two cases. The `user` case relies on the hook block that
# `archon-kit hooks install codex` writes to ${CODEX_HOME:-~/.codex}/config.toml, so install and
# trust that block first. The `repo` case puts the block in the probe repository's
# .codex/config.toml. Both cases also register a capture hook that records the shape of every
# tool call. Exits 0 when the probe ran (whatever it found), 2 when a prerequisite is missing.

# shellcheck disable=SC2012
set -uo pipefail

PROVIDER=codex
KEEP=0

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }
usage_error() { printf 'usage: codex-lane-probe.sh [--provider codex|claude] [--keep]\n' >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --provider) [ $# -ge 2 ] || usage_error; PROVIDER=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) usage_error ;;
  esac
done
case "$PROVIDER" in codex | claude) ;; *) usage_error ;; esac

# ---- preflight ----------------------------------------------------------------------------------
# Only shell builtins run before this ends, so a missing tool is reported and not hidden by
# another missing tool.
AH=${ARCHON_HOME:-$HOME/.archon}
bad=0
missing() { printf 'missing: %s\n' "$1" >&2; bad=1; }
have() { command -v "$1" > /dev/null 2>&1; }

if [ "$PROVIDER" = codex ]; then
  have codex || missing "codex is not on PATH. Install Codex, then run: archon provider add codex"
else
  have claude || missing "claude is not on PATH. Install Claude Code"
fi
have archon || missing "archon is not on PATH. Install Archon 0.13.2"
have jq || missing "jq is not on PATH. Install jq"
have node || missing "node is not on PATH. Install Node.js"
if have archon; then
  doctor=$(archon doctor 2>&1)
  grep -q "Installed providers:.*$PROVIDER" <<< "$doctor" \
    || missing "archon doctor does not list $PROVIDER under 'Installed providers:'. Run: archon provider add $PROVIDER"
fi
[ -f "$AH/scripts/lane.sh" ] || missing "$AH/scripts/lane.sh does not exist. Run the kit's install.sh"
[ -f "$AH/scripts/lane-hook.mjs" ] || missing "$AH/scripts/lane-hook.mjs does not exist. Run the kit's install.sh"
[ -f "$AH/profiles/$PROVIDER.yaml" ] || missing "$AH/profiles/$PROVIDER.yaml does not exist. Run the kit's install.sh"
[ "$bad" = 0 ] || exit 2

if [ "$PROVIDER" = codex ]; then CASES="user repo"; REPORT_NAME="codex-lane-probe-report"; else CASES="repo"; REPORT_NAME="codex-lane-probe-report-claude"; fi
DATE=$(date -u +%Y-%m-%d)
REPORT="$HOME/$REPORT_NAME-$DATE.md"
RAW=$(mktemp "${TMPDIR:-/tmp}/codex-lane-probe.XXXXXX") || exit 2
MADE=()

for c in $CASES; do
  for p in "$HOME/codex-lane-probe-$c" "$HOME/codex-lane-probe-$c-artifacts" "$HOME/codex-lane-probe-$c-outside.txt"; do
    [ ! -e "$p" ] || { printf '%s exists; remove it first\n' "$p" >&2; rm -f "$RAW"; exit 2; }
  done
done

cleanup() {
  cd "$HOME" || return 0
  rm -f "$RAW"
  [ "$KEEP" = 1 ] && return 0
  for p in ${MADE[@]+"${MADE[@]}"}; do rm -rf "$p"; done
}
trap cleanup EXIT
cd "$HOME" || exit 2

TIMEOUT=$(command -v timeout || command -v gtimeout || true)
T=()
[ -z "$TIMEOUT" ] || T=("$TIMEOUT" 900)

say() { printf '%s\n' "$*" >> "$RAW"; }

# ---- one case -----------------------------------------------------------------------------------
build_case() { # build_case <case>
  local c=$1
  REPO="$HOME/codex-lane-probe-$c"
  ART="$HOME/codex-lane-probe-$c-artifacts"
  OUTSIDE="$HOME/codex-lane-probe-$c-outside.txt"
  MADE+=("$REPO" "$ART" "$OUTSIDE")

  mkdir -p "$REPO/.archon/workflows" "$REPO/.codex" "$REPO/test" "$REPO/src" "$ART"
  printf '{ "tests": ["test/**"] }\n' > "$REPO/.archon/lanes.json"
  printf 'a\n' > "$REPO/src/a.txt"
  printf 'a\n' > "$REPO/test/a.txt"

  # The capture hook records the shape of each tool call and then lets the call go ahead. The first
  # payload of each tool is kept whole, because its shape is one of the unknowns.
  cat > "$REPO/.codex/capture.sh" <<'EOF'
#!/bin/sh
IN=$(cat)
printf '%s' "$IN" | jq -c --arg reg "${1:-}" '{tool_name, event: .hook_event_name, cwd, input_keys: ((.tool_input | keys?) // null), command_type: ((.tool_input.command? | type) // null), registered: $reg}' >> "__ART__/hook-capture.jsonl" 2> /dev/null
tool=$(printf '%s' "$IN" | jq -r '.tool_name // empty' 2> /dev/null | tr -c 'A-Za-z0-9_\n' '_')
if [ -n "$tool" ] && [ ! -e "__ART__/raw-$tool.json" ]; then
  printf '%s' "$IN" | jq -c . > "__ART__/raw-$tool.json" 2> /dev/null || printf '%s\n' "$IN" > "__ART__/raw-$tool.json"
fi
exit 0
EOF
  sed -i.bak "s|__ART__|$ART|g" "$REPO/.codex/capture.sh" && rm -f "$REPO/.codex/capture.sh.bak"
  chmod +x "$REPO/.codex/capture.sh"

  local lane_cmd
  lane_cmd="sh -c '[ -f \"\${ARCHON_HOME:-\$HOME/.archon}/scripts/lane-hook.mjs\" ] && exec node \"\${ARCHON_HOME:-\$HOME/.archon}/scripts/lane-hook.mjs\"; exit 0'"

  if [ "$PROVIDER" = codex ]; then
    # Two capture registrations, one without a matcher and one that names the tools, because the
    # form that Codex accepts is one of the unknowns. The report tells them apart.
    {
      if [ "$c" = repo ]; then
        printf '[[hooks.PreToolUse]]\nmatcher = "Bash|apply_patch|Edit|Write"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\n'
        jq -rn --arg cmd "$lane_cmd" '"command = " + ($cmd | tojson)'
        printf 'timeout = 30\n\n'
      fi
      printf '[[hooks.PreToolUse]]\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "sh %s/.codex/capture.sh any"\ntimeout = 30\n\n' "$REPO"
      printf '[[hooks.PreToolUse]]\nmatcher = "Bash|apply_patch|Edit|Write|shell|local_shell|exec_command"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "sh %s/.codex/capture.sh named"\ntimeout = 30\n' "$REPO"
    } > "$REPO/.codex/config.toml"
  else
    mkdir -p "$REPO/.claude"
    local cap="sh $REPO/.codex/capture.sh named"
    jq -n --arg cmd "$lane_cmd" --arg cap "$cap" '{hooks: {PreToolUse: [
      {matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash", hooks: [{type: "command", command: $cmd}]},
      {matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash", hooks: [{type: "command", command: $cap}]}
    ]}}' > "$REPO/.claude/settings.json"
  fi

  local allowed edit_tool
  if [ "$PROVIDER" = codex ]; then
    allowed='    # allowed_tools is ignored on Codex'
    edit_tool='your file-editing tool (apply_patch), not the shell'
  else
    allowed='    allowed_tools: [Bash, Write]'
    edit_tool='the Write tool'
  fi

  cat > "$REPO/.archon/workflows/lane-probe.yaml" <<'EOF'
name: lane-probe
description: Runs one agent through the lane hook and leaves the evidence in files.
nodes:
  - id: stage_implement
    bash: '"${ARCHON_HOME:-$HOME/.archon}/scripts/lane.sh" stage implement "__ART__"'
    mutates_checkout: false

  - id: implementer
    depends_on: [stage_implement]
    model: small
__ALLOWED__
    prompt: |
      You are testing a tool-call filter. Make exactly these tool calls, one per step, in this
      order. A call may be refused with an error from a hook. Do not retry a refused call, do not
      try another way to do the same thing, and do not stop early: go on to the next step. Make no
      other tool calls. When every step is done, reply with one line per step saying allowed or
      refused.

      Steps that say "edit" use __EDIT_TOOL__. Steps that say "shell" run the command in the shell.

      1. Edit: create __REPO__/test/impl-edit.txt with the content x
      2. Shell: echo x > test/impl-redirect.txt
      3. Edit: create __REPO__/src/impl-ok-edit.txt with the content x
      4. Shell: echo x > src/impl-ok-redirect.txt
      5. Edit: create __OUTSIDE__ with the content x
      6. Edit: create __ART__/impl-artifacts.md with the content x
      7. Shell, with this command on three lines:
         node - <<'JS'
         require('fs').writeFileSync('__REPO__/test/impl-interpreter.txt', 'x')
         JS

  - id: marker_check
    depends_on: [implementer]
    bash: |
      if jq -e '.stage == "implement"' "$(git rev-parse --git-path archon-stage)" > /dev/null 2>&1; then
        printf 'ok\n' > "__ART__/marker.txt"
      else
        printf 'broken\n' > "__ART__/marker.txt"
      fi
    mutates_checkout: false

  - id: verify_stage
    depends_on: [marker_check]
    bash: |
      rc=0
      "${ARCHON_HOME:-$HOME/.archon}/scripts/lane.sh" unstage --verify 2> "__ART__/verify.out" || rc=$?
      printf '%s\n' "$rc" > "__ART__/verify.status"
      exit 0
    mutates_checkout: false

  - id: stage_clear
    depends_on: [verify_stage]
    bash: '"${ARCHON_HOME:-$HOME/.archon}/scripts/lane.sh" unstage'
    mutates_checkout: false
EOF
  sed -i.bak "s|^__ALLOWED__\$|$allowed|; s|__EDIT_TOOL__|$edit_tool|; s|__REPO__|$REPO|g; s|__ART__|$ART|g; s|__OUTSIDE__|$OUTSIDE|g" "$REPO/.archon/workflows/lane-probe.yaml" \
    && rm -f "$REPO/.archon/workflows/lane-probe.yaml.bak"

  git -C "$REPO" init -q -b main
  git -C "$REPO" config user.email probe@example.com
  git -C "$REPO" config user.name probe
  git -C "$REPO" add -A
  git -C "$REPO" commit -q -m "probe repository"
}

# The run-log events that mention hooks, trust, review, denial or blocking, one short line each.
# The routine started/succeeded events of a hook are counted elsewhere and left out here.
log_lines() { # log_lines <jsonl>
  jq -R -r 'fromjson? | select(.type != "node_start" and .type != "workflow_start")
    | select(tojson | test("hook|trust|review|denied|blocked"; "i"))
    | select((.event.type? == "hook" and (.event.status? == "started" or .event.status? == "succeeded")) | not)
    | [.type, (.event.type? // ""), (.event.status? // ""), (.event.hookName? // ""),
       ((.event.output? // .event.message? // .event.text? // .message? // .error? // .output? // "") | tostring | gsub("\n"; " ") | .[0:220])]
    | map(select(. != "")) | join(" | ")' "$1" 2> /dev/null
}

hook_events() { # hook_events <jsonl>: "started 14, succeeded 14"
  jq -R -r 'fromjson? | select(.type == "provider_event" and .event.type? == "hook") | .event.status' "$1" 2> /dev/null \
    | sort | uniq -c | awk '{ printf "%s%s %s", (NR > 1 ? ", " : ""), $2, $1 }'
}

row() { # row <n> <tool> <target> <path> <designed: refused|allowed>
  local state result
  if [ -e "$4" ]; then state=allowed; result="allowed (file present)"; else state=refused; result="refused (file absent)"; fi
  local match=yes
  [ "$state" = "$5" ] || match=no
  printf '| %s | %s | %s | %s | %s | %s |\n' "$1" "$2" "$3" "$result" "$5" "$match"
}

run_case() { # run_case <case>
  local c=$1
  build_case "$c"
  local ws
  ws="$AH/workspaces/_local/$(basename "$REPO")"

  say ""
  say "## Case: $c"
  say ""
  if [ "$PROVIDER" = codex ]; then
    if [ "$c" = user ]; then
      say "Lane hook registered in: the user config (\`archon-kit hooks status\` below)."
    else
      say "Lane hook registered in: the probe repository's \`.codex/config.toml\`."
    fi
    say ""
    say '```'
    (cd "$REPO" && bash "$AH/scripts/archon-kit" hooks status 2>&1) | head -n 5 >> "$RAW"
    say '```'
  else
    say "Lane hook registered in: the probe repository's \`.claude/settings.json\`."
  fi
  if (cd "$REPO" && bash "$AH/scripts/lane.sh" verify > /dev/null 2>&1); then
    say ""
    say "\`lane.sh verify\`: passes."
  else
    say ""
    say "\`lane.sh verify\`: fails, so nothing registers the lane hook for this case."
  fi

  printf 'running the %s case (one %s agent)\n' "$c" "$PROVIDER"
  (cd "$REPO" && "${T[@]+"${T[@]}"}" archon workflow run lane-probe --no-worktree --cwd "$REPO" --config "$AH/profiles/$PROVIDER.yaml") > "$ART/run.log" 2>&1
  local status=$?
  say ""
  say "Workflow exit status: $status."

  say ""
  say "### Steps"
  say ""
  say "| Step | Tool | Target | Result | Designed | As designed |"
  say "| --- | --- | --- | --- | --- | --- |"
  {
    row 1 "edit" "test/" "$REPO/test/impl-edit.txt" refused
    row 2 "shell redirect" "test/" "$REPO/test/impl-redirect.txt" refused
    row 3 "edit" "src/" "$REPO/src/impl-ok-edit.txt" allowed
    row 4 "shell redirect" "src/" "$REPO/src/impl-ok-redirect.txt" allowed
    row 5 "edit" "outside the worktree" "$OUTSIDE" refused
    row 6 "edit" "the artifacts directory" "$ART/impl-artifacts.md" allowed
    row 7 "shell interpreter heredoc" "test/" "$REPO/test/impl-interpreter.txt" allowed
  } >> "$RAW"
  say ""
  say "Step 7 is a documented hole in the hook, so \"allowed\" is the design there. The check at the end of the stage is what catches it."

  # The newest run log of this probe repository.
  local logfile
  logfile=$(ls -t "$ws"/logs/*.jsonl 2> /dev/null | head -n 1)

  say ""
  say "### Did a hook fire?"
  say ""
  local any=0 named=0 lane_text=0 capture="$ART/hook-capture.jsonl"
  if [ -s "$capture" ]; then
    any=$(jq -s '[.[] | select(.registered == "any")] | length' "$capture" 2> /dev/null || echo 0)
    named=$(jq -s '[.[] | select(.registered == "named")] | length' "$capture" 2> /dev/null || echo 0)
  fi
  [ -n "$logfile" ] && lane_text=$(grep -c 'Lane hook' "$logfile" 2> /dev/null || true)
  local lane_run
  lane_run=$(grep -c 'Lane hook' "$ART/run.log" 2> /dev/null || true)
  say "- Capture hook registered without a matcher: $any call(s)."
  say "- Capture hook registered with a matcher naming the tools: $named call(s)."
  local events=""
  [ -z "$logfile" ] || events=$(hook_events "$logfile")
  say "- Hook events Archon logged for the node: ${events:-none}."
  say "- Lines with \`Lane hook\` text in the newest run log: ${lane_text:-0}. In the workflow output: ${lane_run:-0}."
  if [ "$((any + named))" -gt 0 ]; then
    say "- A hook fired inside the Archon node."
  else
    say "- No capture hook fired. Either hooks do not fire inside an Archon node, or this configuration was not loaded (an untrusted project or an unreviewed hook)."
  fi
  if [ "${lane_text:-0}" -gt 0 ] || [ "${lane_run:-0}" -gt 0 ]; then
    say "- The lane hook refused at least one call."
  else
    say "- No refusal from the lane hook was seen."
  fi
  if [ "$(cat "$ART/marker.txt" 2> /dev/null)" = ok ]; then
    say "- The stage marker still parsed after the agent finished."
  else
    say "- The stage marker was missing or unreadable after the agent finished."
  fi

  say ""
  say "### Stage-end check"
  say ""
  say "\`lane.sh unstage --verify\` exit status: $(cat "$ART/verify.status" 2> /dev/null || echo 'not recorded')."
  if [ -s "$ART/verify.out" ]; then
    say ""
    say '```'
    head -n 20 "$ART/verify.out" | cut -c1-300 >> "$RAW"
    say '```'
  else
    say ""
    say "It printed nothing."
  fi
  if [ -e "$REPO/.git/archon-stage" ]; then
    say ""
    say "A stage marker is still in the repository after the last node."
  fi

  say ""
  say "### Tool calls the capture hook saw"
  say ""
  if [ -s "$capture" ]; then
    say "| Tool | Event | Input keys | Type of \`command\` | Registered | Calls |"
    say "| --- | --- | --- | --- | --- | --- |"
    jq -rs 'group_by([.tool_name, .event, (.input_keys | tostring), .command_type, .registered])
      | .[] | "| \(.[0].tool_name) | \(.[0].event) | \(.[0].input_keys | tostring) | \(.[0].command_type) | \(.[0].registered) | \(length) |"' "$capture" >> "$RAW" 2> /dev/null
    say ""
    say "Working directory the hook ran in: $(jq -rs '[.[].cwd] | unique | join(", ")' "$capture" 2> /dev/null)"
    local f
    for f in "$ART"/raw-*.json; do
      [ -e "$f" ] || continue
      say ""
      say "First payload for the \`$(basename "$f" .json | sed 's/^raw-//')\` tool:"
      say ""
      say '```json'
      cut -c1-1500 "$f" >> "$RAW"
      say '```'
    done
  else
    say "The capture hook recorded nothing."
  fi

  say ""
  say "### Log lines that mention hooks, trust, review, denial or blocking"
  say ""
  local lines
  lines=$({ [ -z "$logfile" ] || log_lines "$logfile"
            grep -i -E 'hook|trust|review|denied|blocked' "$ART/run.log" 2> /dev/null; } | cut -c1-300 | awk '!seen[$0]++' | head -n 20)
  if [ -n "$lines" ]; then
    say '```'
    printf '%s\n' "$lines" >> "$RAW"
    say '```'
  else
    say "None."
  fi

  if [ "$status" != 0 ]; then
    say ""
    say "### Workflow output (last lines)"
    say ""
    say '```'
    tail -n 25 "$ART/run.log" | cut -c1-300 >> "$RAW"
    say '```'
  fi
}

# ---- report -------------------------------------------------------------------------------------
say "# Lane hook probe report"
say ""
say "- Date (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "- Provider: $PROVIDER"
if [ "$PROVIDER" = codex ]; then
  say "- Codex: $(codex --version 2>&1 | head -n 1)"
else
  say "- Claude Code: $(claude --version 2>&1 | head -n 1)"
fi
say "- Archon: $(archon --version 2>&1 | head -n 1)"
say "- Kit: $(jq -r '.version // "unknown"' "$AH/kit-installed.json" 2> /dev/null || echo unknown)"
say "- Platform: $(uname -sm)"
printf 'codex-lane-probe: %s, %s\n' "$PROVIDER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

for c in $CASES; do run_case "$c"; done

say ""
say "This report holds versions, tool names, paths inside the probe repository and the probe's own test payloads. It holds none of your files."
say ""
say "Send this file to the maintainer."

# Replace the home directory with ~ before the report leaves the page.
tilde='~'
while IFS= read -r line || [ -n "$line" ]; do printf '%s\n' "${line//"$HOME"/$tilde}"; done < "$RAW" > "$REPORT"
cat "$REPORT"
printf '\nreport written to %s\n' "${REPORT/#"$HOME"/$tilde}"
if [ "$KEEP" = 1 ]; then
  printf 'kept:\n'
  for p in ${MADE[@]+"${MADE[@]}"}; do printf '  %s\n' "$p"; done
fi
exit 0
