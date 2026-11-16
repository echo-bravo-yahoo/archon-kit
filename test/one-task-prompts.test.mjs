import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The research follow-up guidance and the build planner prompts share one rule: the owner's
// steering first, otherwise one run is one conceptual task. The prompts are checked for its key terms.
const here = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(here, "..", "workflows", "build", "build.yaml");
const RESEARCH = path.join(here, "..", "workflows", "research", "research.yaml");

const hasPyYaml = spawnSync("python3", ["-c", "import yaml"]).status === 0;
const opts = { skip: hasPyYaml ? false : "PyYAML is not installed" };

function node(file, id) {
  const script = `
import json, sys, yaml
def find(n, id):
    if isinstance(n, dict):
        if n.get("id") == id:
            return n
        for v in n.values():
            r = find(v, id)
            if r: return r
    elif isinstance(n, list):
        for v in n:
            r = find(v, id)
            if r: return r
n = find(yaml.safe_load(open(sys.argv[1])), sys.argv[2])
print(json.dumps(n))
`;
  const r = spawnSync("python3", ["-I", "-c", script, file, id], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const n = JSON.parse(r.stdout);
  assert.ok(n, `node ${id} exists in ${path.basename(file)}`);
  return n;
}
const prompt = (file, id) => node(file, id).prompt.replace(/\s+/g, " ");

const STEERING = /owner'?s steering/i;
const TASK = /one conceptual task/i;
const SCOPE = /## Scope of this run/;
const REPO = /lands only the repository it runs in|one follow-up entry (for|per) each repository/i;

test("the research prompt states the one-task rule", opts, () => {
  const p = prompt(RESEARCH, "research");
  for (const re of [STEERING, TASK, /dig-deeper/, /at most five/i, /not taken this run/i, REPO]) {
    assert.match(p, re);
  }
});

test("the research prompt no longer splits follow-ups by place", opts, () => {
  assert.doesNotMatch(prompt(RESEARCH, "research"), /spans several places/);
});

test("the research follow_ups list keeps its cap of five", opts, () => {
  const fu = node(RESEARCH, "research").output_format.properties.follow_ups;
  assert.equal(fu.maxItems, 5);
});

for (const id of ["approach", "spec"]) {
  test(`the build ${id} prompt states the one-task and scope rule`, opts, () => {
    const p = prompt(BUILD, id);
    for (const re of [STEERING, TASK, SCOPE, REPO]) assert.match(p, re);
  });
}

test("the build spec prompt asks for a summary that opens the plan page", opts, () => {
  const spec = node(BUILD, "spec");
  const p = prompt(BUILD, "spec");
  for (const re of [
    /at most seven plain sentences/,
    /in two paragraphs/,
    /first paragraph is two sentences of under 350 characters in all: what the work is in the owner's terms, then why it is wanted/,
    /pause message prints only that paragraph/,
    /second paragraph gives the work item by item/,
    /what approve starts/,
    /by name/,
    /the decision you ask/,
    /pick or propose work, put the items in the second paragraph, each with its reason/,
  ]) {
    assert.match(p, re);
  }
  assert.equal(spec.output_format.properties.summary.type, "string");
  assert.ok(spec.output_format.required.includes("summary"));
});

test("the nodes keep their ids", opts, () => {
  node(RESEARCH, "research");
  node(BUILD, "approach");
  node(BUILD, "spec");
});
