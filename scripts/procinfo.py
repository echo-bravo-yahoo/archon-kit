#!/usr/bin/env python3
"""Process lookups for workflow-cleanup.py and archon-dead-runs.sh that say so when they cannot answer.

The kit asks two questions of the process table: is the process that owns a run still the Archon
that started it, and which processes work inside a directory. Linux answers both from /proc. Other
systems have no /proc, so the lookups fall back to `ps` for the first question and `lsof` for the
second. When no source works, they return "unknown" (an owner) or None (the working directories),
and the callers read that as "do not call the run dead" and "leave the worktree alone", because the
other answers lead to a resumed run that is still running and to work deleted under a live shell.

Two environment variables exist for the tests: KIT_PROC_BACKENDS, a comma-separated list of the
sources to use (default "proc,ps,lsof"; "none" disables all), and KIT_PROC_ROOT, the directory to
read as /proc (default /proc).
"""

import glob
import os
import subprocess


def _backends():
    return {b for b in os.environ.get("KIT_PROC_BACKENDS", "proc,ps,lsof").split(",") if b}


def _root():
    return os.environ.get("KIT_PROC_ROOT") or "/proc"


def have_proc():
    """Whether a /proc directory can be read."""
    return "proc" in _backends() and os.path.isdir(_root())


def _run(argv, timeout):
    """(exit code, stdout) of a command, or None when it cannot run or does not finish."""
    try:
        p = subprocess.run(argv, capture_output=True, text=True, errors="replace", timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    return p.returncode, p.stdout


def _command_line(pid):
    """The process's command line as one string, or None when no source can read it."""
    if have_proc():
        try:
            with open(os.path.join(_root(), str(pid), "cmdline"), "rb") as f:
                return f.read().replace(b"\0", b" ").decode("utf-8", "replace")
        except OSError:
            pass
    if "ps" in _backends():
        got = _run(["ps", "-o", "args=", "-p", str(pid)], 5)
        if got and got[0] == 0:
            return got[1].strip()
    return None


def owner_state(pid):
    """"alive" when the process exists and its command line names archon, "dead" when it is gone or
    is something else (the pid was reused), "unknown" when this system cannot show the command line
    of a process that exists."""
    if os.name != "posix" or not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return "unknown"
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return "dead"
    except PermissionError:
        pass  # the process exists and belongs to another user
    except OSError:
        return "unknown"
    cmd = _command_line(pid)
    if cmd is None:
        return "unknown"
    return "alive" if "archon" in cmd else "dead"


def start_ticks(pid):
    """Field 22 of /proc/<pid>/stat, the start time of the process in clock ticks, or None when
    there is no /proc or no such process. The fields are counted from the last `)`, because a
    command name may hold spaces and parentheses."""
    if not have_proc():
        return None
    try:
        with open(os.path.join(_root(), str(pid), "stat")) as f:
            stat = f.read()
    except OSError:
        return None
    rest = stat[stat.rfind(")") + 2 :].split()
    return rest[19] if len(rest) > 19 else None


def cwds():
    """[(pid, working directory)] for the processes this user can see, or None when this system
    cannot list them."""
    if have_proc():
        out = []
        for link in glob.glob(os.path.join(glob.escape(_root()), "[0-9]*", "cwd")):
            pid = os.path.basename(os.path.dirname(link))
            if not pid.isdigit():
                continue
            try:
                target = os.readlink(link)
            except OSError:
                continue
            if target.endswith(" (deleted)"):
                continue
            out.append((int(pid), target))
        return out
    if "lsof" in _backends():
        got = _run(["lsof", "-a", "-d", "cwd", "-F", "pn"], 60)
        if not got:
            return None
        out, pid = [], None
        for line in got[1].splitlines():
            if line.startswith("p") and line[1:].isdigit():
                pid = int(line[1:])
            elif line.startswith("n") and pid is not None and not line.endswith(" (deleted)"):
                out.append((pid, line[1:]))
        # This process has a working directory too, so an empty list means lsof failed.
        return out or None
    return None
