# Workflow playground

`build.py` writes one static HTML page that draws the workflows of an Archon home and of the repositories in a workspace. On the page you can move nodes, edit dependencies, simulate a run, export the YAML, see the run statistics from the Archon database, and see which files each node writes and reads. The page inlines the workflows, the statistics and its own source, so rebuild it after the workflows change.

## Build

Refresh both pages with `archon-kit playground`, or `bash playground/refresh.sh`. It rebuilds the playground page and, when `baseline/` exists, the before/after page that `baseline/baseline.json` describes. The page's banner names the same command.

To build one page by hand:

```bash
python3 playground/build.py
python3 playground/build.py --out page.html --no-link
python3 playground/build.py --baseline DIR --label "before the cleanup" --out before-after.html
```

The first command writes `$ARCHON_HOME/designs/archon/workflow-playground/index.html` (`ARCHON_HOME` defaults to `~/.archon`) and prints its URL through `scripts/report.sh link`. `--baseline DIR` compares the workflows with an earlier set and adds a table of what changed. `DIR` holds `personal/<name>/<name>.yaml` for home-level workflows and `repo/<repo>/<name>/<name>.yaml` for repository ones.

`DIR/baseline.json` holds the label and output file of the before/after page, so that `refresh.sh` needs no flags:

```json
{ "label": "before the cleanup", "out": "~/.archon/designs/archon/before-after/index.html" }
```

`--label` and `--out` override it. A baseline page needs `--out` or an `out` here, because the default output file is the playground page itself. The page groups each workflow by the directory under `workflows/` that holds it, so a workflow that moved from `personal` to `kit` shows as moved.

`build.py` needs Python 3 with PyYAML. It reads `$ARCHON_HOME/workflows/<group>/<name>/<name>.yaml` for every group (`personal`, `kit`, and so on) and `~/workspace/<repo>/.archon/workflows/<name>/<name>.yaml`. It opens `$ARCHON_HOME/archon.db` read-only and shows no statistics when the database is missing.

The page draws each file a workflow creates as a row in a pane under the graph, with a dot under every node that writes, reads or deletes it. `data/files.json` lists the scripts known to write files. A script missing from it needs a rule there before its files appear.

## Your own data

These files hold one person's data, so `.gitignore` keeps them out of the repository, and the page builds without them.

| File | What it holds |
| --- | --- |
| `data/annotations.json` | A sentence on what each node does and why, keyed `<workflow>/<node key>` |
| `data/findings.json` | Findings to mark as try, discuss or dismiss |
| `data/findings-note.txt` | A sentence or two shown above the findings |
| `data/aliases.json` | Run history recorded under an earlier workflow name: `{"new-name": ["old-name"]}` |
| `baseline/` | A copy of earlier workflows to pass to `--baseline` |
| `baseline/baseline.json` | The before/after page's `label` and its `out` file, read by `refresh.sh` |

These files are not in git, so keep a second copy outside the clone. From `playground/`, refresh it with:

```bash
rsync -a data/annotations.json data/findings*.json data/findings-note.txt data/aliases.json baseline \
  "${ARCHON_HOME:-$HOME/.archon}/playground-data/"
```

To restore, copy the files from `playground-data/` back to the same places: the `data/` files into `data/` and `baseline/` into `playground/`. Run the `rsync` again after you edit one of them.

## Tests

Run `node --test tests/*.test.js` from this directory. The tests that read `data/annotations.json` skip when it is absent, and fail when a node has no annotation or an annotation names a node that is gone.

`tests/browser.mjs` drives a built page in headless Chromium. Run it from a directory where `playwright` resolves, with `PLAYGROUND_URL` set to the page's URL or `file://` path. Its steps choose what to edit from the workflows on the host, and a step with nothing to exercise, such as a host without a findings file or run history, prints `skipped` and its reason. These tests are not part of the kit's gates.
