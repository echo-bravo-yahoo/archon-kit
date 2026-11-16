<!-- archon-kit:reports:start -->
## Archon reports

Archon workflow runs write their reports (plans, reviews, research) as HTML pages under `~/.archon/designs/<repo>/<slug>/`. A read-only server shows them at the address in `~/.archon/report-base-url`.

- Give the user a report's URL, not its file path. `~/.archon/scripts/report.sh link <file>` prints the URL, or the path when no server is set up.
- A paused run's message starts with the report's URL on its first line. Pass it on unchanged.
- If a URL does not open, run `archon-kit reports status`. `archon-kit reports up` starts the server on localhost.
- Build a page from a Markdown report with `~/.archon/scripts/report.sh markdown`, and do not edit files under `~/.archon/designs/` by hand.
- The server has no login. Do not bind it beyond localhost unless the user asks.
<!-- archon-kit:reports:end -->
