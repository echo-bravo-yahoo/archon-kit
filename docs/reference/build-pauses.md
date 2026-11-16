# Build pauses and the base check

This reference explains what a `build` run does when a gate is red before the run starts, what each pause of the build loop offers, when the loop fails the run instead of pausing, and how to bring a fix from the base branch into a run that is waiting or has failed. It is for the person who answers `build` runs.

## The base check

Before a run plans anything, the `base_gates` node runs the repository's `feature` gate set on the commit where the run's branch left the base branch. A gate that is red there cannot be made green by anything the run does, so the run ends at once with the failing gates and their output, and no model has been used. The run's own worktree is not touched: the gates run in a throwaway worktree under the run's artifacts directory, which is removed afterwards.

The message names each failing gate on its own line, then says to fix the gates on the base branch and start the run again. The output of every failing gate follows, and is also in `base/gate-report.md` in the run's artifacts directory. All the ordered gates run, not only up to the first failure, so one run reports every red gate.

The node records one word as the `base-gates` key in the run's `state` file and prints it.

| Word | Meaning |
| --- | --- |
| `green` | Every gate passed on the base commit. |
| `cached` | An earlier run found this commit green, so the gates were not run again. |
| `skipped` | `.archon/build.json` turns the check off. |
| `unknown` | The check could not run, for example because the base commit has no `.archon/gates.json`. The run goes on without it, and the reason is in the node's output. |

A green result is cached by commit under `$ARCHON_HOME/base-gates/<repository>/`, so several runs started from the same commit run the gates once. A red result is never cached, so a flaky test or a fixed environment gets another look at the next start.

To turn the check off for a repository whose gates take too long to run twice, set `base_gates` to `"off"` in `.archon/build.json`. `"on"` is the default and the only other accepted value besides `true` and `false`. A run that has adopted another run's branch is checked on the commit where that branch left the base branch, not on the adopted commits.

## The plan pause

A run that plans pauses at the plan gate when the planner sets `needs_decision` or proposes a hand-off. The message starts with the plan page's address. It then gives the first paragraph of the planner's `summary`, which the planner is told to write as two sentences of under 350 characters, what the work is and why it is wanted, and which the message cuts to 400 characters at a sentence end if it runs longer. The page's summary continues with the work item by item, what `approve` starts and the decision asked. A line follows that names each hand-off the run starts after delivery, and the planner's question when it asked one. The last line says that `approve` starts the build of the plan and that `rework` asks for a new plan with your note.

The run fails at `plan_record`, before the gate, when the plan has a defect: a hand-off that the repository does not allow (one line on stderr and in `plan-defects.txt` names it), or more things that nothing puts live (`gaps`) than `build` hand-offs. No plan page or gate is built for a refused plan.

The plan page opens with the same `summary`, and its banner shows the decision when there is one, what `approve` starts (this build, then each hand-off by name with its inputs, or "nothing after it") and each stage the plan skips with its reason. The banner leaves out the line about hand-offs for a run whose `handoffs-approved.json` is missing or unreadable.

## Publish targets and hand-offs

When the change touches the `auto_paths` of a `publish` target in `.archon/build.json`, the final pause's message, and the `auto_land` message, adds the line `After landing this run also starts: publish <target>`. A run that delivers a draft pull request says `Not started by this run, because it delivers a draft pull request: publish <target>` and starts no `publish`. After delivery the `handoff` node starts every approved hand-off and every matched `publish` once, with up to three tries each. A hand-off that cannot start fails the run, and `handoffs-started.json` in the run's artifacts records the ones that did, so a resume starts nothing twice.

## Pauses of the build loop

A round of the build loop ends at the final pause when the gates are green and the review is clean, or when the implementer asks a question in an interactive run. The pause kind is the `pause-kind` key of the run's `state` file.

| Kind | What the pause means | What each answer does |
| --- | --- | --- |
| `clean` | The change is built, reviewed and green. | `approve` lands it, `rework` sends a note back for another round, and `reply` counts as `rework`. |
| `ask` | The implementer asked a question. | `reply` keeps building with the answer, and `approve` finishes the work with what exists. |

A run that the owner answered during the build, such as an interactive run that asked for a measurement, records the answers in `owner-notes.md`. At a `clean` pause the `report_pick` stage reads that file and returns `findings`, at most three sentences on what the answers showed and what the change records of them. The review page opens with them under "What the run found", the pause message prints them on a line of their own after the "waits for you to land it" sentence, and the page keeps the answers themselves in a closed section after the review. `review-change` checks the change against the answers too, and treats a recorded result that they contradict or do not support as blocking. A run with no owner answers has no `findings`, and its page and message are as before.

The `report_pick` stage also writes the review page's summary, which opens with whether the change does what was asked and names any departure from the plan, and returns `open_items`: each caveat, unverified item, step to take after landing and declined test that `report.md` or the plan lists as still open, one sentence each. It leaves out an item that only says a gate had not run when the review was written, because the gates have run by then and `gate-report.md` has their result, and keeps an item for a gate that failed or was skipped. The page shows them in an "Open items" section right after the Summary and counts them in its banner, and the pause message says how many the page lists. The page and the message leave them out when the list is empty or the field is missing, as in a run that began before the field existed. `review-change` knows that a build's gates run after it, so it does not report a gate that has not run as a defect, and it lists what it could not verify under a final `## Not verified` heading of `report.md`.

## A loop that does not converge

A round passes when every gate passes and the review says clean. Five rounds in a row that do not pass fail the run, and no pause asks the owner anything first: nothing the owner could answer would change a red round, and every answer would only start another one. The run keeps its branch and its worktree, and the error says what to do next:

```text
The build loop stopped: the last 5 rounds in a row did not pass. A round passes when every gate passes and the review says clean. In the last round `npm test` failed and the review said clean. These gates did not run: `npm run lint`.
The branch keeps its commits in <worktree>. To continue from it, run `archon workflow run build --adopt <run-id> --detach` from the repository.
```

The count restarts at zero after a green round and after any answer at a pause. The fifth round runs every gate, not only up to the first failure, so the error names every red gate, and it lists the gates that did not run. The error describes the last round only. A separate cap of 30 rounds counts every round, the owner's `rework` answers included, and also fails the run.

To continue, fix the cause and adopt the run: `archon workflow run build --adopt <run-id> --detach` starts a new run on the failed run's branch and worktree, reuses its plan and tests, and skips planning. When the cause is on the base branch, bring the fix into the failed run first with `archon-kit run-sync`, below. A run started before this behavior was added still pauses as `stuck` after three rounds, whose answers all start another round.

## Bringing a fix into a waiting or failed run

The loop synchronises with the base branch only when it ends, and a loop whose gates are red does not end. A fix that lands on the base branch after the run started therefore never reaches the run's gates by itself. `archon-kit run-sync` brings it in while the run is paused or after it has failed.

```bash
archon-kit run-sync <run-id> <commit>...
archon-kit run-sync <run-id>
```

With commits, it cherry-picks each one with `git cherry-pick -x`, in the order given, in the run's worktree. Without commits, it merges the run's base branch, which is the `fork-ref` key in its `state` file. A cherry-pick of just the fix usually applies when a merge of the whole base branch conflicts, because other runs have landed overlapping work meanwhile. The run id can be a prefix of at least a few characters.

It refuses unless the run's status is `paused` or `failed` and its worktree has no uncommitted changes. A conflict leaves the branch where it was, names the conflicting files and ends with an error. It never rebases, because the run's `state` records commit ids that a rebase would orphan. The lane checks compare against the base branch by name, so the commits it brings in do not count as changes the run made.

Afterwards, answer the pause to start the next round, or adopt the failed run as described above:

```bash
archon workflow respond <run-id> rework "The failing tests were stale on the base branch; the fix is cherry-picked."
```

A note that says nothing needs changing keeps the implementer from editing code that is not at fault.
