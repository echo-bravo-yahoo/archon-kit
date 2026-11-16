# # Keep a message's brief out of the repository

# Keep a message's brief out of the repository

## Why

When `build` starts from a message and no design or brief exists for it, the `intake` node (`workflows/build/build.yaml`) writes the message to `<brief_dir>/<slug>/brief.md` and commits it on the run's branch as `docs: add the <slug> brief`, so that it lands with the change. Nothing needs it there. The message is already kept in Archon's database and a run's artifacts directory sits outside the worktree. The commit costs the repository more than it gives:

- A brief is whatever the message said, and a message is often built from research output, so it can carry private specifics. One brief held real host names and a device location and was on its way into a public repository; only the reviewer's blocking finding stopped it.
- It adds a commit and a directory for every run. One repository collected 76 brief directories, and 60 of them are never referenced by anything. No code reads a `brief.md`.
- It shows up in review diffs as the first change, and the reviewer treats it as a foreign document.
- A run that is adopted after a failed start can leave a second brief behind for the same work.

The brief commit does two jobs that must keep working. Every later node reads the design or brief from `$settings.output/$intake.output/`, and an adopting run (`--adopt`) finds the slug by searching the branch for the brief commit with `git log --grep="Archon build run $from"`.

## Goal

A brief that arrives as a message stays with the run and never enters the repository: nothing is written to the worktree and nothing is committed for it. A design or brief that the owner commits to `brief_dir` and names by slug works as it does today.

## Changes

1. In `intake`, when a message is the brief, write it under the run's artifacts directory (for example `$ARTIFACTS_DIR/brief/<slug>/brief.md`) and do not touch the worktree or the index. Keep the file's content as it is today (the `# <first line>` heading, then the message). `workflow-cleanup` already reads a run's `brief.md` from its artifacts directory to title the run, so check where it looks and put the file where it finds it, or make both agree.
2. Add one node after `intake` that prints the directory holding the design or brief: the committed `<brief_dir>/<slug>/` when the design or brief is committed there, and the run's artifacts copy otherwise. Replace the seven uses of `$settings.output/$intake.output/` in `build.yaml` (the `approach`, `spec`, `tests`, `implement`, `review` and report prompts, and the wording near line 1004) with that node's output. Every stage must still be able to read the whole directory, and a stage confined to a lane must still be able to read it.
3. Make adoption work without the brief commit. The adopted run's artifacts directory holds the brief, so `reuse` copies it into the adopting run's artifacts and `intake` takes the slug from the adopted run's artifacts. Keep the existing lookup through the branch's brief commit as a fallback, because a run that began before this change committed its brief, and it can still be adopted.
4. Update the tests that assert the old behaviour. Add tests in `test/workflow-nodes.test.mjs`, which already runs single nodes' bash in throwaway repositories, for these cases: a message with no design makes no commit, leaves the worktree clean and writes the brief under the artifacts directory; a committed design and a committed brief named by slug are used in place, with no copy; the node after `intake` prints the right directory in each case; an adopted run's slug comes from its artifacts, and from the brief commit when the artifacts have none. Update the fixtures under `workflows/build/fixtures/` that stub `intake`.
5. Update the kit documentation where it says `intake` commits the brief, or where it describes `brief_dir`: `brief_dir` holds the designs and briefs the owner writes and commits, and a message's brief stays with the run.

## Constraints

- Follow `CLAUDE.md`: no personal path, host, repository or tool name in any file (`test/scrub.test.mjs` fails on them), use `${ARCHON_HOME:-$HOME/.archon}`, use only bash 3.2 features, and keep every `model:` a tier or an alias.
- A paused run keeps the definition it captured, so keep every existing node id, and keep a run that began before this change working.
- Do not change how `research`, `anti-entropy` and `workflow-cleanup` start a build or read a brief, except where this change requires it.
- Run the gates in `.archon/gates.json`.
