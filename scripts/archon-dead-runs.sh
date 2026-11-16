#!/usr/bin/env bash
# usage: archon-dead-runs.sh [list]
#        archon-dead-runs.sh schema
#        archon-dead-runs.sh backup <run-id>...
#        archon-dead-runs.sh mark-failed <run-id> [--cancelled]
#        archon-dead-runs.sh clear-node <run-id> <node-id>...
#
# Recovery helper for Archon runs whose owning process died. See docs/reference/recovering-runs.md
# in the Archon kit. Reads $ARCHON_HOME (default ~/.archon). It reads and writes tables that are
# private to Archon, and tested only against Archon 0.13.x.
#   schema       checks that the tables and columns this script and workflow-cleanup.py use exist,
#                and exits 1 with one line naming the Archon version when one is missing.
#   list         every running run, whether its owner is alive, how many pauses were answered,
#                the minutes since its newest event (idle), and the nodes that have started but
#                not finished (open). A run with a live owner and 20 or more idle minutes is
#                flagged STALLED: a node is probably hung, since a paused run is not listed.
#   backup       copies the database, and each run's artifacts and transcript, to ~/.archon/backups/
#   mark-failed  sets a running run with a dead owner to failed, so `archon workflow resume` can
#                continue it in place. --cancelled does the same for a run that is cancelled.
#                Snapshots the database first.
#   clear-node   forgets what a failed run recorded for the named nodes, so `archon workflow
#                resume` runs them again. Archon keeps a node's last result across resumes: a
#                node that failed once stays failed, and one that completed is skipped, even
#                after the cause is fixed. Takes a loop-body node by its bare id. Removes only
#                the node_* events, never a pause's answer. Snapshots the database first, and
#                the database archives each removed event in remote_agent_workflow_event_archive.
set -euo pipefail
# procinfo.py sits beside this script, in the kit's scripts directory and in the installed copy.
KIT_SCRIPT=$0
export KIT_SCRIPT
exec python3 - "$@" <<'PY'
import glob, json, os, shutil, socket, sqlite3, sys, time, urllib.parse
from datetime import datetime, timezone

# Beside this script, and, when an install links each file and has not linked a newer module yet,
# beside the file the link points to.
sys.dont_write_bytecode = True
_script = os.path.abspath(os.environ["KIT_SCRIPT"])
sys.path[:0] = list(dict.fromkeys(os.path.dirname(p) for p in (_script, os.path.realpath(_script))))
import procinfo

HOME = os.environ.get("ARCHON_HOME") or os.path.expanduser("~/.archon")
DB = os.path.join(HOME, "archon.db")


def ro():
    return sqlite3.connect("file:%s?mode=ro" % urllib.parse.quote(DB), uri=True)


# The tables and columns this script and workflow-cleanup.py (SCHEMA there) use.
SCHEMA = {
    "remote_agent_workflow_runs": (
        "id", "workflow_name", "status", "codebase_id", "working_path", "user_message", "metadata",
        "adopted_from_run_id", "started_at", "completed_at", "last_activity_at", "output_root",
    ),
    "remote_agent_workflow_events": ("workflow_run_id", "event_order", "event_type", "step_name", "data", "created_at"),
    # A trigger of Archon's own database copies each deleted event here; clear-node relies on it.
    "remote_agent_workflow_event_archive": ("workflow_run_id", "event_order", "event_type", "step_name", "data"),
    "remote_agent_codebases": ("id", "default_cwd"),
}


def check_schema():
    if not os.path.exists(DB):
        sys.exit("no database at %s" % DB)
    c = ro()
    for table, cols in SCHEMA.items():
        have = {r[1] for r in c.execute("pragma table_info(%s)" % table)}
        missing = [col for col in cols if col not in have]
        if missing:
            try:
                import subprocess
                ver = subprocess.run(["archon", "--version"], capture_output=True, text=True, timeout=20).stdout.splitlines()[0]
            except Exception:
                ver = "an unknown version"
            sys.exit("the Archon database lacks %s.%s (%s); these scripts were tested against Archon 0.13.x" % (table, ", ".join(missing), ver))
    print("schema ok")


def owner_state(meta):
    o = (meta or {}).get("execution_owner") or {}
    pid, host = o.get("pid"), o.get("host")
    if not pid:
        return None, "unknown"
    if host != socket.gethostname():
        return pid, "unknown"
    return pid, procinfo.owner_state(pid)


def full_id(c, prefix):
    rows = c.execute("select id from remote_agent_workflow_runs where id like ?", (prefix + "%",)).fetchall()
    if len(rows) != 1:
        sys.exit("run id %r matches %d runs" % (prefix, len(rows)))
    return rows[0][0]


def snapshot_db(dest):
    os.makedirs(dest, exist_ok=True)
    out = os.path.join(dest, "archon.db")
    src, dst = ro(), sqlite3.connect(out)
    src.backup(dst)
    dst.close()
    src.close()
    return out


STALLED_MINUTES = 20


def open_nodes(c, rid):
    open_ = {}
    for t, step, data in c.execute(
        "select event_type, step_name, data from remote_agent_workflow_events"
        " where workflow_run_id = ? and event_type in"
        " ('node_started','node_completed','node_failed','node_skipped') order by event_order", (rid,)):
        try:
            inv = json.loads(data)["invocation"]["id"]
        except (ValueError, KeyError, TypeError):
            continue
        if t == "node_started":
            open_[inv] = step
        else:
            open_.pop(inv, None)
    names = set(open_.values())
    return sorted(n for n in names if not any(o.startswith(n + ".") for o in names))


def list_runs():
    c = ro()
    rows = c.execute(
        "select id, workflow_name, working_path, last_activity_at, metadata from remote_agent_workflow_runs"
        " where status = 'running' order by started_at"
    ).fetchall()
    if not rows:
        print("no running runs")
    for rid, name, path, last, meta in rows:
        pid, state = owner_state(json.loads(meta or "{}"))
        n = c.execute(
            "select count(*) from remote_agent_workflow_events where workflow_run_id = ? and event_type = 'wait_answered'",
            (rid,),
        ).fetchone()[0]
        last = c.execute(
            "select max(created_at) from remote_agent_workflow_events where workflow_run_id = ?", (rid,)
        ).fetchone()[0] or last
        idle = (
            datetime.now(timezone.utc)
            - datetime.strptime(last[:19].replace("T", " "), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        ).total_seconds() / 60
        flag = "  STALLED" if state == "alive" and idle >= STALLED_MINUTES else ""
        print(
            "%s  %-10s owner %-8s pid %-8s answered pauses %-3d last activity %s  idle %dm  open %s%s  %s"
            % (rid, name, state, pid, n, last, idle, ",".join(open_nodes(c, rid)) or "-", flag, path)
        )


def backup(ids):
    c = ro()
    dest = os.path.join(HOME, "backups", time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
    ids = [full_id(c, i) for i in ids]
    print("database:", snapshot_db(dest))
    for rid in ids:
        for p in glob.glob(os.path.join(HOME, "workspaces", "*", "*", "artifacts", "runs", rid)):
            shutil.copytree(p, os.path.join(dest, "artifacts-" + rid))
            print("artifacts:", os.path.join(dest, "artifacts-" + rid))
        for p in glob.glob(os.path.join(HOME, "workspaces", "*", "*", "logs", rid + ".jsonl")):
            shutil.copy2(p, dest)
            print("transcript:", os.path.join(dest, rid + ".jsonl"))


def mark_failed(rid, cancelled):
    c = ro()
    rid = full_id(c, rid)
    status, meta = c.execute("select status, metadata from remote_agent_workflow_runs where id = ?", (rid,)).fetchone()
    pid, state = owner_state(json.loads(meta or "{}"))
    if cancelled:
        if status != "cancelled":
            sys.exit("%s is %s, not cancelled" % (rid, status))
    else:
        if status != "running":
            sys.exit("%s is %s, not running" % (rid, status))
        if state != "dead":
            sys.exit("owner of %s is %s (pid %s); only a dead owner is safe to override" % (rid, state, pid))
    c.close()
    dest = os.path.join(HOME, "backups", time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
    print("database snapshot:", snapshot_db(dest))
    w = sqlite3.connect(DB, timeout=30)
    n = w.execute(
        "update remote_agent_workflow_runs set status = 'failed' where id = ? and status = ?",
        (rid, "cancelled" if cancelled else "running"),
    ).rowcount
    w.commit()
    w.close()
    if n != 1:
        sys.exit("run changed underneath; nothing was updated")
    print("%s is now failed; continue it with: archon workflow resume %s" % (rid, rid))


def clear_node(rid, nodes):
    c = ro()
    rid = full_id(c, rid)
    status = c.execute("select status from remote_agent_workflow_runs where id = ?", (rid,)).fetchone()[0]
    if status != "failed":
        sys.exit("%s is %s; only a failed run is safe to edit (mark-failed, or wait for it to fail)" % (rid, status))
    known = {
        r[0]
        for r in c.execute(
            "select distinct step_name from remote_agent_workflow_events where workflow_run_id = ? and event_type like 'node\\_%' escape '\\'",
            (rid,),
        )
        if r[0]
    }
    c.close()
    for n in nodes:
        if not any(k == n or k.endswith("." + n) for k in known):
            sys.exit("%s has no events for node %r" % (rid, n))
    dest = os.path.join(HOME, "backups", time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
    print("database snapshot:", snapshot_db(dest))
    w = sqlite3.connect(DB, timeout=30)
    for n in nodes:
        # LIKE with an escaped underscore: a bare `node_` would also match `nodeX`.
        cur = w.execute(
            "delete from remote_agent_workflow_events where workflow_run_id = ?"
            " and event_type like 'node\\_%' escape '\\' and (step_name = ? or step_name like ? escape '\\')",
            (rid, n, "%." + n.replace("_", "\\_")),
        )
        print("%-20s removed %d events" % (n, cur.rowcount))
    w.commit()
    w.close()
    print("resume it with: archon workflow resume %s" % rid)


args = sys.argv[1:]
cmd = args[0] if args else "list"
if cmd == "list":
    list_runs()
elif cmd == "schema" and len(args) == 1:
    check_schema()
elif cmd == "backup" and len(args) > 1:
    backup(args[1:])
elif cmd == "mark-failed" and len(args) in (2, 3) and (len(args) == 2 or args[2] == "--cancelled"):
    mark_failed(args[1], len(args) == 3)
elif cmd == "clear-node" and len(args) > 2:
    clear_node(args[1], args[2:])
else:
    sys.exit("usage: archon-dead-runs.sh [list] | schema | backup <run-id>... | mark-failed <run-id> [--cancelled] | clear-node <run-id> <node-id>...")
PY
