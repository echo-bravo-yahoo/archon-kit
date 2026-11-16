#!/usr/bin/env python3
"""Serves the HTML reports under $ARCHON_HOME/designs (default ~/.archon/designs) over HTTP, read-only.

usage: report-serve.py [--root DIR] [--bind ADDR] [--port N]

A directory with an index.html serves it. Any other directory lists its subdirectories and .html
files, newest first. Each entry shows the <title> of its page and the page's modification time:
the page of a directory is its index.html, else its review-report.html, plan-report.html or
approach-report.html, and a directory with none shows its own time. A path that names no file, and whose last part has no extension, serves the .html file
of that name when there is one, so /repo/slug/plan-report opens plan-report.html. A path with a
dot-prefixed part, or one that resolves outside the root, is a 404.
A directory below the root may hold a `.csp` file, which sets the Content-Security-Policy for every
file under that directory, and the nearest one wins. A page of several files that loads its own
scripts, styles or WebAssembly needs one, because the default policy allows only inline script and
style. The file holds the policy on one line of at most 1024 characters. A file that is longer, holds
a control character, or links to a file outside the root is ignored, and the default policy applies.
The root's own `.csp` is not read.
The server asks for no login, so it listens on 127.0.0.1 unless --bind says otherwise; a bind
beyond localhost shows every report to the network.
"""

import argparse
import functools
import html
import io
import os
import re
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote, urlsplit

# The reports carry inline script and style and embed their images as data: URIs. 'self' covers
# an image a page links from its own directory.
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
    "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-cache",
}
POLICY_FILE = ".csp"
POLICY_MAX = 1024


# The page that stands for a directory in a listing: the finished report before the plan that led to it.
PAGES = ("index.html", "review-report.html", "plan-report.html", "approach-report.html")
TITLE = re.compile(rb"<title[^>]*>(.*?)</title>", re.I | re.S)


class Handler(SimpleHTTPRequestHandler):
    server_version = "report-serve"

    def end_headers(self):
        for name, value in SECURITY_HEADERS.items():
            if name == "Content-Security-Policy":
                value = self.directory_policy() or value
            self.send_header(name, value)
        super().end_headers()

    def directory_policy(self):
        """The policy in the nearest `.csp` file between the requested path and the root, or None
        when there is none or the nearest one is not usable."""
        root = os.path.realpath(self.directory)
        target = self.translate_path(getattr(self, "path", "") or "/")
        here = target if os.path.isdir(target) else os.path.dirname(target)
        while here.startswith(root + os.sep):
            candidate = os.path.join(here, POLICY_FILE)
            real = os.path.realpath(candidate)
            if real.startswith(root + os.sep) and os.path.isfile(real):
                return read_policy(real)
            if os.path.lexists(candidate):
                return None
            here = os.path.dirname(here)
        return None

    def translate_path(self, path):
        root = os.path.realpath(self.directory)
        dead_end = os.path.join(root, ".missing")
        raw = unquote(urlsplit(path).path)
        parts = [p for p in raw.split("/") if p]
        if "\0" in raw or any(p.startswith(".") for p in parts):
            return dead_end
        target = os.path.realpath(os.path.join(root, *parts))
        if not os.path.exists(target) and not os.path.splitext(target)[1]:
            page = os.path.realpath(target + ".html")
            if page.startswith(root + os.sep) and os.path.isfile(page):
                return page
        return (
            target if target == root or target.startswith(root + os.sep) else dead_end
        )

    def entry_page(self, full):
        """The page file whose title and time stand for the entry at `full`, or None. A page that
        resolves outside the root is not read."""
        root = os.path.realpath(self.directory)
        if os.path.isdir(full):
            candidates = [os.path.join(full, name) for name in PAGES]
        else:
            candidates = [full] if full.endswith(".html") else []
        for page in candidates:
            real = os.path.realpath(page)
            if real.startswith(root + os.sep) and os.path.isfile(real):
                return real
        return None

    def list_directory(self, path):
        entries = []
        for name in os.listdir(path):
            if name.startswith("."):
                continue
            full = os.path.join(path, name)
            is_dir = os.path.isdir(full)
            if not (is_dir or name.endswith(".html")):
                continue
            page = self.entry_page(full)
            try:
                mtime = os.stat(page or full).st_mtime
            except OSError:
                mtime = 0
            entries.append((mtime, name, is_dir, page_title(page) if page else ""))
        entries.sort(key=lambda e: (-e[0], e[1]))
        items = []
        for mtime, name, is_dir, title in entries:
            label = name + ("/" if is_dir else "")
            when = time.strftime("%Y-%m-%d %H:%M", time.localtime(mtime))
            items.append(
                f'<li><a href="{quote(label)}">{html.escape(title or label)}</a>'
                f'<span class="m">{html.escape(label)} · {when}</span></li>'
            )
        title = html.escape(unquote(urlsplit(self.path).path))
        body = (
            "<!doctype html><meta charset=utf-8>"
            "<meta name=viewport content='width=device-width,initial-scale=1'>"
            "<style>:root{color-scheme:light dark}body{font:16px/1.6 system-ui,sans-serif;margin:1rem}"
            "ul{padding-left:1.2rem}li{margin:.6rem 0}.m{display:block;font-size:.85em;opacity:.7}</style>"
            f"<title>{title}</title><h1>{title}</h1><ul>{''.join(items)}</ul>"
        ).encode()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        return io.BytesIO(body)


def read_policy(path):
    """The policy on the one line of the file at `path`, or None when the file is too long, cannot be
    read or holds a character that could end the header value."""
    try:
        with open(path, "rb") as f:
            raw = f.read(POLICY_MAX + 1)
    except OSError:
        return None
    text = raw.decode("utf-8", "replace").strip()
    if len(raw) > POLICY_MAX or not text or not text.isprintable():
        return None
    return text


def page_title(path):
    """The <title> of the HTML file at `path` with its entities decoded and its whitespace collapsed,
    read from the first 32 KB, or an empty string when there is none."""
    try:
        with open(path, "rb") as f:
            head = f.read(32768)
    except OSError:
        return ""
    found = TITLE.search(head)
    if not found:
        return ""
    return " ".join(html.unescape(found.group(1).decode("utf-8", "replace")).split())


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    archon_home = os.environ.get("ARCHON_HOME") or os.path.expanduser("~/.archon")
    ap.add_argument("--root", default=os.path.join(archon_home, "designs"))
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8082)
    args = ap.parse_args()
    handler = functools.partial(Handler, directory=args.root)
    ThreadingHTTPServer((args.bind, args.port), handler).serve_forever()


if __name__ == "__main__":
    main()
