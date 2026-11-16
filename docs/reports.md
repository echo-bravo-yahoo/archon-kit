# Reports

This page explains how the kit's workflows show their reports, and how to start the small web server that makes a report open from a link. It is for a person who installed the kit and wants the links in pause messages to work.

## What a report is

A plan, a review or a research result is written as a Markdown file, and the workflow turns it into one self-contained HTML page in the directory `$ARCHON_HOME/designs/<repository>/<slug>/` (`~/.archon/designs/` by default). The page is `index.html` for a research, anti-entropy or cleanup report, and `plan-report.html` or `review-report.html` for the plan or the review of a build. The page shows the report, and a repository can supply its own page builder through `report_cmd` in `.archon/build.json`, or add to the kit's page through `report_plugin`. When it has neither, the kit's builder (`scripts/report/build.mjs`, which needs only Node) draws the page: a contents list, collapsible sections, a diff viewer, a gate table, test repairs, what the owner's answers showed and how to answer a pause. A research page shows its confidence, the round and the follow-up runs it proposes in its banner, with the decision the pause asks for, and lists those runs in a section after the summary. The round is the number of notes in `steer.md` plus one, and the follow-ups come from `follow-up-plan.json`. Each round after the first keeps one line per round in a `Rounds` section at the end of the report. The plan page opens with the planner's summary of the work and its reason, and its banner says what `approve` starts and which stages the plan skips (`docs/reference/build-pauses.md`, "The plan pause"). If Node is missing, `report-page.py` builds a plain page, which is nicer when the Python package `markdown-it-py` is installed and falls back to a preformatted page when it is not.

A paused run prints the report's address on the first line of its message. With no report server, that address is the file's path. With one, it is a URL, which `report.sh link <file>` builds from the base URL in `$ARCHON_HOME/report-base-url`.

The URL of a directory's `index.html` ends at the directory, as in `<base>/<repository>/<slug>/`, and the URL of any other page leaves off `.html`, as in `<base>/<repository>/<slug>/plan-report`. The server answers the second form from `plan-report.html`. A page keeps its `.html` in the URL when a directory of the same name sits beside it, because the server would send the bare name to the directory. Addresses that end in `index.html` or `.html` still work, so a link from an earlier run keeps opening its report.

The slug is a short name for the work followed by the first six characters of the run id, such as `research-retry-test-overlap-3f9a1c`, and `scripts/slug.sh` builds it. The model that writes the report names the work in a `slug` field of its answer: the researcher in `research`, the evaluator in `anti-entropy`, and the model that diagnoses or assesses the run in `workflow-cleanup`. `build` has no such model before its slug is chosen, so when a run starts from a message with no `design` slug and no adopted run, a small model names the work in the `name` node. A run that has a `design` slug or adopts an earlier run keeps that name. When the model returns no usable name, `slug.sh` takes the first five words of the message or title that are not filler words. A run that builds its report page more than once, as a research run that digs deeper does, keeps the slug of its first page in `slug.txt` among its artifacts, so every round opens at one address.

`report.sh page` and `report.sh markdown` build the page and print one line. Each builder counts only if it exits 0 and leaves a non-empty file, and the first that does builds the page: the repository's `report_cmd`, then the kit's builder, then `report-page.py`. The status line says the repository's builder failed when it did. The line is the page's URL. When no page can be built at all, it is one sentence that names no path, and `run.log` has the reason. A host with no report server still gets a path from `report.sh link`, which is the last resort.

## Starting the server

```bash
archon-kit reports up
```

The command starts `report-serve.py`, a read-only server for the `designs` directory, on `127.0.0.1:8082`, and writes `http://localhost:8082` to `report-base-url`. Pause messages then print links that open in a browser on the same machine. It refuses to start when the port is already in use, or when `report-base-url` already exists, because that file may belong to a server you set up another way. `--force` replaces the file, and `archon-kit reports down` puts its old content back.

The base URL opens a list of the repositories, and each repository's directory lists its reports, newest first. An entry shows the report's title, then its directory name and the time its page was last written. A build's directory has no `index.html`, so its entry takes the title and time of `review-report.html`, or of `plan-report.html` before the review exists. A directory with no page shows its own time and its name.

Every response carries a Content-Security-Policy that allows only inline script and style and `data:` images, because a report is one self-contained file. A directory that holds a page of several files, such as one that loads its own scripts, styles or WebAssembly, can put a `.csp` file in it. The file holds one line of at most 1024 characters, which becomes the policy of every file under that directory, and the nearest `.csp` file wins. The server ignores a file that is longer, holds a control character or links outside the `designs` directory, and sends the default policy instead. It does not read a `.csp` file in the `designs` directory itself, and it never serves one.

How the server is kept running depends on the host.

| Host | Method | Survives a reboot |
| --- | --- | --- |
| Linux with a systemd user manager | A user unit, `archon-kit-reports.service` | Yes |
| macOS | A launchd agent, `net.archon-kit.reports` | Yes |
| Anything else | A background process started with `nohup`, with its pid in `reports.json` | No |

The command records what it started in `$ARCHON_HOME/reports.json`. Running `up` again restarts only a server it recorded.

## The commands

- `archon-kit reports up [--port 8082] [--bind 127.0.0.1] [--url BASE] [--force]` starts the server and prints the base URL. `--url` sets the address that links use, for a server reached through a proxy or another name.
- `archon-kit reports down` stops the server it started, removes its unit file, and restores or removes `report-base-url`. Pause messages print file paths again.
- `archon-kit reports status` prints whether the server runs and answers, and exits 1 when it is not serving.
- `archon-kit reports url <file>` prints the link for a report file, or its path when no server is set up.
- `archon-kit reports serve [--port N] [--bind ADDR] [--root DIR]` runs the server in the foreground, for a test or for a service manager of your own.

## Reaching the server from another device

The server asks for no login, and anyone who can reach its port can read every report. It therefore listens on `127.0.0.1` by default. Binding it to `0.0.0.0` with `--bind` shows the reports to the whole network, which is acceptable only on a network you trust.

To read reports from another device, put a reverse proxy in front of the server and let the proxy handle access. Keep the server on `127.0.0.1`, point the proxy at `http://127.0.0.1:8082`, and start the server with the proxy's public address as the base URL:

```bash
archon-kit reports up --url https://reports.example.net
```

Whatever login or network restriction your proxy offers then protects the reports.

On Windows with WSL2, a browser on the Windows side normally reaches a server listening on `localhost` inside WSL through the default localhost forwarding. This is the usual behaviour and has not been confirmed on every setup.

## What the server refuses

The server answers a request only for a file under the `designs` directory. It serves an address with no extension from the `.html` file of that name when there is one and the file resolves inside the directory. It returns 404 for a path with a part that starts with a dot, for a path that resolves outside the directory (including through a symbolic link or an encoded `..`), and it sends a content-security-policy header that allows inline script and style and images from its own pages or `data:` URIs, which the pages use.

## Customizing reports

There are two extension points, set in the repository's `.archon/build.json`.

- `report_cmd` replaces the builder for any kind of report and in any language. It is called as `<report_cmd> <kind> --out <file> --design <slug> --run <id> --artifacts <dir> [more flags]`.
- `report_plugin` is a repository-relative ES module that adds to the page the kit already builds. It adds a stylesheet, renderers for named fenced blocks, a diff highlighter, diff exclusions and extra sections.

When `report_cmd` is set, the kit's page is built only if that command fails, and `report_plugin` is ignored. The plugin file is read from the repository's main checkout, so a file that is not committed or pushed still loads.

A plugin's default export has this shape. Every key is optional.

```js
export default {
  css: "...", // appended to the page styles
  fences: {
    name(code, ctx) {
      /* html for a fenced block of that name */
    },
  },
  highlight(code, lang) {
    /* html, or null for plain add and remove colouring */
  },
  diff: { skip: /\.bin$/, languages: { ".defaults": "ini" } },
  sections: {
    review(ctx, kit) {
      return [
        { id: "extra", title: "Extra", html: "<p>...</p>", after: "gates" },
      ];
    },
  },
};
```

- `fences[name]` renders a fenced block whose info string is `name`. Every other fence is a plain code block.
- `diff.skip` omits matching files from the diff viewer, which already omits `png`, `jpg`, `gif`, `pdf` and `zip` files. `diff.languages` maps an extension to the `lang` given to `highlight`.
- `sections[kind]` returns extra sections for that kind (`plan`, `review`, `research` or another). `after` names the id of a section to follow, and a missing or unknown one puts the section at the end, before `how-to-answer` in a review. `ctx` is `{ kind, design, run, artifacts, args, picks, spec, state }`, and `kit` holds the helpers (`escapeHtml`, `section`, `renderMarkdown`, `renderDiff`, `parseDiff`, `slugify`, and more), so a plugin imports nothing from the kit.

In a review, `ctx.picks` is the report picker's output: `findings`, `summary`, `open_items`, `picks` and `extra_json`. The picker leaves `extra_json` empty unless the repository's `.archon/build-notes/report.md` says what to put there, so a plugin that needs data from the picker, such as JSON for a custom section, asks for it in that file and reads it from `ctx.picks.extra_json`.

A hook that throws costs that hook and not the page: the builder writes `plugin <hook>: <message>` to stderr and carries on. A plugin that cannot be loaded writes `plugin load: <message>` and the page builds without it.

If the page cannot be built, the chain is the repository's `report_cmd`, the kit's builder, `report-page.py`, and then one sentence.

Not added: an environment variable for the default Markdown, a `report_css` key and a per-kind `report_cmd` map. A plugin returns CSS, its `sections` are keyed by kind, and nothing needs the rest.
