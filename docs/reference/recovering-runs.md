# Recovering a run whose owner is gone

This reference explains how to find an Archon run whose owner process died, how to continue it, and how to clear a node result that makes a resumed run repeat an old failure, for the person who operates the kit's workflows and has a run stuck at `running` or `failed`. [Workflow cleanup](workflow-cleanup.md) applies the second recovery under [Choosing a recovery](#choosing-a-recovery) on its own, in its `resume` rung, for a dead run of a workflow that has a registry entry ([Extending the kit](../extending.md) explains entries).

A run's owner is the `archon` process that started it, which for a `--detach` run is the detached child. When the owner dies, because a terminal closed or the machine restarted, the run keeps the status `running`. A restarted `archon serve` does not adopt it. The web console labels the run "Running · owner not answering", but the CLI does not: `status`, `get` and `runs` show a dead run as an ordinary running one. The behavior below was observed on Archon CLI 0.13.2 against a throwaway workflow in an isolated `ARCHON_HOME`.

A dead run holds its working path. Any other run on that path is refused with "This worktree is in use", and the refused run is marked `cancelled`, even when it was a `failed` run you meant to resume. `resume` refuses a `cancelled` run, so one wrong attempt makes the run unresumable until you undo it (see [Choosing a recovery](#choosing-a-recovery)).

## Finding dead runs

`archon-dead-runs.sh list` (in `$ARCHON_HOME/scripts/`) prints each run on the install that has the status `running`. Each line shows:

- the run id and the workflow name
- the owner state (`alive`, `dead` or `unknown`) and the owner pid
- the number of pauses already answered
- the time of the newest event, and `idle`, the minutes since that event
- `open`, the nodes that have started and not finished
- the run's path

The owner state comes from the pid and host in the run's `metadata`. It is `alive` when the command line of that process on this host mentions `archon`, and `dead` when the process is gone or is another program. It is `unknown` when the run recorded no pid or ran on another host, or when this system cannot show the command line of a process that exists. The command line comes from `/proc/<pid>/cmdline` on Linux and from `ps` elsewhere. `mark-failed` accepts only a `dead` owner, so an `unknown` owner is never overridden.

A run whose owner is `alive` and whose `idle` is 20 minutes or more is marked `STALLED`, which means a node is probably hung. A paused run has the status `paused`, so `list` does not show it. The command reads `$ARCHON_HOME/archon.db` read-only and works with or without `archon serve`. `archon workflow runs` and `status` show only the repository you are in unless `--all` widens them, and `runs` shows only the newest 20 runs unless `--limit` raises that. Both fail outside a git repository.

## Effects of each command

| Command | Effect on a run whose owner is dead |
| --- | --- |
| `archon workflow cancel <id>` | No effect. It prints "Cancel has nothing to stop" and the run stays `running`. |
| `archon workflow abandon <id>` | Sets `cancelled` and frees the path. The checkout stays. |
| `archon workflow resume <id>` | Takes `failed` or `paused`. Refuses `running` and `cancelled`. |
| `archon workflow run <name> --resume` | Takes `failed`, `paused`, and `running` runs idle for over 24 hours. |

`abandon` prints "Retained checkout … no valid proof this run created it" for a run started with `--no-worktree`. The message is expected, and the checkout is untouched.

`run --resume` finds runs by the working path of the current directory and takes the newest eligible one by start time. A `running` run counts as eligible only when its last activity is more than 24 hours old, so a run that died ten minutes ago is invisible to it, and an older `failed` run on the same path is picked instead. The command also refuses `--input`.

## Choosing a recovery

Start with `archon-dead-runs.sh backup <id>...` for each run involved. It copies the database, each run's artifacts directory and each transcript to `$ARCHON_HOME/backups/<timestamp>/`. Then pick the case that fits.

- When the dead run superseded a failed run and only the failed run's work matters, run `archon workflow abandon <dead-id>`, then `archon workflow resume <failed-id>`. The failed run continues in place and skips the nodes it had finished.
- When the dead run itself has work to keep, such as finished nodes or answered pauses, run `archon-dead-runs.sh mark-failed <dead-id>`, then `archon workflow resume <dead-id>`. The run continues in place and skips its finished nodes. Do not run `abandon` first, because that makes the run unresumable. Waiting 24 hours so that `run --resume` takes the run also works and needs no database edit.
- When neither run has anything worth keeping, run `archon workflow abandon <dead-id>` and start a new run.
- When a refused resume already cancelled a failed run, abandon the dead run, run `archon-dead-runs.sh mark-failed <id> --cancelled`, then `archon workflow resume <id>`. The run's history keeps a `workflow_cancelled` event.

For the second case, the sequence is:

```bash
archon-dead-runs.sh list
archon-dead-runs.sh backup <dead-id>
archon-dead-runs.sh mark-failed <dead-id>
cd <the run's working path> && archon workflow resume <dead-id> --detach
```

Archon has no command that sets a dead run to `failed`, so `mark-failed` writes the `status` column of Archon's database directly. It refuses a `running` run whose owner is not `dead` (with `--cancelled`, it refuses a run that is not `cancelled`), and it snapshots the database before it writes. It has been tested only with no `archon serve` running.

## A node's last result after a resume

Archon keeps each node's last result when it resumes a run. A node that completed is skipped with the reason `prior_success`, and a node that failed is not run again, even after its cause is fixed. The failed node's dependents are skipped with the cause `upstream_failed`, and the run ends within a second with the old error. One way to reach this state is a provider usage limit that fails a planning loop, followed by a decision node that fails on a missing file. The resume that your plan approval triggers then finishes the loop and ends with that same error, so the approval is lost.

A run is in this state when its latest `workflow_failed` event names a first failed node that has no `node_started` event after the latest `workflow_started`, and the error text is older than the resume. Fix it in four steps:

1. Run `archon-dead-runs.sh backup <run-id>`. The next step needs the status `failed`, so run `mark-failed` first for a run that is `running` with a dead owner.
2. Run `archon-dead-runs.sh clear-node <run-id> <node-id>...`. Name the failed node and any node that completed on input that was stale at the time, such as a node that printed `go` before the tests stage had run. A node inside a loop takes its bare id. The helper refuses a run whose status is not `failed` and a node that has no events in the run. It snapshots the database, removes only those nodes' `node_*` events and no pause's answer, and the database copies each removed event into `remote_agent_workflow_event_archive`. It has been tested with `archon serve` running.
3. Make the checkout match what the approved work assumed. Read the plan's preconditions first. In one observed case the plan required the worktree to be fast-forwarded to the commit the plan was written against, and the approval skipped that step.
4. Run `archon workflow resume <run-id> --detach` from the run's working path. The cleared nodes then run in their normal order.

A resume runs the workflow definition that the run captured. When the failure came from a bug in that definition, adopt the run instead: `archon workflow run build --adopt <run-id> --detach` from the repository starts a new run in the failed run's worktree and on its branch, reuses the plan and tests, and skips planning and the tests stage. The `build` workflow's description covers adoption.

A node with `trigger_rule: all_done` runs after a failed dependency, so a failure inside it is recorded and then persists across resumes. A node that reads a file written inside a loop should not take `all_done`, because it runs after a failed loop and records a failure that a resume does not clear (`clear-node` does). Leave the default rule, which skips the node, or use `none_failed_min_one_success` when it also has to run after a skipped dependency. The `diagnosis` node of `workflow-cleanup` uses `all_done` and ends with `exit 0` for this reason.

## Where a run keeps its work

The answers to a run's pauses, such as a plan gate's `rework` notes, are `wait_answered` events in `$ARCHON_HOME/archon.db`. Plan drafts and notes are under `$ARCHON_HOME/workspaces/<owner>/<repo>/artifacts/runs/<run-id>/`, and the transcript is `$ARCHON_HOME/workspaces/<owner>/<repo>/logs/<run-id>.jsonl`. `abandon`, `cancel` and a refused `resume` delete none of them. `archon-dead-runs.sh list` shows how many pauses each running run has answered, and a nonzero count means the run holds your steering.

A new run started to replace an old one carries over only what its workflow copies. The old run keeps its answers and mockups, and the new one does not show them.

If the host has no `sqlite3` binary, query the database with Python: `sqlite3.connect('file:<path>?mode=ro', uri=True)`. Copy it with `Connection.backup`, which is safe while the server runs.

## Archon database

The tables in `$ARCHON_HOME/archon.db` are private to Archon, and the kit's scripts are tested only against Archon 0.13.x. `archon-dead-runs.sh list` and `backup` read them. The commands `mark-failed` and `clear-node` write them directly, and both snapshot the database first. `archon-dead-runs.sh schema` checks that the tables and columns this script and `workflow-cleanup.py` use exist. When one is missing it exits 1 with one line that names the Archon version. `workflow-cleanup.py` makes the same check each time it opens the database.
