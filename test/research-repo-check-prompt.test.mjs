import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Proves the `research` prompt carries the instruction to list tracked files before `repo` is set,
// and that the instruction is ordered ahead of the repo choice. It does not prove a model follows it.
const here = path.dirname(fileURLToPath(import.meta.url));
const RESEARCH = path.join(here, "..", "workflows", "research", "research.yaml");

const hasPyYaml = spawnSync("python3", ["-c", "import yaml"]).status === 0;
const skip = hasPyYaml ? false : "PyYAML is not installed";

const script = `
import json, sys, yaml
ids = []
prompts = {}
def walk(n):
    if isinstance(n, dict):
        if "id" in n:
            ids.append(n["id"])
            if "prompt" in n:
                prompts[n["id"]] = n["prompt"]
        for v in n.values():
            walk(v)
    elif isinstance(n, list):
        for v in n:
            walk(v)
walk(yaml.safe_load(open(sys.argv[1])))
print(json.dumps({"ids": ids, "prompts": prompts}))
`;

let parsed = null;
const load = () => {
  if (!parsed) {
    const r = spawnSync("python3", ["-c", script, RESEARCH], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    parsed = JSON.parse(r.stdout);
  }
  return parsed;
};
const prompt = () => load().prompts.research.replace(/\s+/g, " ").toLowerCase();

test("the research prompt tells the researcher to list tracked files with git ls-files", { skip }, () => {
  const p = prompt();
  assert.match(p, /git[^.]*ls-files/);
  assert.match(p, /tracked files/);
});

test("the listing comes before the sentence that chooses build with repo empty", { skip }, () => {
  const p = prompt();
  const list = p.indexOf("ls-files");
  const choose = p.indexOf("choose `build` with `repo` empty");
  assert.ok(list >= 0, "prompt mentions ls-files");
  assert.ok(choose >= 0, "prompt still has the repo-empty sentence");
  assert.ok(list < choose, "the check precedes the repo choice");
});

test("a file this repository tracks stays in this repository with repo empty", { skip }, () => {
  const p = prompt();
  const list = p.indexOf("ls-files");
  assert.ok(list >= 0, "prompt mentions ls-files");
  const after = p.slice(list);
  assert.ok(after.includes("this repository tracks"));
  assert.ok(after.includes("stays empty"));
});

test("the prompt covers a first directory that has the name of a candidate repository", { skip }, () => {
  const p = prompt();
  assert.match(p, /first directory/);
  assert.match(p, /same as the name of a repository|matches? [^.]*name/);
});

test("repo is set only for files tracked in the candidate and not in this repository", { skip }, () => {
  assert.match(prompt(), /only for files that are tracked in the candidate and not in this repository|tracked in [^.]* and not in this one/);
});

test("the note names the evidence", { skip }, () => {
  const p = prompt();
  assert.ok(/note[\s\S]{0,200}evidence|evidence[\s\S]{0,200}note/.test(p), "note and evidence appear close together");
});

test("the node ids are unchanged, so a paused run keeps working", { skip }, () => {
  const ids = [...fs.readFileSync(RESEARCH, "utf8").matchAll(/^ *- id: *(\S+)/gm)].map((m) => m[1]).sort();
  const expected = ["candidates", "research_cycle", "round", "research", "follow_plan", "report_page", "notice", "decision", "follow_up", "sync_base"].sort();
  assert.deepEqual(ids, expected);
});

test("the prompt keeps its unrelated follow-up sentences", { skip }, () => {
  const p = prompt();
  assert.ok(p.includes("choose `check-later` when the research leaves a claim"));
  assert.ok(p.includes("return an empty array when no file can be changed by a listed workflow"));
});
