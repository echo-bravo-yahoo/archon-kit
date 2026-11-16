# Extending the kit

This page is for a person who wants a repository's own workflows to take part in the kit: started by `research` or `build` after you confirm them, and understood by `workflow-cleanup`. It explains the pattern first, then walks through one example, then covers hand-offs that apply to every repository and the registry that `workflow-cleanup` reads.

## The pattern

A repository adds a workflow under `.archon/workflows/<name>/<name>.yaml` and declares it in `.archon/build.json`, in the `handoffs` array. An entry has this shape:

```json
{
  "workflow": "deploy-staging",
  "use_when": "the change alters anything that is deployed to staging",
  "ask": ["service"],
  "optional": ["region"],
  "pass_ref": true
}
```

- `workflow` is the name of a workflow in the repository or a global one.
- `use_when` tells the proposing agent when the workflow applies. It is the only thing that makes a hand-off discoverable, so write it as a condition about the change.
- `ask` lists the inputs the proposer must supply. `start-run.sh check` drops a proposal that supplies other inputs or leaves one of these out.
- `optional` lists inputs the proposer may supply and need not.
- `pass_ref`, when true, gives the new run the delivered commit as its `ref` input.

Once the entry exists, `start-run.sh candidates` lists the workflow, and the `research` and `build` workflows offer it to their agents. The agent proposes it, and nothing starts until you confirm: at the `research` pause with the answer that starts the follow-up, or at the `build` plan gate, which opens whenever a hand-off is proposed. `start-run.sh start` then starts each confirmed workflow detached, from the repository's main checkout, so Archon cuts a new worktree for it. A proposal holds at most five entries, and `start-run.sh check` drops repeats and entries that the declaration does not allow.

`start-run.sh` lives in `$ARCHON_HOME/scripts/` (`~/.archon/scripts/` by default).

## Walkthrough: a deploy hand-off

The kit ships an example in `templates/workflows/handoff-example/` (installed under `$ARCHON_HOME/kit/templates/workflows/handoff-example/`). It holds a `deploy-staging` workflow that builds a commit, waits for your approval and then deploys, with two fixtures, and a `build.json.sample` with the declaration.

1. Copy the workflow into the repository and merge the declaration into `.archon/build.json`.

   ```bash
   cd ~/projects/my-repo
   cp -r "$ARCHON_HOME/kit/templates/workflows/handoff-example/.archon/workflows/deploy-staging" .archon/workflows/
   cat "$ARCHON_HOME/kit/templates/workflows/handoff-example/build.json.sample"
   ```

   Add the `handoffs` entry from the sample to `.archon/build.json`. Set `ARCHON_HOME` to `~/.archon` if the variable is not set.

2. Check that the kit sees the hand-off. The first line of the output is the candidate line for the new workflow.

   ```bash
   "$ARCHON_HOME/scripts/start-run.sh" candidates
   ```

   ```text
   deploy-staging — use when the change alters anything that is deployed to staging. Inputs to supply: none.
   ```

3. Run the workflow's fixtures. A fixture stubs each node's output and checks the route through the graph, so it proves the graph and not the commands.

   ```bash
   archon workflow test deploy-staging
   ```

   Both fixtures should pass (`2 passed, 0 failed`).

4. Run it once for real in a scratch repository, then answer the pause.

   ```bash
   archon workflow run deploy-staging --detach
   archon workflow status
   archon workflow respond <run-id> deploy
   ```

   The status shows the run paused at the `approve` node, and the answer lets it finish. This run was done with the workflow file committed on the local branch and not pushed, and Archon found it. It reads the workflow file from the main checkout. The run's worktree, however, is cut from `origin/<branch>`, so a file that a workflow reads from its worktree, such as `.archon/gates.json` for `build`, must be pushed before a run sees it.

5. Replace the placeholder commands in the `build_artifact` and `deploy` nodes with your own, adjust `use_when`, and commit the workflow and `build.json`.

From then on, a `build` plan that touches something deployed can propose `deploy-staging`, and a `research` report can propose it too. You confirm it, and the workflow starts after the build delivers.

## Publish targets

A repository that has something to put live, such as a docs site, declares it under `publish` in `.archon/build.json`:

```json
{
  "publish": [
    {
      "name": "docs-site",
      "command": "npm run build:docs && npm run deploy:docs",
      "check": "curl -fsS https://example.com/docs/ > /dev/null",
      "use_when": "the change alters a page of the docs site",
      "auto_paths": ["docs/**"],
      "skip_paths": ["docs/drafts/**"],
      "in_main": false,
      "confirm": false
    }
  ]
}
```

- `name` and `command` are required. `check`, when present, runs after the command and fails the run when it fails.
- `use_when` tells the planner when the target applies.
- `auto_paths` (glob patterns) and `skip_paths` decide when a `build` run starts the target by itself: when the change touches a path under `auto_paths` that `skip_paths` does not exclude, the run starts `publish` for the target after it lands.
- `in_main` runs the command in the main checkout, which must contain the commit and have no uncommitted changes under `auto_paths`. Otherwise it runs in the run's worktree.
- `confirm`, when true, pauses the run for your go-ahead before the command.

The repository gets a `publish` hand-off that asks for `target`, unless `handoffs` declares `publish` itself, and `start-run.sh check` drops a proposal whose `target` is not a declared name. Two `publish` runs of one repository take a lock, because they write the same tree. A deliverable that no workflow puts live is a plan failure: the planner proposes a `build` hand-off that adds the missing target, or the run fails at the plan stage.

## A hand-off for every repository

A hand-off declared in `build.json` is shared through git with everyone who uses the repository. A hand-off that belongs to you and applies in every repository, such as a workflow that keeps your own configuration repository in sync, goes in `$ARCHON_HOME/kit.json` instead. Its entry names the repository that holds the workflow:

```json
{
  "handoffs": [
    {
      "workflow": "publish-docs",
      "repo": "site",
      "use_when": "the work changes files that the site repository publishes",
      "ask": []
    }
  ]
}
```

A global hand-off is available when `<workspace>/<repo>/.archon/workflows/<workflow>/<workflow>.yaml` exists, where `workspace` is the `workspace` setting of `kit.json` (default `~/workspace`). It starts in that repository without a `ref`, because `ref` names a commit of the repository the research ran in. `candidates --also build` prints one line for it, saying where it starts. A hand-off that the current repository declares itself takes the place of a global one with the same name, and the names `build` and `check-later` are reserved.

Three limits apply. `kit.json` belongs to one person, so a team cannot share a global hand-off through git; a `build.json` entry is the shareable form. A repository outside the workspace is not offered. A global hand-off that runs no tests leaves verification to you, and the `research` prompt only asks the researcher to end its report with the commands to run before approving.

## The base branch of a started run

`start-run.sh run` passes `--base <branch>` to `archon workflow run`, so Archon cuts the new run's worktree from `origin/<branch>` and does not ask the remote for its default branch. Archon abandons that question after 10 seconds, and a run started over a slow connection then fails before its first node with `Timed out creating workspace`.

The script reads the branch from local state, in this order: `base` in the repository's `.archon/build.json`, the branch that `origin/HEAD` names, then `main` or `master`, whichever `origin` has. When none applies it passes no `--base`, and Archon asks the remote as before. Set `base` in `build.json` for a repository whose default branch has another name and has no `origin/HEAD`. A run that adopts another (`--adopt`) gets no `--base`, because Archon rejects the two options together and an adopting run takes its worktree from the adopted run. A `build.json` that is not valid JSON stops the start with an error.

## Settings in `kit.json`

`$ARCHON_HOME/kit.json` is a JSON object that belongs to the person who installed the kit. A missing file or key means the default. A file that is not a JSON object fails the node that reads it, so a typo does not fall back to the defaults.

| Key | Default | Meaning |
| --- | --- | --- |
| `workspace` | `~/workspace` | The directory that holds the repositories a run may start work in. |
| `run_env` | `{}` | Environment variables that every run the kit starts receives. |
| `scratch_dirs` | `[]` | Directory names whose untracked content never counts as work to save. |
| `done` | `{}` | `workflow-done.json` entries that apply to every repository. |
| `handoffs` | `[]` | Global hand-offs, described above. |
| `plan_rules` | none | The path of a Markdown file of planning rules for `build`'s planner. |
| `approach_check` | `false` | `true` makes `build` ask for an approach before it writes the full plan. |
| `auto_land` | `false` | `true` lets a clean `build` run that lands skip its final pause. |

A run's agents load none of your own instructions, so `build` reads the file `plan_rules` names and puts its text in the planner's prompt. A path that starts with `~/` is under your home directory. A run fails when the named file does not exist.

When the work establishes lasting knowledge, such as a measurement, a limit or a decision and its reason, `build`'s planner records it in the place your project already keeps that kind of knowledge, and adds no new structure of its own.

With `approach_check` on, the first plan pause links to a report page of the approach, written by a small-tier agent and built like the plan report. The page opens with a short paragraph saying what the work is, why, and what `approve` starts, which the pause shows as its second line, and then lists the choices still open, the files the change touches and the tests that will prove it. A note about how the approach reads rewrites only that paragraph and the page. A repository's `report_cmd` receives it as kind `approach`, and the kit's page is built when that command fails. Answer `approve` to have the planner write the full plan from that approach, or `rework` with a note to ask for another approach. The setting adds one answer to every run that plans, and it lets you redirect a wrong direction before the full plan is paid for.

With `auto_land` on, a `build` run that lands (not a draft pull request) and is not interactive skips the final pause after a round that is green, reviewed clean and made no test repair, when the plan asked no question and you have not sent the build back with `rework`. The run still writes the review report, then lands. Every other run pauses as before. `workflow-cleanup` treats a run that landed this way as approved, so it can still land one whose landing loop failed. When `worktree-land` fails in the landing loop, `run.log` gets its output followed by a line saying the rest is its trace, the last 80 commands it ran with their source lines; a landing that succeeds adds no trace.

## Telling workflow-cleanup about a workflow

`workflow-cleanup` decides from recorded facts whether a run finished its task and saved its work. It has entries for the five kit workflows that other runs start (`workflow-cleanup` never judges its own runs). A workflow without an entry in its registry always reaches you, which is the safe default: no failed run of it is closed out on its own. To let the cleanup judge your workflow, add an entry to `.archon/workflow-done.json` in the repository that owns it:

```json
{
  "deploy-staging": {
    "finish": [["deploy"]],
    "git": "none",
    "attention_nodes": ["build_artifact", "deploy"],
    "effects": { "deploy": "the staging environment" }
  }
}
```

The keys are all optional.

| Key | Meaning |
| --- | --- |
| `finish` | Groups of node ids. A group is satisfied when one of its nodes completed. A completed run is finished when every group is satisfied. |
| `housekeeping` | Nodes whose failure, after the task finished, does not need a person. |
| `git` | `landed` demands that a close-out leave the work absent, landed or in a pull request. `none` demands nothing. |
| `land` | `{ "approval": "<node>" }`, the final gate whose `approve` answer allows the `land` rung. Add `"state": "<key>"` for a run that records `yes` under that key in its `state` file when it skipped the gate, as `build` does under `auto_land`. |
| `adopt` | `true` allows the `adopt` rung, which starts a new run that takes over a failed run's worktree. |
| `attention_nodes` | Nodes whose failure points at a defect in the workflow or its setup. |
| `effects` | `{ "<node>": "<what>" }`, the nodes that change something outside git. The facts say whether each one completed, failed or never ran. |

The registry has three layers, and a later layer replaces an earlier entry for the same workflow name. The kit's own `workflow-done.json` comes first and holds the five kit workflows only. Then come the `done` object in `kit.json`, which applies to every repository, and last `.archon/workflow-done.json` in the run's repository. [workflow-cleanup](reference/workflow-cleanup.md) describes how the entries are used.

## Copying a global workflow into a repository

A workflow file in a repository with the same name as a global one replaces the global one outright, and Archon does not merge them. This forks the graph, so later changes to the kit's workflow do not reach the repository. Use it only when the shape of the graph has to differ. A change to which commands run does not need it: the gate sets, lanes and `build.json` are data that every workflow reads at run time.
