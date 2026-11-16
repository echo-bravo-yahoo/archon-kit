#!/usr/bin/env python3
"""The ledger and the subject inventory behind the `anti-entropy` workflow.

usage: anti-entropy.py inventory --out FILE
       anti-entropy.py claim --run ID --subject FILE
       anti-entropy.py record --run ID --decision build|close|none --subject FILE
                              --evaluation FILE [--build-started FILE]
       anti-entropy.py brief --subject FILE --evaluation FILE --report FILE --note FILE

Run it with `python3 -I` from inside the repository, with HOME set: the ledger is
~/.archon/state/anti-entropy/<repo>.jsonl, one JSON object per line with run, ts, lens, paths,
status (picked, clean, declined or handed-off), base, summary, findings (titles) and build.
A run appends `picked` first and its outcome last; a reader takes the last line for each run and
ignores entries older than 180 days.

  inventory  ranks the subjects a run could examine and prints the best twelve. FILE gets all of
             them as JSON. A subject is a lens (tests, docs or structure) and a few paths.
  claim      validates the subject a run picked, prints the earlier entries that overlap it, and
             appends `picked`. It rewrites the subject file with normalised paths, naming a
             directory in place of a list of every file the lens has in it.
  record     appends the run's outcome. build is `handed-off`, close is `declined`, none is
             `clean`. --build-started names the file that holds `started build, run <id>`; it
             is read only for build.
  brief      prints the Markdown a `build` run takes as its message.

Settings come from the scripts that own them: build-settings.sh (repository name, brief_dir,
anti_entropy_exclude) and lane.sh (the tests lane). Exit 1 means the input was refused, 2 a
usage error.
"""

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
LENSES = ("tests", "docs", "structure")
WINDOW_DAYS = 180
SPLIT_AT = 30
MAX_SUBJECT_FILES = 60
TOP = 12
NEVER_DAYS = 90
MAX_FILE_BYTES = 2_000_000
MAX_STRUCTURE_BYTES = 200_000
BUILTIN_EXCLUDES = [
    ".archon/**",
    "**/vendor/**",
    "**/third_party/**",
    "**/node_modules/**",
    "**/dist/**",
    "**/*.min.*",
    "**/*.lock",
    "**/package-lock.json",
    "**/npm-shrinkwrap.json",
    "**/pnpm-lock.yaml",
    "**/bun.lockb",
    "**/go.sum",
]
CONSTRAINTS = [
    "Remove or simplify only: add no behaviour, dependency or abstraction that a finding does not call for.",
    "Keep behaviour the same unless a finding says it changes; a finding that changes an interface names its callers, and the change updates every one.",
    "Make one commit for each finding, so any one can be reverted alone.",
    "When tests are merged, generalized or removed, each behaviour they pinned stays pinned by a test that remains, and the plan maps every removed test to the test that keeps its behaviour.",
    "When docs change, each claim that stays has been checked against the code or the command it describes.",
    "The findings are the whole scope, and the note, when there is one, takes precedence over them: a finding it drops is out of scope.",
]


def die(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def git(*args):
    r = run(["git", *args])
    if r.returncode != 0:
        die("git %s failed: %s" % (" ".join(args[:2]), r.stderr.strip()))
    return r.stdout


def script(name, *args):
    r = run(["bash", str(SCRIPTS / name), *args])
    if r.returncode != 0:
        die(r.stderr.strip() or "%s failed" % name)
    return r.stdout


def setting(key, default):
    return script("build-settings.sh", key, default).rstrip("\n")


def now():
    return datetime.now(timezone.utc)


def stamp(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(text):
    try:
        moment = datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def load_json(path, what):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        die("cannot read %s %s: %s" % (what, path, e))


def read_text(path, what):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError as e:
        die("cannot read %s %s: %s" % (what, path, e))


# --- the ledger -------------------------------------------------------------------------------


def ledger_file(repo):
    return (
        Path(os.environ.get("ARCHON_HOME") or Path(os.environ["HOME"]) / ".archon")
        / "state"
        / "anti-entropy"
        / (repo + ".jsonl")
    )


def read_ledger(repo, moment):
    """The last line for each run, newest last, without entries older than the window."""
    try:
        text = ledger_file(repo).read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    runs = {}
    for line in text.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if isinstance(e, dict) and "run" in e and parse_ts(e.get("ts")):
            runs[e["run"]] = e
    cutoff = moment - timedelta(days=WINDOW_DAYS)
    kept = [e for e in runs.values() if parse_ts(e["ts"]) >= cutoff]
    return sorted(kept, key=lambda e: parse_ts(e["ts"]))


def append_entry(repo, entry):
    path = ledger_file(repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.parent / (repo + ".lock"), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        line = json.dumps(entry, ensure_ascii=False) + "\n"
        fd = os.open(str(path), os.O_RDWR | os.O_APPEND | os.O_CREAT, 0o644)
        try:
            size = os.fstat(fd).st_size
            if size and os.pread(fd, 1, size - 1) != b"\n":
                line = "\n" + line
            os.write(fd, line.encode("utf-8"))
        finally:
            os.close(fd)


def covers(a, b):
    return a == b or (a.endswith("/") and b.startswith(a))


def overlaps(paths, others):
    return any(covers(a, b) or covers(b, a) for a in paths for b in others)


def new_entry(run_id, lens, paths, status, base, summary="", findings=None, build=None):
    return {
        "run": run_id,
        "ts": stamp(now()),
        "lens": lens,
        "paths": paths,
        "status": status,
        "base": base,
        "summary": summary,
        "findings": findings or [],
        "build": build,
    }


# --- what can be examined ---------------------------------------------------------------------


def exclusion_specs():
    brief_dir = setting("brief_dir", "docs/briefs").strip("/")
    try:
        extra = json.loads(setting("anti_entropy_exclude", "[]"))
    except ValueError:
        extra = None
    if not isinstance(extra, list) or not all(isinstance(g, str) for g in extra):
        die(
            "anti_entropy_exclude in .archon/build.json must be an array of git glob pathspecs"
        )
    globs = list(BUILTIN_EXCLUDES)
    if brief_dir:
        globs.append(brief_dir + "/**")
    specs = [":(exclude,glob)" + g for g in globs]
    specs += [g if g.startswith(":") else ":(exclude,glob)" + g for g in extra]
    return specs


def tracked(pathspecs):
    return sorted(p for p in git("ls-files", "-z", "--", *pathspecs).split("\0") if p)


def usable(path, limit):
    """The line count of a regular text file within the size limit, or None."""
    if os.path.islink(path) or not os.path.isfile(path):
        return None
    try:
        if os.path.getsize(path) > limit:
            return None
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return None
    if b"\0" in data[:8000]:
        return None
    return data.count(b"\n") + (1 if data and not data.endswith(b"\n") else 0)


def lens_files():
    """{lens: {path: line count}} for every tracked file a run may examine."""
    # git 2.43 lists nothing when a glob pathspec like `:(glob)test/**` is combined with some
    # exclude globs (`:(exclude,glob)gen/**`), so the lane and the exclusions are listed apart
    # and intersected. Exclusions pair only with `.`.
    lane = [s for s in script("lane.sh", "list").split("\n") if s]
    in_lane = set(tracked(lane))
    result = {lens: {} for lens in LENSES}
    for path in tracked(["."] + exclusion_specs()):
        if path in in_lane:
            lens, limit = "tests", MAX_FILE_BYTES
        elif path.lower().endswith(".md"):
            lens, limit = "docs", MAX_FILE_BYTES
        else:
            lens, limit = "structure", MAX_STRUCTURE_BYTES
        lines = usable(path, limit)
        if lines is not None:
            result[lens][path] = lines
    return result


def split_subjects(members):
    """Groups a lens's files into (paths, files): a directory, or a list of loose files.

    The repository root always splits by its first path component. A directory with more than 30
    files splits by the next one, and its loose files become subjects of at most 30 files."""
    out = []

    def loose(files):
        for i in range(0, len(files), SPLIT_AT):
            chunk = files[i : i + SPLIT_AT]
            out.append((chunk, chunk))

    def split(prefix, files):
        if len(files) <= SPLIT_AT:
            out.append(([prefix], files))
            return
        loose([f for f in files if "/" not in f[len(prefix) :]])
        groups = {}
        for f in files:
            rest = f[len(prefix) :]
            if "/" in rest:
                groups.setdefault(rest.split("/", 1)[0], []).append(f)
        for name, group in groups.items():
            split(prefix + name + "/", group)

    loose([f for f in members if "/" not in f])
    groups = {}
    for f in members:
        if "/" in f:
            groups.setdefault(f.split("/", 1)[0], []).append(f)
    for name, group in groups.items():
        split(name + "/", group)
    return out


def commits_since(paths, moment):
    specs = [":(literal)" + p for p in paths]
    return int(
        git(
            "rev-list", "--count", "--since=" + stamp(moment), "HEAD", "--", *specs
        ).strip()
        or 0
    )


def rank(by_lens, entries, moment):
    newest_lens = entries[-1].get("lens") if entries else None
    subjects = []
    for lens in LENSES:
        for paths, files in split_subjects(sorted(by_lens[lens])):
            hits = [e for e in entries if overlaps(paths, e.get("paths") or [])]
            last = max(hits, key=lambda e: parse_ts(e["ts"])) if hits else None
            if last:
                since = parse_ts(last["ts"])
                age = min((moment - since).days, 120)
            else:
                since = moment - timedelta(days=NEVER_DAYS)
                age = 100
            commits = commits_since(paths, since)
            lines = sum(by_lens[lens][f] for f in files)
            score = (
                age
                + 4 * min(commits, 15)
                + min(lines // 200, 10)
                - (10 if lens == newest_lens else 0)
            )
            subjects.append(
                {
                    "lens": lens,
                    "paths": paths,
                    "files": len(files),
                    "lines": lines,
                    "last": {
                        "run": last["run"],
                        "ts": last["ts"],
                        "status": last.get("status", ""),
                    }
                    if last
                    else None,
                    "commits": commits,
                    "score": score,
                }
            )
    subjects.sort(key=lambda s: (-s["score"], s["lens"], "\0".join(s["paths"])))
    return subjects


def show_paths(paths):
    text = ", ".join(paths[:3]) + (
        ", +%d more" % (len(paths) - 3) if len(paths) > 3 else ""
    )
    return text if len(text) <= 56 else text[:53] + "..."


def cmd_inventory(args):
    moment = now()
    by_lens = lens_files()
    if not any(by_lens.values()):
        die("nothing to examine: the repository has no tracked file a run may examine")
    subjects = rank(by_lens, read_ledger(repo_name(), moment), moment)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(subjects, f)
    rows = [("lens", "paths", "files", "lines", "last examined", "commits")]
    for s in subjects[:TOP]:
        last = s["last"]
        age = (
            "never"
            if not last
            else "%dd ago, %s" % ((moment - parse_ts(last["ts"])).days, last["status"])
        )
        rows.append(
            (
                s["lens"],
                show_paths(s["paths"]),
                str(s["files"]),
                str(s["lines"]),
                age,
                str(s["commits"]),
            )
        )
    widths = [max(len(r[i]) for r in rows) for i in range(6)]
    for r in rows:
        print("  ".join(c.ljust(w) for c, w in zip(r, widths)).rstrip())


# --- claim, record, brief ---------------------------------------------------------------------


def normalise_paths(paths):
    if (
        not isinstance(paths, list)
        or not paths
        or not all(isinstance(p, str) for p in paths)
    ):
        die("the subject needs a non-empty list of paths")
    out = []
    for raw in paths:
        p = raw.strip()
        while p.startswith("./"):
            p = p[2:]
        if p.startswith("/") or ".." in p.split("/"):
            die(
                "path %r must be relative to the repository root and cannot contain .."
                % raw
            )
        q = p.rstrip("/")
        if q in ("", "."):
            die(
                "path %r is the whole repository; name the files or directories to examine"
                % raw
            )
        listed = [
            f for f in git("ls-files", "-z", "--", ":(literal)" + q).split("\0") if f
        ]
        if q in listed:
            p = q
        elif any(f.startswith(q + "/") for f in listed):
            p = q + "/"
        else:
            die("path %r is not tracked by git" % raw)
        if p not in out:
            out.append(p)
    return out


def collapse(paths, members, available):
    """Names a directory in place of the files in it when the subject covers every file of the
    lens there, so a pick that lists a whole directory file by file is recorded as the directory.
    The repository root is never named."""
    covered = set(members)
    ancestors = {f[: i + 1] for f in covered for i, c in enumerate(f) if c == "/"}
    chosen = []
    for d in sorted(ancestors, key=lambda d: (d.count("/"), d)):
        if not any(covers(c, d) for c in chosen) and all(
            f in covered for f in available if f.startswith(d)
        ):
            chosen.append(d)
    return chosen + [p for p in paths if not any(covers(c, p) for c in chosen)]


def noun(n, word):
    return "%d %s" % (n, word if n == 1 else word + "s")


def describe(e):
    lines = [
        "- %s run %s, %s of %s: %s"
        % (
            str(e["ts"])[:10],
            str(e["run"])[:6],
            e.get("lens", "?"),
            show_paths(e.get("paths") or []),
            "picked, no outcome recorded"
            if e.get("status") == "picked"
            else e.get("status", "?"),
        )
    ]
    summary = " ".join(str(e.get("summary") or "").split())
    if summary:
        lines.append(
            "  Summary: %s"
            % (summary if len(summary) <= 300 else summary[:300] + "...")
        )
    if e.get("findings"):
        lines.append("  Findings: %s" % "; ".join(e["findings"]))
    base = e.get("base")
    if base and run(["git", "cat-file", "-e", base + "^{commit}"]).returncode == 0:
        specs = [":(literal)" + p for p in e.get("paths") or []]
        n = int(git("rev-list", "--count", base + "..HEAD", "--", *specs).strip() or 0)
        lines.append("  Changed since: %s touched these paths" % noun(n, "commit"))
    return lines


def cmd_claim(args):
    subject = load_json(args.subject, "subject")
    lens = subject.get("lens")
    if lens not in LENSES:
        die("unknown lens %r; use tests, docs or structure" % lens)
    paths = normalise_paths(subject.get("paths"))
    available = lens_files()[lens]
    members = [f for f in available if any(covers(p, f) for p in paths)]
    if not members:
        die("no %s files under %s" % (lens, ", ".join(paths)))
    if len(members) > MAX_SUBJECT_FILES:
        die(
            "the subject has %d %s files, but at most %d files are allowed; name a smaller part"
            % (len(members), lens, MAX_SUBJECT_FILES)
        )
    paths = collapse(paths, members, available)

    repo = repo_name()
    earlier = [
        e
        for e in read_ledger(repo, now())
        if e["run"] != args.run and overlaps(paths, e.get("paths") or [])
    ]
    earlier.reverse()
    out = [
        "Subject: %s of %s (%s)" % (lens, ", ".join(paths), noun(len(members), "file"))
    ]
    if not earlier:
        out.append("Earlier runs on overlapping subjects: none")
    else:
        out.append("Earlier runs on overlapping subjects:")
        for e in earlier[:6]:
            out.extend(describe(e))

    subject["paths"] = paths
    with open(args.subject, "w", encoding="utf-8") as f:
        json.dump(subject, f)
    append_entry(
        repo,
        new_entry(args.run, lens, paths, "picked", git("rev-parse", "HEAD").strip()),
    )
    print("\n".join(out))


def cmd_record(args):
    subject = load_json(args.subject, "subject")
    evaluation = load_json(args.evaluation, "evaluation")
    status = {"build": "handed-off", "close": "declined", "none": "clean"}[
        args.decision
    ]
    build = None
    if args.decision == "build":
        text = (
            read_text(args.build_started, "build-started file")
            if args.build_started and os.path.exists(args.build_started)
            else ""
        )
        m = re.search(r"^started build, run (\S+)\s*$", text, re.M)
        if not m:
            die(
                "the decision is build, but %s has no line 'started build, run <id>'"
                % args.build_started
            )
        build = m.group(1)
    repo = repo_name()
    picked = next(
        (e for e in reversed(read_ledger(repo, now())) if e["run"] == args.run), None
    )
    base = (picked or {}).get("base") or git("rev-parse", "HEAD").strip()
    findings = [f.get("title", "") for f in evaluation.get("findings") or []]
    append_entry(
        repo,
        new_entry(
            args.run,
            subject["lens"],
            subject["paths"],
            status,
            base,
            evaluation.get("summary", ""),
            findings,
            build,
        ),
    )
    print("recorded %s" % status)


def cmd_brief(args):
    subject = load_json(args.subject, "subject")
    evaluation = load_json(args.evaluation, "evaluation")
    report = read_text(args.report, "report").lstrip("\n")
    note = read_text(args.note, "note").strip() if os.path.exists(args.note) else ""
    findings = evaluation.get("findings") or []

    first, _, rest = report.partition("\n")
    if first.startswith("# "):
        report = rest.lstrip("\n")

    out = ["# %s" % evaluation["title"], ""]
    out.append(
        "An anti-entropy run examined the %s of %s and found %s worth removing. %s"
        % (
            subject["lens"],
            ", ".join(subject["paths"]),
            noun(len(findings), "thing"),
            evaluation.get("summary", ""),
        )
    )
    out.append("")
    if note:
        out += ["## Note", "", note, ""]
    out += ["## Findings", ""]
    for i, f in enumerate(findings, 1):
        files = ", ".join("`%s`" % p for p in f.get("files") or []) or "none named"
        out += [
            "### %s — %s" % (f.get("id") or "F%d" % i, f.get("title", "")),
            "",
            "- Change: %s" % f.get("change", ""),
            "- Files: %s" % files,
            "- Must still hold: %s" % f.get("keeps", ""),
            "- Risk: %s" % f.get("risk", ""),
            "",
        ]
    out += (
        ["## Constraints", ""]
        + ["- " + c for c in CONSTRAINTS]
        + ["", "## Evidence", "", report.rstrip(), ""]
    )
    sys.stdout.write("\n".join(out))


_repo = []


def repo_name():
    if not _repo:
        _repo.append(script("build-settings.sh", "--repo").strip())
    return _repo[0]


def main():
    p = argparse.ArgumentParser(
        prog="anti-entropy.py",
        description="The ledger and subject inventory behind the anti-entropy workflow.",
    )
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("inventory", help="rank the subjects a run could examine")
    a.add_argument(
        "--out", required=True, help="file that receives every subject as JSON"
    )
    b = sub.add_parser("claim", help="validate a run's subject and record it as picked")
    b.add_argument("--run", required=True)
    b.add_argument(
        "--subject", required=True, help="JSON file with lens, paths and reason"
    )
    c = sub.add_parser("record", help="append a run's outcome")
    c.add_argument("--run", required=True)
    c.add_argument("--decision", required=True, choices=["build", "close", "none"])
    c.add_argument("--subject", required=True)
    c.add_argument(
        "--evaluation", required=True, help="JSON file with title, summary and findings"
    )
    c.add_argument(
        "--build-started",
        help="file holding 'started build, run <id>'; read only for build",
    )
    d = sub.add_parser("brief", help="print the brief a build run takes as its message")
    d.add_argument("--subject", required=True)
    d.add_argument("--evaluation", required=True)
    d.add_argument("--report", required=True)
    d.add_argument(
        "--note", required=True, help="the owner's note; may be empty or missing"
    )
    args = p.parse_args()

    top = run(["git", "rev-parse", "--show-toplevel"])
    if top.returncode != 0:
        die("not inside a git repository")
    os.chdir(top.stdout.strip())
    {
        "inventory": cmd_inventory,
        "claim": cmd_claim,
        "record": cmd_record,
        "brief": cmd_brief,
    }[args.cmd](args)


if __name__ == "__main__":
    main()
