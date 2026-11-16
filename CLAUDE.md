# Archon kit

This repository holds the shareable Archon workflows, the scripts they call and the `archon-kit` command. README.md is the user's entry point. This file is for working on the kit.

## Layout

- `workflows/<name>/<name>.yaml` and `workflows/<name>/fixtures/` hold the six workflows (`build`, `research`, `review-change`, `anti-entropy`, `check-later`, `workflow-cleanup`). `install.sh` puts them under `$ARCHON_HOME/workflows/kit/`.
- `scripts/` holds every script a workflow calls (`scripts/report/` is the default report page builder and its vendored Markdown library), the vendored `git-retry`, `worktree-land` and `worktree-cleanup.sh`, `archon-dead-runs.sh`, `report-serve.py`, `kit-settings.sh` and the `archon-kit` dispatcher. Each keeps the path `$ARCHON_HOME/scripts/<name>` after install, because workflows and repositories' `.claude/settings.json` call it there.
- `profiles/` holds the per-run config layers for Claude and Codex, and `config/config.yaml.template` is the install default. The template pins no model tier.
- `templates/` holds what `init-repo`, `agent-docs`, `hooks install` and `reports up` copy or fill in.
- `docs/` holds the user documentation. `README.md` and `docs/choosing-a-workflow.md` carry the same Mermaid diagram, and `test/docs.test.mjs` checks that they match.
- `playground/` holds the workflow playground, a generator for an HTML page that draws the workflows. `playground/README.md` describes it, and `archon-kit playground` rebuilds its pages. Its tests run from that directory and are not part of the gates.
- `test/` holds the `node --test` files. `test/kit-home.mjs` builds a scratch `ARCHON_HOME` that points at this clone's scripts and workflows.

## Checks

Run the whole suite with `node --test test/*.test.mjs`. Node 25 does not accept a directory argument, so list the files with the glob. Run `shellcheck -S warning` over the shell scripts. The gates in `.archon/gates.json` do both.

To check the workflows against the kit's own files and not against an installed copy, install into a scratch home and point Archon at it:

```bash
mkdir -p /tmp/kit-home && ln -s ~/.archon/plugins /tmp/kit-home/plugins
ARCHON_HOME=/tmp/kit-home ./install.sh --link --prefix /tmp/kit-home/bin
ARCHON_HOME=/tmp/kit-home archon workflow test build
ARCHON_HOME=/tmp/kit-home archon validate workflows
```

Archon finds fixtures only in a real directory, which is why `install.sh --link` links each file and keeps the directories real.

## Rules

- No personal path, host, repository or tool name enters the kit. `test/scrub.test.mjs` has two parts. The generic part always runs and fails on a home or mount path, an email address other than a placeholder, a private network address and a URL outside the placeholder and known-public hosts. The personal part reads a word list, one case-insensitive regular expression per line, from `$ARCHON_KIT_SCRUB_WORDS` or `~/.config/archon-kit/scrub-words.txt`, and is skipped when that file does not exist. Keep the list outside the repository, because a tracked list would publish the words. The test reads the files git would commit, so a host keeps its own data in an ignored file, as `playground/data/findings.json` is. Use neutral names in examples: `deploy-staging` for a workflow and `site` for a repository.
- A script reaches the Archon home through `${ARCHON_HOME:-$HOME/.archon}`, never through `$HOME` alone, and reads a person's own settings (workspace, scratch directories, environment for runs, global hand-offs) from `kit.json` through `scripts/kit-settings.sh`.
- Every `model:` in a workflow is `small`, `medium`, `large` or an `@alias`. Every object in an `output_format` lists all its properties under `required`, because Codex's strict mode rejects an object that does not.
- A stage of `build` that is held to a lane ends with `lane.sh unstage --verify || exit 1`. The table of stages and lanes lives in `lane.sh`, and `lane-hook.mjs` holds the same table. `test/lane.test.mjs` checks that they agree.
- A script avoids bash 4 features, because macOS ships bash 3.2.
- Nothing in the kit may need a tool, path or document that exists on one machine. Anything beyond the standard set of tools is listed in `docs/reference/dependencies.md`, and `test/dependencies.test.mjs` checks the list.
- A subcommand name or flag that a paused `workflow-cleanup` run may call from its captured definition stays, because that run calls the script on disk.
- The kit is tested against Archon 0.13.2 only.

## Copies of the vendored scripts

`git-retry`, `worktree-land`, `worktree-cleanup.sh` and `archon-dead-runs.sh` came from scripts that a host may already keep elsewhere on its `PATH`. A host that keeps those copies keeps them as separate files, because a sync tool that skips symlinks cannot carry links to this clone, and one that follows them can write an old copy through a link into this repository. A change to one of these four scripts here therefore does not reach the other copies, and each copy has to be updated by hand until the host drops it in favour of the installed one. `archon-dead-runs.sh` imports `scripts/procinfo.py` from its own directory, so a copy of it that is updated needs `procinfo.py` beside it.

## Landing changes

`build` can run in this repository, since `.archon/gates.json` and `.archon/lanes.json` declare its gates and its tests lane. With `install.sh --link`, a change that lands here changes the installed workflows and scripts at once. Runs that are already working keep the workflow definitions they captured and read scripts from disk.

<!-- archon-kit:reports:start -->

## Archon reports

Archon workflow runs write their reports (plans, reviews, research) as HTML pages under `~/.archon/designs/<repo>/<slug>/`. A read-only server shows them at the address in `~/.archon/report-base-url`.

- Give the user a report's URL, not its file path. `~/.archon/scripts/report.sh link <file>` prints the URL, or the path when no server is set up.
- A paused run's message starts with the report's URL on its first line. Pass it on unchanged.
- If a URL does not open, run `archon-kit reports status`. `archon-kit reports up` starts the server on localhost.
- Build a page from a Markdown report with `~/.archon/scripts/report.sh markdown`, and do not edit files under `~/.archon/designs/` by hand.
- The server has no login. Do not bind it beyond localhost unless the user asks.
<!-- archon-kit:reports:end -->
