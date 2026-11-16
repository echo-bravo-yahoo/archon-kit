# Workflow cleanup

This reference describes how the `workflow-cleanup` workflow of the Archon kit decides whether a finished, failed or dead run saved its work, what it does in each case, and how to answer its pauses, for the person who installed the kit and runs its sweeps. [Recovering a run whose owner is gone](recovering-runs.md) covers the manual commands behind the workflow's `resume` rung.

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [Running a sweep](#running-a-sweep)
  - [What a sweep changes](#what-a-sweep-changes)
  - [Model calls and spending](#model-calls-and-spending)
- [Modes](#modes)
- [Candidates](#candidates)
- [Work state](#work-state)
- [Routes](#routes)
- [Failure classes](#failure-classes)
- [Rescue rungs](#rescue-rungs)
- [The pause](#the-pause)
  - [Facts](#facts)
  - [Diagnosis](#diagnosis)
  - [Recommended answer](#recommended-answer)
  - [Report](#report)
- [Answers](#answers)
- [Worktree pass](#worktree-pass)
  - [Assessment run](#assessment-run)
- [The ledger](#the-ledger)
- [The registry](#the-registry)
- [Settings in kit.json](#settings-in-kitjson)
- [Limits](#limits)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Running a sweep

Archon keeps a run's worktree and branch when the run ends, and it does not check afterwards whether the run finished its task or saved its work. `workflow-cleanup` makes that check. It finds each run that left a worktree behind, died or failed, and decides from recorded facts whether the work is saved. When the task finished and the work is saved, it removes the leftover worktree without asking you. Otherwise it rescues the run within fixed limits, or raises one pause for you. A sweep also goes through the worktrees of the project it runs in, including worktrees that no run owns, such as Claude Code session worktrees (see [Worktree pass](#worktree-pass)).

The kit schedules nothing, so the workflow runs only when you start it. A sweep removes worktrees and can start runs that spend model tokens, so start with a dry sweep from the root of a repository that is set up for the kit:

```bash
cd site
archon workflow run workflow-cleanup --input dry=yes
```

The dry sweep prints one line for each run it found with the route that run would get, and one line for each worktree it would delete or assess. It starts nothing and changes nothing. After reading it, start the real sweep, or clean up one run or one worktree:

```bash
archon workflow run workflow-cleanup --detach
archon workflow run workflow-cleanup --detach --input run=<run-id> [--input spend=yes]
archon workflow run workflow-cleanup --detach --input worktree=<path>
```

### What a sweep changes

Without asking you, the workflow may do the following:

- Commit uncommitted work onto the run's own branch.
- Remove the worktree of a run whose work is saved, and keep the run's branch when it is not landed.
- Land onto the local base branch a `build` run that you approved at its final gate, or that landed without that pause under `auto_land`, and whose landing loop then failed.
- Delete a worktree and its branch when the worktree has a clean tree and its content is already in the base branch.

A branch that has commits missing from the base branch is deleted in two cases. One is your answer `delete` or `discard` at a pause. The other is a clean worktree whose files all match the base branch already, as after a squash merge. Each branch deletion prints the branch's old tip, and `git branch <name> <sha>` restores the branch from it.

The workflow does not push and does not land work that you did not approve. To tell whether a branch is pushed, it runs `git ls-remote`, may fetch the branch from `origin`, and runs `gh pr list` when `gh` is installed. It reads Archon's database read-only. Its one write to that database is the `resume` rung's call to `archon-dead-runs.sh mark-failed`, which sets a run with a dead owner to `failed`.

### Model calls and spending

The workflow makes two kinds of model call itself: the diagnosis of a run that raises a pause, and the assessment of a worktree that holds unlanded or uncommitted content. A sweep starts at most three assessments. The rescue rungs `resume`, `relaunch` and `adopt` run or start workflow runs that spend tokens, so they run only when the `spend` input is `yes`. A sweep sets `spend=yes` for the first three candidates, oldest first, that could use one of those rungs, and `spend=no` for the rest.

## Modes

The workflow takes four inputs and no message. `archon workflow run` starts it without one. The web console's start card needs one character in its message box, which the workflow ignores.

| Input | Default | Meaning |
| --- | --- | --- |
| `run` | empty | The id, or an id prefix, of the run to clean up. Empty sweeps the install. |
| `dry` | `no` | `yes` prints what each run would get and changes nothing. |
| `spend` | `no` | `yes` lets this cleanup run start model-spending rescues. |
| `worktree` | empty | The path of one worktree to assess. |

The `run` and `worktree` inputs exclude each other.

With neither, the workflow sweeps the install. The `candidates` node lists the runs worth a look, and `fan_out` starts one independent `workflow-cleanup` run for each, from the run's own repository, so a pause in one cleanup run blocks no other. The `wt_sweep` node runs beside `fan_out` and goes through the project's worktrees (see [Worktree pass](#worktree-pass)).

With `run`, the workflow cleans up that one run. The `inspect` node prints the run's route and writes `verdict.json` and `state.txt` to the artifacts directory. The route decides what follows.

| Route | What follows |
| --- | --- |
| `skip` | The run is still working or paused, so the workflow takes no action. |
| `close` | `settle` removes the leftover worktree and `record` appends `closed` to the ledger. |
| `rescue` | A loop of at most four rounds runs one rung each (see [Rescue rungs](#rescue-rungs)). |
| `waiting` | A run that an earlier rescue started waits at a pause of its own, and `record` appends `rescued`. |
| `attention` | The nodes from `facts` to `notice` build the report and raise the pause. |
| `worktree` | `inspect` prints this when the `worktree` input is set, and `wt_inspect` routes that worktree. |

Under `dry=yes` an `attention` route is written as `dry`, so no pause is raised. The `cleanup` node runs last and removes the cleanup run's own worktree and branch.

## Candidates

The `candidates` node skips `workflow-cleanup` runs, runs with a terminal ledger entry, live runs, and runs that another live cleanup run already targets. It lists any other run when one of these holds:

- The run is `dead`: its status is `running` and its owner process is gone.
- The run's `working_path` is a leftover linked worktree that no live run uses.
- The run failed, or the engine refused to start it, and it has no ledger entry at all.
- The run is a `build` that completed in the last 14 days and approved a hand-off it did not start.

The age of a run does not matter. A run is listed as soon as it ends, and a failed run stays listed until it gets a ledger entry other than `queued`, because a cleanup run that failed at launch leaves only a `queued` entry. A run in the main checkout, started with `--no-worktree`, is not a leftover worktree. A candidate whose repository is no longer registered or no longer on disk is listed as skipped. A run that has two `queued` ledger entries and no outcome is listed and not started a third time.

## Work state

The state of a run's work comes from `worktree-cleanup.sh scan` of the run's `working_path`, plus `git` and, when it is installed, `gh`.

| State | Meaning | Saved |
| --- | --- | --- |
| `none` | No linked worktree is on disk, including a run that used the main checkout | yes |
| `landed` | Each commit's patch is in the base branch (`git cherry`), and the tree is clean | yes |
| `pr` | The remote branch contains `HEAD`, and `gh pr list --state all` shows an open or merged PR | yes |
| `pushed` | The remote branch contains `HEAD` | yes |
| `branch` | The tree is clean and the commits are only on the local branch | yes |
| `unsaved` | Uncommitted files, or commits on a detached `HEAD` that no branch holds | no |

`landed` goes by patch-id, so a cherry-pick landing, which gives the commits new SHAs, counts. Without a working `gh`, a branch with an open pull request reads as `pushed` and not `pr`. Untracked files inside a scratch directory named in `scratch_dirs` do not make a tree `unsaved` (see [Settings in kit.json](#settings-in-kitjson)).

## Routes

A run is `live` when its status is `paused`, or `running` with an owner process that is alive or unknown. The workflow does not touch a live run. The other kinds are:

- `completed` and `failed` — the status Archon recorded.
- `dead` — the status is `running` and the owner process is gone.
- `cancelled-chosen` — the run was cancelled for a reason other than `precondition_failed`, such as `operator` or `halt_node`.
- `cancelled-refused` — the engine refused a launch or resume (`precondition_failed`).

The kinds `failed`, `dead` and `cancelled-refused` count as failed.

| Run kind | Condition | Route |
| --- | --- | --- |
| `completed` | Finishing nodes done, work saved, and it meets the entry's `git` requirement | `close` |
| `completed` | Work `unsaved` | `rescue` (`commit-wip`), then inspect again |
| `completed` | A `build` with an approved hand-off that was not started | `attention`, naming the hand-offs |
| `completed` | Anything else | `attention` |
| `cancelled-chosen` | Work saved | `close` |
| `cancelled-chosen` | Work `unsaved` | `rescue` (`commit-wip`), then `close` |
| failed kinds | The workflow has no registry entry | `attention` |
| failed kinds | Housekeeping failure, task finished, work `none`, `landed` or `pr`, signature not recurring | `close` |
| failed kinds | A rescue rung is eligible and its budget allows it | `rescue` |
| failed kinds | Anything else | `attention` |
| any | A run started by a rescue rung waits at a pause | `waiting` |
| any | After a rescue that worked, the failure is systemic or its signature is recurring | `attention` |

A hand-off counts as not started when `handoffs-approved.json` in the run's artifacts lists it and `handoffs-started.json` does not. A run that has no `handoffs-started.json` is judged by the `started <workflow>, run <id>` lines of its `handoff` node. A completed run older than 14 days is not listed, so the first sweep does not queue old builds.

A failed run closes without asking you only when its `finish` nodes completed and the failure came afterwards in a `housekeeping` node. A completed or cancelled run of a workflow with no registry entry is judged by its work alone. A failed run that a completed run adopted (`adopted_from_run_id`) counts as rescued by that run.

## Failure classes

The class comes from the failure that the run recorded in its last `workflow_failed` event. A dead run has class `other` and the exit reason `dead`. The tests run in this order, and the first that matches decides:

- `housekeeping` — the first failed node is in the entry's `housekeeping` list, such as a `build` run that failed in `cleanup` after it landed. `handoff` is not housekeeping, because a failed hand-off leaves work for you.
- `transient` — the exit reason is `launch_failed` and the error contains `Timed out creating workspace`, which means a launch lost a race for the workspace.
- `systemic` — the error contains `Credential preflight failed` or `Cannot determine git r`, the exit reason is `unhandled_error`, the first failed node is in `attention_nodes`, or its name contains `lane` or `guard`. A `build` run that failed in `gates_declared` is an example.
- `other` — any failure that no earlier test matched, such as an ordinary node failing.

A failure's signature is `workflow|first_failed_node|exit_reason|error head`, with digit runs and hex runs replaced by `N` and the head cut to 70 characters. The signature is recurring when at least two `workflow_failed` events with it, the run's own included, are newer than its last `answered` ledger entry and fall within 30 days. An answer therefore resets the count. The signature keys the ledger and the list of earlier failures in the facts. The report does not print it.

## Rescue rungs

A rescue runs at most three rungs for a run, in the order below, each once. The workflow inspects the run again after each rung. A rung that spends a model runs only when `spend=yes`, and when the next eligible rung spends and the run may not spend, the route becomes `attention`. A rung that starts or resumes a run waits for it with `archon workflow wait` for at most 45 minutes.

- `commit-wip` (no model) — eligible when the work is `unsaved`. It switches a detached `HEAD` to `wip/<workflow>-<run8>`, runs `git add -A` and commits with `wip: preserve <workflow> run <run8> (workflow-cleanup)`. A hook that refuses the commit fails the rung. The rung does not pass `--no-verify`.
- `land` (no model) — eligible when the entry has `land`, the run counts as failed, the gate that `land` names was answered `approve` or the run's `state` file holds `yes` for the key that `land` names under `state`, the work is `branch` or `pushed`, the base branch is an ancestor of `HEAD`, and the run did not deliver by draft pull request (`deliver` in its `state` file, or `deliver.txt` in a run made before `state` existed). It takes the repository's git lock (`$ARCHON_HOME/state/<repo>-git.lock`), runs `run-gates.sh feature` in the worktree and, only when the gates pass, runs `worktree-land`. It then checks that no patch is missing from the base branch.
- `resume` (spends) — eligible when the run is `dead`. It runs `archon-dead-runs.sh backup` and `mark-failed`, then `archon workflow resume --detach` from the run's path, then waits.
- `relaunch` (spends) — eligible when the exit reason is `launch_failed` and the class is `transient`. It runs `start-run.sh run` from the repository with the recorded `inputs` and message, then waits.
- `adopt` (spends) — eligible when the entry has `adopt`, the run failed with class `other`, the run is not itself an adoption, it started from a `design` input or a message, the workflow definition it captured differs from the current one, and its artifacts hold `plan.md` and an approved plan, which is `plan-decision` set to `approve` in `state`. A run made before `plan-decision` was recorded qualifies when it kept `tests-sha` in `state`, or in a `tests.sha` file before `state` existed. It runs `start-run.sh run <workflow> --adopt <run>` with the recorded `inputs` and message, then waits.

An adopting run's message arrives empty, so the `intake` node of `build` takes the slug from the adopted run's artifacts, where `intake` kept the message's brief, and `reuse` copies that brief into the adopting run. A run begun before briefs moved there has a brief commit instead, and the node falls back to it. An adopted run with neither fails there and names the run. The rung skips a run that is itself an adoption because a failed adoption would otherwise be adopted in turn.

A rescued run that reaches a pause of its own ends the rescue as `waiting`. That pause is the attention item, so the workflow raises no second one. The answer `retry` runs `rescue --retry`, which writes a `retry` marker to the ledger, lets each rung run once more and runs up to three rungs in one call. A rung's outcome is its ledger entry's detail, `<rung> ok <message>` or `<rung> failed <message>`.

## The pause

The `notice` node raises the only pause for a run. Its first line is the report link and its second is the headline, which gives the cause in one clause and then the recommended answer. Its third line says what each answer does. The report page is built by `report.sh markdown cleanup`, so a repository with a `report_cmd` gets the same page shell as its plan and review reports, and a repository without one gets the plain page from `report-page.py` (see [Reports](../reports.md)). The page is at `$ARCHON_HOME/designs/<repo>/workflow-cleanup-<name>-<first six characters of the run id>/index.html`, and its link ends at the directory. `<name>` is the `slug` that `diagnose` returns, or the name of the cleaned run's workflow when the diagnosis has none, as one cached before the field existed does. A worktree report takes `<name>` from the `slug` that `wt_assess` returns, or from the worktree's directory name. The first page a run builds fixes the slug, and a rescue that builds the page again keeps its address.

The report answers four questions: what happened, whether it should have happened, whether the run needs a rescue, and whether its work matters. The nodes `facts`, `follow_candidates`, `diagnose` and `diagnosis` produce what the report needs. A step that fails or produces nothing costs the report its diagnosis, and the pause still happens.

### Facts

The `facts` node runs in each mode and prints `none` unless the run needs a person. For a run that does, it writes `facts.json` and `facts.md` (at most 100 KB) to the artifacts directory and prints `fresh` or `cached`, or `none` when it could not gather the facts. The facts hold:

- The run's task: its message, its inputs, the first heading of its `plan.md` or `brief.md`, and how it began, such as a run it adopted or the rescue rung or hand-off that started it.
- A timeline with one row for each node (state, start time, exit code, time taken), loop iterations collapsed to one row with a count, nodes that did not run grouped by cause, a row for each resume after a pause you answered, and at most 40 rows.
- The registry's `effects` for the workflow: each node that changes something outside git, and whether it completed, failed or did not run.
- The state of the work, with the commits and the diffstat against the base branch for a branch, a pushed branch or unsaved work.
- Runs of the same workflow that started within a minute of this one or overlapped it, because two runs can race for a shared file.
- Earlier failures with the same signature in the last 30 days, with their cause and what you answered, including the run a hand-off started and how it ended.
- The output of the failing node, of the last node that finished and of each effect node, as the head and the tail, with a note when Archon had clipped it to 2,000 characters.
- The failing node's text in the workflow definition that the run captured, whether the current definition differs from it, and the commits made since the run started to the files that text names, in the run's repository and, when the kit's clone is recorded, in the clone.
- Each artifact file with its size, and the first 30 lines of `blocked*.md`, `resolution.md`, `restore.txt`, `*report*.md` and `*.log` files under 20 KB, up to 60 KB in all.

A run's start time is the first record of its transcript, because a resume rewrites `started_at` in the database. A collector that fails leaves its section out and names the gap at the end of `facts.md`. The node prints `cached` when `facts.md` hashes to the value cached for this run, and copies the cached diagnosis to `diagnosis.json`.

### Diagnosis

The `follow_candidates` node prints the list that `start-run.sh candidates --also build` gives for the run's repository, which is the list the `research` workflow offers. It holds the hand-offs the repository declares, `build` in this repository when it can start here, `build` in each other repository under `workspace` where it can start, each available global hand-off from `kit.json` and, when the repository declares none of its own, `check-later`.

The `diagnose` node is a model call at the `medium` tier ([Providers](../providers.md) explains how tiers map to models). The agent is told to read only: it reads `facts.md`, any further file that file names, and the candidate list, and it uses read-only commands and no network. It returns the cause, whether the failure was expected, where the defect is, whether a rescue is needed and its steps, whether the work matters, a recommended answer with a reason, a confidence, and its evidence, each item marked `confirmed` only when the agent read it in a file or log. The `defect` field takes one of these values:

- `repo` — a file in the run's repository.
- `global-workflow` — a file of an installed copy of the kit, which means a file under `$ARCHON_HOME/workflows/` or `$ARCHON_HOME/scripts/` that `$ARCHON_HOME/kit-installed.json` lists.
- `environment` or `operator` — an absent operator, an unreachable machine or a quota.
- `none` — no defect.
- `unknown` — the agent could not place it.

When the recommended answer is `follow-up`, the agent names one entry of the candidate list in `follow_up`: the workflow, the repository (empty for the run's own), the inputs the list asks for, and a note that names the files and the change. The node runs only when `facts` printed `fresh`, so a pause that nobody answered costs one model call and not one for each sweep.

The `diagnosis` node keeps the agent's output in `diagnosis.json` when it parses and names an answer. It caches the output in `$ARCHON_HOME/state/workflow-cleanup/diagnoses/<run id>.json` with the hash of `facts.md`, and prints `ok`, `cached` or `none`. A different `facts.md`, such as one that lists a new artifact or a new commit on the failing node's files, misses the cache and is diagnosed again.

### Recommended answer

The `headline` node writes the report from the verdict, `facts.json` and `diagnosis.json`. Before it renders, the script holds the recommended answer to what the defect's location allows.

| Defect                              | Answers the report may recommend |
| ----------------------------------- | -------------------------------- |
| `repo` or `global-workflow`         | `follow-up`                      |
| `environment`, `operator` or `none` | `accept` or `retry`              |
| `unknown`                           | `research`                       |

A commit in `fixed_by` that the facts contain also allows `accept` and `retry`, because a defect that is already fixed needs no change. A `fixed_by` without a commit id from the facts is dropped. For a defect of any location, `accept` is also allowed when the diagnosis says no rescue is needed (`rescue` is `none-needed`) and the work is minor or has no value (`work_value` is `minor` or `none`), because closing the run out then loses nothing.

The recommendation becomes `research` when any of these holds, and the summary says why:

- The agent's answer is outside the row for its defect and the allowances above, or is not on the menu, `discard` included.
- The diagnosis has `low` confidence.
- The recommendation is `follow-up` and `start-run.sh check --also build` drops the `follow_up` entry in the run's repository, for example because the entry is not on the candidate list, supplies different inputs from the ones the candidate asks for, or names a repository where `build` cannot start.

The `research` run gets the agent's `question`, or one made from its summary. A defect in an installed kit file gets a `follow-up` only when the candidate list holds a candidate that can change the file, such as `build` in the repository that holds the kit's clone, which has to be under `workspace` and a place where `build` can start.

### Report

The report is titled `Cleanup of <workflow> run <run8>: <cause in one clause>`. Its summary reads `Recommended answer: <answer>. <why>.` and then `Confidence: <confidence>.` When a rule above changed the agent's answer, the next paragraph gives the answer the agent recommended and its own reason, so the rule's wording does not replace it. When the answer is `research`, the question that the run will be asked follows as `Question for the research run: <question>.` When the answer is `follow-up`, the next sentence names the workflow, the repository and the scope. The sections follow in the order of your questions: `What happened`, `Whether it was expected`, `Rescue` (with the exact commands when one is needed), `Value of the work`, `Evidence` (each claim marked `confirmed` or `inferred`, with its source) and `Facts`.

With no diagnosis the summary reads `No diagnosis (the diagnosing agent produced none). Facts below.`, only `Facts` follows, and the headline is the plain description of the run and its route.

## Answers

Answer the pause in the web console or with `archon workflow respond`. An empty answer is `accept`.

| Answer | What happens |
| --- | --- |
| `research` | Starts `research` from the run's repository with the report as its brief |
| `follow-up` | Starts the workflow and repository that the report names, with the report as its brief |
| `retry` | Rescues once more with `spend=yes`, then removes the worktree if the run closes |
| `accept` | Commits unsaved work with `commit-wip`, then removes the worktree and keeps an unlanded branch |
| `discard` | Removes the worktree and its branch, and prints the old tip |

The `follow-up` answer starts the `follow_up` entry through `start-run.sh start --strict`, so a start that fails makes the answer fail. It works only when the report recommends `follow-up`. Otherwise the hand-off refuses it with "the report recommends no follow-up that can start". A pause raised before the `follow-up` answer existed offers one answer for each workflow it could start, and its captured definition still passes that workflow's name to the script. The script accepts such a name and starts the workflow, with the old diagnosis's `fix` text as its scope, only when `start-run.sh check --also build` lists the workflow for the run's repository. The `discard` answer prints the old tip so that `git branch <name> <sha>` restores the branch.

The hand-off message holds your note, the report's title, `## Established by the cleanup report` (what happened, where the defect is and the evidence), `## Question` for `research` or `## Task` for `follow-up`, and the report's `## Facts`. With no diagnosis it holds the whole report. For `follow-up`, `start-run.sh` adds the entry's note under `## Scope of this run`. A hand-off leaves the run's worktree in place as evidence for the follow-up. The workflow starts no follow-up without your answer and does not apply a recommendation.

```bash
archon workflow respond <cleanup-run-id> accept ""
archon workflow respond <cleanup-run-id> research "find why the rollout step failed"
archon workflow respond <cleanup-run-id> follow-up "keep the change small"
```

## Worktree pass

A sweep also goes through the worktrees of the project it runs in, whoever made them: Claude Code session worktrees, worktrees that other tools created and hand-made ones. It runs from the main checkout or from any linked worktree and finds the same project. It compares each worktree with the project's `main`, or `master` when there is no `main`. A repository with neither is skipped with `skipped: no main or master branch`. Sweeping another repository means running from it.

The `wt_sweep` node prints one row for each worktree: `would delete` or `deleted`, `would assess` or `assess`, or `ignore: <reason>`. The first rule that applies decides.

1. A worktree that is in use is ignored. In use means one of these:
   - A process has its working directory inside it. The workflow reads the working directories from `/proc`, and from `lsof` where there is no `/proc`. Where neither can list them, the worktree counts as in use and the row says "this system cannot show which processes work inside it".
   - Its lock has the form `claude session <name> (pid N start T)`, which Claude Code writes for its own session worktrees, and that process is alive: `/proc/N/stat` exists and its start time, field 22 counted after the last `)`, is `T`. Where there is no `/proc` the start time cannot be read, so the lock counts as a live session and stays.
   - An Archon run that is live, or that has no terminal ledger entry, has it as its working path. A `workflow-cleanup` run that is not live does not count, because `candidates` skips `workflow-cleanup` runs.

   A lock with any other reason is respected, and so is a prunable worktree, whose directory is gone. A lock that names a Claude Code session whose process is gone is stale, and the sweep unlocks it before it deletes the worktree.

2. A worktree with a clean tree whose content is in `main` is deleted with its branch, silently. The tree is clean when `git status` shows nothing outside the scratch directories. The content is in `main` when `git cherry` finds no missing patch, so rebases and cherry-picks count, or when all files the branch changed since the merge-base are identical in `main`, so squash merges and reverts count. A detached `HEAD` is judged by the same two tests. A branch whose patches differ from `main`'s, as after a squash merge, is deleted with `--discard-unlanded`, and the deletion is recorded as `wt-deleted` with the tip.
3. Any other worktree, one with unlanded commits or uncommitted changes, is assessed. `wt_sweep` starts one `workflow-cleanup` run with `worktree=<path>` for each, from the main checkout, at most three per sweep, and appends `wt-queued`. The ledger can end the assessment first: a worktree whose branch you declined, one assessed as worth keeping whose content has not changed, and one that another live run is assessing are ignored.

The idle time of a worktree does not count. A worktree made a moment ago at the tip of `main`, or one that `worktree-land` just reset, is deleted unless one of the in-use conditions holds it. A tool that creates worktrees without a lock is protected only by the process condition, so a sweep can delete its worktree while the tool's session is idle.

### Assessment run

An assessment run works in these steps:

- `wt_inspect` classifies the worktree again, because the sweep's view may be minutes old, and writes the route: `skip`, `delete` (a worktree that became clean and landed meanwhile is deleted without a prompt), `abandon` (the ledger holds an `abandon` verdict for the current content), `assess`, or `dry`. For `assess` and `abandon` it writes the facts file.
- `wt_assess` is a model call at the `medium` tier by an agent that is told to read only. It reads the facts file, which holds the worktree's unlanded commits, a diffstat, each uncommitted file labelled `identical-to-main`, `differs-from-main`, `absent-in-main` or `deleted`, the commits on `main` that touched the same paths, and the diffs, each capped at 40 KB and the file at 100 KB. The agent returns `abandon` only when it is confident that nothing is worth keeping: the content is in `main` under another form, is superseded there, or is trivial. It returns `keep` when it is unsure.
- `wt_judge` caches the verdict by a fingerprint of the content (`HEAD`, the status, the diff against `HEAD` and the untracked files) that `wt_inspect` saved in `wt-verdict.json`. An unchanged worktree is assessed once, and an edit made during the model call leaves the new content unassessed.
- A `keep` verdict ends the run silently, and the worktree is not assessed again until its content changes.
- An `abandon` verdict raises one pause, `wt_notice`, whose first line is the report link and whose second line says what each answer does.

The report opens with `Recommended: delete (the assessor found nothing worth keeping)`. It lists only the uncommitted files that differ from `main`, are missing there or were deleted, gives the count of the files identical to `main` once instead of listing them, and shows only the commits on `main` that touched the listed files.

| Answer | What happens |
| --- | --- |
| `delete` | Saves uncommitted work as a commit, removes the worktree and branch, and prints the old tip |
| `keep` | Appends `wt-declined` with the branch, and the worktree is not assessed again |

With `delete`, a hook that refuses the work-in-progress commit fails the step and nothing is deleted. When the branch is removed, the output ends with `restore with: git branch <name> <sha>`. A worktree you answered `keep` is still deleted if it later lands in `main`. The answer covers one branch, so a new branch at the same path is assessed again. An empty answer is `keep`. Before it deletes, `wt-act` checks again that the worktree is not in use.

```bash
archon workflow respond <cleanup-run-id> delete ""
archon workflow respond <cleanup-run-id> keep ""
```

With `dry=yes`, the worktree pass lists what it would delete and assess and starts and changes nothing. An assessment run started with `dry=yes` routes `assess` to `dry` and makes no model call. A worktree that `worktree-cleanup.sh scan` could not describe is missing from the scan, and the scan says so on stderr. The sweep prints that worktree as `ignore: worktree-cleanup.sh scan did not list it`, followed by the scan's warnings as `scan:` lines, and does not touch it.

## The ledger

`$ARCHON_HOME/state/workflow-cleanup/ledger.jsonl` records what this install did. It sits under `state/`, which the kit's installer does not write. Each line is one JSON object with `run`, `ts` (ISO-8601 UTC), `action`, `detail`, `signature` and `child` (a started run's id). Each append takes a `flock` on `ledger.lock` beside the ledger. The diagnosis cache, `$ARCHON_HOME/state/workflow-cleanup/diagnoses/<run id>.json`, holds `{facts_sha, diagnosis}`, so a pause that nobody answered reuses its diagnosis until its facts change.

| Action | Written when |
| --- | --- |
| `queued` | A sweep started a cleanup run for the run |
| `rung` | A rescue rung ran, or `rescue --retry` began (detail `retry`) |
| `closed` | The run was closed out |
| `rescued` | A rescue left a run waiting at a pause |
| `answered`, `handed-off`, `accepted`, `discarded` | You answered the pause, and what the answer did |
| `attention` | A pause ended without an answer |
| `wt-queued` | A sweep started an assessment run for a worktree (`child` holds its id) |
| `wt-assessed` | The assessor judged a worktree: `detail` is `<verdict> <reason>` and `signature` is the fingerprint |
| `wt-declined` | You answered `keep` at a worktree pause (`detail` is the branch) |
| `wt-deleted` | A worktree was removed (`detail` is `<branch> <tip>`, with `-` for a detached `HEAD`) |

The entries `closed`, `rescued`, `answered`, `handed-off`, `accepted` and `discarded` are terminal: a run that has one is not a candidate again. The four `wt-` entries use `wt:<realpath>` as their `run`, so they match no run id and add no terminal entry to any run.

## The registry

The registry says what counts as a finished task for each workflow. It is a JSON object with one entry for each workflow name, and each key of an entry is optional. A run of a workflow with no entry reaches you at a pause when it fails, which is the safe default.

The registry has three layers. A later layer replaces an earlier entry for the same workflow name.

1. The kit's own file, `$ARCHON_HOME/scripts/workflow-done.json`, which has entries for `build`, `research`, `review-change`, `anti-entropy` and `check-later`.
2. The `done` object in `$ARCHON_HOME/kit.json`, which applies to each repository.
3. `<repository>/.archon/workflow-done.json`, which applies to runs in that repository.

| Key | Meaning |
| --- | --- |
| `finish` | Groups of node ids, each satisfied when one of its nodes has a `node_completed` event |
| `housekeeping` | Nodes whose failure, after the task finished, does not need a person |
| `git` | `landed` requires a close-out to leave the work `none`, `landed` or `pr`; any other value asks nothing |
| `land` | `{ "approval": <node>, "state": <key> }`, the final gate whose `approve` answer allows the `land` rung, and optionally a `state` key that the same run records as `yes` when it skipped that gate |
| `adopt` | `true` allows the `adopt` rung |
| `attention_nodes` | Nodes whose failure is systemic |
| `effects` | `{ "<node>": "<what it changes>" }`, the nodes that change something outside git |

A node id matches the name Archon records for a node exactly or after a loop prefix, so `final_gate` matches `build_cycle.final_gate`. An entry without `finish` asks nothing of a completed run and makes a failed run count as unfinished, so that failure reaches you. The `effects` key exists because a work state of `landed` says nothing about a deployed service or a live configuration. The facts say whether each effect node completed, failed or did not run. For example, a repository that has a `deploy-staging` workflow can declare it in its own `.archon/workflow-done.json`:

```json
{
  "deploy-staging": {
    "finish": [["rollout"]],
    "housekeeping": ["notify"],
    "git": "none",
    "attention_nodes": ["credentials_check"],
    "effects": { "rollout": "the staging deployment" }
  }
}
```

The kit's entry for `build` has `finish` set to `[["sync_cycle", "deliver_pr"]]`. The `sync_cycle` node records a `node_completed` event only when the landing loop ends, so a build that failed in `handoff` or `cleanup` afterwards still counts as finished. Only `cleanup` is housekeeping. The kit's entry for `publish` has `finish` set to `[["verify"]]` and declares the effect of its `run` node. A group that named `cleanup` would not count such a build as finished. [Extending the kit](../extending.md) explains how to write entries for your own workflows.

## Settings in kit.json

The person who installed the kit sets machine-specific values in `$ARCHON_HOME/kit.json`, a flat JSON object that `kit-settings.sh` reads. [Extending the kit](../extending.md) describes the file. The cleanup scripts use these keys:

| Key | Default | Use in cleanup |
| --- | --- | --- |
| `scratch_dirs` | none | Directory names whose untracked content does not count as work to save |
| `run_env` | none | Environment variables set for runs the kit starts, and for rescue rungs that resume or wait |
| `workspace` | `~/workspace` | Where repositories live, which `start-run.sh` uses to find other `build` targets |
| `done` | none | Registry entries that apply to each repository |
| `handoffs` | none | Global hand-offs that the follow-up candidate list may include |

A directory name in `scratch_dirs` has no slash and matches at any depth. The scan, the worktree pass and the content fingerprint ignore paths inside such a directory. The `commit-wip` rung runs `git add -A`, which stages untracked files in a scratch directory that your git ignore rules do not cover whenever the tree has other changes to save, so list the directories in your ignore rules as well.

## Limits

- The workflow does not run on a schedule, and the kit installs no timer. A cron entry would run the sweep unattended, but rescues, diagnoses and assessments spend tokens, so scheduling it is a separate decision.
- A cleanup run that fails keeps its worktree, and cleanup runs are not candidates themselves. The worktree pass of a later sweep removes that leftover once the run is no longer live and the worktree's content is in `main`.
- `build` cannot target a directory that is not a git repository, so a run in such a directory gets no `build` follow-up.
- A worktree of an idle Codex session is protected only by the process condition of the worktree pass, which holds while a process has its working directory inside it.
- The process checks read `/proc` on Linux. Where there is no `/proc`, such as on macOS, they ask `ps` for the owner's command line and `lsof` for the processes in a directory. Where those fail too, a run's owner reads as `unknown`, and an `unknown` owner is not `dead`, so the run is left alone, and every worktree counts as in use. The sweep then deletes nothing until `lsof` or `/proc` works. `lsof` shows the processes of the user who runs it, so a process of another user inside a worktree is not seen.
- `gh` is optional. Without it a branch that has an open pull request reads as `pushed` and not `pr`.
- Archon's database tables are private to Archon, and the kit's scripts are tested only against Archon 0.13.x. Each subcommand of `workflow-cleanup.py` checks that the tables and columns it uses exist before it reads them, and refuses with one line that names the Archon version when one is missing. `archon-dead-runs.sh schema` runs the same check.
