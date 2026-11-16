#!/usr/bin/env python3
"""Decisions and actions of the workflow-cleanup Archon workflow.

usage: workflow-cleanup.py <subcommand> [options]

  candidates --out FILE                 list the runs worth a look
  fan-out --candidates FILE --dry yes|no
                                        start one cleanup run for each candidate
  inspect --run ID --dry yes|no --state FILE --out FILE
                                        print the route for one run
  rescue --run ID --spend yes|no --dry yes|no --state FILE --out FILE [--retry]
                                        run the next rescue rung and inspect again
  settle --run ID --dry yes|no [--save-first] [--discard]
                                        remove the run's leftover worktree
  facts --verdict FILE --out DIR        gather what the diagnosing agent reads: facts.json, facts.md
  diagnosis --run ID --facts-word W --raw FILE --dir DIR
                                        check the agent's diagnosis and cache it
  report --verdict FILE --out FILE [--facts FILE] [--diagnosis FILE]
                                        write the attention report
  follow-candidates --run ID            print the workflows a report of the run may start
  handoff --run ID --workflow W --report FILE --note FILE [--diagnosis FILE]
                                        start research, or the follow-up the report recommends
  record --run ID --dry yes|no --state S --decision D --handoff FILE --verdict FILE
                                        append the run's outcome to the ledger
  worktrees --dry yes|no [--repo DIR]   delete the project's worktrees that hold nothing, and start
                                        one assessment run for each that might
  wt-inspect --worktree PATH --dry yes|no --state F --facts F --verdict F
                                        route one worktree: skip, delete, abandon, assess or dry
  wt-judge --state F --assess F --worktree PATH [--verdict F]
                                        record the assessor's verdict and print the final state
  wt-report --worktree PATH --facts F --verdict F --out F
                                        write the report for a worktree the assessor would delete
  wt-act --worktree PATH --decision delete|keep --dry yes|no
                                        delete the worktree, or record that it is kept

Every decision comes from facts in $ARCHON_HOME/archon.db (default ~/.archon/archon.db, read only) and from git in the run's
worktree or the project's worktrees. The workflow makes two model calls, and no subcommand makes
one: the assessor of a worktree with unlanded or uncommitted content, which wt-judge records,
and the diagnosis of a run that needs attention, which facts feeds and diagnosis checks. Under
--dry yes no subcommand writes the ledger, a repository or Archon. Exit 1 means refused input or a
refused action, exit 2 a usage error. The routes, rungs and ledger are described in
docs/reference/workflow-cleanup.md of the Archon kit.
"""

import argparse
import fcntl
import fnmatch
import glob
import hashlib
import json
import os
import re
import socket
import sqlite3
import subprocess
import sys
import tempfile
import urllib.parse
from datetime import datetime, timedelta, timezone

# procinfo.py sits beside this file. python3 -I leaves the file's own directory off sys.path, and
# an install that links each file may not have linked a newer module yet, so the directory the
# link points to is searched too. No bytecode is written, so no __pycache__ appears in the install.
sys.dont_write_bytecode = True
sys.path[:0] = list(dict.fromkeys(os.path.dirname(f(__file__)) for f in (os.path.abspath, os.path.realpath)))
import procinfo  # noqa: E402

HOME = os.path.expanduser("~")
ARCHON_HOME = os.environ.get("ARCHON_HOME") or os.path.join(HOME, ".archon")
DB = os.path.join(ARCHON_HOME, "archon.db")
STATE_DIR = os.path.join(ARCHON_HOME, "state", "workflow-cleanup")
DIAGNOSES = os.path.join(STATE_DIR, "diagnoses")
LEDGER = os.path.join(STATE_DIR, "ledger.jsonl")
LEDGER_LOCK = os.path.join(STATE_DIR, "ledger.lock")

SCRIPTS = os.path.join(ARCHON_HOME, "scripts")
KIT_JSON = os.path.join(ARCHON_HOME, "kit.json")
KIT_INSTALLED = os.path.join(ARCHON_HOME, "kit-installed.json")

ARCHON = os.environ.get("WC_ARCHON") or "archon"
GH = os.environ.get("WC_GH") or "gh"
DEAD_RUNS = os.environ.get("WC_DEAD_RUNS") or os.path.join(
    SCRIPTS, "archon-dead-runs.sh"
)
WT_CLEANUP = os.path.join(SCRIPTS, "worktree-cleanup.sh")
WT_LAND = os.path.join(SCRIPTS, "worktree-land")
START_RUN = os.path.join(SCRIPTS, "start-run.sh")
RUN_GATES = os.path.join(SCRIPTS, "run-gates.sh")
REGISTRY = os.environ.get("WC_REGISTRY") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "workflow-done.json"
)

RUNG_ORDER = ["commit-wip", "land", "resume", "relaunch", "adopt"]
SPENDING = {"resume", "relaunch", "adopt"}
MAX_RUNGS = 3
SPEND_CAP = 3
RECURRENCE_WINDOW = timedelta(days=30)
FAILED_KINDS = ("failed", "dead", "cancelled-refused")
TERMINAL = {"closed", "rescued", "answered", "handed-off", "accepted", "discarded"}
HANDOFFS = ("research", "follow-up")
# A pause raised before `follow-up` existed offered one answer for each workflow it could start.
# Its captured workflow definition still passes that workflow's name to `handoff` and `record`,
# so both accept any name, and `handoff` starts it only when `start-run.sh check` lists it.
NOT_HANDOFFS = ("accept", "retry", "discard", "none", "")
WORKFLOW_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
WAIT_SECONDS = 2700
WT_LIST_CAP = 2000
WT_UNTRACKED_CAP = 500
FACTS_CAP = 100 << 10
ARTIFACT_HEAD_CAP = 60 << 10
TIMELINE_ROWS = 40
CONCURRENT_SECONDS = 60
CONCURRENT_ROWS = 10
HEAD_FILES = ("blocked*.md", "resolution.md", "restore.txt", "*report*.md", "*.log")
SOURCE_REF = re.compile(r"[\w./-]+\.(?:sh|py|mjs|json|js|yaml)(?![\w])")
RECOMMENDS = ("accept", "retry", "research", "follow-up")
DEFECTS = ("none", "repo", "global-workflow", "environment", "operator", "unknown")
# The answers a defect's location allows. A defect in the repository or in an installed kit file is
# fixed by the follow-up that changes the files holding it, and one outside the code by an answer
# that changes no code.
ALLOWED = {
    "repo": ("follow-up",),
    "global-workflow": ("follow-up",),
    "environment": ("accept", "retry"),
    "operator": ("accept", "retry"),
    "none": ("accept", "retry"),
    "unknown": ("research",),
}


class Refused(Exception):
    """Input or state this program will not act on."""


# ---- small helpers ------------------------------------------------------------------------


def now():
    return datetime.now(timezone.utc)


def parse_ts(s):
    if not s:
        return None
    try:
        return datetime.strptime(
            str(s).strip().replace("T", " ")[:19], "%Y-%m-%d %H:%M:%S"
        ).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ") if dt else ""


def ago(dt):
    if not dt:
        return "?"
    s = (now() - dt).total_seconds()
    if s < 3600:
        return "%dm" % (s // 60)
    if s < 172800:
        return "%dh" % (s // 3600)
    return "%dd" % (s // 86400)


def sh(argv, cwd=None, env=None, timeout=120):
    try:
        p = subprocess.run(
            argv,
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
        )
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError as e:
        return 127, "", str(e)
    except subprocess.TimeoutExpired:
        return 124, "", "timed out after %ds" % timeout


def git(path, *args, timeout=60):
    rc, out, _ = sh(["git", "-C", path, *args], timeout=timeout)
    return rc, out.strip()


def tail(text, n=300):
    return " ".join(str(text).strip().split())[-n:]


def load_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_text(path, text):
    with open(path, "w") as f:
        f.write(text)


_KIT = []


def kit_setting(key, default=None):
    """The value of `key` in $ARCHON_HOME/kit.json, or the default when the file or key is missing.
    The file is read once for each process."""
    if not _KIT:
        _KIT.append(load_json(KIT_JSON, {}))
    data = _KIT[0]
    if isinstance(data, dict) and key in data:
        return data[key]
    return default


def scratch_dirs():
    names = kit_setting("scratch_dirs", [])
    if not isinstance(names, list):
        return []
    return [n for n in names if isinstance(n, str) and n and "/" not in n]


def is_scratch(text):
    """True when a path or a `git status` line lies inside a scratch directory named in kit.json."""
    return any(("%s/" % n) in text for n in scratch_dirs())


def run_env():
    """The environment for a run or a wait: this one plus the variables of `run_env` in kit.json."""
    env = dict(os.environ)
    extra = kit_setting("run_env", {})
    if isinstance(extra, dict):
        for k, v in extra.items():
            if isinstance(k, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k):
                env[k] = str(v)
    return env


def registry(repo=None):
    """The workflow-done entries that apply to a run of a repository. A later layer replaces an
    earlier entry for the same workflow: the kit's file, `done` in kit.json, then the repository's
    own .archon/workflow-done.json."""
    layers = [load_json(REGISTRY, {}), kit_setting("done", {})]
    if repo:
        layers.append(load_json(os.path.join(repo, ".archon", "workflow-done.json"), {}))
    out = {}
    for layer in layers:
        if isinstance(layer, dict):
            out.update({k: v for k, v in layer.items() if isinstance(v, dict)})
    return out


# ---- the database -------------------------------------------------------------------------


# The tables and columns this program and archon-dead-runs.sh read or write. Both scripts check
# the same list (archon-dead-runs.sh schema), because the tables are private to Archon.
SCHEMA = {
    "remote_agent_workflow_runs": (
        "id",
        "workflow_name",
        "status",
        "codebase_id",
        "working_path",
        "user_message",
        "metadata",
        "adopted_from_run_id",
        "started_at",
        "completed_at",
        "last_activity_at",
        "output_root",
    ),
    "remote_agent_workflow_events": (
        "workflow_run_id",
        "event_order",
        "event_type",
        "step_name",
        "data",
        "created_at",
    ),
    # A trigger of Archon's own database copies each deleted event here; clear-node relies on it.
    "remote_agent_workflow_event_archive": (
        "workflow_run_id",
        "event_order",
        "event_type",
        "step_name",
        "data",
    ),
    "remote_agent_codebases": ("id", "default_cwd"),
}


def archon_version():
    rc, out, _ = sh([ARCHON, "--version"], timeout=20)
    line = out.strip().splitlines()[0] if rc == 0 and out.strip() else ""
    return line or "an unknown version"


def check_schema(c):
    """Refuse, with one line that names the Archon version, when Archon's tables lack a column
    this program uses."""
    for table, cols in SCHEMA.items():
        have = {r[1] for r in c.execute("pragma table_info(%s)" % table)}
        missing = [col for col in cols if col not in have]
        if missing:
            raise Refused(
                "the Archon database lacks %s.%s (%s); this program was tested against Archon 0.13.x"
                % (table, ", ".join(missing), archon_version())
            )


def connect():
    if not os.path.exists(DB):
        raise Refused("no database at %s" % DB)
    c = sqlite3.connect("file:%s?mode=ro" % urllib.parse.quote(DB), uri=True, timeout=30)
    c.row_factory = sqlite3.Row
    check_schema(c)
    return c


def run_dict(row):
    try:
        meta = json.loads(row["metadata"] or "{}")
    except ValueError:
        meta = {}
    return {
        "id": row["id"],
        "workflow": row["workflow_name"],
        "status": row["status"],
        "codebase_id": row["codebase_id"],
        "path": row["working_path"] or "",
        "message": row["user_message"] or "",
        "meta": meta if isinstance(meta, dict) else {},
        "adopted_from": row["adopted_from_run_id"],
        "started": parse_ts(row["started_at"]),
        "completed": parse_ts(row["completed_at"]),
        "last": parse_ts(row["last_activity_at"]),
    }


def find_run(c, ref):
    rows = c.execute(
        "select * from remote_agent_workflow_runs where id = ?", (ref,)
    ).fetchall()
    if not rows and ref:
        rows = c.execute(
            "select * from remote_agent_workflow_runs where substr(id, 1, ?) = ?",
            (len(ref), ref),
        ).fetchall()
    if len(rows) != 1:
        raise Refused("run id %r matches %d runs" % (ref, len(rows)))
    return run_dict(rows[0])


def events_of(c, rid):
    out = []
    for r in c.execute(
        "select event_type, step_name, data, created_at from remote_agent_workflow_events"
        " where workflow_run_id = ? order by event_order, created_at",
        (rid,),
    ):
        try:
            d = json.loads(r["data"] or "{}")
        except ValueError:
            d = {}
        out.append(
            {
                "type": r["event_type"],
                "step": r["step_name"] or "",
                "data": d if isinstance(d, dict) else {},
                "at": parse_ts(r["created_at"]),
            }
        )
    return out


def repo_of(c, run):
    row = c.execute(
        "select default_cwd from remote_agent_codebases where id = ?",
        (run["codebase_id"],),
    ).fetchone()
    return row["default_cwd"] if row else None


def owner_state(meta):
    """alive, dead or unknown (a run of another host, or a system that cannot show the process)."""
    owner = meta.get("execution_owner") or {}
    pid, host = owner.get("pid"), owner.get("host")
    if not pid or host != socket.gethostname():
        return "unknown"
    return procinfo.owner_state(pid)


def run_kind(run, evs):
    status = run["status"]
    if status == "completed":
        return "completed"
    if status == "failed":
        return "failed"
    if status == "cancelled":
        reasons = [
            e["data"].get("cancel_reason")
            for e in evs
            if e["type"] == "workflow_cancelled"
        ]
        return (
            "cancelled-refused"
            if reasons and reasons[-1] == "precondition_failed"
            else "cancelled-chosen"
        )
    if status == "running" and owner_state(run["meta"]) == "dead":
        return "dead"
    return "live"


def artifacts_dir(rid):
    found = glob.glob(
        os.path.join(ARCHON_HOME, "workspaces", "*", "*", "artifacts", "runs", rid)
    )
    return found[0] if found else None


def run_fact(art, key, legacy=""):
    """The last value the run's state file holds for key. A run made before the state file
    existed kept the fact in a one-word file, named by legacy."""
    value = ""
    try:
        with open(os.path.join(art, "state")) as f:
            for line in f:
                k, sep, v = line.rstrip("\n").partition("=")
                if sep and k == key:
                    value = v
    except OSError:
        pass
    if not value and legacy:
        try:
            with open(os.path.join(art, legacy)) as f:
                value = f.read().strip()
        except OSError:
            pass
    return value


def transcript_path(rid):
    found = glob.glob(
        os.path.join(ARCHON_HOME, "workspaces", "*", "*", "logs", rid + ".jsonl")
    )
    return found[0] if found else None


def child_state(rid):
    """What a run started by a rescue is doing now: completed, waiting, failed or unknown."""
    try:
        c = connect()
        row = c.execute(
            "select * from remote_agent_workflow_runs where id = ?", (rid,)
        ).fetchone()
    except (Refused, sqlite3.Error):
        return "unknown"
    if not row:
        return "unknown"
    run = run_dict(row)
    if run["status"] == "completed":
        return "completed"
    if run["status"] == "paused":
        return "waiting"
    if run["status"] == "running":
        return "failed" if owner_state(run["meta"]) == "dead" else "waiting"
    return "failed"


# ---- the ledger ---------------------------------------------------------------------------


def read_ledger():
    out = []
    try:
        with open(LEDGER) as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if isinstance(e, dict):
                    out.append(e)
    except OSError:
        pass
    return out


def ledger_entry(run, action, detail="", signature="", child=None):
    return {
        "run": run,
        "ts": iso(now()),
        "action": action,
        "detail": detail,
        "signature": signature,
        "child": child,
    }


def ledger_append(entries):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(LEDGER_LOCK, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with open(LEDGER, "a") as f:
            for e in entries:
                f.write(json.dumps(e) + "\n")
            f.flush()
            os.fsync(f.fileno())


def rung_history(rid, led):
    """The rungs tried since the run's last retry marker."""
    es = [e for e in led if e.get("run") == rid and e.get("action") == "rung"]
    cut = max((i for i, e in enumerate(es) if e.get("detail") == "retry"), default=-1)
    out = []
    for e in es[cut + 1 :]:
        parts = (e.get("detail") or "").split(" ", 2)
        out.append(
            {
                "rung": parts[0],
                "ok": len(parts) > 1 and parts[1] == "ok",
                "message": parts[2] if len(parts) > 2 else "",
                "child": e.get("child"),
            }
        )
    return out


# ---- failures -----------------------------------------------------------------------------


def bare(node):
    return node.rsplit(".", 1)[-1] if node else ""


def in_list(node, names):
    return bool(node) and (node in names or bare(node) in names)


def failure_of(run, kind, evs):
    failed = [e for e in evs if e["type"] == "workflow_failed"]
    if kind == "dead":
        return {
            "node": None,
            "exit_reason": "dead",
            "error": "the process that owned the run is gone",
        }
    if kind == "cancelled-refused":
        cancelled = [e for e in evs if e["type"] == "workflow_cancelled"]
        d = cancelled[-1]["data"] if cancelled else {}
        err = (d.get("terminal_record") or {}).get(
            "error"
        ) or "the engine refused to start or resume the run"
        return {"node": None, "exit_reason": "precondition_failed", "error": str(err)}
    if failed:
        d = failed[-1]["data"]
        tr = d.get("terminal_record") or {}
        return {
            "node": tr.get("first_failed_node"),
            "exit_reason": d.get("exit_reason"),
            "error": str(d.get("error") or run["meta"].get("error") or ""),
        }
    if kind == "failed":
        return {
            "node": None,
            "exit_reason": "unknown",
            "error": str(run["meta"].get("error") or ""),
        }
    return None


def classify(entry, failure):
    entry = entry or {}
    node, error = failure["node"], failure["error"]
    if in_list(node, entry.get("housekeeping", [])):
        return "housekeeping"
    if (
        failure["exit_reason"] == "launch_failed"
        and "Timed out creating workspace" in error
    ):
        return "transient"
    name = bare(node).lower()
    if (
        "Credential preflight failed" in error
        or "Cannot determine git r" in error
        or failure["exit_reason"] == "unhandled_error"
        or in_list(node, entry.get("attention_nodes", []))
        or "lane" in name
        or "guard" in name
    ):
        return "systemic"
    return "other"


def normalize(text):
    text = re.sub(r"\b(?=[0-9a-f]*\d)[0-9a-f]{6,}\b", "N", text)
    text = re.sub(r"\d+", "N", text)
    return " ".join(text.split())


def signature(workflow, node, exit_reason, error):
    return "%s|%s|%s|%s" % (
        workflow,
        node or "",
        exit_reason or "",
        normalize(error or "")[:70],
    )


def recurrence(c, sig, led):
    """Failures with this signature newer than its last answer, within the window."""
    answered = [
        parse_ts(e.get("ts"))
        for e in led
        if e.get("action") == "answered" and e.get("signature") == sig
    ]
    floor = max((a for a in answered if a), default=None)
    horizon = now() - RECURRENCE_WINDOW
    items = []
    for r in c.execute(
        "select e.workflow_run_id as rid, e.data as data, e.created_at as at,"
        " r.workflow_name as wf from remote_agent_workflow_events e"
        " join remote_agent_workflow_runs r on r.id = e.workflow_run_id"
        " where e.event_type = 'workflow_failed'"
    ):
        at = parse_ts(r["at"])
        if not at or at < horizon or (floor and at <= floor):
            continue
        try:
            d = json.loads(r["data"] or "{}")
        except ValueError:
            continue
        tr = d.get("terminal_record") or {}
        s = signature(
            r["wf"],
            tr.get("first_failed_node"),
            d.get("exit_reason"),
            str(d.get("error") or ""),
        )
        if s == sig:
            items.append((r["rid"], at))
    return sorted(items, key=lambda x: x[1])


# ---- the work a run left ------------------------------------------------------------------

SCAN_CACHE = {}
SCAN_WARNINGS = {}


def linked_worktree(path):
    """The main checkout of the repository when `path` is a linked worktree, else None."""
    if not path or not os.path.isdir(path):
        return None
    rc, top = git(path, "rev-parse", "--show-toplevel")
    if rc or os.path.realpath(top) != os.path.realpath(path):
        return None
    rc1, gd = git(path, "rev-parse", "--path-format=absolute", "--git-dir")
    rc2, cd = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if rc1 or rc2 or os.path.realpath(gd) == os.path.realpath(cd):
        return None
    return os.path.dirname(os.path.realpath(cd))


def scan_entry(main, path):
    if main not in SCAN_CACHE:
        rc, out, err = sh([WT_CLEANUP, "scan", main], timeout=180)
        if rc != 0:
            raise Refused("worktree-cleanup.sh scan failed: %s" % tail(err))
        try:
            SCAN_CACHE[main] = json.loads(out)
        except ValueError:
            raise Refused("worktree-cleanup.sh scan printed no JSON") from None
        SCAN_WARNINGS[main] = [x for x in err.splitlines() if x.strip()]
    real = os.path.realpath(path)
    for e in SCAN_CACHE[main]:
        if os.path.realpath(e["path"]) == real:
            return e
    return None


def base_branch(main):
    for b in ("main", "master"):
        rc, _ = git(main, "rev-parse", "--verify", "-q", b)
        if rc == 0:
            return b
    rc, out = git(main, "symbolic-ref", "--quiet", "--short", "HEAD")
    return out or "main"


def cherry_count(path, base):
    rc, out = git(path, "cherry", base, "HEAD")
    if rc:
        raise Refused("git cherry failed in %s" % path)
    return sum(1 for line in out.splitlines() if line.startswith("+"))


def dirty_lines(path):
    rc, out = git(path, "status", "--porcelain")
    return [line for line in out.splitlines() if not is_scratch(line)]


def remote_contains_head(path, branch):
    rc, remotes = git(path, "remote")
    if "origin" not in remotes.split():
        return False
    rc, out = git(
        path, "ls-remote", "--heads", "origin", "refs/heads/" + branch, timeout=30
    )
    if rc or not out:
        return False
    sha = out.split()[0]
    rc, head = git(path, "rev-parse", "HEAD")
    if sha == head:
        return True
    if git(path, "cat-file", "-e", sha + "^{commit}")[0] != 0:
        git(path, "fetch", "-q", "--no-write-fetch-head", "origin", branch, timeout=60)
        if git(path, "cat-file", "-e", sha + "^{commit}")[0] != 0:
            return False
    return git(path, "merge-base", "--is-ancestor", "HEAD", sha)[0] == 0


def has_pull_request(path, branch):
    rc, out, _ = sh(
        [
            GH,
            "pr",
            "list",
            "--head",
            branch,
            "--state",
            "all",
            "--json",
            "state,number",
        ],
        cwd=path,
        timeout=30,
    )
    if rc:
        return False
    try:
        prs = json.loads(out or "[]")
    except ValueError:
        return False
    return any(str(p.get("state", "")).upper() in ("OPEN", "MERGED") for p in prs)


def work_state(path):
    work = {
        "state": "none",
        "path": path,
        "branch": "",
        "head": "",
        "ahead": 0,
        "dirty_files": [],
        "saved": True,
        "locked": False,
        "repo": None,
        "base": "",
    }
    main = linked_worktree(path)
    if not main:
        return work
    entry = scan_entry(main, path)
    if entry is None:
        raise Refused("%s is not in the worktree list of %s" % (path, main))
    branch = entry.get("branch") or ""
    base = base_branch(main)
    ahead = entry.get("ahead_of_main", 0) if branch else cherry_count(path, base)
    work.update(
        repo=main,
        base=base,
        branch=branch,
        head=entry.get("head") or "",
        ahead=ahead,
        dirty_files=list(entry.get("dirty_files") or []),
        locked=bool(entry.get("locked")),
    )
    if entry.get("dirty") or (not branch and ahead > 0):
        state = "unsaved"
    elif ahead == 0:
        state = "landed"
    elif branch and remote_contains_head(path, branch):
        state = "pr" if has_pull_request(path, branch) else "pushed"
    else:
        state = "branch"
    work["state"] = state
    work["saved"] = state != "unsaved"
    return work


# ---- worktrees of a project ---------------------------------------------------------------

CLAUDE_LOCK = re.compile(r"^claude session .*\(pid (\d+) start (\d+)\)\s*$")


def project_root(start):
    """The main checkout of the repository that holds `start`, a main checkout or a linked worktree."""
    if not start or not os.path.isdir(start):
        raise Refused("%s is not a directory" % start)
    rc, common = git(start, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if rc or not common:
        raise Refused("%s is not inside a git repository" % start)
    return os.path.dirname(os.path.realpath(common))


def worktree_list(main):
    """([realpath of each linked worktree], {realpath: lock reason or None} for the locked ones)."""
    paths, locks = [], {}
    rc, text = git(main, "worktree", "list", "--porcelain")
    if rc:
        return paths, locks
    cur = None
    for line in text.splitlines():
        if line.startswith("worktree "):
            cur = os.path.realpath(line[len("worktree ") :])
            if cur != os.path.realpath(main):
                paths.append(cur)
        elif cur and (line == "locked" or line.startswith("locked ")):
            locks[cur] = line[len("locked") :].strip() or None
    return paths, locks


def lock_reasons(main):
    """{realpath: reason or None} for each locked worktree of the repository."""
    return worktree_list(main)[1]


def claude_lock_state(reason):
    """None when the reason is not a Claude session's, else whether that session's process lives.
    A system with no /proc cannot compare start times, so it reads the session as alive and the
    lock stays."""
    m = CLAUDE_LOCK.match(reason or "")
    if not m:
        return None
    if not procinfo.have_proc():
        return True
    return procinfo.start_ticks(m.group(1)) == m.group(2)


def process_cwds():
    """[(pid, working directory)], or None when this system cannot list them."""
    return procinfo.cwds()


def pids_in(path, cwds=None):
    real = os.path.realpath(path)
    cwds = process_cwds() if cwds is None else cwds
    return sorted(
        pid
        for pid, cwd in (cwds or [])
        if cwd == real or cwd.startswith(real + os.sep)
    )


def status_paths(path):
    """(XY, path) for each changed or untracked file, outside the scratch directories of kit.json."""
    rc, out, _ = sh(["git", "-C", path, "status", "--porcelain", "-z", "-uall"])
    if rc:
        return []
    items = out.split("\0")
    res = []
    i = 0
    while i < len(items) and len(res) < WT_LIST_CAP:
        it = items[i]
        i += 1
        if len(it) < 4:
            continue
        xy, p = it[:2], it[3:]
        orig = None
        if "R" in xy or "C" in xy:
            orig = items[i] if i < len(items) else None
            i += 1
        if is_scratch(p):
            continue
        res.append((xy, p))
        if orig and "C" not in xy:
            res.append((" D", orig))
    return res


def content_in_base(path, base):
    """True when every file the branch changed since the merge-base is identical in `base`, which
    squash merges and reverts leave behind where `git cherry` finds a missing patch."""
    rc, mb = git(path, "merge-base", base, "HEAD")
    if rc or not mb:
        return False
    rc, out, _ = sh(
        ["git", "-C", path, "diff", "--name-only", "--no-renames", "-z", mb, "HEAD"]
    )
    if rc:
        return False
    files = [f for f in out.split("\0") if f]
    for i in range(0, len(files), 200):
        rc, _, _ = sh(
            [
                "git",
                "-C",
                path,
                "--literal-pathspecs",
                "diff",
                "--quiet",
                base,
                "HEAD",
                "--",
                *files[i : i + 200],
            ]
        )
        if rc != 0:
            return False
    return True


def fingerprint(path):
    """Identifies the worktree's content: HEAD, the status, the diff against HEAD and the
    untracked files, so a verdict is reused until something changes."""
    h = hashlib.sha1()
    _, head = git(path, "rev-parse", "HEAD")
    h.update(head.encode() + b"\0")
    for argv in (["status", "--porcelain"], ["diff", "HEAD"]):
        _, out, _ = sh(["git", "-C", path, *argv])
        h.update(out.encode(errors="replace") + b"\0")
    _, out, _ = sh(
        ["git", "-C", path, "ls-files", "--others", "--exclude-standard", "-z"]
    )
    files = sorted(f for f in out.split("\0") if f and not is_scratch(f))
    for rel in files[:WT_UNTRACKED_CAP]:
        h.update(rel.encode(errors="replace") + b"\0")
        full = os.path.join(path, rel)
        try:
            if os.path.islink(full):
                h.update(os.readlink(full).encode(errors="replace"))
            elif os.path.isfile(full):
                h.update(str(os.path.getsize(full)).encode())
                with open(full, "rb") as f:
                    h.update(f.read(8 << 20))
        except OSError:
            pass
    return h.hexdigest()


def wt_context(main):
    """What a sweep of the project's worktrees needs, read once. None when the repository has
    neither a main nor a master branch to compare against."""
    base = None
    for b in ("main", "master"):
        if git(main, "rev-parse", "--verify", "-q", "refs/heads/" + b)[0] == 0:
            base = b
            break
    if not base:
        return None
    scan_entry(main, main)
    entries = SCAN_CACHE[main]
    wanted = {os.path.realpath(e["path"]) for e in entries}
    listed, locks = worktree_list(main)
    c = connect()
    led = read_ledger()
    owners, children = {}, {}
    for row in c.execute("select * from remote_agent_workflow_runs"):
        run = run_dict(row)
        real = os.path.realpath(run["path"]) if run["path"] else None
        cancelled = run["status"] == "cancelled"
        is_child = run["workflow"] == "workflow-cleanup"
        if real not in wanted and not is_child:
            continue
        kind = run_kind(run, events_of(c, run["id"]) if cancelled else [])
        if real in wanted:
            owners.setdefault(real, []).append((run, kind))
        target = str((run["meta"].get("inputs") or {}).get("worktree") or "")
        if is_child and kind == "live" and target:
            children.setdefault(os.path.realpath(target), set()).add(run["id"])
    return {
        "main": main,
        "base": base,
        "entries": entries,
        "locks": locks,
        "unscanned": [p for p in listed if p not in wanted],
        "owners": owners,
        "children": children,
        "ledger": led,
        "terminal": {e.get("run") for e in led if e.get("action") in TERMINAL},
        "cwds": process_cwds(),
    }


def use_reason(ctx, entry):
    """(why the sweep leaves this worktree alone, or None; whether its lock is a stale Claude
    lock that may be removed). Anything something holds stays: a lock, a process in the
    directory, or a run. Nothing here goes by how long the worktree has been idle."""
    path = entry["path"]
    real = os.path.realpath(path)
    if entry.get("prunable") or not os.path.isdir(path):
        return "prunable (its directory is gone)", False
    stale = False
    if real in ctx["locks"] or entry.get("locked"):
        reason = ctx["locks"].get(real)
        alive = claude_lock_state(reason)
        if alive is None:
            return "locked (%s)" % (reason or "no reason given"), False
        if alive:
            return "in use (a live Claude session holds its lock)", False
        stale = True
    if ctx["cwds"] is None:
        return "in use (this system cannot show which processes work inside it)", stale
    pids = pids_in(real, ctx["cwds"])
    if pids:
        return "in use (process %d works inside it)" % pids[0], stale
    for run, kind in ctx["owners"].get(real, []):
        if kind == "live":
            return "in use (run %s is working or paused)" % run["id"][:8], stale
        if run["workflow"] != "workflow-cleanup" and run["id"] not in ctx["terminal"]:
            return "in use (run %s has no verdict yet)" % run["id"][:8], stale
    return None, stale


def classify_worktree(ctx, entry, self_run=""):
    """{action: delete|assess|ignore, reason, ...} for one worktree of the project."""
    path, base = entry["path"], ctx["base"]
    real = os.path.realpath(path)
    branch = entry.get("branch") or ""
    why, stale = use_reason(ctx, entry)
    if why:
        return {"action": "ignore", "reason": why}
    try:
        cherry = cherry_count(path, base)
    except Refused as e:
        return {"action": "ignore", "reason": str(e)}
    in_base = cherry == 0 or content_in_base(path, base)
    dirty = bool(entry.get("dirty"))
    if not dirty and in_base:
        how = (
            "every patch is in %s" % base
            if cherry == 0
            else "every file it changed matches %s" % base
        )
        return {
            "action": "delete",
            "reason": "clean; %s" % how,
            "discard_unlanded": cherry > 0,
            "stale_lock": stale,
        }
    if dirty:
        n = len(entry.get("dirty_files") or [])
        extra = (
            ""
            if in_base
            else " and %d unlanded commit%s" % (cherry, "" if cherry == 1 else "s")
        )
        blocker = "%d uncommitted file%s%s" % (n, "" if n == 1 else "s", extra)
    else:
        blocker = "%d unlanded commit%s" % (cherry, "" if cherry == 1 else "s")
    mine = [e for e in ctx["ledger"] if e.get("run") == "wt:" + real]
    if any(
        e.get("action") == "wt-declined" and (e.get("detail") or "") == branch
        for e in mine
    ):
        return {"action": "ignore", "reason": "declined (you answered keep)"}
    fp = fingerprint(path)
    verdicts = [
        (e.get("detail") or "").split(" ", 1)[0]
        for e in mine
        if e.get("action") == "wt-assessed" and e.get("signature") == fp
    ]
    cached = verdicts[-1] if verdicts else None
    if cached == "keep":
        return {
            "action": "ignore",
            "reason": "assessed as worth keeping, unchanged since",
        }
    live = ctx["children"].get(real, set()) - {self_run}
    if live:
        return {
            "action": "ignore",
            "reason": "run %s is already assessing it" % sorted(live)[0][:8],
        }
    return {
        "action": "assess",
        "reason": blocker,
        "fingerprint": fp,
        "cached": cached,
        "stale_lock": stale,
    }


def wt_run_id():
    """The id of the workflow run this process belongs to, from its artifacts directory."""
    return os.path.basename(os.environ.get("ARTIFACTS_DIR", "").rstrip("/"))


def wt_remove(main, path, discard_dirty):
    """Remove the worktree and, when its work is in the base or the removal is confirmed, its
    branch. Returns the branch tip, which restores the branch."""
    real = os.path.realpath(path)
    base = base_branch(main)
    _, tip = git(path, "rev-parse", "--short", "HEAD")
    if claude_lock_state(lock_reasons(main).get(real)) is False:
        rc, _, err = sh(["git", "-C", main, "worktree", "unlock", path])
        if rc:
            raise Refused("could not unlock %s: %s" % (path, tail(err)))
    argv = [WT_CLEANUP, "remove"]
    if discard_dirty:
        argv.append("--discard-dirty")
    if cherry_count(path, base) > 0 and (discard_dirty or content_in_base(path, base)):
        argv.append("--discard-unlanded")
    rc, out, err = sh([*argv, path], cwd=main, timeout=180)
    if os.path.exists(path):
        raise Refused("%s was not removed: %s" % (path, tail(err or out)))
    return tip


def cap_lines(text, n):
    lines = text.splitlines()
    if len(lines) <= n:
        return text.strip("\n")
    return "\n".join(lines[:n] + ["[%d more lines]" % (len(lines) - n)])


def cap_bytes(text, n):
    raw = text.encode("utf-8", errors="replace")
    if len(raw) <= n:
        return text
    return raw[:n].decode("utf-8", errors="ignore") + "\n[truncated %d bytes]" % (
        len(raw) - n
    )


def build_facts(path, base, out):
    """Write what the assessor reads, and return the parts a report quotes."""
    main = project_root(path)
    real = os.path.realpath(path)
    _, branch = git(path, "branch", "--show-current")
    _, head = git(path, "rev-parse", "HEAD")
    _, mb = git(path, "merge-base", base, "HEAD")
    changes = status_paths(path)
    dirty_files = [p for _, p in changes]
    locks = lock_reasons(main)
    reason = locks.get(real)
    lock_text = (reason or "locked, no reason given") if real in locks else "none"

    _, cherry = git(path, "cherry", "-v", base, "HEAD")
    unlanded = [x for x in cherry.splitlines() if x.startswith("+")]
    stat = ""
    if mb:
        _, stat = git(path, "diff", "--stat", mb, "HEAD")
    labelled = []
    for xy, p in changes[:WT_LIST_CAP]:
        full = os.path.join(path, p)
        if not os.path.lexists(full):
            label = "deleted"
        else:
            rc, mine = git(path, "hash-object", "--", p)
            rc2, in_base = git(path, "rev-parse", "-q", "--verify", "%s:%s" % (base, p))
            if rc2 != 0:
                label = "absent-in-main"
            elif rc == 0 and mine == in_base:
                label = "identical-to-main"
            else:
                label = "differs-from-main"
        labelled.append((label, p))
    branch_paths = []
    if mb:
        _, names, _ = sh(
            ["git", "-C", path, "diff", "--name-only", "--no-renames", "-z", mb, "HEAD"]
        )
        branch_paths = [f for f in names.split("\0") if f]

    def touching(paths):
        if not (mb and paths):
            return ""
        rc, out, _ = sh(
            [
                "git",
                "-C",
                path,
                "--literal-pathspecs",
                "log",
                "--oneline",
                "%s..%s" % (mb, base),
                "--",
                *paths,
            ]
        )
        return out

    superseding = touching(list(dict.fromkeys(branch_paths + dirty_files))[:300])
    # The report lists only the files that differ from main, so the commits it shows are those
    # that touched them. A file identical to main was landed by someone else, and the commits
    # that landed it say nothing about this worktree.
    listed = [(lab, p) for lab, p in labelled if lab != "identical-to-main"]
    listed_log = touching(
        list(dict.fromkeys(branch_paths + [p for _, p in listed]))[:300]
    )
    branch_diff = git(path, "diff", mb, "HEAD")[1] if mb else ""
    work_diff = git(path, "diff", "HEAD")[1]
    _, others, _ = sh(
        ["git", "-C", path, "ls-files", "--others", "--exclude-standard", "-z"]
    )
    samples = []
    for rel in [f for f in others.split("\0") if f and not is_scratch(f)][:10]:
        try:
            with open(os.path.join(path, rel), errors="replace") as f:
                body = "".join(f.readline() for _ in range(40))
        except OSError:
            continue
        samples.append("--- %s\n%s" % (rel, cap_bytes(body.rstrip("\n"), 4 << 10)))

    parts = [
        "# Facts about one worktree",
        "",
        "- path: %s" % path,
        "- branch: %s" % (branch or "(detached HEAD)"),
        "- base branch: %s" % base,
        "- head: %s" % head,
        "- lock: %s" % lock_text,
        "",
        "## Unlanded commits (git cherry -v %s HEAD)" % base,
        "",
        cap_lines("\n".join(unlanded), 30) or "none",
        "",
        "## Changes since the merge-base with %s (git diff --stat)" % base,
        "",
        cap_lines(stat, 60) or "none",
        "",
        "## Uncommitted files",
        "",
        "\n".join("%s  %s" % (lab, p) for lab, p in labelled[:60])
        + ("\n[%d more files]" % (len(labelled) - 60) if len(labelled) > 60 else "")
        if labelled
        else "none",
        "",
        "## Commits on %s since the merge-base that touched these paths" % base,
        "",
        cap_lines(superseding.strip(), 30) or "none",
        "",
        "## Diff of the branch against its merge-base",
        "",
        cap_bytes(branch_diff, 40 << 10) or "none",
        "",
        "## Diff of the uncommitted changes against HEAD",
        "",
        cap_bytes(work_diff, 40 << 10) or "none",
        "",
        "## Untracked files (first 40 lines of up to 10)",
        "",
        "\n\n".join(samples) or "none",
        "",
    ]
    write_text(out, cap_bytes("\n".join(parts), 100 << 10))
    return {
        "unlanded_count": len(unlanded),
        "dirty_count": len(labelled),
        "unlanded": unlanded[:30],
        "stat": cap_lines(stat, 60).splitlines(),
        "dirty": listed[:60],
        "identical_count": len(labelled) - len(listed),
        "superseding": cap_lines(listed_log.strip(), 30).splitlines(),
        "lock": reason,
    }


# ---- facts about a run, and the route -----------------------------------------------------


def finish_status(entry, evs):
    """None when the workflow declares no finishing nodes, else whether each group has one done."""
    finish = (entry or {}).get("finish")
    if not finish:
        return None
    done = {e["step"] for e in evs if e["type"] == "node_completed"}

    def has(name):
        return any(s == name or s.endswith("." + name) for s in done)

    return all(any(has(n) for n in group) for group in finish)


def approved(evs, step):
    last = None
    for e in evs:
        if e["type"] == "wait_answered" and (
            e["step"] == step or e["step"].endswith("." + step)
        ):
            last = (e["data"].get("answer") or {}).get("decision")
    return last == "approve"


def definition_changed(run, repo):
    root = run["meta"].get("workflow_source", {}).get("root")
    if not root or not os.path.isdir(root):
        return False
    name = run["workflow"]
    captured = glob.glob(os.path.join(root, "**", name + ".yaml"), recursive=True)
    current = []
    if repo:
        current += glob.glob(
            os.path.join(repo, ".archon", "workflows", "**", name + ".yaml"),
            recursive=True,
        )
    current += glob.glob(os.path.join(ARCHON_HOME, "workflows", "*", name, name + ".yaml"))
    current = [p for p in current if os.path.isfile(p)]
    if not captured or not current:
        return False

    def digest(p):
        with open(p, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()

    return digest(captured[0]) != digest(current[0])


def eligible_rungs(run, evs, kind, entry, failure, work, tried, repo):
    if len(tried) >= MAX_RUNGS:
        return []
    out = []
    if work["state"] == "unsaved" and work["repo"]:
        out.append("commit-wip")
    land = (entry or {}).get("land")
    art = artifacts_dir(run["id"]) if land else None
    if (
        land
        and kind in FAILED_KINDS
        and work["state"] in ("branch", "pushed")
        and (
            approved(evs, land.get("approval", ""))
            or bool(
                land.get("state") and art and run_fact(art, land["state"]) == "yes"
            )
        )
        and git(run["path"], "merge-base", "--is-ancestor", work["base"], "HEAD")[0]
        == 0
    ):
        mode = run_fact(art, "deliver", "deliver.txt") if art else ""
        if mode != "draft-pr":
            out.append("land")
    if kind == "dead":
        out.append("resume")
    if (
        failure
        and failure["exit_reason"] == "launch_failed"
        and failure["class"] == "transient"
    ):
        out.append("relaunch")
    if (
        entry
        and entry.get("adopt")
        and run["status"] == "failed"
        and failure
        and failure["class"] == "other"
        and not run["adopted_from"]
        and (run["message"] or (run["meta"].get("inputs") or {}).get("design"))
        and definition_changed(run, repo)
    ):
        art = artifacts_dir(run["id"])
        # The run got past its plan gate: it recorded an approved plan, or, when it was made before
        # plan-decision existed, the commit its tests stage started from.
        if (
            art
            and os.path.isfile(os.path.join(art, "plan.md"))
            and (
                run_fact(art, "plan-decision") in ("approve", "reused")
                or run_fact(art, "tests-sha", "tests.sha")
            )
        ):
            out.append("adopt")
    names = {t["rung"] for t in tried}
    return [r for r in RUNG_ORDER if r in out and r not in names]


def child_info(c, run, tried):
    ids = [t["child"] for t in tried if t["child"] and t["ok"]]
    for r in c.execute(
        "select id from remote_agent_workflow_runs where adopted_from_run_id = ?"
        " order by started_at",
        (run["id"],),
    ):
        ids.append(r["id"])
    if not ids:
        return None
    return ids[-1], child_state(ids[-1])


def open_handoffs(rid, evs):
    """The workflows of the hand-offs a build approved and did not start, by the run's artifacts.
    A run with no handoffs-approved.json has none. Without handoffs-started.json, each
    `started <workflow>, run <id>` line a `handoff` node printed counts for one approved entry
    of that workflow."""
    art = artifacts_dir(rid)
    if not art:
        return []

    def read(name):
        try:
            with open(os.path.join(art, name)) as f:
                data = json.load(f)
        except (OSError, ValueError):
            return None
        return data if isinstance(data, list) else None

    approved_list = read("handoffs-approved.json")
    if not approved_list:
        return []
    approved_list = [e for e in approved_list if isinstance(e, dict)]

    def key(e):
        return json.dumps(
            [e.get("workflow"), e.get("repo") or "", e.get("inputs") or []],
            sort_keys=True,
        )

    started = read("handoffs-started.json")
    if started is not None:
        seen = {key(e) for e in started if isinstance(e, dict)}
        left = [e for e in approved_list if key(e) not in seen]
    else:
        left = list(approved_list)
        for e in evs:
            step = e["step"]
            if e["type"] != "node_completed" or not (
                step == "handoff" or step.endswith(".handoff")
            ):
                continue
            out = e["data"].get("node_output")
            for m in re.finditer(
                r"^started ([^,\s]+), run ", out if isinstance(out, str) else "", re.M
            ):
                for i, a in enumerate(left):
                    if a.get("workflow") == m.group(1):
                        del left[i]
                        break
    return [str(e.get("workflow")) for e in left]


def decide(v, entry):
    kind, work, f, elig = v["kind"], v["work"], v["failure"], v["eligible"]
    child, child_st = v["child"], v["child_state"]

    def worrying():
        return bool(f) and (f["class"] == "systemic" or f["recurring"])

    def rescue_or_attention(rescue_reason, attention_reason):
        if elig:
            return "rescue", "%s; next rung %s" % (rescue_reason, elig[0])
        return "attention", attention_reason

    if kind == "live":
        return "skip", "the run is still working or paused"
    if child_st == "waiting":
        return "waiting", "run %s waits at a pause of its own" % child[:8]
    finished = v["rescued_by"] or child_st == "completed"
    if finished and work["state"] != "unsaved":
        who = v["rescued_by"] or (
            "a resume" if child == v["run"] else "run %s" % child[:8]
        )
        if worrying():
            return "attention", "rescued by %s, but the failure is %s" % (
                who,
                "recurring" if f["recurring"] else "systemic",
            )
        return "close", "rescued by %s" % who
    if kind in ("completed", "cancelled-chosen"):
        if v["post_rescue"] and worrying():
            return "attention", "rescued, but the failure is %s" % (
                "recurring" if f["recurring"] else "systemic"
            )
        if work["state"] == "unsaved":
            return rescue_or_attention(
                "the work is unsaved", "the work is unsaved and no rung can save it"
            )
        if kind == "cancelled-chosen":
            return "close", "the owner cancelled the run and its work is saved"
        if v.get("open_handoffs"):
            return "attention", "the run completed without starting: %s" % ", ".join(
                v["open_handoffs"]
            )
        if v["task_complete"] is False:
            return "attention", "the run completed without its finishing node"
        if not v["meets_git"]:
            return "attention", "the work is only on a local branch"
        return "close", "the run finished and its work is saved"
    if entry is None:
        return "attention", "the workflow has no registry entry"
    if (
        f["class"] == "housekeeping"
        and v["task_complete"]
        and work["state"] in ("none", "landed", "pr")
        and not f["recurring"]
    ):
        return "close", "the task finished and only housekeeping failed"
    where = f["node"] or f["exit_reason"]
    return rescue_or_attention(
        "the failure at %s may be rescued" % where,
        "no rescue rung applies to the failure at %s" % where,
    )


def analyze(c, ref, led=None, ignore_tried=False):
    run = find_run(c, ref)
    led = read_ledger() if led is None else led
    evs = events_of(c, run["id"])
    kind = run_kind(run, evs)
    repo = repo_of(c, run)
    entry = registry(repo).get(run["workflow"])
    v = {
        "run": run["id"],
        "workflow": run["workflow"],
        "status": run["status"],
        "kind": kind,
        "repo": repo,
        "working_path": run["path"],
        "message": run["message"],
        "route": "skip",
        "reason": "",
        "work": None,
        "failure": None,
        "task_complete": None,
        "meets_git": True,
        "rungs": [],
        "eligible": [],
        "child": None,
        "child_state": None,
        "rescued_by": None,
        "post_rescue": False,
        "open_handoffs": [],
        "artifacts": artifacts_dir(run["id"]),
        "transcript": transcript_path(run["id"]),
    }
    if kind == "live":
        v["reason"] = decide(v, entry)[1]
        return v
    work = work_state(run["path"])
    v["work"] = work
    failure = failure_of(run, kind, evs)
    if failure:
        failure["class"] = classify(entry, failure)
        failure["signature"] = signature(
            run["workflow"], failure["node"], failure["exit_reason"], failure["error"]
        )
        rec = recurrence(c, failure["signature"], led)
        failure["recurrence"] = [
            {"run": r, "date": at.strftime("%Y-%m-%d %H:%M")} for r, at in rec
        ]
        failure["recurring"] = len(rec) >= 2
        failure["error"] = failure["error"][-20000:]
    v["failure"] = failure
    tried = [] if ignore_tried else rung_history(run["id"], led)
    v["rungs"] = tried
    v["post_rescue"] = any(
        t["ok"] and t["rung"] in ("land", "resume", "relaunch", "adopt") for t in tried
    )
    if any(t["ok"] and t["rung"] == "land" for t in tried) and work["state"] in (
        "landed",
        "pr",
        "none",
    ):
        v["rescued_by"] = "land"
    v["child"], v["child_state"] = child_info(c, run, tried) or (None, None)
    satisfied = finish_status(entry, evs)
    if kind in ("completed", "cancelled-chosen"):
        v["task_complete"] = satisfied is not False
    else:
        v["task_complete"] = satisfied is True
    v["meets_git"] = not (entry and entry.get("git") == "landed") or work["state"] in (
        "none",
        "landed",
        "pr",
    )
    v["open_handoffs"] = (
        open_handoffs(run["id"], evs)
        if kind == "completed" and run["workflow"] == "build"
        else []
    )
    v["eligible"] = eligible_rungs(run, evs, kind, entry, failure, work, tried, repo)
    v["route"], v["reason"] = decide(v, entry)
    return v


def next_rung(v, spend):
    for r in v["eligible"]:
        if r in SPENDING and not spend:
            continue
        return r
    return None


def summary_line(v):
    work = (v.get("work") or {}).get("state", "-")
    return "%s %s %s: work %s; route %s (%s)" % (
        v["run"][:8],
        v["workflow"],
        v["kind"],
        work,
        v["route"],
        v["reason"],
    )


# ---- rungs --------------------------------------------------------------------------------


def commit_wip(path, workflow, rid):
    run8 = rid[:8]
    if git(path, "symbolic-ref", "-q", "HEAD")[0] != 0:
        branch = "wip/%s-%s" % (workflow, run8)
        rc, _, err = sh(["git", "-C", path, "switch", "-c", branch])
        if rc:
            return False, "git switch -c %s failed: %s" % (branch, tail(err))
    if dirty_lines(path):
        rc, _, err = sh(["git", "-C", path, "add", "-A"])
        if rc:
            return False, "git add failed: %s" % tail(err)
        msg = "wip: preserve %s run %s (workflow-cleanup)" % (workflow, run8)
        rc, _, err = sh(["git", "-C", path, "commit", "-q", "-m", msg])
        if rc:
            return False, "git commit refused: %s" % tail(err)
    _, branch = git(path, "branch", "--show-current")
    return True, "saved on branch %s" % branch


def rung_land(v):
    wp, work = v["working_path"], v["work"]
    lock = os.path.join(
        ARCHON_HOME, "state", "%s-git.lock" % os.path.basename(work["repo"])
    )
    os.makedirs(os.path.dirname(lock), exist_ok=True)
    with open(lock, "a") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        with tempfile.TemporaryDirectory() as art:
            env = {**os.environ, "ARTIFACTS_DIR": art}
            rc, _, err = sh([RUN_GATES, "feature"], cwd=wp, env=env, timeout=3600)
        if rc:
            return False, "the feature gates are red"
        rc, out, err = sh([WT_LAND], cwd=wp, timeout=600)
        if rc:
            return False, "worktree-land failed: %s" % tail(err or out)
    if cherry_count(wp, work["base"]) != 0:
        return False, "a patch is still missing from %s after landing" % work["base"]
    return True, "landed on %s" % work["base"]


def wait_for(rid, cwd):
    env = run_env()
    sh([ARCHON, "workflow", "wait", rid], cwd=cwd, env=env, timeout=WAIT_SECONDS)
    return child_state(rid)


def rung_result(state, child, what):
    if state == "waiting":
        return {
            "ok": True,
            "waiting": True,
            "child": child,
            "message": "%s waits at a pause" % what,
        }
    if state in ("completed", "unknown"):
        return {"ok": True, "child": child, "message": "%s %s" % (what, state)}
    return {"ok": False, "child": child, "message": "%s did not finish" % what}


def rung_resume(v):
    rid, wp = v["run"], v["working_path"]
    for argv in ([DEAD_RUNS, "backup", rid], [DEAD_RUNS, "mark-failed", rid]):
        rc, out, err = sh(argv)
        if rc:
            return {
                "ok": False,
                "message": "%s failed: %s" % (argv[1], tail(err or out)),
            }
    cwd = wp if os.path.isdir(wp) else v["repo"]
    env = run_env()
    rc, out, err = sh(
        [ARCHON, "workflow", "resume", rid, "--detach"], cwd=cwd, env=env, timeout=300
    )
    if rc:
        return {"ok": False, "message": "resume failed: %s" % tail(err or out)}
    return rung_result(wait_for(rid, cwd), rid, "the resumed run")


def launch(v, tail_args, what):
    if not v["repo"] or not os.path.isdir(v["repo"]):
        return {"ok": False, "message": "the repository is not on disk"}
    rc, out, err = sh([START_RUN, "run", *tail_args], cwd=v["repo"], timeout=300)
    child = out.strip().splitlines()[-1].strip() if out.strip() else ""
    if rc or not child:
        return {"ok": False, "message": "did not start: %s" % tail(err or out)}
    return rung_result(wait_for(child, v["repo"]), child, what)


def start_args(v, run, extra=()):
    """The arguments that start the run's workflow again: its inputs, then extra, then its message."""
    args = [v["workflow"]]
    for k, val in (run["meta"].get("inputs") or {}).items():
        args += ["--input", "%s=%s" % (k, val)]
    args += extra
    if v["message"]:
        args.append(v["message"])
    return args


def rung_relaunch(v, run):
    return launch(v, start_args(v, run), "the relaunched run")


def rung_adopt(v, run):
    return launch(v, start_args(v, run, ["--adopt", v["run"]]), "the adopting run")


def run_rung(rung, v, run):
    try:
        if rung == "commit-wip":
            ok, msg = commit_wip(v["working_path"], v["workflow"], v["run"])
            return {"ok": ok, "message": msg}
        if rung == "land":
            ok, msg = rung_land(v)
            return {"ok": ok, "message": msg}
        if rung == "resume":
            return rung_resume(v)
        if rung == "relaunch":
            return rung_relaunch(v, run)
        return rung_adopt(v, run)
    except Refused as e:
        return {"ok": False, "message": str(e)}


# ---- subcommands --------------------------------------------------------------------------


def write_verdict(path, v):
    write_text(path, json.dumps(v, indent=2, default=str) + "\n")


def cmd_inspect(a):
    c = connect()
    v = analyze(c, a.run)
    write_verdict(a.out, v)
    word = "dry" if a.dry == "yes" and v["route"] == "attention" else v["route"]
    write_text(a.state, word + "\n")
    print(v["route"])
    print(summary_line(v), file=sys.stderr)
    return 0


def cmd_rescue(a):
    c = connect()
    spend, dry = a.spend == "yes", a.dry == "yes"
    run_id = find_run(c, a.run)["id"]
    if a.retry and not dry:
        ledger_append([ledger_entry(run_id, "rung", "retry")])
    finished = False
    v = None
    for _ in range(3 if a.retry else 1):
        SCAN_CACHE.clear()
        v = analyze(connect(), run_id, ignore_tried=a.retry and dry)
        if v["route"] != "rescue":
            finished = True
            break
        rung = next_rung(v, spend)
        if rung is None:
            v["route"], v["reason"] = (
                "attention",
                "the next rung spends a model and this run may not spend",
            )
            finished = True
            break
        if dry:
            print("would run rung %s for run %s" % (rung, run_id[:8]))
            write_verdict(a.out, v)
            write_text(a.state, "dry\n")
            return 0
        res = run_rung(rung, v, find_run(c, run_id))
        sig = (v["failure"] or {}).get("signature", "")
        detail = "%s %s %s" % (rung, "ok" if res["ok"] else "failed", res["message"])
        ledger_append([ledger_entry(run_id, "rung", detail, sig, res.get("child"))])
        print(detail)
        if res.get("waiting"):
            v["route"] = "waiting"
            v["reason"] = res["message"]
            v["child"], v["child_state"] = res["child"], "waiting"
            write_verdict(a.out, v)
            write_text(a.state, "waiting\n")
            return 0
    if not finished:
        SCAN_CACHE.clear()
        v = analyze(connect(), run_id, ignore_tried=a.retry and dry)
        if a.retry and v["route"] == "rescue":
            v["route"], v["reason"] = "attention", "the retry used its rungs"
    write_verdict(a.out, v)
    word = "continue" if v["route"] == "rescue" else v["route"]
    if dry and word == "attention":
        word = "dry"
    write_text(a.state, word + "\n")
    print(summary_line(v), file=sys.stderr)
    return 0


def live_siblings(c, run):
    out = []
    for r in c.execute(
        "select * from remote_agent_workflow_runs where working_path = ? and id != ?",
        (run["path"], run["id"]),
    ):
        other = run_dict(r)
        if run_kind(other, []) == "live":
            out.append(other)
    return out


def cmd_settle(a):
    c = connect()
    run = find_run(c, a.run)
    wp = run["path"]
    main = linked_worktree(wp)
    if not main:
        print(
            "nothing to remove: %s is not a leftover worktree"
            % (wp or "the run has no path")
        )
        return 0
    kind = run_kind(run, events_of(c, run["id"]))
    if kind == "live":
        raise Refused("run %s is still working or paused" % run["id"][:8])
    sib = live_siblings(c, run)
    if sib:
        raise Refused("run %s is using %s, so it stays" % (sib[0]["id"][:8], wp))
    work = work_state(wp)
    if work["locked"]:
        raise Refused("%s is locked" % wp)
    if a.dry == "yes":
        extra = ""
        if work["state"] == "unsaved":
            extra = " after %s" % ("discarding" if a.discard else "saving its work")
        print("would remove %s%s" % (wp, extra))
        return 0
    if work["state"] == "unsaved" and not a.discard:
        if not a.save_first:
            raise Refused(
                "%s has unsaved work; settle needs --save-first or --discard" % wp
            )
        ok, msg = commit_wip(wp, run["workflow"], run["id"])
        if not ok:
            raise Refused("could not save the work in %s: %s" % (wp, msg))
    _, branch = git(wp, "branch", "--show-current")
    _, tip = git(wp, "rev-parse", "--short", "HEAD")
    argv = [WT_CLEANUP, "remove"]
    if a.discard:
        argv += ["--discard-dirty", "--discard-unlanded"]
    rc, out, err = sh(argv + [wp], cwd=main, timeout=180)
    if os.path.exists(wp):
        raise Refused("%s was not removed: %s" % (wp, tail(err or out)))
    if not branch:
        print("removed %s (detached HEAD at %s)" % (wp, tip))
        return 0
    alive = git(main, "show-ref", "--verify", "-q", "refs/heads/" + branch)[0] == 0
    if alive:
        print("removed %s; branch %s kept at %s" % (wp, branch, tip))
    else:
        print("removed %s; branch %s removed (was %s)" % (wp, branch, tip))
    return 0


def cmd_candidates(a):
    c = connect()
    led = read_ledger()
    runs = [
        run_dict(r)
        for r in c.execute(
            "select * from remote_agent_workflow_runs where workflow_name != 'workflow-cleanup'"
        )
    ]
    kinds = {
        r["id"]: run_kind(
            r, events_of(c, r["id"]) if r["status"] == "cancelled" else []
        )
        for r in runs
    }
    live_paths = {r["path"] for r in runs if kinds[r["id"]] == "live" and r["path"]}
    cleaning = []
    for r in c.execute(
        "select metadata from remote_agent_workflow_runs"
        " where workflow_name = 'workflow-cleanup' and status in ('running', 'paused')"
    ):
        try:
            cleaning.append(
                str(
                    (json.loads(r["metadata"] or "{}").get("inputs") or {}).get(
                        "run", ""
                    )
                )
            )
        except ValueError:
            continue
    out = []
    for run in runs:
        rid, kind = run["id"], kinds[run["id"]]
        mine = [e for e in led if e.get("run") == rid]
        if kind == "live" or any(e.get("action") in TERMINAL for e in mine):
            continue
        if any(x and len(x) >= 6 and rid.startswith(x) for x in cleaning):
            continue
        ended = run["completed"] or run["last"] or run["started"]
        on_disk = bool(linked_worktree(run["path"])) and run["path"] not in live_paths
        # A `queued` entry only says a cleanup run was started. That run may have failed
        # before doing anything, so it does not make a failed run handled; fan-out stops
        # after two of them.
        unhandled_failure = kind in FAILED_KINDS and all(
            e.get("action") == "queued" for e in mine
        )
        # A completed build that approved a hand-off it did not start, for 14 days after it ended.
        open_hand = (
            kind == "completed"
            and run["workflow"] == "build"
            and ended is not None
            and datetime.now(timezone.utc) - ended < timedelta(days=14)
            and bool(open_handoffs(rid, events_of(c, rid)))
        )
        if not (kind == "dead" or on_disk or unhandled_failure or open_hand):
            continue
        repo = repo_of(c, run)
        skip = None
        if not repo or not os.path.isdir(repo):
            skip = "its repository (%s) is not on disk or not registered" % (
                repo or "unknown"
            )
        could_spend = False
        if not skip and kind in FAILED_KINDS:
            try:
                v = analyze(c, rid, led=led)
                could_spend = v["route"] == "rescue" and any(
                    r in SPENDING for r in v["eligible"]
                )
            except Refused:
                pass
        out.append(
            {
                "run": rid,
                "workflow": run["workflow"],
                "kind": kind,
                "status": run["status"],
                "working_path": run["path"],
                "worktree": on_disk,
                "repo": repo,
                "ended": iso(ended),
                "queued": sum(1 for e in mine if e.get("action") == "queued"),
                "could_spend": could_spend,
                "skip": skip,
            }
        )
    out.sort(key=lambda x: x["ended"])
    write_text(a.out, json.dumps(out, indent=2) + "\n")
    if not out:
        print("no runs need a look")
        return 0
    print(
        "%-8s  %-16s  %-17s  %-5s  %-8s  %s"
        % ("RUN", "WORKFLOW", "KIND", "ENDED", "WORKTREE", "NOTE")
    )
    for x in out:
        note = x["skip"] or ("queued %d" % x["queued"] if x["queued"] else "")
        print(
            "%-8s  %-16s  %-17s  %-5s  %-8s  %s"
            % (
                x["run"][:8],
                x["workflow"],
                x["kind"],
                ago(parse_ts(x["ended"])),
                "yes" if x["worktree"] else "no",
                note,
            )
        )
    return 0


def cmd_fan_out(a):
    cands = load_json(a.candidates, [])
    if not isinstance(cands, list):
        raise Refused("%s holds no candidate list" % a.candidates)
    dry = a.dry == "yes"
    c = connect()
    led = read_ledger()
    spend_left = SPEND_CAP
    started = 0
    for cand in cands:
        rid, run8 = cand["run"], cand["run"][:8]
        if cand.get("skip"):
            print("skipped %s: %s" % (run8, cand["skip"]))
            continue
        if cand.get("queued", 0) >= 2:
            print("skipped %s: queued twice with no outcome" % run8)
            continue
        spend = "yes" if cand.get("could_spend") and spend_left > 0 else "no"
        if spend == "yes":
            spend_left -= 1
        if dry:
            try:
                v = analyze(c, rid, led=led)
                what = "route %s, %s" % (v["route"], v["reason"])
            except Refused as e:
                what = "cannot be inspected: %s" % e
            print(
                "would start a cleanup run for %s (%s, %s): %s, spend=%s"
                % (run8, cand["workflow"], cand["kind"], what, spend)
            )
            continue
        rc, out, err = sh(
            [
                START_RUN,
                "run",
                "workflow-cleanup",
                "--input",
                "run=" + rid,
                "--input",
                "dry=no",
                "--input",
                "spend=" + spend,
            ],
            cwd=cand["repo"],
            timeout=300,
        )
        child = out.strip().splitlines()[-1].strip() if out.strip() else ""
        if rc or not child:
            print("did not start a cleanup run for %s: %s" % (run8, tail(err or out)))
            continue
        ledger_append([ledger_entry(rid, "queued", "spend=" + spend, "", child)])
        started += 1
        print("started a cleanup run for %s: run %s (spend=%s)" % (run8, child, spend))
    if not dry:
        print("%d of %d candidates started" % (started, len(cands)))
    return 0


# ---- facts for the diagnosis --------------------------------------------------------------


def is_iteration(step):
    return bool(re.search(r"-iteration-\d+$", step or ""))


def duration_ms(rec):
    d = ((rec.get("execution") or {}).get("timing") or {}).get("durationMs")
    if d is None:
        d = rec.get("duration_ms")
    return d if isinstance(d, (int, float)) else 0


def span_text(ms):
    if ms < 10000:
        return "%.1f s" % (ms / 1000.0)
    s = int(round(ms / 1000.0))
    if s < 7200:
        return "%d s" % s
    return "%d h %02d min" % (s // 3600, s % 3600 // 60)


def stamp(ts):
    d = parse_ts(ts)
    return d.strftime("%m-%d %H:%M:%S") if d else "?"


def one_line(text, n=None):
    t = " ".join(str(text or "").split())
    return t[:n] if n else t


def error_cause(text, n=160):
    """The part of an Archon error that names the cause, without the DAG and node boilerplate."""
    t = str(text or "")
    m = re.search(r"\bfailed \[exit \d+\]:\s*", t) or re.search(
        r"completed with failures:\s*", t
    )
    return one_line(t[m.end() :] if m else t, n)


def skip_cause(cause):
    if isinstance(cause, dict):
        kind, origin = str(cause.get("kind") or ""), cause.get("origin")
        if kind in ("upstream_failed", "upstream_skipped"):
            return "%s at %s" % (kind.replace("_", " "), origin)
        if kind == "condition":
            return "its condition was false"
        return kind.replace("_", " ")
    return str(cause or "").replace("_", " ")


def real_start(run):
    """When the run first started. A resume rewrites started_at, so the transcript's first record
    is the better source."""
    path = transcript_path(run["id"])
    if path:
        try:
            with open(path, errors="replace") as f:
                first = json.loads(f.readline())
            if first.get("type") == "workflow_start" and parse_ts(first.get("ts")):
                return parse_ts(first["ts"])
        except (OSError, ValueError, AttributeError):
            pass
    return run["started"]


def read_transcript(rid):
    path = transcript_path(rid)
    if not path:
        return None
    rows = []
    with open(path, errors="replace") as f:
        for line in f:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if isinstance(r, dict):
                rows.append(r)
    return rows


def build_timeline(rows):
    """One entry per node, in the order each first ran, with the pauses the owner answered between
    them. A loop's iterations of a node collapse into one entry with a count."""
    items, by, waiting = [], {}, ""
    for r in rows:
        kind, step = r.get("type") or "", r.get("step") or ""
        if kind == "workflow_resume":
            items.append({"resumed": r.get("ts") or "", "after": waiting})
            continue
        if (
            not step
            or is_iteration(step)
            or not (kind.startswith("node_") or kind == "exec_output")
        ):
            continue
        name = bare(step)
        x = by.get(name)
        if x is None:
            x = by[name] = {
                "node": name,
                "state": "",
                "count": 0,
                "ms": 0,
                "at": r.get("ts") or "",
                "cause": "",
                "exit": None,
                "stdout": "",
                "stderr": "",
                "error": "",
                "loop": False,
            }
            items.append(x)
        if kind == "node_start":
            inv = (r.get("execution") or {}).get("invocation") or {}
            x["loop"] = x["loop"] or bool(inv.get("loopPath"))
            if x["state"] not in ("running", "waiting"):
                x["count"] += 1
            x["state"] = "running"
        elif kind == "node_complete":
            x["state"] = "completed"
            x["ms"] += duration_ms(r)
        elif kind == "node_error":
            x["state"] = "failed"
            x["ms"] += duration_ms(r)
            x["error"] = str(r.get("error") or "")
        elif kind == "node_suspended":
            x["state"] = "waiting"
            waiting = name
        elif kind == "node_skipped":
            if not x["count"] and not x["state"]:
                cause = r.get("cause") or r.get("content") or ""
                prior = cause == "prior_success"
                x["state"] = "done earlier" if prior else "skipped"
                x["cause"] = "" if prior else skip_cause(cause)
        elif kind == "exec_output":
            x["exit"] = r.get("exit_code")
            x["stdout"] = str(r.get("stdout_tail") or "")
            x["stderr"] = str(r.get("stderr_tail") or "")
    for x in items:
        if "node" in x and x["state"] in ("running", ""):
            x["state"] = "failed" if x["exit"] not in (None, 0) else "unfinished"
    return items


def group_skipped(items):
    """The nodes that never ran, one entry for each cause, placed where the first of them is."""
    out, groups = [], {}
    for x in items:
        if x.get("state") != "skipped":
            out.append(x)
            continue
        g = groups.get(x["cause"])
        if g is None:
            g = groups[x["cause"]] = {
                "skipped": [],
                "cause": x["cause"],
                "at": x["at"],
                "state": "skipped",
            }
            out.append(g)
        g["skipped"].append(x["node"])
    return out


def cap_timeline(items):
    """At most TIMELINE_ROWS entries: nodes that never ran go first, then the oldest entries."""
    omitted = 0
    items = list(items)
    for drop in ("skipped", "done earlier"):
        while len(items) > TIMELINE_ROWS:
            k = next((i for i, x in enumerate(items) if x.get("state") == drop), None)
            if k is None:
                break
            del items[k]
            omitted += 1
    if len(items) > TIMELINE_ROWS:
        omitted += len(items) - TIMELINE_ROWS
        items = items[-TIMELINE_ROWS:]
    return items, omitted


def node_rows(items):
    return [x for x in items or [] if "node" in x]


def failing_row(items, node):
    rows = node_rows(items)
    want = bare(node)
    for x in rows:
        if x["node"] == want and x["state"] in ("failed", "unfinished"):
            return x
    failed = [
        x
        for x in rows
        if x["state"] == "failed" and (x["stdout"] or x["stderr"] or x["error"])
    ]
    if failed:
        return failed[-1]
    unfinished = [x for x in rows if x["state"] == "unfinished"]
    return unfinished[-1] if unfinished else None


def last_completed(items):
    done = [x for x in node_rows(items) if x["state"] == "completed"]
    return done[-1] if done else None


def unclip(text):
    """(text without Archon's clipping marker, whether Archon had clipped it)."""
    if text.startswith("…[truncated"):
        _, _, rest = text.partition("\n")
        return rest, True
    return text, False


def head_tail(text, head=12, last=25):
    lines = [ln[:400] for ln in text.strip("\n").splitlines()]
    if len(lines) <= head + last:
        return "\n".join(lines)
    gap = len(lines) - head - last
    return "\n".join(lines[:head] + ["[%d lines omitted]" % gap] + lines[-last:])


def pick_outputs(items, failing, effect_nodes):
    """The output of the failing node, of the last node that finished and of each node that changes
    something outside git. Other nodes' output stays out of the facts."""
    picks, seen = [], set()
    wanted = [
        ("failing node", failing),
        ("last node that finished", last_completed(items)),
    ]
    rows = {x["node"]: x for x in node_rows(items)}
    wanted += [("node with an outside effect", rows.get(n)) for n in effect_nodes]
    for role, x in wanted:
        if x is None or x["node"] in seen:
            continue
        seen.add(x["node"])
        out, c1 = unclip(x["stdout"])
        err, c2 = unclip(x["stderr"])
        if x["exit"] is None and not (out or err or x["error"]):
            continue
        picks.append(
            {
                "node": x["node"],
                "role": role,
                "state": x["state"],
                "exit": x["exit"],
                "stdout": head_tail(out),
                "stderr": head_tail(err),
                "error": error_cause(x["error"], 600) if not (out or err) else "",
                "clipped": c1 or c2,
            }
        )
    return picks


def first_heading(path):
    try:
        with open(path, errors="replace") as f:
            for line in f:
                if line.startswith("# "):
                    return line[2:].strip()[:200]
    except OSError:
        pass
    return ""


def lineage(run, led, v):
    out = []
    if run["adopted_from"]:
        out.append("It adopted the failed run %s." % run["adopted_from"][:8])
    for e in led:
        if e.get("child") != run["id"]:
            continue
        who = str(e.get("run") or "")[:8]
        if e.get("action") == "rung":
            rung = (e.get("detail") or "").split(" ", 1)[0]
            out.append(
                "The `%s` rung of the cleanup of run %s started it." % (rung, who)
            )
        elif e.get("action") == "handed-off":
            out.append(
                "The cleanup of run %s handed off to it as `%s`."
                % (who, e.get("detail") or "")
            )
    if v.get("child") and v["child"] != run["id"]:
        out.append(
            "Run %s, started from this one, is %s."
            % (v["child"][:8], v.get("child_state"))
        )
    return out


def task_of(run, rows, art, led, v):
    content = ""
    for r in rows or []:
        if r.get("type") == "workflow_start":
            content = str(r.get("content") or "")
            break
    content = content or run["message"]
    heading = ""
    paths = [os.path.join(art, n) for n in ("plan.md", "brief.md")] if art else []
    if art:
        paths += sorted(glob.glob(os.path.join(art, "brief", "*", "brief.md")))
    for path in paths:
        if not heading:
            heading = first_heading(path)
    inputs = run["meta"].get("inputs") or {}
    return {
        "message": cap_bytes(content.strip(), 1500),
        "inputs": {str(k): str(val)[:200] for k, val in inputs.items()},
        "heading": heading,
        "origin": lineage(run, led, v),
    }


def effects_of(entry, items):
    out = []
    rows = {x["node"]: x for x in node_rows(items)}
    for node, what in ((entry or {}).get("effects") or {}).items():
        x = rows.get(node)
        state = {
            "completed": "completed",
            "done earlier": "completed",
            "failed": "failed",
            "unfinished": "started and did not finish",
            "waiting": "is waiting",
        }.get(x["state"] if x else "", "never ran")
        out.append({"node": node, "what": what, "state": state})
    return out


def captured_source(run):
    root = (run["meta"].get("workflow_source") or {}).get("root")
    if not root or not os.path.isdir(root):
        return None
    found = glob.glob(
        os.path.join(root, "**", run["workflow"] + ".yaml"), recursive=True
    )
    return found[0] if found else None


def node_definition(run, node):
    """The failing node's text in the workflow definition the run captured when it started."""
    src = captured_source(run)
    if not src or not node:
        return ""
    with open(src, errors="replace") as f:
        lines = f.read().splitlines()
    pat = re.compile(
        r"^(\s*)-\s+id:\s*['\"]?%s['\"]?\s*(#.*)?$" % re.escape(bare(node))
    )
    for i, line in enumerate(lines):
        m = pat.match(line)
        if m:
            break
    else:
        return ""
    indent = len(m.group(1))
    out = [line]
    for nxt in lines[i + 1 :]:
        if nxt.strip() and len(nxt) - len(nxt.lstrip()) <= indent:
            break
        out.append(nxt)
    return cap_lines("\n".join(out).rstrip(), 40)


def log_since(repo, since, paths):
    if not paths or not repo or not os.path.exists(os.path.join(repo, ".git")):
        return []
    rc, out, _ = sh(
        [
            "git",
            "-C",
            repo,
            "--literal-pathspecs",
            "log",
            "--since=" + since,
            "--format=%h %s",
            "--",
            *paths,
        ]
    )
    return cap_lines(out.strip(), 15).splitlines() if rc == 0 and out.strip() else []


def tracked(repo, rel):
    if not repo or not os.path.exists(os.path.join(repo, ".git")):
        return False
    rc, out, _ = sh(["git", "-C", repo, "--literal-pathspecs", "ls-files", "--", rel])
    return rc == 0 and bool(out.strip())


def kit_source():
    """The kit's clone, as install.sh recorded it, or None when no clone is recorded or it is gone."""
    info = load_json(KIT_INSTALLED, {})
    src = info.get("source") if isinstance(info, dict) else None
    if isinstance(src, str) and os.path.exists(os.path.join(src, ".git")):
        return src
    return None


def changes_since(run, node_text, repo):
    """Commits made since the run started to the files its failing node names, in the kit's clone
    (None when no clone is recorded) and in the run's repository."""
    since = iso(real_start(run))
    refs = SOURCE_REF.findall(node_text or "")
    kit = kit_source()
    kit_paths = []
    if kit:
        kit_paths = ["workflows/%s" % run["workflow"]]
        for ref in refs:
            rel = "scripts/%s" % os.path.basename(ref)
            if rel not in kit_paths and tracked(kit, rel):
                kit_paths.append(rel)
    mine = []
    if repo:
        mine = [r for r in dict.fromkeys(refs) if tracked(repo, r)]
        mine += [
            os.path.relpath(p, repo)
            for p in glob.glob(
                os.path.join(
                    repo, ".archon", "workflows", "**", run["workflow"] + ".yaml"
                ),
                recursive=True,
            )
        ]
    return {
        "since": since,
        "kit": log_since(kit, since, kit_paths) if kit else None,
        "kit_paths": kit_paths,
        "repo": log_since(repo, since, mine),
        "repo_paths": mine,
        "definition_changed": definition_changed(run, repo),
    }


def concurrent_runs(c, run):
    """Other runs of the workflow that started within a minute of this one or overlapped it."""
    start = real_start(run)
    if not start:
        return []
    live = ("running", "paused")
    end = now() if run["status"] in live else (run["completed"] or run["last"] or start)
    found = []
    for r in c.execute(
        "select * from remote_agent_workflow_runs where workflow_name = ? and id != ?",
        (run["workflow"], run["id"]),
    ):
        o = run_dict(r)
        o["started"] = real_start(o)
        if not o["started"]:
            continue
        o_end = (
            now()
            if o["status"] in live
            else (o["completed"] or o["last"] or o["started"])
        )
        gap = (o["started"] - start).total_seconds()
        if abs(gap) <= CONCURRENT_SECONDS or (o["started"] <= end and o_end >= start):
            found.append((abs(gap), gap, o))
    found.sort(key=lambda x: x[0])
    return [
        {
            "run": o["id"][:8],
            "started": iso(o["started"]),
            "gap_s": int(gap),
            "status": o["status"],
        }
        for _, gap, o in found[:CONCURRENT_ROWS]
    ]


def work_detail(v):
    w = v.get("work") or {}
    d = {
        "state": w.get("state", "none"),
        "phrase": work_phrase(w) if w else "unknown",
        "path": w.get("path") or v.get("working_path") or "",
        "branch": w.get("branch") or "",
        "base": w.get("base") or "",
        "log": [],
        "stat": [],
        "dirty": list(w.get("dirty_files") or [])[:20],
        "dirty_total": len(w.get("dirty_files") or []),
    }
    path = d["path"]
    if (
        d["state"] in ("branch", "pushed", "unsaved")
        and d["base"]
        and os.path.isdir(path)
    ):
        _, out = git(path, "log", "--oneline", "%s..HEAD" % d["base"])
        d["log"] = cap_lines(out, 15).splitlines() if out else []
        _, out = git(path, "diff", "--stat", "%s...HEAD" % d["base"])
        d["stat"] = cap_lines(out, 20).splitlines() if out else []
    return d


def run_outcome(rid, led):
    mine = [e for e in led if e.get("run") == rid]
    answers = [e for e in mine if e.get("action") == "answered"]
    if not answers:
        for action, word in (
            ("closed", "closed"),
            ("rescued", "rescued"),
            ("attention", "paused, not answered"),
        ):
            if any(e.get("action") == action for e in mine):
                return word
        return "not answered"
    text = "answered %s" % answers[-1].get("detail", "")
    handed = [e for e in mine if e.get("action") == "handed-off" and e.get("child")]
    if handed:
        child = handed[-1]["child"]
        text += " -> run %s %s" % (child[:8], child_state(child))
    return text


def history(c, sig, led, run):
    """Earlier failures with the run's signature, newest first, and what the owner did about each."""
    horizon = now() - RECURRENCE_WINDOW
    found = []
    for r in c.execute(
        "select e.workflow_run_id as rid, e.data as data, e.created_at as at,"
        " r.workflow_name as wf from remote_agent_workflow_events e"
        " join remote_agent_workflow_runs r on r.id = e.workflow_run_id"
        " where e.event_type = 'workflow_failed'"
    ):
        at = parse_ts(r["at"])
        if r["rid"] == run["id"] or not at or at < horizon:
            continue
        try:
            d = json.loads(r["data"] or "{}")
        except ValueError:
            continue
        tr = d.get("terminal_record") or {}
        err = str(d.get("error") or "")
        s = signature(r["wf"], tr.get("first_failed_node"), d.get("exit_reason"), err)
        if s == sig:
            found.append((at, r["rid"], err))
    found.sort(key=lambda x: x[0], reverse=True)
    rows = [
        {
            "run": rid[:8],
            "date": at.strftime("%Y-%m-%d %H:%M"),
            "cause": error_cause(err, 160),
            "outcome": run_outcome(rid, led),
        }
        for at, rid, err in found[:10]
    ]
    return {"rows": rows, "more": max(0, len(found) - 10)}


def artifact_digest(art):
    """Every artifact file with its size, and the opening lines of the ones that explain a run."""
    out = {"files": [], "more": 0, "heads": []}
    if not art or not os.path.isdir(art):
        return out
    files = []
    for root, dirs, names in os.walk(art):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for n in sorted(names):
            if n.startswith("."):
                continue
            p = os.path.join(root, n)
            try:
                files.append((os.path.relpath(p, art), os.path.getsize(p)))
            except OSError:
                continue
    out["files"] = [{"path": p, "size": s} for p, s in files[:100]]
    out["more"] = max(0, len(files) - 100)
    ranked = []
    for rel, size in files:
        base = os.path.basename(rel)
        for rank, pat in enumerate(HEAD_FILES):
            if fnmatch.fnmatch(base, pat) and not (pat == "*.log" and size >= 20 << 10):
                ranked.append((rank, rel, size))
                break
    budget = ARTIFACT_HEAD_CAP
    for _, rel, size in sorted(ranked):
        # cap_bytes adds a marker of about 30 bytes to what it cuts
        limit = min(budget, 6 << 10) - 40
        if limit < 200:
            break
        try:
            with open(os.path.join(art, rel), errors="replace") as f:
                text = "".join(f.readline() for _ in range(30)).rstrip("\n")
        except OSError:
            continue
        text = cap_bytes(text, limit)
        budget -= len(text.encode("utf-8", errors="replace"))
        out["heads"].append({"path": rel, "size": size, "text": text})
    return out


def fence(lines, lang="text"):
    body = [ln.replace("```", "'''") for ln in lines] or ["(none)"]
    return ["```" + lang, *body, "```"]


def render_facts(f, level=2, full=True):
    """The facts as Markdown lines, under headings `level` deep. `full` adds the parts only the
    diagnosing agent needs: the failing node's definition, the commits since the run started and
    the heads of the artifact files."""
    out = []

    def head(title):
        out.extend(["", "#" * level + " " + title, ""])

    h = f.get("header") or {}
    fail = f.get("failure")
    head("Run")
    out.append(
        "- Workflow `%s`, run `%s`, status `%s`, counted as `%s`."
        % (h.get("workflow"), h.get("run"), h.get("status"), h.get("kind"))
    )
    out.append(
        "- Started %s; last activity %s."
        % (h.get("started") or "?", h.get("ended") or "?")
    )
    out.append("- Route: %s (%s)." % (h.get("route"), h.get("reason")))
    if fail:
        out.append(
            "- Failed at `%s`, exit reason `%s`, failure class `%s`%s."
            % (
                fail.get("node") or "no node",
                fail.get("exit_reason"),
                fail.get("class"),
                "; the failure is recurring" if fail.get("recurring") else "",
            )
        )
        shown = any(o["role"] == "failing node" for o in f.get("outputs") or [])
        if fail.get("cause") and not shown:
            out.append("- Archon recorded: %s" % fail["cause"])

    task = f.get("task")
    if task:
        head("Task")
        if task["message"]:
            out.append("- Message:")
            out += fence(task["message"].splitlines(), "text")
        else:
            out.append("- Message: (empty)")
        out.append(
            "- Inputs: %s"
            % (", ".join("`%s=%s`" % kv for kv in task["inputs"].items()) or "none")
        )
        if task["heading"]:
            out.append("- Title of its plan or brief: %s" % task["heading"])
        for line in task["origin"]:
            out.append("- %s" % line)

    tl = f.get("timeline")
    if tl is not None:
        head("Timeline")
        out.append("Times are UTC.")
        out.append("")
        if tl["omitted"]:
            out.append("- [%d earlier rows left out]" % tl["omitted"])
        for x in tl["items"]:
            if "resumed" in x:
                out.append(
                    "- %s resumed%s"
                    % (
                        stamp(x["resumed"]),
                        " after the pause at `%s`" % x["after"] if x["after"] else "",
                    )
                )
                continue
            if "skipped" in x:
                names = ", ".join("`%s`" % n for n in x["skipped"][:8])
                more = len(x["skipped"]) - 8
                out.append(
                    "- %s %s skipped, %s: %s%s"
                    % (
                        stamp(x["at"]),
                        plural(len(x["skipped"]), "node"),
                        x["cause"] or "no reason recorded",
                        names,
                        ", and %d more" % more if more > 0 else "",
                    )
                )
                continue
            n = " ×%d" % x["count"] if x["count"] > 1 else ""
            extra = []
            if x["exit"] not in (None, 0):
                extra.append("exit %s" % x["exit"])
            if x["ms"]:
                extra.append(span_text(x["ms"]))
            out.append(
                "- %s `%s` %s%s%s"
                % (
                    stamp(x["at"]),
                    x["node"],
                    x["state"],
                    n,
                    ", " + ", ".join(extra) if extra else "",
                )
            )

    if f.get("effects"):
        head("Outside effects")
        for e in f["effects"]:
            out.append("- %s: node `%s` %s." % (e["what"], e["node"], e["state"]))

    w = f.get("work")
    if w:
        head("Work")
        out.append("- The work is %s." % w["phrase"])
        if w["path"]:
            out.append("- Worktree: `%s`" % w["path"])
        if w["log"]:
            out.append("- Commits not in `%s`:" % w["base"])
            out += fence(w["log"])
        if w["stat"]:
            out.append("- Changes against `%s`:" % w["base"])
            out += fence(w["stat"])
        if w["dirty"]:
            out.append(
                "- %d uncommitted file%s%s:"
                % (
                    w["dirty_total"],
                    "" if w["dirty_total"] == 1 else "s",
                    ", first %d" % len(w["dirty"])
                    if w["dirty_total"] > len(w["dirty"])
                    else "",
                )
            )
            out += fence(w["dirty"])

    if f.get("concurrent"):
        head("Runs of the same workflow around the same time")
        for r in f["concurrent"]:
            gap = r["gap_s"]
            when = (
                "the same second"
                if gap == 0
                else "%d s %s" % (abs(gap), "later" if gap > 0 else "earlier")
            )
            out.append(
                "- `%s` started at %s UTC (%s), status `%s`."
                % (r["run"], stamp(r["started"]), when, r["status"])
            )

    hist = f.get("history")
    if hist and (hist["rows"] or hist["more"]):
        head("Earlier runs that failed the same way")
        for r in hist["rows"]:
            out.append(
                "- `%s` on %s: %s. Outcome: %s."
                % (r["run"], r["date"], r["cause"] or "no cause recorded", r["outcome"])
            )
        if hist["more"]:
            out.append("- [%d more]" % hist["more"])
    elif hist is not None:
        head("Earlier runs that failed the same way")
        out.append("No other run has failed this way in the last 30 days.")

    if f.get("rungs"):
        head("Rescue rungs tried")
        for t in f["rungs"]:
            out.append(
                "- `%s` %s: %s"
                % (t["rung"], "worked" if t["ok"] else "failed", t["message"])
            )

    for o in f.get("outputs") or []:
        head("Output of `%s`, the %s" % (o["node"], o["role"]))
        out.append(
            "State `%s`, exit %s.%s"
            % (
                o["state"],
                o["exit"] if o["exit"] is not None else "not recorded",
                " Archon kept only the last 2,000 characters of its output."
                if o["clipped"]
                else "",
            )
        )
        if o["stdout"]:
            out += ["", "Standard output:", ""] + fence(o["stdout"].splitlines())
        if o["stderr"]:
            out += ["", "Standard error:", ""] + fence(o["stderr"].splitlines())
        if o["error"]:
            out += ["", "Error recorded by Archon: %s" % o["error"]]

    if full and f.get("definition"):
        head("Definition of the failing node")
        out += fence(f["definition"].splitlines(), "yaml")

    ch = f.get("changes")
    if full and ch:
        head("Changes since the run started")
        out.append(
            "- The workflow definition %s the copy captured when the run started."
            % ("differs from" if ch["definition_changed"] else "matches")
        )
        if ch.get("kit") is not None:
            out.append("- Commits in the Archon kit repository (since %s):" % ch["since"])
            out += fence(ch["kit"] or ["none"])
        out.append("- Commits in the run's repository:")
        out += fence(ch["repo"] or ["none"])

    art = f.get("artifacts")
    if art is not None:
        head("Artifact files")
        for x in art["files"][:60]:
            out.append("- `%s` (%d bytes)" % (x["path"], x["size"]))
        extra = max(0, len(art["files"]) - 60) + art["more"]
        if extra:
            out.append("- [%d more files]" % extra)
        if not art["files"]:
            out.append("None.")
        if full:
            for x in art["heads"]:
                out += ["", "`%s`, first 30 lines:" % x["path"], ""] + fence(
                    x["text"].splitlines()
                )

    if f.get("errors"):
        head("Gaps in these facts")
        for k, val in f["errors"].items():
            out.append("- %s: %s" % (k, val))
    return out


def facts_markdown(f):
    return (
        "\n".join(
            ["# Facts about one finished workflow run", *render_facts(f, 2, True)]
        )
        + "\n"
    )


def facts_run(a):
    v = load_json(a.verdict)
    if not isinstance(v, dict) or not v.get("run"):
        raise Refused("%s holds no verdict" % a.verdict)
    c = connect()
    run = find_run(c, v["run"])
    led = read_ledger()
    repo = v.get("repo") or repo_of(c, run)
    entry = registry(repo).get(run["workflow"])
    errors = {}

    def attempt(name, fn):
        try:
            return fn()
        except Exception as e:  # one section failing must not cost the others
            errors[name] = "%s: %s" % (type(e).__name__, tail(str(e), 160))
            return None

    rows = attempt("transcript", lambda: read_transcript(run["id"]))
    if rows is None and "transcript" not in errors:
        errors["transcript"] = "no transcript was found for this run"
    items = (
        attempt("timeline", lambda: build_timeline(rows)) if rows is not None else None
    )
    fail = v.get("failure")
    failing = (
        attempt("outputs", lambda: failing_row(items, (fail or {}).get("node")))
        if items
        else None
    )
    effects = (
        attempt("effects", lambda: effects_of(entry, items))
        if items is not None
        else None
    )
    if items is None and (entry or {}).get("effects"):
        effects = [
            {
                "node": n,
                "what": w,
                "state": "unknown, because the run has no transcript",
            }
            for n, w in entry["effects"].items()
        ]
    outputs = (
        attempt(
            "outputs",
            lambda: pick_outputs(
                items, failing, list((entry or {}).get("effects") or {})
            ),
        )
        if items
        else None
    )
    def_node = (fail or {}).get("node") or (failing or {}).get("node")
    definition = attempt("definition", lambda: node_definition(run, def_node)) or ""
    capped, omitted = (
        cap_timeline(group_skipped(items)) if items is not None else (None, 0)
    )
    art = v.get("artifacts") or artifacts_dir(run["id"])
    facts = {
        "header": {
            "run": run["id"],
            "workflow": run["workflow"],
            "status": run["status"],
            "kind": v.get("kind"),
            "started": iso(real_start(run)),
            "ended": iso(run["completed"] or run["last"]),
            "route": v.get("route"),
            "reason": v.get("reason"),
            "repo": repo,
        },
        "failure": {
            "node": fail.get("node"),
            "exit_reason": fail.get("exit_reason"),
            "class": fail.get("class"),
            "recurring": bool(fail.get("recurring")),
            "cause": error_cause(fail.get("error"), 600),
        }
        if fail
        else None,
        "task": attempt("task", lambda: task_of(run, rows, art, led, v)),
        "timeline": {"items": capped, "omitted": omitted}
        if capped is not None
        else None,
        "effects": effects or None,
        "work": attempt("work", lambda: work_detail(v)),
        "concurrent": attempt("concurrent", lambda: concurrent_runs(c, run)),
        "history": attempt(
            "history", lambda: history(c, (fail or {}).get("signature", ""), led, run)
        )
        if fail
        else None,
        "rungs": v.get("rungs") or [],
        "outputs": outputs,
        "definition": definition,
        "changes": attempt("changes", lambda: changes_since(run, definition, repo)),
        "artifacts": attempt("artifacts", lambda: artifact_digest(art)),
        "paths": {"artifacts": art, "transcript": v.get("transcript")},
    }
    facts = {k: val for k, val in facts.items() if val is not None}
    if errors:
        facts["errors"] = errors
    text = cap_bytes(facts_markdown(facts), FACTS_CAP)
    os.makedirs(a.out, exist_ok=True)
    write_text(
        os.path.join(a.out, "facts.json"),
        json.dumps(facts, indent=2, default=str) + "\n",
    )
    write_text(os.path.join(a.out, "facts.md"), text)
    return run["id"], text


def diagnosis_cache_path(rid):
    return os.path.join(DIAGNOSES, rid + ".json")


def cmd_facts(a):
    """Never fails: it prints fresh, cached or none, and a missing diagnosis only costs a report
    its verdict. cached means diagnosis.json already holds the diagnosis of these exact facts."""
    out_diag = os.path.join(a.out, "diagnosis.json")
    try:
        rid, text = facts_run(a)
        sha = hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()
        hit = load_json(diagnosis_cache_path(rid))
        if (
            isinstance(hit, dict)
            and hit.get("facts_sha") == sha
            and isinstance(hit.get("diagnosis"), dict)
        ):
            write_text(out_diag, json.dumps(hit["diagnosis"], indent=2) + "\n")
            print("cached")
            return 0
        if os.path.exists(out_diag):
            os.remove(out_diag)
        print("fresh")
        return 0
    except Exception as e:  # the pause must still happen without a diagnosis
        print(
            "workflow-cleanup: facts: %s: %s" % (type(e).__name__, tail(str(e), 200)),
            file=sys.stderr,
        )
        print("none")
        return 0


def cmd_diagnosis(a):
    """Keeps the agent's diagnosis when it parses and names an answer, caches it against the facts
    it read, and prints ok, cached or none. It never fails."""
    out = os.path.join(a.dir, "diagnosis.json")
    try:
        if a.facts_word == "cached":
            print("cached")
            return 0
        try:
            with open(a.raw) as f:
                d = json.loads(f.read())
            if isinstance(d, str):
                d = json.loads(d)
        except (OSError, ValueError):
            d = None
        if not (isinstance(d, dict) and str(d.get("recommend") or "").strip()):
            if os.path.exists(out):
                os.remove(out)
            print("none")
            return 0
        write_text(out, json.dumps(d, indent=2) + "\n")
        with open(os.path.join(a.dir, "facts.md"), "rb") as f:
            sha = hashlib.sha256(f.read()).hexdigest()
        rid = find_run(connect(), a.run)["id"]
        os.makedirs(DIAGNOSES, exist_ok=True)
        tmp = diagnosis_cache_path(rid) + ".tmp"
        write_text(tmp, json.dumps({"facts_sha": sha, "diagnosis": d}) + "\n")
        os.replace(tmp, diagnosis_cache_path(rid))
        print("ok")
        return 0
    except Exception as e:
        print(
            "workflow-cleanup: diagnosis: %s: %s"
            % (type(e).__name__, tail(str(e), 200)),
            file=sys.stderr,
        )
        print("none")
        return 0


# ---- the diagnosis and the report ---------------------------------------------------------


def follow_up_of(d):
    """The diagnosis's `follow_up` as {workflow, repo, inputs, note}, or None when it names no workflow."""
    fu = d.get("follow_up") if isinstance(d, dict) else None
    if not isinstance(fu, dict):
        return None
    wf = one_line(fu.get("workflow"))
    if not wf:
        return None
    inputs = []
    for i in fu.get("inputs") or []:
        if isinstance(i, dict) and one_line(i.get("name")):
            inputs.append(
                {"name": one_line(i.get("name")), "value": one_line(i.get("value"))}
            )
    return {
        "workflow": wf,
        "repo": one_line(fu.get("repo")),
        "inputs": inputs,
        "note": str(fu.get("note") or "").strip(),
    }


def checked_follow_up(fu, repo):
    """(entry, reason): the follow-up as `start-run.sh check --also build` keeps it, or None and the
    reason it drops it. The check runs in the run's repository, where the candidates were listed."""
    if not fu:
        return None, "it names no workflow"
    if not repo or not os.path.isdir(repo):
        return None, "the run's repository is not on disk"
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump([fu], f)
        name = f.name
    try:
        rc, out, err = sh(
            [START_RUN, "check", "--also", "build", name], cwd=repo, timeout=120
        )
    finally:
        os.unlink(name)
    try:
        kept = json.loads(out)
    except ValueError:
        kept = []
    if rc == 0 and isinstance(kept, list) and kept:
        return kept[0], ""
    return None, tail(err or "it is not one of the candidates", 160)


def guard_diagnosis(d, facts=None, repo=None):
    """The agent's diagnosis with its answer held to what the defect allows, or None when it names
    no answer. The agent may suggest an answer, and these rules decide the one the report
    recommends: an answer that does not fit the defect's location, a low-confidence diagnosis, a
    follow-up that `start-run.sh check` drops in the run's repository and an answer outside the
    menu (discard included) all become a research run with a question. A fix that the diagnosis
    names and the facts contain also allows accept and retry, and no rescue being needed for work
    that is minor or worthless allows accept."""
    if not isinstance(d, dict):
        return None
    old_answer = str(d.get("recommend") or "").strip()
    if (
        "fix" in d
        and not d.get("follow_up")
        and old_answer not in RECOMMENDS + ("discard", "")
    ):
        # A diagnosis cached by a pause that offered one answer for each workflow, with its `fix`.
        d = {
            **d,
            "recommend": "follow-up",
            "follow_up": {
                "workflow": old_answer,
                "repo": "",
                "inputs": [],
                "note": str(d.get("fix") or ""),
            },
        }

    def one(key):
        return one_line(d.get(key))

    out = {
        k: one(k)
        for k in (
            "summary",
            "happened",
            "expected",
            "expected_why",
            "fixed_by",
            "defect",
            "defect_where",
            "rescue",
            "work_value",
            "work_why",
            "recommend",
            "recommend_why",
            "question",
            "confidence",
        )
    }
    out["follow_up"] = follow_up_of(d)
    out["rescue_how"] = str(d.get("rescue_how") or "").strip()
    out["evidence"] = [
        {
            "claim": one_line(e.get("claim")),
            "source": one_line(e.get("source")),
            "confirmed": e.get("confirmed") is True,
        }
        for e in (d.get("evidence") or [])
        if isinstance(e, dict) and one_line(e.get("claim"))
    ]
    if not out["recommend"]:
        return None
    if out["defect"] not in DEFECTS:
        out["defect"] = "unknown"
    if out["confidence"] not in ("high", "medium", "low"):
        out["confidence"] = "low"
    if out["fixed_by"]:
        # Only a commit id that the facts contain counts as a fix.
        tokens = re.findall(r"\b[0-9a-f]{7,40}\b", out["fixed_by"])
        hay = json.dumps(facts) if facts is not None else ""
        if not any(t in hay for t in tokens):
            out["fixed_by"] = ""
    asked, why = out["recommend"], None
    # Closing the run out loses nothing when no rescue is needed and the work is minor or worthless,
    # whatever the defect's location.
    nothing_lost = out["rescue"] == "none-needed" and out["work_value"] in (
        "minor",
        "none",
    )
    if asked not in RECOMMENDS:
        why = "the agent named no answer this pause offers (%s)" % asked
    elif asked != "research":
        # A defect whose fix is in the facts needs no change, so closing the run out is allowed.
        allowed = (
            ALLOWED[out["defect"]]
            + (("accept", "retry") if out["fixed_by"] else ())
            + (("accept",) if nothing_lost else ())
        )
        if asked not in allowed and out["defect"] == "unknown":
            why = (
                "the agent could not place the defect, so `%s` has nothing to fix"
                % asked
            )
        elif asked not in allowed:
            why = "the agent placed the defect in `%s`, which `%s` does not fix" % (
                out["defect"],
                asked,
            )
        elif out["confidence"] == "low":
            why = "the agent's confidence was low"
        elif asked == "follow-up":
            entry, reason = checked_follow_up(out["follow_up"], repo)
            if entry is None:
                why = "the follow-up the agent named cannot start (%s)" % reason
            else:
                out["follow_up"] = entry
    if why:
        out["agent_recommend"] = asked
        out["agent_recommend_why"] = out["recommend_why"]
        out["recommend"] = "research"
        out["recommend_why"] = (
            "A research run settles the cause first, because %s." % why
        )
    if out["recommend"] == "research" and not out["question"]:
        out["question"] = (
            "Find the cause of this failure and say whether its work needs rescuing: %s"
            % (out["summary"] or out["happened"][:200] or "no summary was given")
        )
    return out


def sentence(text):
    t = one_line(text)
    return t if not t or t[-1] in ".!?" else t + "."


def evidence_line(e):
    src = " (%s)" % e["source"] if e["source"] else ""
    return "- %s: %s%s." % (
        "confirmed" if e["confirmed"] else "inferred",
        e["claim"].rstrip(".!?"),
        src,
    )


WORK_WORDS = {
    "none": "absent (no worktree is left)",
    "landed": "landed on the base branch",
    "pr": "in a pull request",
    "pushed": "pushed to the remote",
}


def work_phrase(work):
    s = work["state"]
    if s == "branch":
        return "committed only on the local branch %s" % work["branch"]
    if s == "unsaved":
        n = len(work["dirty_files"])
        return "unsaved (%d changed file%s)" % (n, "" if n == 1 else "s")
    return WORK_WORDS.get(s, s)


def mechanical_headline(v):
    f = v.get("failure") or {}
    how = {
        "failed": "failed",
        "dead": "lost its owner process",
        "cancelled-refused": "was refused by the engine",
        "completed": "completed",
        "cancelled-chosen": "was cancelled",
    }.get(v["kind"], v["kind"])
    where = " at %s" % f["node"] if f.get("node") else ""
    reason = v["reason"][:1].upper() + v["reason"][1:]
    return "%s run %s %s%s; its work is %s. %s." % (
        v["workflow"],
        v["run"][:8],
        how,
        where,
        work_phrase(v["work"]),
        reason,
    )


def headline(v, d=None):
    if not d:
        return mechanical_headline(v)
    cause = d["summary"].rstrip(".") or mechanical_headline(v).rstrip(".")
    return "%s. Recommended: %s." % (cause[:1].upper() + cause[1:], d["recommend"])


def basic_facts(v):
    """The facts the verdict alone holds, for a report whose facts file could not be made."""
    f = v.get("failure") or {}
    out = ["", "### Run", ""]
    out.append(
        "- Run `%s` of `%s` has the status `%s`, which counts as `%s`."
        % (v["run"], v["workflow"], v["status"], v["kind"])
    )
    if f:
        out.append(
            "- It failed at `%s` with `%s` (failure class `%s`)."
            % (f.get("node") or "no node", f.get("exit_reason"), f["class"])
        )
    out.append(
        "- Worktree: `%s`; the work is %s."
        % (v["working_path"] or "none", work_phrase(v["work"]))
    )
    if v["rungs"]:
        out += ["", "### Rescue rungs tried", ""]
        for t in v["rungs"]:
            out.append(
                "- `%s` %s: %s"
                % (t["rung"], "worked" if t["ok"] else "failed", t["message"])
            )
    if f:
        err = f["error"].splitlines()[-40:]
        out += ["", "### Error, last %d lines" % len(err), ""] + fence(err)
    out += ["", "### Where to look", ""]
    out.append("- Artifacts: `%s`" % (v.get("artifacts") or "none found"))
    out.append("- Transcript: `%s`" % (v.get("transcript") or "none found"))
    return out


EXPECTED_WORDS = {
    "expected": "This failure was expected.",
    "unexpected": "This failure was not expected.",
    "unclear": "It is unclear whether this failure was expected.",
}
RESCUE_WORDS = {
    "none-needed": "No rescue is needed.",
    "optional": "A rescue is optional.",
    "needed": "A rescue is needed.",
}
VALUE_WORDS = {
    "important": "The work is important.",
    "minor": "The work is minor.",
    "none": "The work has no value.",
    "unknown": "The value of the work is not known.",
}


def render_report(v, facts=None, d=None):
    run8 = v["run"][:8]
    if d:
        title = "# Cleanup of %s run %s" % (v["workflow"], run8)
        if d["summary"]:
            title += ": " + d["summary"].rstrip(".")
        lines = [
            title,
            "",
            "Recommended answer: %s. %s"
            % (d["recommend"], sentence(d["recommend_why"])),
            "",
            "Confidence: %s." % d["confidence"],
        ]
        if d.get("agent_recommend"):
            lines += [
                "",
                "The diagnosing agent recommended `%s`: %s"
                % (
                    d["agent_recommend"],
                    sentence(d.get("agent_recommend_why")) or "it gave no reason.",
                ),
            ]
        if d["recommend"] == "research" and d["question"]:
            lines += ["", "Question for the research run: %s" % d["question"]]
        fu = d["follow_up"]
        if d["recommend"] == "follow-up" and fu:
            where = " in the %s repository" % fu["repo"] if fu["repo"] else ""
            lines += [
                "",
                "The follow-up is `%s`%s: %s"
                % (fu["workflow"], where, sentence(fu["note"]) or "no scope was given."),
            ]
        lines += [
            "",
            "## What happened",
            "",
            d["happened"] or "The agent gave no account.",
        ]
        exp = EXPECTED_WORDS.get(d["expected"], EXPECTED_WORDS["unclear"])
        text = " ".join(x for x in (exp, sentence(d["expected_why"])) if x)
        if d["fixed_by"]:
            text += " It has been fixed since by %s." % d["fixed_by"].rstrip(".")
        lines += ["", "## Whether it was expected", "", text]
        res = RESCUE_WORDS.get(d["rescue"], "Whether a rescue is needed is not known.")
        lines += ["", "## Rescue", "", res]
        if d["rescue_how"]:
            if d["rescue"] == "none-needed":
                lines += ["", sentence(d["rescue_how"])]
            else:
                lines += [""] + fence(d["rescue_how"].splitlines())
        val = VALUE_WORDS.get(d["work_value"], VALUE_WORDS["unknown"])
        lines += [
            "",
            "## Value of the work",
            "",
            " ".join(x for x in (val, sentence(d["work_why"])) if x),
        ]
        lines += ["", "## Evidence", ""]
        lines += [evidence_line(e) for e in d["evidence"]]
        if not d["evidence"]:
            lines.append("None given.")
    else:
        lines = [
            "# Cleanup of %s run %s" % (v["workflow"], run8),
            "",
            "No diagnosis (the diagnosing agent produced none). Facts below.",
        ]
    lines += ["", "## Facts"]
    if facts:
        lines += render_facts(facts, 3, False)
    else:
        lines += basic_facts(v)
    return "\n".join(lines).rstrip("\n") + "\n"


def load_diagnosis(path, facts=None, repo=None):
    if not path or not os.path.isfile(path):
        return None
    return guard_diagnosis(load_json(path), facts, repo)


def cmd_report(a):
    v = load_json(a.verdict)
    if not isinstance(v, dict) or not v.get("work"):
        raise Refused("%s holds no verdict for a run with a work state" % a.verdict)
    facts = load_json(a.facts) if a.facts else None
    facts = facts if isinstance(facts, dict) else None
    d = load_diagnosis(a.diagnosis, facts, v.get("repo"))
    write_text(a.out, render_report(v, facts, d))
    print(headline(v, d))
    return 0


def facts_section(report):
    """The `## Facts` section of a report, to the end."""
    i = report.find("\n## Facts")
    return report[i + 1 :] if i >= 0 else ""


def follow_up_base(repo):
    """The commit the base branch of the repository holds, for a hand-off that takes `ref`."""
    rc, out, _ = sh([os.path.join(SCRIPTS, "build-settings.sh"), "base"], cwd=repo)
    base = out.strip() if rc == 0 and out.strip() else "main"
    rc, sha = git(repo, "rev-parse", base)
    return sha if rc == 0 and sha else "HEAD"


def cmd_follow_candidates(a):
    """Prints what a report of this run may start, which is what `research` offers (start-run.sh
    candidates --also build, run in the run's repository), or `none`."""
    c = connect()
    repo = repo_of(c, find_run(c, a.run))
    if repo and os.path.isdir(repo):
        rc, out, _ = sh([START_RUN, "candidates", "--also", "build"], cwd=repo, timeout=120)
        if rc == 0 and out.strip():
            print(out.strip())
            return 0
    print("none")
    return 0


def cmd_handoff(a):
    c = connect()
    run = find_run(c, a.run)
    cwd = repo_of(c, run)
    if not cwd or not os.path.isdir(cwd):
        raise Refused("the repository for %s (%s) is not on disk" % (a.workflow, cwd))
    try:
        with open(a.report) as f:
            report = f.read()
        note = ""
        if os.path.isfile(a.note):
            with open(a.note) as f:
                note = f.read().strip()
    except OSError as e:
        raise Refused(str(e)) from None
    d = load_diagnosis(a.diagnosis, None, cwd)
    entry = None
    if a.workflow not in HANDOFFS:
        # An old answer's name starts that workflow, with the diagnosis's `fix` or question as its
        # scope, when the candidate list of the run's repository holds it.
        raw = load_json(a.diagnosis, {}) if a.diagnosis else {}
        fix = str(raw.get("fix") or "").strip() if isinstance(raw, dict) else ""
        entry, why = checked_follow_up(
            {
                "workflow": a.workflow,
                "repo": "",
                "inputs": [],
                "note": fix or (d["question"] if d else ""),
            },
            cwd,
        )
        if entry is None:
            raise Refused("%s cannot start: %s" % (a.workflow, why))
    elif a.workflow == "follow-up":
        if not d or d["recommend"] != "follow-up" or not d["follow_up"]:
            raise Refused(
                "the report recommends no follow-up that can start, so there is nothing to start"
            )
        entry = d["follow_up"]
    if d:
        title = (
            report.splitlines()[0] if report.startswith("# ") else "# Cleanup report"
        )
        established = [
            "## Established by the cleanup report",
            "",
            d["happened"] or "The agent gave no account.",
        ]
        if d["defect"] != "none":
            where = " in %s" % d["defect_where"] if d["defect_where"] else ""
            established += ["", "The defect is in the %s%s." % (d["defect"], where)]
        established += [evidence_line(e) for e in d["evidence"]]
        ask = (
            "Make the change that the report recommends."
            if entry
            else d["question"]
        )
        body = "\n".join(
            [
                title,
                "",
                *established,
                "",
                "## Question" if not entry else "## Task",
                "",
                ask or "Settle the cause of this failure.",
                "",
                facts_section(report),
            ]
        )
    else:
        body = report
    message = cap_bytes((note + "\n\n" + body) if note else body, 100 << 10)
    if entry is None:
        rc, out, err = sh([START_RUN, "run", a.workflow, message], cwd=cwd, timeout=300)
        child = out.strip().splitlines()[-1].strip() if out.strip() else ""
        if rc or not child:
            raise Refused("%s did not start: %s" % (a.workflow, tail(err or out)))
        print("started %s, run %s" % (a.workflow, child))
        return 0
    with tempfile.TemporaryDirectory() as tmp:
        plan = os.path.join(tmp, "follow-up-plan.json")
        brief = os.path.join(tmp, "brief.md")
        write_text(plan, json.dumps([entry]))
        write_text(brief, message)
        rc, out, err = sh(
            [START_RUN, "start", "--strict", plan, follow_up_base(cwd), brief],
            cwd=cwd,
            timeout=300,
        )
    if rc or "started " not in out:
        raise Refused(
            "%s did not start: %s" % (entry["workflow"], tail(out + " " + err))
        )
    print(out.strip())
    return 0


def cmd_record(a):
    state, decision = a.state, a.decision
    if a.dry == "yes" or state in ("skip", "dry", "sweep", "worktree"):
        print("nothing recorded")
        return 0
    verdict = load_json(a.verdict, {}) or {}
    sig = (verdict.get("failure") or {}).get("signature", "")
    rid = a.run
    answered = decision not in ("", "none")
    es = []
    if answered:
        es.append(ledger_entry(rid, "answered", decision, sig))
        if decision not in NOT_HANDOFFS:
            m = None
            try:
                with open(a.handoff) as f:
                    m = re.search(r"run (\S+)", f.read())
            except OSError:
                pass
            es.append(
                ledger_entry(
                    rid, "handed-off", decision, sig, m.group(1) if m else None
                )
            )
        elif decision == "accept":
            es.append(ledger_entry(rid, "accepted", "", sig))
        elif decision == "discard":
            es.append(ledger_entry(rid, "discarded", "", sig))
    if state == "close":
        es.append(ledger_entry(rid, "closed", verdict.get("reason", ""), sig))
    elif state == "waiting":
        child = verdict.get("child")
        child = child.get("id") if isinstance(child, dict) else child
        es.append(ledger_entry(rid, "rescued", verdict.get("reason", ""), sig, child))
    elif state == "attention" and not answered:
        es.append(ledger_entry(rid, "attention", verdict.get("reason", ""), sig))
    if es:
        ledger_append(es)
    print("recorded %s" % (", ".join(e["action"] for e in es) or "nothing"))
    return 0


def branch_note(main, branch, tip):
    if not branch:
        return "detached HEAD at %s" % tip
    if git(main, "show-ref", "--verify", "-q", "refs/heads/" + branch)[0] == 0:
        return "branch %s kept at %s" % (branch, tip)
    return "branch %s removed (was %s)" % (branch, tip)


def start_assessment(ctx, entry):
    rc, out, err = sh(
        [
            START_RUN,
            "run",
            "workflow-cleanup",
            "--input",
            "worktree=" + entry["path"],
            "--input",
            "dry=no",
        ],
        cwd=ctx["main"],
        timeout=300,
    )
    child = out.strip().splitlines()[-1].strip() if out.strip() else ""
    if rc or not child:
        return None, tail(err or out)
    return child, ""


def cmd_worktrees(a):
    dry = a.dry == "yes"
    main = project_root(a.repo or os.getcwd())
    ctx = wt_context(main)
    if ctx is None:
        print("skipped: no main or master branch")
        return 0
    results = [(e, classify_worktree(ctx, e)) for e in ctx["entries"]]
    assess = [x for x in results if x[1]["action"] == "assess"]
    chosen = {id(e) for e, _ in assess[:SPEND_CAP]}
    counts = {"delete": 0, "assess": 0, "ignore": 0}
    rows = []
    for entry, res in results:
        name = os.path.basename(entry["path"].rstrip("/"))
        real = os.path.realpath(entry["path"])
        branch = entry.get("branch") or ""
        act = res["action"]
        if act == "ignore":
            counts["ignore"] += 1
            rows.append((name, "ignore: %s" % res["reason"]))
        elif act == "delete":
            if dry:
                counts["delete"] += 1
                rows.append((name, "would delete (%s)" % res["reason"]))
                continue
            try:
                tip = wt_remove(main, entry["path"], False)
            except Refused as e:
                rows.append((name, "not deleted: %s" % e))
                continue
            ledger_append(
                [
                    ledger_entry(
                        "wt:" + real, "wt-deleted", "%s %s" % (branch or "-", tip)
                    )
                ]
            )
            counts["delete"] += 1
            rows.append(
                (
                    name,
                    "deleted (%s); %s"
                    % (res["reason"], branch_note(main, branch, tip)),
                )
            )
        else:
            counts["assess"] += 1
            if dry:
                rows.append((name, "would assess (%s)" % res["reason"]))
            elif id(entry) not in chosen:
                rows.append(
                    (
                        name,
                        "assess (%s); not started, %d per sweep"
                        % (res["reason"], SPEND_CAP),
                    )
                )
            else:
                child, err = start_assessment(ctx, entry)
                if not child:
                    rows.append(
                        (name, "assess (%s); did not start: %s" % (res["reason"], err))
                    )
                    continue
                ledger_append(
                    [ledger_entry("wt:" + real, "wt-queued", branch, "", child)]
                )
                rows.append(
                    (name, "assess (%s); started run %s" % (res["reason"], child))
                )
    for p in ctx["unscanned"]:
        counts["ignore"] += 1
        rows.append(
            (
                os.path.basename(p),
                "ignore: worktree-cleanup.sh scan did not list it",
            )
        )
    if not rows:
        print("%s has no linked worktrees" % main)
        return 0
    width = max(len(n) for n, _ in rows)
    print("%-*s  %s" % (width, "WORKTREE", "ACTION"))
    for name, text in rows:
        print("%-*s  %s" % (width, name, text))
    for line in SCAN_WARNINGS.get(main, []):
        print("scan: %s" % line)
    verb = "would " if dry else ""
    print(
        "%sdelete %d, %sassess %d, ignore %d"
        % (verb, counts["delete"], verb, counts["assess"], counts["ignore"])
    )
    return 0


def cmd_wt_inspect(a):
    def finish(route, why=""):
        write_text(a.state, route + "\n")
        print(route)
        if why:
            print("%s: %s" % (a.worktree, why), file=sys.stderr)
        return 0

    main = linked_worktree(a.worktree)
    if not main:
        return finish("skip", "not a linked worktree on disk")
    ctx = wt_context(main)
    entry = scan_entry(main, a.worktree) if ctx else None
    if ctx is None or entry is None:
        return finish("skip", "no longer listed by git, or no main or master branch")
    res = classify_worktree(ctx, entry, wt_run_id())
    if res["action"] == "ignore":
        return finish("skip", res["reason"])
    if res["action"] == "delete":
        return finish("delete", res["reason"])
    if a.dry == "yes":
        return finish("dry", "would assess: %s" % res["reason"])
    facts = build_facts(a.worktree, ctx["base"], a.facts)
    write_verdict(
        a.verdict,
        {
            "worktree": os.path.realpath(a.worktree),
            "name": os.path.basename(a.worktree.rstrip("/")),
            "branch": entry.get("branch") or "",
            "base": ctx["base"],
            "head": entry.get("head") or "",
            "fingerprint": res["fingerprint"],
            "why_not_clean": res["reason"],
            **facts,
        },
    )
    return finish("abandon" if res["cached"] == "abandon" else "assess", res["reason"])


def cmd_wt_judge(a):
    try:
        with open(a.state) as f:
            state = f.read().strip()
    except OSError:
        state = ""
    if state != "assess":
        print(state or "none")
        return 0
    if not os.path.isdir(a.worktree):
        write_text(a.state, "skip\n")
        print("skip")
        return 0
    verdict, reason = "keep", "the assessor returned no readable verdict"
    data = load_json(a.assess)
    if isinstance(data, dict) and data.get("verdict") in ("abandon", "keep"):
        verdict = data["verdict"]
        reason = " ".join(str(data.get("reason") or "").split())
    # The content the assessor read is the one wt-inspect fingerprinted. An edit during the model
    # call must leave the new content unassessed, so the verdict is not cached against it.
    saved = (load_json(a.verdict, {}) or {}).get("fingerprint") if a.verdict else None
    ledger_append(
        [
            ledger_entry(
                "wt:" + os.path.realpath(a.worktree),
                "wt-assessed",
                ("%s %s" % (verdict, reason)).strip(),
                saved or fingerprint(a.worktree),
            )
        ]
    )
    write_text(a.state, verdict + "\n")
    print(verdict)
    return 0


def plural(n, word):
    return "%d %s%s" % (n, word, "" if n == 1 else "s")


WT_RECOMMENDATION = "Recommended: delete (the assessor found nothing worth keeping)."


def wt_holds(v):
    parts = []
    if v.get("unlanded_count"):
        parts.append(plural(v["unlanded_count"], "unlanded commit"))
    if v.get("dirty_count"):
        parts.append(plural(v["dirty_count"], "uncommitted file"))
    return " and ".join(parts) or "nothing to save"


def wt_headline(v, reason):
    return "%s Worktree %s (%s) holds %s and %s: %s" % (
        WT_RECOMMENDATION,
        v["name"],
        "branch %s" % v["branch"] if v["branch"] else "detached HEAD",
        plural(v.get("unlanded_count", 0), "unlanded commit"),
        plural(v.get("dirty_count", 0), "uncommitted file"),
        reason or "the assessor gave no reason",
    )


def cmd_wt_report(a):
    v = load_json(a.verdict)
    if not isinstance(v, dict) or not v.get("worktree"):
        raise Refused("%s holds no verdict for a worktree" % a.verdict)
    mine = [
        e
        for e in read_ledger()
        if e.get("run") == "wt:" + v["worktree"] and e.get("action") == "wt-assessed"
    ]
    detail = (mine[-1].get("detail") or "") if mine else ""
    reason = detail.split(" ", 1)[1] if " " in detail else ""
    head = wt_headline(v, reason)

    def block(title, lines, note=""):
        body = [x.replace("```", "'''") for x in lines] or ["none"]
        return ["", "## %s" % title, "", *([note, ""] if note else []), *fence(body)]

    total = v.get("dirty_count", 0)
    same = v.get("identical_count", 0)
    listed = v.get("dirty") or []
    note = (
        "%s in all. %d differ from main or are missing there, and %d are identical to main"
        " and not listed.%s"
        % (
            plural(total, "file"),
            total - same,
            same,
            " Only the first %d of the differing ones are listed." % len(listed)
            if total - same > len(listed)
            else "",
        )
    )
    lines = [
        "# Worktree %s" % v["name"],
        "",
        head,
        "",
        "## What it holds",
        "",
        "- Path: `%s`" % v["worktree"],
        "- Branch: `%s`, compared with `%s`"
        % (v["branch"] or "(detached HEAD)", v["base"]),
        "- Lock: %s" % (v.get("lock") or "none"),
        "- Why it is not clean: %s." % wt_holds(v),
        "",
        "## Why the assessor would delete it",
        "",
        reason or "The assessor gave no reason.",
    ]
    lines += block("Unlanded commits", v.get("unlanded") or [])
    lines += block("Changes since the merge-base", v.get("stat") or [])
    lines += block(
        "Uncommitted files",
        ["%s  %s" % (lab, p) for lab, p in listed],
        note if total else "",
    )
    lines += block(
        "Commits on %s that touched the listed files" % v["base"],
        v.get("superseding") or [],
    )
    lines += [
        "",
        "## Where to look",
        "",
        "- Facts the assessor read: `%s`" % a.facts,
    ]
    write_text(a.out, "\n".join(lines) + "\n")
    print(head)
    return 0


def cmd_wt_act(a):
    path, dry = a.worktree, a.dry == "yes"
    real = os.path.realpath(path)
    if a.decision == "keep":
        branch = git(path, "branch", "--show-current")[1] if os.path.isdir(path) else ""
        if dry:
            print("would record that %s is kept" % path)
            return 0
        ledger_append([ledger_entry("wt:" + real, "wt-declined", branch)])
        print("kept %s; it will not be assessed again unless it lands in main" % path)
        return 0
    if not os.path.isdir(path):
        print("nothing to remove: %s is already gone" % path)
        return 0
    main = linked_worktree(path)
    if not main:
        raise Refused("%s is not a linked worktree" % path)
    ctx = wt_context(main)
    if ctx is None:
        raise Refused("%s has no main or master branch" % main)
    entry = scan_entry(main, path)
    if entry is None:
        raise Refused("%s is not in the worktree list of %s" % (path, main))
    why, _ = use_reason(ctx, entry)
    if why:
        if dry:
            print("would not delete %s: %s" % (path, why))
            return 0
        raise Refused("%s is not deleted: %s" % (path, why))
    if dry:
        print("would delete %s" % path)
        return 0
    _, head = git(path, "rev-parse", "--short", "HEAD")
    ok, msg = commit_wip(path, "workflow-cleanup", wt_run_id() or head)
    if not ok:
        raise Refused("could not save the work in %s: %s" % (path, msg))
    _, branch = git(path, "branch", "--show-current")
    tip = wt_remove(main, path, True)
    ledger_append(
        [ledger_entry("wt:" + real, "wt-deleted", "%s %s" % (branch or "-", tip))]
    )
    print("removed %s; %s" % (path, branch_note(main, branch, tip)))
    if (
        branch
        and git(main, "show-ref", "--verify", "-q", "refs/heads/" + branch)[0] != 0
    ):
        print("restore with: git branch %s %s" % (branch, tip))
    return 0


def workflow_name(text):
    if text not in HANDOFFS and not WORKFLOW_NAME.fullmatch(text):
        raise argparse.ArgumentTypeError("%r is not a workflow name" % text)
    return text


def build_parser():
    p = argparse.ArgumentParser(
        prog="workflow-cleanup.py", description=__doc__.split("\n")[0]
    )
    sub = p.add_subparsers(dest="cmd", required=True)
    yn = ["yes", "no"]

    s = sub.add_parser("candidates")
    s.add_argument("--out", required=True)
    s.set_defaults(fn=cmd_candidates)

    s = sub.add_parser("fan-out")
    s.add_argument("--candidates", required=True)
    s.add_argument("--dry", choices=yn, required=True)
    s.set_defaults(fn=cmd_fan_out)

    s = sub.add_parser("inspect")
    s.add_argument("--run", required=True)
    s.add_argument("--dry", choices=yn, required=True)
    s.add_argument("--state", required=True)
    s.add_argument("--out", required=True)
    s.set_defaults(fn=cmd_inspect)

    s = sub.add_parser("rescue")
    s.add_argument("--run", required=True)
    s.add_argument("--spend", choices=yn, required=True)
    s.add_argument("--dry", choices=yn, required=True)
    s.add_argument("--state", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--retry", action="store_true")
    s.set_defaults(fn=cmd_rescue)

    s = sub.add_parser("settle")
    s.add_argument("--run", required=True)
    s.add_argument("--dry", choices=yn, required=True)
    s.add_argument("--save-first", action="store_true")
    s.add_argument("--discard", action="store_true")
    s.set_defaults(fn=cmd_settle)

    s = sub.add_parser("facts")
    s.add_argument("--verdict", required=True)
    s.add_argument("--out", required=True)
    s.set_defaults(fn=cmd_facts)

    s = sub.add_parser("diagnosis")
    s.add_argument("--run", required=True)
    s.add_argument("--facts-word", required=True)
    s.add_argument("--raw", required=True)
    s.add_argument("--dir", required=True)
    s.set_defaults(fn=cmd_diagnosis)

    s = sub.add_parser("report")
    s.add_argument("--verdict", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--facts")
    s.add_argument("--diagnosis")
    s.set_defaults(fn=cmd_report)

    s = sub.add_parser("follow-candidates")
    s.add_argument("--run", required=True)
    s.set_defaults(fn=cmd_follow_candidates)

    s = sub.add_parser("handoff")
    s.add_argument("--run", required=True)
    s.add_argument("--workflow", type=workflow_name, required=True)
    s.add_argument("--report", required=True)
    s.add_argument("--note", required=True)
    s.add_argument("--diagnosis")
    s.set_defaults(fn=cmd_handoff)

    s = sub.add_parser("record")
    s.add_argument("--run", required=True)
    s.add_argument("--dry", choices=yn, required=True)
    s.add_argument("--state", required=True)
    s.add_argument("--decision", required=True)
    s.add_argument("--handoff", required=True)
    s.add_argument("--verdict", required=True)
    s.set_defaults(fn=cmd_record)

    s = sub.add_parser("worktrees")
    s.add_argument("--dry", choices=yn, required=True)
    s.add_argument("--repo")
    s.set_defaults(fn=cmd_worktrees)

    s = sub.add_parser("wt-inspect")
    s.add_argument("--worktree", required=True)
    s.add_argument("--dry", choices=yn, required=True)
    s.add_argument("--state", required=True)
    s.add_argument("--facts", required=True)
    s.add_argument("--verdict", required=True)
    s.set_defaults(fn=cmd_wt_inspect)

    s = sub.add_parser("wt-judge")
    s.add_argument("--state", required=True)
    s.add_argument("--assess", required=True)
    s.add_argument("--worktree", required=True)
    s.add_argument("--verdict")
    s.set_defaults(fn=cmd_wt_judge)

    s = sub.add_parser("wt-report")
    s.add_argument("--worktree", required=True)
    s.add_argument("--facts", required=True)
    s.add_argument("--verdict", required=True)
    s.add_argument("--out", required=True)
    s.set_defaults(fn=cmd_wt_report)

    s = sub.add_parser("wt-act")
    s.add_argument("--worktree", required=True)
    s.add_argument("--decision", choices=["delete", "keep"], required=True)
    s.add_argument("--dry", choices=yn, required=True)
    s.set_defaults(fn=cmd_wt_act)
    return p


def main():
    args = build_parser().parse_args()
    try:
        return args.fn(args)
    except Refused as e:
        print("workflow-cleanup: %s" % e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
