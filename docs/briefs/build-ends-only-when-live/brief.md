# Fail a build run whose deliverables are not live, and add a publish wo

Fail a build run whose deliverables are not live, and add a publish workflow

A `build` run may end `completed` only when everything it produced is live, or a workflow it started owns finishing it. Today a run can end `completed` with a page that was built, tested and merged but never published, because nothing in `build` refuses a deliverable that has no workflow behind it, and nothing notices afterwards. A hand-off that cannot start fails its run, and the failure reaches the owner through `workflow-cleanup` instead of ending quietly.

## Background

A `build` run ended `completed` with a documentation site built, tested and merged to the base branch and never published. Its approved plan said the publish command "runs after the build lands" and that "no workflow does it". An earlier fix told the planner to list such unowned steps as prose, which made them visible and left no one to do them.

Reading the kit shows five causes:

- The planner's instructions (a repository's `build-notes/plan.md`) tell it to list things with no workflow as prose. That is a repository file, so this brief changes only the kit side of the rule.
- The `handoff` node of `build.yaml` exits 0 when a hand-off fails to start, and its comment says the change "is already delivered".
- `scripts/workflow-done.json` lists `handoff` under `build.housekeeping`, which `workflow-cleanup` treats as a failure that does not need a person, so `analyze` routes it to `close`.
- The `plan_record` node (inside `plan_cycle`) sends `start-run.sh check`'s stderr to the node log, so an undeclared hand-off disappears without a pause, and `plan_report` prints only the entries that survived. A failure of `check` itself leaves an empty list.
- A repository that declares no `.archon/` files is not listed by `start-run.sh candidates`, so a hand-off to it cannot be proposed. That one is a repository-side setup and needs no kit change.

## Decision

Leaving work for the owner as prose stops being a legal way to end a run. Each item becomes a hand-off, which is a workflow started after landing. A change under the paths of a declared publish target starts that target's `publish` run automatically, without relying on the planner. A plan with an unowned deliverable fails at plan time instead of proceeding. The cost is more runs.

## Declared targets

A repository declares what its changes publish under a `publish` key of `.archon/build.json`, an array of objects:

```json
"publish": [
  { "name": "docs-site",
    "command": "npm run publish-docs",
    "check": "curl -fsS -o /dev/null https://example.com/docs/",
    "use_when": "the change alters a Markdown doc or the docs builder",
    "auto_paths": ["docs/**", "tools/build-docs.mjs"],
    "skip_paths": ["docs/drafts/**"],
    "confirm": false,
    "in_main": false }
]
```

- `auto_paths` are git `:(glob)` pathspecs, so `**` works. `skip_paths` are excluded the same way. A change that touches any `auto_paths` file outside `skip_paths` starts the target.
- `confirm: true` makes the `publish` run pause before it runs the command.
- `in_main: true` runs the command in the repository's main checkout. The default runs it in a clean worktree at the landed commit.
- `check` is optional, because a deploy script may verify itself and exit non-zero on failure.

## Changes

Work through these in order. Use node ids, not line numbers, because `build.yaml` changes often.

1. `scripts/build-settings.sh`: give `publish` the default `[]` in the default `case`.
2. `scripts/start-run.sh`: change `declared` to append `{"workflow":"publish","pass_ref":true,"ask":["target"],"use_when":"<each target's name and use_when>"}` when `build-settings.sh publish` is a non-empty array and `handoffs` does not declare `publish` itself. In `check`, pass the target names to the `jq` filter and add the drop `dropped publish: no target named <x>`. In `start`, add `--retries N` (default 1), which repeats `do_run` for one entry until it prints a run id.
3. New `scripts/publish-match.sh <base> <head>`: for each target it runs `git diff --name-only <base>...<head> -- ':(glob)<p>'` for every `auto_paths` entry, adds `':(exclude,glob)<p>'` for every `skip_paths` entry, and prints a JSON array of `{workflow:"publish",repo:"",inputs:[{name:"target",value:<name>}],note:"changed <first matching path>"}`. It prints `[]` for no match. It avoids bash 4 features and passes `shellcheck -S warning`.
4. `build.yaml`, node `spec`: add `gaps` (an array of `{thing, why}` objects) to the `output_format` and to its `required` list, and list both properties under `required` in the object. Add a paragraph to the prompt after the hand-off paragraph: list in `gaps` each thing the change produces that no declared hand-off puts live, and propose one `build` hand-off per gap whose `note` asks for the missing target.
5. `build.yaml`, node `plan_record`: send `start-run.sh check`'s stderr to `$ARTIFACTS_DIR/handoffs-dropped.txt`, and write `start-run.sh check failed` there when `check` exits non-zero, instead of emptying the list silently. Write `$ARTIFACTS_DIR/plan-defects.txt` from that file plus one line when the count of `gaps` exceeds the count of approved `build` hand-offs. When `plan-defects.txt` is non-empty, print it to stderr and exit 1, so the run fails at plan time and names the defect. Decide how the failure interacts with the plan loop's other nodes (`plan_report` depends on this node) so that the failure is the run's visible cause.
6. `build.yaml`, node `report`: directly after `base=$sync_base.output`, run `publish-match.sh "$base" HEAD > "$ARTIFACTS_DIR/publish-matched.json"` and build a line `After landing this run also starts: publish docs-site; …`. Print the line in both the `auto` message and the pause message, before the `auto` early exit. The match belongs here and not in `handoff`, because the branch is reset to the base after landing and its diff is empty by the time `handoff` runs.
7. `build.yaml`, node `handoff`: merge `handoffs-approved.json` and `publish-matched.json` with `jq`, removing duplicates by workflow and inputs. Remove each entry already recorded in `handoffs-started.json`, so resuming a failed run cannot start a hand-off twice. Run `start-run.sh start --strict --retries 3`, append each `started <workflow>, run <id>` line to `handoffs-started.json`, and exit with `start`'s status. With `deliver` set to `draft-pr`, print the `publish` entries in the node output and skip them, because nothing is on the base branch to publish. Delete the comment that says a failed start does not fail the run.
8. New `workflows/publish/publish.yaml` with inputs `target` and `ref` and four nodes. `resolve` reads the target from the repository's `build.json` and fails when it is missing. With `in_main` false it checks out `ref` detached in the run's worktree. With `in_main` true it requires that the main checkout contains `ref` and has no uncommitted change under the target's `auto_paths`. `confirm` is a `wait:` node with the single option `publish`, run only when the target's `confirm` is true. `run` executes the command under `flock "${ARCHON_HOME:-$HOME/.archon}/state/publish-<repo>.lock"`, because two publish runs write the same tree. `verify` runs `check` when the target has one. Follow the kit's rules for a new workflow: `model:` values are `small`, `medium`, `large` or an alias, scripts reach the Archon home through `${ARCHON_HOME:-$HOME/.archon}`, and the install, `archon-kit doctor`, the fixtures directory and the README and `docs/choosing-a-workflow.md` lists (and their matching diagram) account for a seventh workflow where they now say six.
9. `scripts/workflow-done.json`: set `build.housekeeping` to `["cleanup"]` and add `"publish": {"finish": [["verify"]], "git": "none", "effects": {"run": "the published page or deployed service"}}`. Check the entry's shape against `docs/reference/workflow-cleanup.md`, "The registry", and adjust the `effects` key if the registry defines no such field.
10. `scripts/workflow-cleanup.py`: add `open_handoffs(rid)`. It reads `handoffs-approved.json` from the run's artifacts directory and subtracts the entries in `handoffs-started.json`. A run that has no `handoffs-started.json` uses the `started <workflow>, run <id>` lines in the `node_output` field of its `handoff` `node_completed` event, which the events table records. A run with no `handoffs-approved.json` has none open. In `analyze`'s `completed` branch, return `attention` with the names when any are open. In `cmd_candidates`, treat a completed run with open hand-offs that ended in the last 14 days as a candidate, so the first sweep after install does not open a cleanup run for every historic build.
11. Tests, in the existing style, and docs.
    - `test/start-run.test.mjs`: the synthesized `publish` hand-off, the unknown-target drop, `--retries`.
    - New `test/publish-match.test.mjs`: match, no match, `skip_paths`, `**`.
    - `test/workflow-nodes.test.mjs`: `plan_record` exits 1 on a dropped entry and on a gap with no `build` hand-off, `report` writes `publish-matched.json`, `handoff` skips a started entry and exits 1 when a start fails.
    - `test/workflow-cleanup.test.mjs`: a completed run with an unstarted hand-off routes to `attention`, and a failed `handoff` is no longer `housekeeping`.
    - New `test/publish-workflow.test.mjs`: `resolve` fails for an unknown target and for a dirty `in_main` checkout.
    - Update `docs/reference/build-pauses.md`, `docs/reference/workflow-cleanup.md`, `docs/extending.md` where it describes hand-offs or the registry, and the README and `docs/choosing-a-workflow.md`.

## Constraints

- No personal path, host, repository or tool name enters the kit, tests and docs included (`test/scrub.test.mjs`). Use neutral names such as `deploy-staging` for a workflow or target, `site` for a repository and `https://example.com/` for a URL.
- The gates are `shellcheck -S warning` over the scripts and `node --test test/*.test.mjs`. A change that lands here is live at once on a host that installed the kit with `--link`, and runs already working keep the definitions they captured.
- A subcommand name or flag that a paused `workflow-cleanup` run may call from its captured definition stays.

## Not included

- `research` stays as it is.
- Repositories add their own `publish` declarations and planner notes; this change does not.
- The sweep stays manual.

## Checks beyond the gates

- Replay the new `open_handoffs` over every completed `build` run in the Archon database (`remote_agent_workflow_runs` and the events table, opened read-only through Python's `sqlite3`). Each run whose `handoff` output says `did not start` should be listed, and no other.
- In a throwaway repository registered for tests, declare a `publish` target whose command exits 1 and confirm that its `publish` run fails and `workflow-cleanup` routes it to `attention`. Point a `build.json` hand-off at a missing workflow and confirm that `plan_record` fails the run with the dropped entry named.
