#!/usr/bin/env bash
# usage: report.sh page <kind> --out <file> --design <slug> --run <id> --artifacts <dir> [more args]
#        report.sh markdown <kind> --report <file> --out <file> --design <slug> --run <id> --artifacts <dir> [--status <text>]
#        report.sh link <report file>
#
# page builds a report page and prints its URL. It runs the repository's report_cmd (.archon/build.json)
# as `<report_cmd> <kind> --out <file> --design <slug> --run <id> --artifacts <dir> [more args]`
# from the current directory, under a 120 s limit. A repository with no report_cmd, or a builder that
# fails, outruns the limit or leaves no file, gets the kit's page from report/build.mjs (with the
# repository's report_plugin when no report_cmd is set). When that fails too, or node is missing,
# report-page.py renders a plain page from plan.md (kind `plan`) or report.md (any other kind) in the
# artifacts directory. --status TEXT among the leading flags becomes the page's status line and is not
# passed to the repository's builder.
#
# markdown builds a page from a Markdown report the workflow already wrote. It runs report_cmd from the
# main worktree, as `<report_cmd> <kind> --out <file> --design <slug> --run <id> --artifacts <dir>
# --report <file> [--status <text>]`, under the same limit, and falls back the same way.
#
# Either one prints one URL line, or when no page could be built at all one sentence that names no
# path (run.log has the reason), and exits 0 in every case. Both share publish.
#
# link prints where to open a report: its URL when ~/.archon/report-base-url holds a base URL and
# the report is under ~/.archon/designs (report-serve.py serves that tree), else its Windows
# path, so a host without the report server prints what it printed before. The URL of a directory's
# index.html ends at the directory (.../<slug>/), and that of another page drops .html
# (.../<slug>/plan-report), which report-serve.py serves from the .html file. A page keeps its .html
# when a directory of the same name sits beside it, because the server would send the bare name to
# the directory. Slugs are [a-z0-9-], so no URL encoding is needed.
set -uo pipefail

USAGE='usage: report.sh page <kind> --out <file> --design <slug> --run <id> --artifacts <dir> [more args] | markdown <kind> --report <file> --out <file> --design <slug> --run <id> --artifacts <dir> [--status <text>] | link <report file>'
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# GNU timeout; Homebrew's coreutils installs it on macOS as gtimeout. With neither, the name stays timeout and the call fails as it did.
tmo=$(command -v timeout || command -v gtimeout || printf timeout)

link() {
  local file root base rel
  file=$(realpath "$1") || return 1
  root=$(realpath "${ARCHON_HOME:-$HOME/.archon}/designs") || return 1
  base=$(cat "${ARCHON_HOME:-$HOME/.archon}/report-base-url" 2>/dev/null || true)
  if [ -n "$base" ] && [[ "$file" == "$root"/* ]]; then
    rel=${file#"$root"/}
    case "$rel" in
      index.html) rel= ;;
      */index.html) rel=${rel%index.html} ;;
      *.html) [ -d "${file%.html}" ] || rel=${rel%.html} ;;
    esac
    printf '%s/%s\n' "${base%/}" "$rel"
  else
    wslpath -w "$file" 2>/dev/null || printf '%s\n' "$file"
  fi
}

# publish KIND SRC OUT DESIGN RUN ART CWD STATUS [EXTRA...]
# Builds OUT with the repository's report_cmd run from CWD, else with the kit's report/build.mjs,
# else with report-page.py from the Markdown file SRC, and prints its link. A builder counts only
# when it exits 0 and leaves a non-empty OUT. When none builds, the one line printed names no path. Set title_from_heading=1
# to let report-page.py take the title from SRC's first heading.
publish() {
  local kind=$1 src=$2 out=$3 design=$4 run=$5 art=$6 cwd=$7 status=$8 report_cmd cmd_failed="" title
  shift 8
  rm -f "$out"
  mkdir -p "$(dirname "$out")"
  report_cmd=$(cd "$cwd" && "$here/build-settings.sh" report_cmd) || report_cmd=""
  if [ -n "$report_cmd" ]; then
    if (cd "$cwd" && ARTIFACTS_DIR="$art" "$here/run-log.sh" "$kind-report" "$tmo" -k 5 120 bash -c "$report_cmd \"\$@\"" report "$kind" \
         --out "$out" --design "$design" --run "$run" --artifacts "$art" "$@") && [ -s "$out" ]; then
      link "$out"
      return 0
    fi
    rm -f "$out"
    cmd_failed=1
  fi
  if [ -n "$cmd_failed" ]; then
    status="${status:+$status; }the repository's report builder failed, so this is the default page"
  fi
  # The kit's own builder. report_plugin adds to its page, so it applies only when report_cmd is unset.
  if command -v node > /dev/null 2>&1 && [ -f "$here/report/build.mjs" ]; then
    local -a plugin=()
    local plugin_rel main
    if [ -z "$report_cmd" ]; then
      plugin_rel=$(cd "$cwd" && "$here/build-settings.sh" report_plugin) || plugin_rel=""
      main=$(cd "$cwd" && "$here/build-settings.sh" --main-worktree) || main=""
      if [ -n "$plugin_rel" ] && [ -n "$main" ]; then plugin=(--plugin "$main/$plugin_rel"); fi
    fi
    if (cd "$cwd" && ARTIFACTS_DIR="$art" "$here/run-log.sh" "$kind-report-kit" "$tmo" -k 5 120 node "$here/report/build.mjs" "$kind" \
         --out "$out" --design "$design" --run "$run" --artifacts "$art" "$@" ${plugin[@]+"${plugin[@]}"} ${status:+--status "$status"}) && [ -s "$out" ]; then
      link "$out"
      return 0
    fi
    rm -f "$out"
  fi
  local first rest
  first=$(printf '%s' "${kind:0:1}" | tr '[:lower:]' '[:upper:]')
  rest=${kind:1}
  title=()
  if [ -z "${title_from_heading:-}" ]; then title=(--title "$first$rest: $design"); fi
  if ARTIFACTS_DIR="$art" "$here/run-log.sh" "$kind-report-page" python3 "$here/report-page.py" "$src" "$out" \
       ${title[@]+"${title[@]}"} ${status:+--status "$status"} && [ -s "$out" ]; then
    link "$out"
  else
    rm -f "$out"
    printf 'The %s report could not be built; run.log has the reason.\n' "$kind"
  fi
}

page() {
  local kind=${1:?$USAGE} out="" design="" run="" art="" status="" src
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --out) out=${2:?$USAGE}; shift 2 ;;
      --design) design=${2:?$USAGE}; shift 2 ;;
      --run) run=${2:?$USAGE}; shift 2 ;;
      --artifacts) art=${2:?$USAGE}; shift 2 ;;
      --status) status=${2:?$USAGE}; shift 2 ;;
      *) break ;;
    esac
  done
  if [ -z "$out" ] || [ -z "$design" ] || [ -z "$run" ] || [ -z "$art" ]; then
    printf '%s\n' "$USAGE" >&2
    return 2
  fi
  case "$kind" in
    plan) src="$art/plan.md" ;;
    *) src="$art/report.md" ;;
  esac
  publish "$kind" "$src" "$out" "$design" "$run" "$art" . "$status" "$@"
}

markdown() {
  local kind=${1:?$USAGE} report="" out="" design="" run="" art="" status="" main
  local -a extra
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --report) report=${2:?$USAGE}; shift 2 ;;
      --out) out=${2:?$USAGE}; shift 2 ;;
      --design) design=${2:?$USAGE}; shift 2 ;;
      --run) run=${2:?$USAGE}; shift 2 ;;
      --artifacts) art=${2:?$USAGE}; shift 2 ;;
      --status) status=${2:?$USAGE}; shift 2 ;;
      *) printf '%s\n' "$USAGE" >&2; return 2 ;;
    esac
  done
  if [ -z "$report" ] || [ -z "$out" ] || [ -z "$design" ] || [ -z "$run" ] || [ -z "$art" ]; then
    printf '%s\n' "$USAGE" >&2
    return 2
  fi
  main=$("$here/build-settings.sh" --main-worktree) || main=.
  extra=(--report "$report")
  if [ -n "$status" ]; then extra+=(--status "$status"); fi
  title_from_heading=1 publish "$kind" "$report" "$out" "$design" "$run" "$art" "$main" "$status" "${extra[@]}"
}

case "${1:?$USAGE}" in
  page) shift; page "$@" ;;
  markdown) shift; markdown "$@" ;;
  link) link "${2:?$USAGE}" ;;
  *) printf '%s\n' "$USAGE" >&2; exit 2 ;;
esac
