#!/usr/bin/env python3
"""Builds the Archon workflow playground: one HTML page with the workflows, run statistics and findings inlined.

usage: build.py [--out FILE] [--dump FILE] [--no-link] [--baseline DIR [--label TEXT]]

`bash refresh.sh` (or `archon-kit playground`) runs this for the playground page and for the before/after page.

Reads the workflow YAML files and the Archon database (read-only), then writes the page to
$ARCHON_HOME/designs/archon/workflow-playground/index.html (ARCHON_HOME defaults to ~/.archon), where the
report server serves it. data/aliases.json, annotations.json, findings.json and findings-note.txt, and a
baseline directory, hold one person's data and are not committed; the page builds without them.
--dump writes the workflows and statistics as JSON and builds no page (the tests use it).
--baseline DIR compares the workflows with an earlier set. DIR holds personal/<name>/<name>.yaml for
personal workflows and repo/<repo>/<name>/<name>.yaml for repository ones (other files are ignored).
The page then shows the changes since that set, including the workflows it no longer has.
DIR/baseline.json may hold {"label": TEXT, "out": FILE}: the label shown on the page and where to write it, so
that a refresh needs neither flag. --label and --out override it. A baseline page needs --out or an "out",
because the default output file is the playground page itself.
"""

import argparse
import glob
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
import urllib.parse
from datetime import datetime, timezone

import yaml

HOME = os.path.expanduser("~")
ROOT = os.path.dirname(os.path.abspath(__file__))
ARCHON_HOME = os.environ.get("ARCHON_HOME") or os.path.join(HOME, ".archon")
WORKFLOWS_DIR = os.path.join(ARCHON_HOME, "workflows")
DB_PATH = os.path.join(ARCHON_HOME, "archon.db")
DEFAULT_OUT = os.path.join(ARCHON_HOME, "designs", "archon", "workflow-playground", "index.html")


def load_aliases():
    """Run history recorded under a workflow's earlier name, from data/aliases.json: {"new-name": ["old-name"]}."""
    path = os.path.join(ROOT, "data", "aliases.json")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


HISTORY_ALIASES = load_aliases()
MODULE_ORDER = ["model", "files", "when", "validate", "yaml", "layout", "sim", "ui"]
NODE_TYPES = ["prompt", "command", "bash", "script", "loop", "loop_group", "approval", "wait", "cancel", "include", "workflow"]
EVENT_TYPES = (
    "node_started", "node_completed", "node_failed", "node_skipped", "loop_iteration_started",
    "wait_started", "wait_answered", "wait_completed", "workflow_cancelled", "workflow_failed",
)


def find_workflow_files(root=HOME, baseline=False):
    """Workflow files: the Archon home's (workflows/<group>/<name>/<name>.yaml, such as personal and kit groups) and a
    workspace's repositories', or with `baseline` the layout under `root` that --baseline describes."""
    patterns = [os.path.join(root, p) for p in ("personal/*/*.yaml", "repo/*/*/*.yaml")] if baseline else [os.path.join(WORKFLOWS_DIR, "*", "*", "*.yaml"), os.path.join(root, "workspace/*/.archon/workflows/*/*.yaml")]
    personal, repos = (sorted(glob.glob(pattern)) for pattern in patterns)
    return [p for p in personal + repos if "/worktrees/" not in "/" + os.path.relpath(p, root)]


def leading_comments(text):
    """Maps each node id to the comment block directly above its `- id:` line, and returns the comment above `nodes:`.

    Comment lines are joined into paragraphs; a bare `#` line starts a new paragraph.
    """
    lines = text.split("\n")

    def block_above(i):
        out = []
        j = i - 1
        while j >= 0 and re.match(r"^\s*#", lines[j]):
            out.insert(0, re.sub(r"^\s*#\s?", "", lines[j]).rstrip())
            j -= 1
        paras, cur = [], []
        for line in out:
            if line.strip():
                cur.append(line.strip())
            elif cur:
                paras.append(" ".join(cur))
                cur = []
        if cur:
            paras.append(" ".join(cur))
        return "\n\n".join(paras)

    by_id, nodes_comment = {}, ""
    for i, line in enumerate(lines):
        m = re.match(r"^\s*- id: (\S+)\s*$", line)
        if m:
            comment = block_above(i)
            if comment and m.group(1) not in by_id:
                by_id[m.group(1)] = comment
        elif re.match(r"^nodes:\s*$", line):
            nodes_comment = block_above(i)
    return by_id, nodes_comment


def load_workflow(path, root=HOME, baseline=False):
    with open(path, "rb") as f:
        raw = f.read()
    text = raw.decode("utf-8")
    model = yaml.safe_load(text)
    comments, nodes_comment = leading_comments(text)
    rel = os.path.relpath(path, root).split(os.sep)
    personal = rel[0] == "personal" if baseline else path.startswith(WORKFLOWS_DIR + os.sep)
    repo = None if personal else rel[1]
    group = (rel[0] if baseline else os.path.relpath(path, WORKFLOWS_DIR).split(os.sep)[0]) if personal else None
    return {
        "name": model["name"],
        "source": "personal" if personal else "repo",
        "group": group,
        "repo": repo,
        "path": os.path.relpath(path, root) if baseline else path.replace(HOME, "~"),
        "bytes": len(raw),
        "lines": text.count("\n") + (0 if text.endswith("\n") else 1),
        "description": model.get("description", ""),
        "inputs": model.get("inputs", {}),
        "keys": [k for k in model.keys() if k != "nodes"],
        "comments": comments,
        "nodesComment": nodes_comment,
        "model": model,
    }


def node_entries(nodes, parent=None):
    for node in nodes:
        key = f"{parent}.{node['id']}" if parent else node["id"]
        yield key, node
        body = (node.get("loop_group") or {}).get("nodes") if isinstance(node.get("loop_group"), dict) else None
        if body:
            yield from node_entries(body, key)


def pct(sorted_values, p):
    if not sorted_values:
        return None
    idx = max(0, math.ceil(p * len(sorted_values)) - 1)
    return sorted_values[idx]


def median(values):
    s = sorted(values)
    if not s:
        return None
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


def summarize(values):
    s = sorted(values)
    return {
        "n": len(s), "sum": sum(s), "median": median(s), "p90": pct(s, 0.9), "max": s[-1] if s else None,
        "mean": (sum(s) / len(s)) if s else None,
    }


def include_owner(step, include_ids):
    """The include node whose expansion produced `step` (`<parent>.<include id>__<node>`), or None."""
    parent, _, local = step.rpartition(".")
    if "__" not in local:
        return None
    key = f"{parent}.{local.split('__')[0]}" if parent else local.split("__")[0]
    return key if key in include_ids else None


def collect_stats(workflows):
    """Aggregates run history per workflow. Opens the database read-only and never stores error text."""
    names = [w["name"] for w in workflows]
    canonical = {n: n for n in names}
    for n in names:
        for old in HISTORY_ALIASES.get(n, []):
            canonical[old] = n
    db_names = list(canonical)
    if not os.path.exists(DB_PATH):
        return {"generatedAt": datetime.now(timezone.utc).isoformat(), "available": False, "workflows": {}}
    con = sqlite3.connect("file:%s?mode=ro" % urllib.parse.quote(DB_PATH), uri=True)
    marks = ",".join("?" * len(db_names))
    ev_marks = ",".join("?" * len(EVENT_TYPES))
    out = {"generatedAt": datetime.now(timezone.utc).isoformat(), "available": True, "workflows": {}}
    models = {w["name"]: w["model"] for w in workflows}

    runs = {}
    for wf, status, cost in con.execute(
        f"SELECT workflow_name, status, json_extract(metadata, '$.total_cost_usd') FROM remote_agent_workflow_runs WHERE workflow_name IN ({marks})", db_names
    ):
        runs.setdefault(canonical[wf], []).append((status, cost))

    rows = con.execute(
        f"""SELECT r.workflow_name, r.id, e.event_type, e.step_name,
                   json_extract(e.data, '$.timing.durationMs'), json_extract(e.data, '$.duration_ms'),
                   COALESCE(json_extract(e.data, '$.cost_usd'), json_extract(e.data, '$.spend.costUsd.value')),
                   json_extract(e.data, '$.aggregate'), json_extract(e.data, '$.failure_kind'),
                   json_extract(e.data, '$.iteration'), json_extract(e.data, '$.maxIterations'),
                   json_extract(e.data, '$.answer.decision'), json_extract(e.data, '$.waited_ms'),
                   json_extract(e.data, '$.cancel_reason'), json_extract(e.data, '$.exit_reason')
            FROM remote_agent_workflow_events e JOIN remote_agent_workflow_runs r ON r.id = e.workflow_run_id
            WHERE r.workflow_name IN ({marks}) AND e.event_type IN ({ev_marks})""",
        db_names + list(EVENT_TYPES),
    ).fetchall()
    con.close()

    per = {n: {"nodes": {}, "loops": {}, "pauses": {}, "cancel": {}, "failExit": {}, "nodeMs": 0, "waitMs": 0, "wfFailed": 0} for n in names}
    for wf, run, et, step, dur_a, dur_b, cost, aggregate, kind, iteration, max_it, decision, waited, cancel_reason, exit_reason in rows:
        p = per[canonical[wf]]
        if et == "workflow_cancelled":
            p["cancel"][cancel_reason or "unknown"] = p["cancel"].get(cancel_reason or "unknown", 0) + 1
            continue
        if et == "workflow_failed":
            p["wfFailed"] += 1
            p["failExit"][exit_reason or "unknown"] = p["failExit"].get(exit_reason or "unknown", 0) + 1
            continue
        if not step:
            continue
        rec = p["nodes"].setdefault(step, {"runs": 0, "completed": 0, "failures": 0, "skipped": 0, "dur": [], "cost": [], "kinds": {}, "aggregate": False})
        if et == "node_started":
            rec["runs"] += 1
        elif et == "node_skipped":
            rec["skipped"] += 1
        elif et in ("node_completed", "node_failed"):
            dur = dur_a if dur_a is not None else dur_b
            if et == "node_completed":
                rec["completed"] += 1
            else:
                rec["failures"] += 1
                rec["kinds"][kind or "unknown"] = rec["kinds"].get(kind or "unknown", 0) + 1
            if dur is not None:
                rec["dur"].append(dur)
            if aggregate:
                rec["aggregate"] = True
            else:
                if dur is not None:
                    p["nodeMs"] += dur
                if et == "node_completed" and cost is not None:
                    rec["cost"].append(cost)
        elif et == "loop_iteration_started":
            lp = p["loops"].setdefault(step, {"max": max_it, "byRun": {}})
            lp["max"] = max_it or lp["max"]
            lp["byRun"][run] = max(lp["byRun"].get(run, 0), iteration or 0)
        elif et == "wait_answered":
            ps = p["pauses"].setdefault(step, {"answers": {}, "waited": []})
            ps["answers"][decision or "(none)"] = ps["answers"].get(decision or "(none)", 0) + 1
        elif et == "wait_completed":
            ps = p["pauses"].setdefault(step, {"answers": {}, "waited": []})
            if waited is not None:
                ps["waited"].append(waited)
                p["waitMs"] += waited

    for w in workflows:
        name = w["name"]
        p = per[name]
        keys = {k: n for k, n in node_entries(w["model"].get("nodes", []))}
        include_ids = {k for k, n in keys.items() if "include" in n}
        nodes_out, included, legacy = {}, {}, []
        for step, rec in p["nodes"].items():
            summary_dur = summarize(rec["dur"])
            summary_cost = summarize(rec["cost"])
            entry = {
                "runs": rec["runs"], "completed": rec["completed"], "failures": rec["failures"], "skipped": rec["skipped"],
                "durTotal": summary_dur["sum"], "durMedian": summary_dur["median"], "durP90": summary_dur["p90"], "durMax": summary_dur["max"],
                "costSum": summary_cost["sum"], "costMean": summary_cost["mean"], "costMedian": summary_cost["median"], "costP90": summary_cost["p90"],
                "failureKinds": rec["kinds"], "aggregate": rec["aggregate"],
            }
            if step in keys:
                nodes_out[step] = entry
                continue
            owner = include_owner(step, include_ids)
            if owner:
                included.setdefault(owner, {})[step] = entry
            else:
                legacy.append(step)
        loops_out = {}
        for step, lp in p["loops"].items():
            if step not in keys:
                continue
            hist = {}
            for rounds in lp["byRun"].values():
                hist[str(rounds)] = hist.get(str(rounds), 0) + 1
            loops_out[step] = {"max": lp["max"], "hist": hist, "runs": len(lp["byRun"]), "capHits": sum(1 for r in lp["byRun"].values() if lp["max"] and r >= lp["max"])}
        pauses_out = {}
        for step, ps in p["pauses"].items():
            if step in keys:
                s = summarize(ps["waited"])
                pauses_out[step] = {"answers": ps["answers"], "waitedN": s["n"], "waitedMedian": s["median"], "waitedP90": s["p90"], "waitedMax": s["max"], "waitedSum": s["sum"]}
        run_list = runs.get(name, [])
        by_status = {}
        for status, _ in run_list:
            by_status[status] = by_status.get(status, 0) + 1
        costs = [c for _, c in run_list if c]
        out["workflows"][name] = {
            "runs": len(run_list), "byStatus": by_status, "runCost": summarize(costs),
            "nodeMs": p["nodeMs"], "waitMs": p["waitMs"], "wfFailed": p["wfFailed"], "failExit": p["failExit"], "cancelReasons": p["cancel"],
            "nodes": nodes_out, "included": included, "loops": loops_out, "pauses": pauses_out,
            "legacyNodes": len(legacy), "nodeSpend": sum(e["costSum"] for e in nodes_out.values() if not e["aggregate"]) + sum(e["costSum"] for inc in included.values() for e in inc.values() if not e["aggregate"]),
        }
    return out


def load_notes(workflows):
    """Per workflow: each node key's annotation (what / why, written for the page) and the YAML comment above it."""
    path = os.path.join(ROOT, "data", "annotations.json")
    annotations = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    notes, unannotated = {}, []
    for w in workflows:
        nodes = {}
        for key, node in node_entries(w["model"].get("nodes", [])):
            entry = dict(annotations.get(f"{w['name']}/{key}", {}))
            if node["id"] in w["comments"]:
                entry["comment"] = w["comments"][node["id"]]
            if "what" not in entry:
                unannotated.append(f"{w['name']}/{key}")
            if entry:
                nodes[key] = entry
        notes[w["name"]] = {"nodes": nodes, "nodesComment": w["nodesComment"]}
    if unannotated:
        print(f"note: {len(unannotated)} node(s) have no annotation in data/annotations.json: {', '.join(unannotated[:6])}", file=sys.stderr)
    return notes


def load_findings():
    """The findings to review, from data/findings.json; none when the file is absent."""
    path = os.path.join(ROOT, "data", "findings.json")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_findings_note():
    """A sentence or two shown above the findings, from data/findings-note.txt."""
    path = os.path.join(ROOT, "data", "findings-note.txt")
    if not os.path.exists(path):
        return ""
    with open(path, encoding="utf-8") as f:
        return f.read().strip()


def scope_of(workflow):
    return workflow["group"] if workflow["source"] == "personal" else f"repo/{workflow['repo']}"


def load_baseline(directory):
    """The workflows of a --baseline directory by name, and the ones in it that the current files no longer have."""
    paths = find_workflow_files(directory, baseline=True)
    if not paths:
        sys.exit(f"no workflow files under {directory}: expected personal/<name>/<name>.yaml or repo/<repo>/<name>/<name>.yaml")
    baseline = {}
    for path in paths:
        w = load_workflow(path, directory, baseline=True)
        if w["name"] in baseline:
            sys.exit(f"the baseline has two workflows named {w['name']}: {baseline[w['name']]['path']} and {w['path']}")
        baseline[w["name"]] = w
    return baseline


def load_baseline_config(directory):
    """DIR/baseline.json: {"label": TEXT, "out": FILE}, both optional. A missing file means no settings."""
    path = os.path.join(directory, "baseline.json")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        sys.exit(f'{path} must hold an object such as {{"label": "...", "out": "..."}}')
    return cfg


def removed_workflows(baseline, workflows):
    current = {w["name"] for w in workflows}
    return [
        {
            "name": w["name"], "scope": scope_of(w), "lines": w["lines"],
            "nodes": sum(1 for _ in node_entries(w["model"].get("nodes", []))), "inputs": len(w["inputs"] or {}),
        }
        for w in baseline.values() if w["name"] not in current
    ]


def load_file_rules():
    with open(os.path.join(ROOT, "data", "files.json"), encoding="utf-8") as f:
        return json.load(f)


def load_known_gaps():
    path = os.path.join(ROOT, "data", "known_gaps.json")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def js_json(obj):
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False, default=str)
    return text.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def read(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as f:
        return f.read()


def page_record(workflow):
    return {k: v for k, v in workflow.items() if k not in ("comments", "nodesComment")}


def build_page(workflows, stats, findings, notes, baseline=None, baseline_label=""):
    with open(os.path.join(ROOT, "data", "schema.json"), encoding="utf-8") as f:
        schema = json.load(f)
    meta = {
        "builtAt": stats["generatedAt"], "buildCommand": f"bash {os.path.join(ROOT, 'refresh.sh')}", "engineVersion": schema["engineVersion"],
        "baselineLabel": baseline_label if baseline else None,
    }
    workflows = [page_record(w) for w in workflows]
    baseline_records = {name: page_record(w) for name, w in baseline.items()} if baseline else None
    removed = removed_workflows(baseline, workflows) if baseline else []
    data = (
        f"const SCHEMA={js_json(schema)};\nconst WORKFLOWS={js_json(workflows)};\nconst STATS={js_json(stats)};\n"
        f"const FINDINGS={js_json(findings)};\nconst FINDINGS_NOTE={js_json(load_findings_note())};\nconst META={js_json(meta)};\nconst NOTES={js_json(notes)};\nconst KNOWN_GAPS={js_json(load_known_gaps())};\nconst FILE_RULES={js_json(load_file_rules())};\n"
        f"const BASELINE={js_json(baseline_records)};\nconst REMOVED={js_json(removed)};\n"
    )
    code = "\n".join(read(f"src/{m}.js") for m in MODULE_ORDER)
    if "</script" in code.lower():
        sys.exit("a source file contains a closing script tag")
    return (
        '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        "<title>Archon workflow playground</title>\n"
        f"<style>\n{read('src/style.css')}\n</style></head>\n"
        '<body><div id="app"></div>\n'
        f"<script>\n{data}</script>\n<script>\n{code}\n</script></body></html>\n"
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", help="the page to write (default: the playground page under the Archon home)")
    ap.add_argument("--dump", metavar="FILE", help="write the workflows and statistics as JSON and stop")
    ap.add_argument("--no-link", action="store_true", help="do not print the report URL")
    ap.add_argument("--baseline", metavar="DIR", help="compare with the workflows in DIR: personal/<name>/<name>.yaml and repo/<repo>/<name>/<name>.yaml")
    ap.add_argument("--label", metavar="TEXT", help="what the baseline is, shown on the page (default: the directory's name)")
    args = ap.parse_args()
    if args.label and not args.baseline:
        ap.error("--label needs --baseline")

    workflows = [load_workflow(p) for p in find_workflow_files()]
    baseline = load_baseline(args.baseline) if args.baseline else None
    cfg = load_baseline_config(args.baseline) if args.baseline else {}
    label = args.label or cfg.get("label") or (os.path.basename(os.path.normpath(args.baseline)) if args.baseline else "")
    out = args.out or (os.path.expanduser(cfg["out"]) if cfg.get("out") else DEFAULT_OUT)
    stats = collect_stats(workflows)
    if args.dump:
        dump = {"workflows": workflows, "stats": stats, "baseline": baseline, "baselineLabel": label if baseline else None, "removed": removed_workflows(baseline, workflows) if baseline else []}
        with open(args.dump, "w", encoding="utf-8") as f:
            json.dump(dump, f, default=str)
        return
    if args.baseline and out == DEFAULT_OUT:
        sys.exit('a baseline page needs --out or an "out" in baseline.json, because it would overwrite the main page')
    page = build_page(workflows, stats, load_findings(), load_notes(workflows), baseline, label)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(page)
    print(f"wrote {out} ({len(page.encode('utf-8')) / 1024:.0f} KiB, {len(workflows)} workflows)")
    if not args.no_link and out == DEFAULT_OUT:
        subprocess.run(["bash", os.path.join(ARCHON_HOME, "scripts", "report.sh"), "link", out], check=False)


if __name__ == "__main__":
    main()
