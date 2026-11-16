# Dependencies

This page lists what the Archon kit needs from the machine it runs on, and what happens when something is missing. It covers Linux, macOS and WSL. `archon-kit doctor` fails for each tool the kit cannot run without and warns about the others, and `test/dependencies.test.mjs` fails when a script or a workflow calls a tool that this page does not list.

The kit's tests run on Linux, and the whole suite also passes under a build of bash 3.2.57, the version macOS ships. The macOS fallbacks (`gtimeout`, `gdate`, BSD `stat`, `ps` and `lsof`) are tested with stand-in commands, and no full run on macOS has been made.

## Classes

Every dependency belongs to one of four classes, and the class decides what the kit does about it.

| Class | Test | Examples | What the kit does |
| --- | --- | --- | --- |
| Standard | Present on every Unix | `sh`, `awk`, `sed -E`, `grep`, `find`, `xargs -r`, `mktemp -d`, `sleep` with a fraction | Nothing. The scripts keep to the flags that GNU and BSD share. |
| Common | Installable by name from the package manager of each supported system | `git`, `jq`, `python3`, `node`, `curl`, `gh`, `flock`, `timeout` | Listed on this page with a minimum version, and checked by `archon-kit doctor`. |
| Product | The program the kit drives | `archon`, `claude`, `codex` | Pinned to a version on this page, together with the internals the kit reads, and checked by `archon-kit doctor`. |
| Bespoke | Exists on one machine only | A person's own scripts directory, documents or secrets tool | Not allowed in the kit, and `test/scrub.test.mjs` fails on a path that points at one. A repository's own workflow may use one and lists it in that repository's own requirements. |

## Product tools

| Tool | Version | Needed by | When it is missing |
| --- | --- | --- | --- |
| `archon` | 0.13.2 | Every workflow, and the scripts that read its database. | `archon-kit doctor` fails below 0.13.2 and warns above it, because other versions are untested. |
| `claude` | Current | The agent nodes, when the provider is Claude. | Doctor fails when neither `claude` nor `codex` is on `PATH`. |
| `codex` | Current | The agent nodes, when the provider is Codex. | Doctor fails when neither `claude` nor `codex` is on `PATH`. |

## Common tools

| Tool | Minimum | Needed by | When it is missing |
| --- | --- | --- | --- |
| `bash` | 3.2 | Every script. The scripts use no feature of bash 4 or later, because macOS ships 3.2. | Doctor fails below 3.2. |
| `git` | 2.31 | `git rev-parse --path-format=absolute` in `build-settings.sh`, `start-run.sh`, `publish-match.sh` and `workflow-cleanup.py`, and every workflow that cuts a worktree. | Those scripts fail at once, and doctor fails below 2.31. |
| `jq` | 1.6 | Most of the shell scripts, among them `kit-settings.sh`, `build-settings.sh`, `run-gates.sh`, `start-run.sh`, `lane.sh` (`$ARGS.positional`), `install.sh` (`--rawfile`), `worktree-cleanup.sh` (`--slurpfile`) and `archon-kit`. | Doctor fails below 1.6, and `install.sh` stops. |
| `python3` | 3.7, with the `sqlite3` module | `workflow-cleanup.py`, `archon-dead-runs.sh`, `procinfo.py`, `lane.sh`, `run-sync.sh`, `report-page.py`, `report-serve.py` and `anti-entropy.py`. The 3.7 features are `subprocess.run(capture_output=...)` and `sqlite3.Connection.backup`. | Doctor fails below 3.7 and when `sqlite3` cannot be imported. |
| `node` | 20 | `lane-hook.mjs`, `report/build.mjs` and `lane-replay.mjs`. The kit's own tests need 22.13, the first release in which `node:sqlite` needs no flag. | Doctor fails below 20. |
| `flock` | Any | `state.sh`, `run-log.sh` (so every report node), the loop nodes of `build`, and `publish`. | Those nodes fail. Doctor fails. |
| `timeout` or `gtimeout` | GNU coreutils | `report.sh` and the `shots` node of `build`, which stop a report or screenshot command that hangs. The workflows `build`, `research`, `anti-entropy` and `workflow-cleanup` make report pages. | Both report builders fail, so the report falls back to the plain page that `report-page.py` makes, and the screenshot step produces nothing. Doctor fails when neither exists. |
| `realpath` | GNU coreutils or a recent BSD | `report.sh link`, which turns a report file into its URL. | Report links fail. Doctor fails. |
| `readlink` with `-f` | GNU coreutils or a recent BSD | `worktree-land` and `worktree-cleanup.sh`, which find the scripts beside them through a link. | Landing fails. Doctor fails. |
| `curl` | Any | `archon-kit reports up` and `reports status`. | The report server cannot be started or checked. Doctor warns. |
| `gh` | Any | `build` when `deliver` is `draft-pr` (`gh pr list`, `create` and `edit`), and `workflow-cleanup`, which uses `gh pr list` to tell a branch with an open pull request from one that is only pushed. | A `draft-pr` delivery fails. In `workflow-cleanup` a branch with an open pull request reads as pushed. Doctor warns. |
| `fuser` | Any | `git-retry`, which uses it to tell a lock that a running git holds from a leftover. | `git-retry` removes no stale lock and only waits. Doctor warns. |
| `date` with `-d`, or `gdate` | GNU coreutils | `due-instant.sh`, for relative `check-later` times such as `+7 days`. An ISO-8601 instant needs neither. | A relative time fails with a message that says what to install. Doctor warns. |

`xargs -r` (the conflict-marker check in `build`) belongs to the Standard class, because the BSD `xargs` accepts `-r` for compatibility with GNU, and without it an empty file list would read as "conflict markers found".

## Process lookups

`workflow-cleanup.py` and `archon-dead-runs.sh` ask `scripts/procinfo.py` three questions: whether the process that owns a run is still Archon, whether the Claude session that holds a worktree lock is still alive, and which processes work inside a worktree. Linux answers them from `/proc`. Elsewhere `ps` answers the first and `lsof` the third, and the second has no source, so the lock stays. Where no source can answer, the owner reads as `unknown`, which is not `dead`, and every worktree counts as in use, so the sweep deletes nothing and no run is resumed. The environment variables `KIT_PROC_BACKENDS` and `KIT_PROC_ROOT` choose the sources for the tests.

| Tool | Needed by | When it is missing |
| --- | --- | --- |
| `ps` | `procinfo.py`, where there is no `/proc`. | An owner reads as `unknown`. Doctor warns when `/proc`, or `ps` together with `lsof`, is not there. |
| `lsof` | `procinfo.py`, where there is no `/proc`. It shows the processes of the user who runs it. | The sweep treats every worktree as in use. Doctor warns under the same condition. |

## Platform tools

| Tool | Needed by | When it is missing |
| --- | --- | --- |
| `systemctl` | `archon-kit reports up`, which runs the report server as a systemd user unit when `systemctl --user show-environment` works. | The server starts with `nohup` instead. |
| `launchctl` | `archon-kit reports up` on macOS, which runs the report server as a launch agent. | The server starts with `nohup` instead. |
| `wslpath` | `report.sh link`, which prints a Windows path for a report when no base URL is set. | The link is the Linux path. |

## Development tools

| Tool | Needed by | When it is missing |
| --- | --- | --- |
| `shellcheck` | The kit's own gate, which runs `shellcheck -S warning` over its shell scripts. | The gate fails. Using the kit needs no `shellcheck`. |
| PyYAML | The workflow schema check in the tests, and `playground/build.py`. | Those tests and the playground fail. |
| `markdown-it-py` | `report-page.py`, which makes the default report page. | The report goes into a `<pre>` block. |

## Installing

| Tool | Debian or Ubuntu | macOS with Homebrew |
| --- | --- | --- |
| `jq` | `apt install jq` | `brew install jq` |
| `flock` | `apt install util-linux` | `brew install flock` |
| `timeout`, `realpath`, `readlink -f` and `date -d` | `apt install coreutils` | `brew install coreutils`, then put `$(brew --prefix coreutils)/libexec/gnubin` first on `PATH` |
| `fuser` | `apt install psmisc` | Run `archon-kit doctor` to see whether the system has it. |
| `lsof` and `ps` | `apt install lsof procps` | Included with the system. |
| `gh` | See the GitHub CLI's install page | `brew install gh` |

Homebrew installs every command of `coreutils` with a `g` prefix, so `brew install coreutils` provides `gtimeout` and `gdate` and not `timeout` and `date`. The kit uses `gtimeout` and `gdate` when it finds them. `realpath` and `readlink -f` have no such fallback, so they need the `gnubin` directory on `PATH` where the system's own commands lack them. `archon-kit doctor` tests each of them.

## Archon internals the kit reads

Archon's database tables and the layout of its home directory are private to Archon. The kit reads them in the places below, checks that the tables and columns exist before it reads them, and refuses with one line that names the Archon version when one is missing (`archon-dead-runs.sh schema`, and every subcommand of `workflow-cleanup.py`). It opens the database read-only, except for the two writes named in the last column.

| Item | Used by | Access |
| --- | --- | --- |
| `remote_agent_workflow_runs`: `id`, `workflow_name`, `status`, `codebase_id`, `working_path`, `user_message`, `metadata`, `adopted_from_run_id`, `started_at`, `completed_at`, `last_activity_at`, `output_root` | `workflow-cleanup.py`, `archon-dead-runs.sh`, `lane.sh`, `run-sync.sh` | Read. `archon-dead-runs.sh mark-failed` sets `status` to `failed` for a run whose owner is dead. |
| `remote_agent_workflow_events`: `workflow_run_id`, `event_order`, `event_type`, `step_name`, `data`, `created_at` | `workflow-cleanup.py`, `archon-dead-runs.sh` | Read. `archon-dead-runs.sh clear-node` deletes the `node_*` events of the nodes it is given. |
| `remote_agent_workflow_event_archive`: `workflow_run_id`, `event_order`, `event_type`, `step_name`, `data` | `archon-dead-runs.sh clear-node` | Not read. A trigger of Archon's own database copies each deleted event into it. The kit snapshots the database first, and the snapshot is the way back. |
| `remote_agent_codebases`: `id`, `default_cwd` | `workflow-cleanup.py` | Read. |
| Run `metadata`: `execution_owner` (`pid`, `host`), `workflow_source` (`root`, `aliases`), `inputs`, `model_bindings`, `ai_configuration` | `workflow-cleanup.py`, `archon-dead-runs.sh`, `lane.sh` | Read. The playground also reads `total_cost_usd`. |
| `$ARCHON_HOME/workspaces/<owner>/<repository>/artifacts/runs/<run id>` and `logs/<run id>.jsonl` | `archon-dead-runs.sh backup`, `workflow-cleanup.py` | Read, and `backup` copies them. |
| `archon workflow run`, `resume` and `wait`, and `archon --version` | `start-run.sh`, `workflow-cleanup.py`, `archon-kit` | Run as the person who started the kit. The wake template calls `archon workflow wake`. |

## Scheduled waits

A run that waits for a later instant, such as a `check-later` run, resumes only when something calls `archon workflow wake`. Without a caller, the run waits until its own process, or a running `archon serve`, resumes it. `archon workflow wake` resumes every due run on the install and exits, and `--watch` repeats the pass every 5 seconds until it is stopped.

The kit ships `templates/wake/archon-wake.sh`, which installs to `$ARCHON_HOME/kit/templates/wake/archon-wake.sh`. It sets a `PATH` that holds `archon`, the provider (`claude` or `codex`), `gh` and `node`, because a scheduler's own `PATH` is short and a resumed run calls all four, and then runs `archon workflow wake --json`. Edit its `PATH` line for the machine, then run it every few minutes in one of three ways.

- Cron: add the line `*/5 * * * * /path/to/archon-wake.sh` with `crontab -e`.
- A systemd user timer: save this service as `~/.config/systemd/user/archon-wake.service`,

  ```ini
  [Unit]
  Description=Resume due Archon runs

  [Service]
  Type=oneshot
  ExecStart=/path/to/archon-wake.sh
  ```

  save this timer as `~/.config/systemd/user/archon-wake.timer`,

  ```ini
  [Unit]
  Description=Resume due Archon runs every five minutes

  [Timer]
  OnBootSec=1min
  OnUnitActiveSec=5min

  [Install]
  WantedBy=timers.target
  ```

  and run `systemctl --user enable --now archon-wake.timer`.

- On macOS, `archon schedule install` manages a wake timer, and `archon schedule remove` removes it. `--interval <seconds>` sets the interval, which is 5 by default. The kit has not run it.

## Host setup the kit does not do

The installer copies files and writes an empty `kit.json`. It does not start or schedule anything, so each of these is the machine's own setup.

- Nothing starts `archon serve` at boot or restarts it. Start it by hand, or under the machine's own service manager.
- The wake timer above.
- `kit.json` in the Archon home holds the person's settings (`workspace`, `run_env`, `scratch_dirs`, `handoffs`, `plan_rules`), which `scripts/kit-settings.sh` documents.
- `archon-kit reports up` serves the report pages on localhost and writes `report-base-url`. Showing them to other machines needs a reverse proxy or a bind address, and a firewall rule. The server has no login, so do not bind it beyond localhost unless the pages may be read by everyone who can reach it.
