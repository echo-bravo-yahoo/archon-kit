const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const { toYaml, diffWorkflows, yamlString, baselineStatus, baselineRows } = require("../src/yaml.js");
const { loadDump, wf } = require("./load.js");

// Parses YAML text with PyYAML and returns the JSON of the result.
function pyLoad(text) {
  const r = spawnSync("python3", ["-c", "import sys, json, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read()), default=str))"], { input: text, encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("string rules: first the one that applies", () => {
  assert.strictEqual(yamlString(" lead").kind, "quoted");
  assert.strictEqual(yamlString("a\tb").kind, "quoted");
  assert.strictEqual(yamlString("a\r").kind, "quoted");
  assert.strictEqual(yamlString("a\nb").kind, "block");
  assert.strictEqual(yamlString("hello world").kind, "plain");
  assert.strictEqual(yamlString("$a.output").kind, "plain");
  for (const s of ["true", "false", "null", "yes", "no", "on", "off", "~", "123", "1.5", "2026-11-03", "@alias", "-x", "a: b", "a #b", "trail "]) {
    assert.strictEqual(yamlString(s).kind, "quoted", s);
  }
});

test("a hard corpus of strings survives a round trip through PyYAML", () => {
  const strings = [
    "plain", "with: colon", "# hash", "a #b", "- dash", "@alias", "true", "Null", "~", "0x1F", "1_000", "12:30", "2026-11-03", "1e3", ".5", ".inf",
    "line1\nline2", "line1\nline2\n", "line1\nline2\n\n", "line1\n\nline3", "\nleading blank", "  indented\nmore", "x\n  indented second",
    "trailing space ", " leading space", "tab\there", "cr\rhere", "quote ' and \"", "back\\slash", "unicode é ☃", "ctl \u0001", "ls x", "[flow]", "{a}",
    "$id.output.field", "a,b", "-", "?", "", " ", "\n", "key: |\n  nested", "---", "...", "! tag", "& anchor", "* alias", "%dir", "`tick",
  ];
  const w = wf([{ id: "a", bash: "echo", list: strings, map: Object.fromEntries(strings.map((s, i) => ["k" + i, s])) }]);
  const text = toYaml(w);
  const back = pyLoad(text);
  assert.deepStrictEqual(back.nodes[0].list, strings);
  assert.deepStrictEqual(back.nodes[0].map, w.nodes[0].map);
});

test("keys that are not plain are quoted", () => {
  const w = wf([{ id: "a", bash: "x", with: { "a b": "1", "true": "2", "x:y": "3", "12": "4" } }]);
  assert.deepStrictEqual(pyLoad(toYaml(w)).nodes[0].with, { "a b": "1", true: "2", "x:y": "3", 12: "4" });
});

test("scalar lists of at most 80 characters use flow style, longer lists and empty collections do not", () => {
  const w = wf([{ id: "a", bash: "x", short: ["a", "b"], empty: [], none: {}, long: Array.from({ length: 12 }, (_, i) => "item-number-" + i) }]);
  const text = toYaml(w);
  assert.match(text, /short: \[a, b\]/);
  assert.match(text, /empty: \[\]/);
  assert.match(text, /none: \{\}/);
  assert.match(text, /long:\n {6}- item-number-0/);
  assert.deepStrictEqual(pyLoad(text).nodes[0].long, w.nodes[0].long);
});

test("a flow list item that holds a comma or bracket is quoted", () => {
  const w = wf([{ id: "a", bash: "x", t: ["Write(a,b)", "[x]"] }]);
  assert.deepStrictEqual(pyLoad(toYaml(w)).nodes[0].t, ["Write(a,b)", "[x]"]);
});

test("a node keeps its own key order and a node new to the snapshot gets the canonical order", () => {
  const snap = wf([{ id: "a", bash: "x", mutates_checkout: false }]);
  const edited = JSON.parse(JSON.stringify(snap));
  edited.nodes[0].depends_on = ["z"];
  edited.nodes.push({ bash: "y", model: "opus", when: "$a.output == 'x'", id: "n", depends_on: ["a"], trigger_rule: "all_done" });
  const text = toYaml(edited, snap);
  const lines = text.split("\n");
  const first = lines.slice(lines.indexOf("  - id: a"), lines.indexOf("  - id: n"));
  assert.deepStrictEqual(first.map((l) => l.trim().split(":")[0]).filter(Boolean), ["- id", "bash", "mutates_checkout", "depends_on"]);
  const second = text.slice(text.indexOf("  - id: n"));
  assert.deepStrictEqual(second.split("\n").filter(Boolean).map((l) => l.trim().replace(/^- /, "").split(":")[0]), ["id", "depends_on", "when", "trigger_rule", "model", "bash"]);
});

test("every real workflow reloads to the same structure", () => {
  for (const w of loadDump().workflows) {
    const back = pyLoad(toYaml(w.model));
    assert.deepStrictEqual(back, JSON.parse(JSON.stringify(w.model, (k, v) => v)), w.name);
  }
});

test("diff lists nodes, edges, conditions and fields, with a line diff of changed text", () => {
  const before = wf([{ id: "a", bash: "one\ntwo\nthree" }, { id: "b", depends_on: ["a"], when: "$a.output == 'x'", prompt: "p" }, { id: "gone", bash: "z" }], { description: "d" });
  const after = JSON.parse(JSON.stringify(before));
  after.nodes[0].bash = "one\n2\nthree";
  after.nodes[1].depends_on = [];
  delete after.nodes[1].depends_on;
  after.nodes[1].when = "$a.output == 'y'";
  after.nodes[1].model = "opus";
  after.nodes.splice(2, 1);
  after.nodes.push({ id: "fresh", depends_on: ["a"], bash: "n" });
  after.description = "changed";
  const d = diffWorkflows(before, after);
  assert.deepStrictEqual(d.nodesAdded, ["fresh"]);
  assert.deepStrictEqual(d.nodesRemoved, ["gone"]);
  assert.deepStrictEqual(d.edgesAdded, [{ from: "a", to: "fresh" }]);
  assert.deepStrictEqual(d.edgesRemoved, [{ from: "a", to: "b" }]);
  assert.deepStrictEqual(d.conditions, [{ key: "b", before: "$a.output == 'x'", after: "$a.output == 'y'" }]);
  const bash = d.fields.find((f) => f.key === "a" && f.field === "bash");
  assert.deepStrictEqual(bash.lines.filter((l) => l.op !== " ").map((l) => l.op + l.text), ["-two", "+2"]);
  assert.ok(d.fields.some((f) => f.key === "b" && f.field === "model"));
  assert.deepStrictEqual(d.workflow.map((f) => f.field), ["description"]);
  assert.strictEqual(d.empty, false);
  assert.strictEqual(diffWorkflows(before, before).empty, true);
});

function record(name, nodes, extra) {
  return Object.assign({ name, source: "personal", repo: null, lines: 10, inputs: {}, model: wf(nodes, { name }) }, extra || {});
}

test("a workflow stands against the baseline as added, removed, moved, changed or unchanged", () => {
  const nodes = [{ id: "a", bash: "x" }, { id: "g", loop_group: { nodes: [{ id: "c", bash: "z" }], max_iterations: 2, until_bash: "true" } }];
  const base = record("w", nodes);
  assert.strictEqual(baselineStatus(null, base), "added");
  assert.strictEqual(baselineStatus(base, null), "removed");
  assert.strictEqual(baselineStatus(base, record("w", JSON.parse(JSON.stringify(nodes)))), "unchanged");
  const edited = JSON.parse(JSON.stringify(nodes));
  edited[1].loop_group.nodes[0].bash = "y";
  assert.strictEqual(baselineStatus(base, record("w", edited)), "changed");
  assert.strictEqual(baselineStatus(base, record("w", [...nodes, { id: "n", bash: "x" }])), "changed");
  assert.strictEqual(baselineStatus(base, record("w", nodes, { source: "repo", repo: "site" })), "moved");
  assert.strictEqual(baselineStatus(base, record("w", nodes, { source: "repo", repo: "site", model: wf([], { name: "w" }) })), "moved");
  const withInput = record("w", nodes);
  withInput.model.inputs = { ref: { default: "main" } };
  assert.strictEqual(baselineStatus(base, withInput), "changed");
});

test("a workflow that moved from the personal group to the kit group is moved, and its scope names the group", () => {
  const nodes = [{ id: "a", bash: "x" }];
  const base = record("w", nodes);
  const cur = record("w", nodes, { group: "kit" });
  assert.strictEqual(baselineStatus(base, cur), "moved");
  const rows = baselineRows([cur], { w: base }, []);
  assert.deepStrictEqual(rows[0].scope, ["personal", "kit"]);
  assert.strictEqual(baselineStatus(base, record("w", nodes, { group: "personal" })), "unchanged");
});

test("the baseline table gives each count as before and after, with null for a side that lacks the workflow", () => {
  const nodes = [{ id: "a", bash: "x" }, { id: "g", loop_group: { nodes: [{ id: "c", bash: "z" }], max_iterations: 2, until_bash: "true" } }];
  const moved = record("moved", nodes, { lines: 12, source: "repo", repo: "site", inputs: { ref: {} } });
  moved.model.description = "now described";
  const workflows = [record("same", nodes), record("grown", [...nodes, { id: "n", bash: "x" }], { lines: 14 }), moved, record("fresh", nodes, { lines: 5 })];
  const baseline = { same: record("same", nodes), grown: record("grown", nodes), moved: record("moved", nodes, { lines: 20 }), gone: record("gone", nodes) };
  const removed = [{ name: "gone", scope: "personal", lines: 7, nodes: 3, inputs: 1 }];
  const rows = Object.fromEntries(baselineRows(workflows, baseline, removed).map((r) => [r.name, r]));
  assert.deepStrictEqual(Object.keys(rows), ["same", "grown", "moved", "fresh", "gone"]);
  assert.deepStrictEqual([rows.same.status, rows.grown.status, rows.moved.status, rows.fresh.status, rows.gone.status], ["unchanged", "changed", "moved", "added", "removed"]);
  assert.deepStrictEqual([rows.same.lines, rows.same.nodes, rows.same.inputs], [[10, 10], [3, 3], [0, 0]]);
  assert.deepStrictEqual([rows.grown.lines, rows.grown.nodes], [[10, 14], [3, 4]]);
  assert.deepStrictEqual([rows.moved.scope, rows.moved.lines, rows.moved.inputs, rows.moved.changed], [["personal", "repo/site"], [20, 12], [0, 1], true]);
  assert.deepStrictEqual([rows.fresh.scope, rows.fresh.lines, rows.fresh.nodes], [[null, "personal"], [null, 5], [null, 3]]);
  assert.deepStrictEqual([rows.gone.scope, rows.gone.lines, rows.gone.nodes, rows.gone.inputs], [["personal", null], [7, null], [3, null], [1, null]]);
});
