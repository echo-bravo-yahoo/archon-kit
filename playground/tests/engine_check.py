#!/usr/bin/env python3
"""Checks the page's YAML emitter and validator against the Archon engine at localhost:3090.

usage: engine_check.py [--write-gaps] [-v]

"The engine" is both checks: POST /api/workflows/validate and `archon validate workflows`. A mutation counts as accepted only when both accept it.

1. For each workflow: emit the YAML with tests/emit.js, check that yaml.safe_load of the
   emitted text equals yaml.safe_load of the original, and that both engine checks accept it.
2. Apply a corpus of mutations and compare the page's error verdict with the engine's.
Disagreements are listed; --write-gaps records the ones that remain in data/known_gaps.json, which
build.py embeds as the page's "Known gaps".
"""

import copy
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import build  # noqa: E402

ENGINE = os.environ.get("ARCHON_URL", "http://localhost:3090")
FIXTURES = os.path.join(HERE, "fixtures")


def engine_validate(defn):
    req = urllib.request.Request(
        ENGINE + "/api/workflows/validate", data=json.dumps({"definition": defn}).encode(), headers={"Content-Type": "application/json"}
    )
    try:
        body = json.loads(urllib.request.urlopen(req, timeout=30).read())
    except urllib.error.HTTPError as e:
        body = json.loads(e.read() or b"{}")
    return bool(body.get("valid")), body.get("errors", [])


CLI_DIR = None


def cli_validate(model):
    """Runs `archon validate workflows` (the check the owner runs) on one workflow; returns (valid, errors)."""
    global CLI_DIR
    if not model.get("name"):
        return True, []
    if CLI_DIR is None:
        CLI_DIR = tempfile.mkdtemp(prefix="archon-check-")
        subprocess.run(["git", "init", "-q"], cwd=CLI_DIR, check=True)
        os.makedirs(os.path.join(CLI_DIR, ".archon", "workflows"))
    m = copy.deepcopy(model)
    m["name"] = "chk-" + m["name"]
    with open(os.path.join(CLI_DIR, ".archon", "workflows", m["name"] + ".yaml"), "w") as f:
        f.write(emit(m))
    r = subprocess.run(["archon", "validate", "workflows", m["name"]], cwd=CLI_DIR, capture_output=True, text=True, timeout=120)
    errors = re.findall(r"^\s+ERROR \[[^\]]*\] (.*)$", r.stdout, re.M)
    return not errors, errors


def emit(model):
    r = subprocess.run(["node", os.path.join(HERE, "emit.js")], input=json.dumps(model), capture_output=True, text=True, check=True)
    return r.stdout


def page_issues(models):
    r = subprocess.run(["node", os.path.join(HERE, "verdict.js")], input=json.dumps(models), capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def find(m, node_id):
    def walk(nodes):
        for n in nodes:
            if n["id"] == node_id:
                return n
            body = (n.get("loop_group") or {}).get("nodes") if isinstance(n.get("loop_group"), dict) else None
            if body:
                hit = walk(body)
                if hit:
                    return hit
        return None

    return walk(m["nodes"])


def body_of(m, loop_id):
    return find(m, loop_id)["loop_group"]["nodes"]


def mut(name, wf, fn):
    return (name, wf, fn)


def setk(node_id, key, value):
    def f(m):
        find(m, node_id)[key] = value

    return f


def delk(node_id, key):
    def f(m):
        find(m, node_id).pop(key, None)

    return f


def addnode(node, loop=None):
    def f(m):
        (body_of(m, loop) if loop else m["nodes"]).append(copy.deepcopy(node))

    return f


def remove_node(node_id):
    def f(m):
        m["nodes"] = [n for n in m["nodes"] if n["id"] != node_id]

    return f


def dep_add(node_id, dep):
    def f(m):
        n = find(m, node_id)
        n["depends_on"] = list(n.get("depends_on", [])) + [dep]

    return f


def dep_del(node_id, dep):
    def f(m):
        n = find(m, node_id)
        n["depends_on"] = [d for d in n.get("depends_on", []) if d != dep]

    return f


def setwait(node_id, **kw):
    def f(m):
        find(m, node_id)["wait"] = kw

    return f


def setdeep(node_id, path, value):
    def f(m):
        cur = find(m, node_id)
        for p in path[:-1]:
            cur = cur[p]
        cur[path[-1]] = value

    return f


MUTATIONS = [
    mut("delete a node that others depend on", "deploy-staging", remove_node("build")),
    mut("drop a dependency but keep $x.output in the text", "build", dep_del("intake", "settings")),
    mut("text reads $ghost.output, a node that does not exist", "deploy-staging", setk("verify", "bash", "echo $ghost.output")),
    mut("add an edge that creates a cycle", "deploy-staging", dep_add("prerequisites", "verify")),
    mut("a node depends on itself", "deploy-staging", dep_add("build", "build")),
    mut("depends_on names a missing node", "deploy-staging", dep_add("verify", "nope")),
    mut("when with an unclosed quote", "deploy-staging", setk("deploy", "when", "$ready.output.decision == 'deploy")),
    mut("when with parentheses", "deploy-staging", setk("deploy", "when", "($ready.output.decision == 'deploy')")),
    mut("when with double quotes", "deploy-staging", setk("deploy", "when", '$ready.output.decision == "deploy"')),
    mut("when reads an unknown node", "deploy-staging", setk("verify", "when", "$ghost.output == 'x'")),
    mut("when reads a node that is not a dependency", "deploy-staging", setk("prerequisites", "when", "$verify.output == 'x'")),
    mut("when compares the whole output of an AI node", "research", lambda m: (dep_add("follow_up", "research")(m), setk("follow_up", "when", "$research.output == 'x'")(m))),
    mut("when reads a field of an AI node with no output_format", "check-later", delk("verify", "output_format")),
    mut("$LOOP_PREV in a when outside a loop", "deploy-staging", setk("verify", "when", "$LOOP_PREV.deploy.output == 'x'")),
    mut("$LOOP_PREV names a node outside the body", "build", lambda m: find(m, "plan_round").__setitem__("when", "$LOOP_PREV.settings.output == 'x'")),
    mut("nested shorthand in a when", "deploy-staging", setk("verify", "when", "$ready.a.b == 'x'")),
    mut("a numeric operator with a text literal", "deploy-staging", setk("verify", "when", "$ready.output.decision > 'x'")),
    mut("duplicate id at the top level", "deploy-staging", addnode({"id": "verify", "bash": "echo"})),
    mut("an id used in a loop body and at the top level", "build", addnode({"id": "settings", "bash": "echo"}, "plan_cycle")),
    mut("timeout on a prompt node", "research", setk("research", "timeout", 1000)),
    mut("with on a bash node", "deploy-staging", setk("checkout", "with", {"a": "b"})),
    mut("two type keys on one node", "deploy-staging", setk("checkout", "prompt", "hello")),
    mut("retry on a loop_group", "build", setk("plan_cycle", "retry", {"max_attempts": 2})),
    mut("retry on a wait node", "deploy-staging", setk("ready", "retry", {"max_attempts": 2})),
    mut("output_format on a wait node", "deploy-staging", setk("ready", "output_format", {"type": "object"})),
    mut("always_run on a wait node", "deploy-staging", setk("ready", "always_run", True)),
    mut("mutates_checkout on an include node inside a loop body", "build", setdeep("review", ["mutates_checkout"], False)),
    mut("mutates_checkout on a top-level include node", "deploy-staging", addnode({"id": "inc", "include": "review-change", "depends_on": ["verify"], "mutates_checkout": False})),
    mut("retry on a wait node inside a loop body", "build", setdeep("plan_gate", ["retry"], {"max_attempts": 2})),
    mut("with on a bash node inside a loop body", "build", setdeep("plan_round", ["with"], {"a": "b"})),
    mut("timeout on a prompt node inside a loop body", "build", setdeep("spec", ["timeout"], 1000)),
    mut("output_format on a wait node inside a loop body", "build", setdeep("plan_gate", ["output_format"], {"type": "object"})),
    mut("always_run on a wait node inside a loop body", "build", setdeep("plan_gate", ["always_run"], True)),
    mut("two type keys inside a loop body", "build", setdeep("plan_round", ["prompt"], "hello")),
    mut("a when that does not parse inside a loop body", "build", setdeep("spec", ["when"], "($plan_round.output == 'plan')")),
    mut("until_field on a loop_group", "build", setdeep("plan_cycle", ["loop_group", "until_field"], "done")),
    mut("select form without options", "deploy-staging", setwait("ready", attention="ok?", form="select")),
    mut("approval form with options", "deploy-staging", setwait("ready", attention="ok?", form="approval", options=[{"id": "a"}])),
    mut("option id with capitals", "deploy-staging", setwait("ready", attention="ok?", form="select", options=[{"id": "Go On"}])),
    mut("duplicate option ids", "deploy-staging", setwait("ready", attention="ok?", form="select", options=[{"id": "go"}, {"id": "go"}])),
    mut("two pauses that can run at the same time", "deploy-staging", addnode({"id": "ready2", "wait": {"attention": "again?", "form": "approval"}})),
    mut("a node that depends on the pause in a loop body", "build", addnode({"id": "after", "depends_on": ["plan_gate"], "bash": "echo"}, "plan_cycle")),
    mut("a second terminal node beside the pause in a loop body", "build", addnode({"id": "extra", "bash": "echo"}, "plan_cycle")),
    mut("a workflow node in a loop body", "build", addnode({"id": "child", "workflow": "other"}, "plan_cycle")),
    mut("a node with no type key", "deploy-staging", addnode({"id": "bare"})),
    mut("the reserved id INPUTS", "deploy-staging", addnode({"id": "INPUTS", "bash": "echo"})),
    mut("an unknown trigger_rule", "deploy-staging", setk("verify", "trigger_rule", "sometimes")),
    mut("a model list with one entry", "research", setk("research", "model", ["sonnet"])),
    mut("AI fields on a bash node", "deploy-staging", setk("checkout", "model", "opus")),
    mut("loop_group without a completion channel", "build", lambda m: find(m, "plan_cycle")["loop_group"].pop("until_bash")),
    mut("loop_group with max_iterations 0", "build", setdeep("plan_cycle", ["loop_group", "max_iterations"], 0)),
    mut("loop_group with no nodes", "build", setdeep("plan_cycle", ["loop_group", "nodes"], [])),
    mut("script without a runtime", "deploy-staging", addnode({"id": "s", "script": "print(1)"})),
    mut("script with runtime node", "deploy-staging", addnode({"id": "s", "script": "print(1)", "runtime": "node"})),
    mut("a misspelled key on a node", "deploy-staging", setk("verify", "depends_onn", ["deploy"])),
    mut("an empty bash", "deploy-staging", setk("checkout", "bash", "")),
    mut("a negative idle_timeout", "research", setk("research", "idle_timeout", -5)),
    mut("an unknown effort", "research", setk("research", "effort", "extreme")),
    mut("maxBudgetUsd 0", "research", setk("research", "maxBudgetUsd", 0)),
    mut("a command name with a path", "deploy-staging", addnode({"id": "c", "command": "../x"})),
    mut("an empty cancel reason", "build", addnode({"id": "abort", "cancel": ""})),
    mut("include fan_out without as", "build", setdeep("review", ["fan_out"], {"items": "$settings.output"})),
    mut("approval with decisions and on_reject", "deploy-staging", addnode({"id": "ap", "approval": {"message": "ok?", "decisions": [{"id": "a"}], "on_reject": {"prompt": "x"}}, "depends_on": ["verify"]})),
    mut("context.resume on a bash node", "deploy-staging", setk("checkout", "context", {"resume": "prerequisites"})),
    mut("wait.until that is not a time", "check-later", setwait("hold", until="tomorrow")),
    mut("a loop node with no completion channel", "deploy-staging", addnode({"id": "lp", "loop": {"prompt": "x", "max_iterations": 2}})),
    mut("loop.until_field not declared in output_format", "deploy-staging", addnode({"id": "lp", "loop": {"prompt": "x", "max_iterations": 2, "until_field": "done"}})),
    mut("output_format on a bash node", "deploy-staging", setk("checkout", "output_format", {"type": "object", "properties": {"a": {"type": "string"}}})),
    mut("a workflow with no description", "deploy-staging", lambda m: m.pop("description")),
    mut("a workflow with an empty name", "deploy-staging", lambda m: m.__setitem__("name", "")),
    mut("depends_on that is not a list", "deploy-staging", setk("verify", "depends_on", "deploy")),
    mut("a wait that mixes shapes", "deploy-staging", setwait("ready", duration_ms=5, attention="ok?")),
    mut("a wait with a negative duration", "deploy-staging", addnode({"id": "w", "wait": {"duration_ms": -5}, "depends_on": ["verify"]})),
    mut("an include with a with binding", "build", setdeep("review", ["with"], {"base": "$INPUTS.base"})),
    mut("an undeclared $INPUTS name", "deploy-staging", setk("verify", "bash", "echo $INPUTS.nope")),
    mut("a loop body node reading an outer node it does not depend on", "build", setdeep("plan_round", ["bash"], "echo $sync_base.output")),
    mut("a $LOOP_PREV reference in bash text outside a loop", "deploy-staging", setk("verify", "bash", "echo $LOOP_PREV.deploy.output")),
]


def main():
    write_gaps = "--write-gaps" in sys.argv
    verbose = "-v" in sys.argv
    workflows = {w["name"]: w["model"] for w in (build.load_workflow(p) for p in build.find_workflow_files())}
    for p in sorted(glob.glob(os.path.join(FIXTURES, "*.yaml"))):
        with open(p) as f:
            model = yaml.safe_load(f)
        workflows[model["name"]] = model
    failures = 0

    print("== round trip and engine acceptance")
    for name, model in workflows.items():
        text = emit(model)
        same = yaml.safe_load(text) == model
        valid, errors = engine_validate(yaml.safe_load(text))
        cli_valid, cli_errors = cli_validate(yaml.safe_load(text))
        ok = same and valid and cli_valid
        failures += 0 if ok else 1
        print(f"  {'ok  ' if ok else 'FAIL'} {name}: round trip {'equal' if same else 'DIFFERENT'}, endpoint {'accepts' if valid else 'rejects ' + str(errors)}, archon validate workflows {'accepts' if cli_valid else 'rejects ' + str(cli_errors)}")

    print(f"== {len(MUTATIONS)} mutations: page verdict against engine verdict")
    mutated = []
    for name, wf, fn in MUTATIONS:
        m = copy.deepcopy(workflows[wf])
        fn(m)
        mutated.append(m)
    issues = page_issues(mutated)
    gaps = []
    notes = []
    agree = 0
    for (name, wf, fn), m, iss in zip(MUTATIONS, mutated, issues):
        valid, errors = engine_validate(m)
        cli_valid, cli_errors = cli_validate(m)
        if valid and not cli_valid:
            notes.append({"rule": name, "kind": "endpoint", "note": f"POST /api/workflows/validate accepts this, but archon validate workflows rejects it: {cli_errors[0][:200]}"})
        valid, errors = valid and cli_valid, errors + cli_errors
        page_errors = [i for i in iss if i["severity"] == "error"]
        page_valid = not page_errors
        if page_valid == valid:
            agree += 1
            if verbose:
                print(f"  ok   {name}: both {'accept' if valid else 'reject'}")
            continue
        who = "engine rejects, page accepts" if not valid else "page rejects, engine accepts"
        print(f"  DIFF {name} [{wf}]: {who}")
        print(f"       engine: {errors[0][:220] if errors else 'valid'}")
        print(f"       page:   {'; '.join(i['rule'] + ': ' + i['message'][:110] for i in page_errors) or 'no errors (' + ', '.join(i['severity'] + ':' + i['rule'] for i in iss) + ')'}")
        gaps.append({"rule": name, "kind": "gap", "note": f"{who}. Engine: {(errors[0] if errors else 'valid')[:200]}"})
    notes.append({"rule": "mutates_checkout on an include node", "kind": "engine", "note": "The engine rejects it on a top-level include node and accepts it inside a loop body. The page flags it as an error only at the top level."})
    print(f"== {agree} of {len(MUTATIONS)} mutations agree; {len(gaps)} disagree")
    for n in notes:
        print(f"  NOTE {n['rule']}: {n['note']}")
    if write_gaps:
        with open(os.path.join(ROOT, "data", "known_gaps.json"), "w") as f:
            json.dump(gaps + notes, f, indent=1)
        print(f"wrote data/known_gaps.json with {len(gaps) + len(notes)} entries")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
