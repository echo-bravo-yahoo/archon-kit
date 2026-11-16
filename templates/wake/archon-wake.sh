#!/usr/bin/env bash
# Resumes the Archon runs whose scheduled wait has come due, such as a check-later run, and exits.
# Run it every few minutes from cron, a systemd user timer or launchd. The section "Scheduled waits"
# of docs/reference/dependencies.md in the Archon kit shows each of the three.
#
# A scheduler starts programs with a short PATH, and a resumed run needs archon and the tools its
# nodes call: the provider (claude or codex), gh and node. Add the directories that hold them.
set -uo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
exec archon workflow wake --json
