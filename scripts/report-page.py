#!/usr/bin/env python3
"""Builds a self-contained HTML page from a Markdown report.

usage: report-page.py REPORT OUT [--title TEXT] [--status TEXT]

Raw HTML in the report is escaped, so the page shows only what Markdown can express. The page
loads nothing from the network, and links to files beside it (files/graph.svg) work when the
report server serves OUT's directory. Without markdown-it-py the report goes into a <pre>.
"""

import argparse
import html
import os
import re
import sys

CSS = """
:root {
  --bg: #ffffff; --fg: #1d2127; --muted: #5b6573; --rule: #d9dee5;
  --code-bg: #f3f5f8; --link: #1456b8;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171b; --fg: #e3e7ec; --muted: #9aa5b3; --rule: #2d343c;
    --code-bg: #1d2228; --link: #7fb0ff;
  }
}
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.6 system-ui, sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: 24px 16px 64px; }
.status { margin: 0 0 8px; color: var(--muted); font-size: 14px; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.8em 0 .5em; }
h1 { margin-top: .4em; font-size: 1.7rem; }
h2 { font-size: 1.3rem; padding-top: .4em; border-top: 1px solid var(--rule); }
h3 { font-size: 1.1rem; }
a { color: var(--link); }
code { font: .9em ui-monospace, monospace; background: var(--code-bg);
  padding: .1em .3em; border-radius: 3px; overflow-wrap: anywhere; }
pre { background: var(--code-bg); padding: 12px; overflow-x: auto; border-radius: 4px; }
pre code { background: none; padding: 0; overflow-wrap: normal; }
table { display: block; overflow-x: auto; border-collapse: collapse; margin: 1em 0; }
th, td { border: 1px solid var(--rule); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: var(--code-bg); }
blockquote { margin: 1em 0; padding-left: 14px; border-left: 3px solid var(--rule); color: var(--muted); }
img { max-width: 100%; height: auto; }
"""


def render(source):
    try:
        from markdown_it import MarkdownIt
    except ImportError:
        return "<pre>" + html.escape(source) + "</pre>"
    md = MarkdownIt("commonmark", {"html": False})
    return md.enable("table").enable("strikethrough").render(source)


def first_heading(source):
    match = re.search(r"^#[ \t]+(.+?)[ \t]*#*[ \t]*$", source, re.M)
    return match.group(1) if match else "Report"


def build(source, title, status):
    status_line = f'<p class="status">{html.escape(status, quote=False)}</p>\n' if status else ""
    return (
        '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>{html.escape(title)}</title>\n<style>{CSS}</style>\n</head>\n"
        f"<body>\n<main>\n{status_line}{render(source)}</main>\n</body>\n</html>\n"
    )


def main():
    ap = argparse.ArgumentParser(
        description=__doc__.split("\n")[0],
        epilog="example: report-page.py report.md index.html --status 'Research finished (likely)'",
    )
    ap.add_argument("report", help="the Markdown file to render")
    ap.add_argument("out", help="the HTML file to write; its directory is created if missing")
    ap.add_argument("--title", help="the page title (default: the report's first # heading)")
    ap.add_argument("--status", help="a line shown above the report")
    args = ap.parse_args()

    try:
        with open(args.report, encoding="utf-8") as f:
            source = f.read()
    except OSError as e:
        sys.exit(f"cannot read {args.report}: {e.strerror}")
    if not source.strip():
        sys.exit(f"{args.report} is empty")

    page = build(source, args.title or first_heading(source), args.status)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    tmp = f"{args.out}.tmp.{os.getpid()}"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(page)
        os.replace(tmp, args.out)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


if __name__ == "__main__":
    main()
