const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const m = require("../src/model.js");
const { loadDump, wf } = require("./load.js");

test("node counts include loop bodies and exclude include expansion", () => {
  const w = wf([
    { id: "a", bash: "x" },
    { id: "cycle", depends_on: ["a"], loop_group: { max_iterations: 2, until_bash: "true", nodes: [{ id: "b", bash: "x" }, { id: "c", depends_on: ["b"], bash: "x" }] } },
    { id: "inc", depends_on: ["cycle"], include: "child" },
  ]);
  assert.strictEqual(m.countNodes(w), 5, "a, cycle, its two body nodes and the include itself");
});

test("addNode uses the template, a unique id and the chosen scope", () => {
  const w = wf([{ id: "bash", bash: "echo" }, { id: "loop", loop_group: { nodes: [{ id: "a", bash: "x" }], max_iterations: 2, until_bash: "true" } }]);
  const a = m.addNode(w, "bash", null);
  assert.strictEqual(a.node.id, "bash_2");
  const b = m.addNode(w, "wait", "loop");
  assert.strictEqual(b.key, "loop.wait");
  assert.deepStrictEqual(Object.keys(b.node), ["id", "wait"]);
  const g = m.addNode(w, "loop_group", null);
  assert.ok(g.node.loop_group.nodes.length >= 1);
});

test("edges: add, duplicate, cross-scope refusal and removal", () => {
  const w = wf([{ id: "a", bash: "x" }, { id: "b", bash: "y" }, { id: "g", loop_group: { nodes: [{ id: "c", bash: "z" }], max_iterations: 1, until_bash: "true" } }]);
  assert.ok(m.addEdge(w, "a", "b").ok);
  assert.deepStrictEqual(w.nodes[1].depends_on, ["a"]);
  assert.ok(!m.addEdge(w, "a", "b").ok);
  assert.ok(!m.addEdge(w, "a", "g.c").ok);
  assert.ok(!m.addEdge(w, "a", "a").ok);
  assert.ok(m.removeEdge(w, "a", "b"));
  assert.strictEqual(w.nodes[1].depends_on, undefined);
});

test("deleteNode drops edges to the node and reports references left behind", () => {
  const w = wf([{ id: "a", bash: "echo" }, { id: "b", depends_on: ["a"], bash: "echo $a.output" }, { id: "c", depends_on: ["a", "b"], when: "$a.output == 'x'", bash: "z" }]);
  const r = m.deleteNode(w, "a");
  assert.strictEqual(w.nodes.length, 2);
  assert.strictEqual(w.nodes[0].depends_on, undefined);
  assert.deepStrictEqual(w.nodes[1].depends_on, ["b"]);
  assert.deepStrictEqual(r.dangling.map((d) => d.key).sort(), ["b", "c"]);
});

test("renameNode rewrites dependencies, references and conditions", () => {
  const w = wf([{ id: "a", bash: "echo" }, { id: "b", depends_on: ["a"], when: "$a.output == 'x'", bash: "echo $a.output $a.output.f" }]);
  const r = m.renameNode(w, "a", "first");
  assert.strictEqual(r.key, "first");
  assert.deepStrictEqual(w.nodes[1].depends_on, ["first"]);
  assert.strictEqual(w.nodes[1].when, "$first.output == 'x'");
  assert.strictEqual(w.nodes[1].bash, "echo $first.output $first.output.f");
  assert.ok(!m.renameNode(w, "first", "b").ok);
});

test("collectRefs finds node outputs, loop-prev outputs and inputs in text and conditions", () => {
  const refs = m.collectRefs({ id: "x", bash: "d=$settings.output; echo $INPUTS.base $LOOP_PREV.r.output.t", when: "$ready.output == 'pause' && $INPUTS.flag == 'on'" });
  assert.deepStrictEqual(refs.nodes.map((r) => r.id + (r.loopPrev ? "^" : "") + ":" + r.via).sort(), ["r^:text", "ready:when", "settings:text"]);
  assert.deepStrictEqual(refs.inputs.map((i) => i.name).sort(), ["base", "flag"]);
});

test("topoOrder orders by dependency and reports a cycle", () => {
  const ok = m.topoOrder([{ id: "b", depends_on: ["a"] }, { id: "a" }]);
  assert.deepStrictEqual(ok.order, ["a", "b"]);
  const bad = m.topoOrder([{ id: "a", depends_on: ["b"] }, { id: "b", depends_on: ["a"] }, { id: "c" }]);
  assert.deepStrictEqual(bad.cycle, ["a", "b"]);
});

test("build.py --dump with a baseline lists the workflows the current files no longer have", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-baseline-"));
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  try {
    const kept = loadDump().workflows[0];
    const ghost = "name: ghost\ninputs:\n  x:\n    default: 1\n  y:\n    default: 2\nnodes:\n  - id: a\n    bash: echo\n  - id: g\n    loop_group:\n      max_iterations: 2\n      until_bash: 'true'\n      nodes:\n        - id: c\n          bash: echo\n";
    const gone = "name: gone\nnodes:\n  - id: a\n    bash: echo\n";
    put(`personal/${kept.name}/${kept.name}.yaml`, `name: ${kept.name}\nnodes:\n  - id: a\n    bash: echo\n`);
    put("personal/ghost/ghost.yaml", ghost);
    put("repo/zed/gone/gone.yaml", gone);
    put("scripts/tests/not-a-workflow.yaml", "name: not-a-workflow\nnodes: []\n");
    const out = path.join(dir, "dump.json");
    const run = spawnSync("python3", [path.join(__dirname, "..", "build.py"), "--dump", out, "--baseline", dir, "--label", "fixture"], { encoding: "utf8" });
    assert.strictEqual(run.status, 0, run.stderr);
    const dump = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.strictEqual(dump.baselineLabel, "fixture");
    assert.deepStrictEqual(dump.removed.map((r) => [r.name, r.scope, r.lines, r.nodes, r.inputs]), [["ghost", "personal", ghost.split("\n").length - 1, 3, 2], ["gone", "repo/zed", gone.split("\n").length - 1, 1, 0]]);
    assert.deepStrictEqual(Object.keys(dump.baseline).sort(), ["ghost", "gone", kept.name].sort());
    assert.strictEqual(dump.baseline.gone.repo, "zed");
    assert.ok(!dump.removed.some((r) => r.name === kept.name));
    assert.strictEqual(dump.workflows.length, loadDump().workflows.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("build.py without --baseline dumps no baseline, and an empty baseline directory is refused", () => {
  const plain = loadDump();
  assert.strictEqual(plain.baseline, null);
  assert.deepStrictEqual(plain.removed, []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-baseline-"));
  try {
    const run = spawnSync("python3", [path.join(__dirname, "..", "build.py"), "--dump", path.join(dir, "dump.json"), "--baseline", dir], { encoding: "utf8" });
    assert.notStrictEqual(run.status, 0);
    assert.match(run.stderr, /no workflow files under/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
