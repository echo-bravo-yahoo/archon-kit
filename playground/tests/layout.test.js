const test = require("node:test");
const assert = require("node:assert");
const { layoutWorkflow, layoutVisibleKey, LAYOUT_DEFAULTS } = require("../src/layout.js");
const { workflowFiles, fileNodes } = require("../src/files.js");
const rules = require("../data/files.json");
const { flattenNodes } = require("../src/model.js");
const { loadDump, wf } = require("./load.js");

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function checkLayout(w, options) {
  const res = layoutWorkflow(w, options);
  const entries = flattenNodes(w);
  const byParent = new Map();
  for (const e of entries) {
    const box = res.nodes[e.key];
    if (!box) continue;
    const k = e.parentKey || "";
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push([e, box]);
  }
  for (const [parent, boxes] of byParent) {
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlap(boxes[i][1], boxes[j][1]), parent + ": " + boxes[i][0].key + " overlaps " + boxes[j][0].key);
    }
  }
  for (const [parent, boxes] of byParent) {
    if (!parent) continue;
    const c = res.containers[parent];
    for (const [e, box] of boxes) {
      assert.ok(box.x >= c.x && box.y >= c.y + c.headerH && box.x + box.w <= c.x + c.w && box.y + box.h <= c.y + c.h, e.key + " is inside " + parent);
    }
  }
  // ranks respect edges: a node sits to the right of every node it depends on, in its own scope
  for (const e of entries) {
    const box = res.nodes[e.key];
    for (const d of Array.isArray(e.node.depends_on) ? e.node.depends_on : []) {
      const from = res.nodes[(e.parentKey ? e.parentKey + "." : "") + d];
      if (from && box) assert.ok(from.x + from.w <= box.x, d + " -> " + e.key);
    }
  }
  return res;
}

test("every real workflow lays out without overlaps and with ranks that respect edges", () => {
  for (const w of loadDump().workflows) {
    checkLayout(w.model, {});
    checkLayout(w.model, { collapsed: flattenNodes(w.model).filter((e) => e.node.loop_group).map((e) => e.key) });
  }
});

test("a collapsed loop is one card and hides its body", () => {
  const w = loadDump().workflows.find((x) => x.name === "build").model;
  const res = layoutWorkflow(w, { collapsed: ["build_cycle"] });
  assert.strictEqual(res.nodes["build_cycle"].w, LAYOUT_DEFAULTS.nodeW);
  assert.ok(!res.nodes["build_cycle.implement"]);
  assert.ok(res.nodes["plan_cycle.spec"]);
  assert.ok(res.containers["plan_cycle"] && !res.containers["build_cycle"]);
});

test("a data reference into a collapsed loop attaches to the container", () => {
  const w = wf([
    { id: "cfg", bash: "echo" },
    { id: "g", loop_group: { nodes: [{ id: "inner", bash: "echo $cfg.output" }], max_iterations: 2, until_bash: "true" } },
  ]);
  const open = layoutWorkflow(w, { showData: true });
  assert.ok(open.edges.some((e) => e.kind === "data" && e.from === "cfg" && e.to === "g.inner"));
  const shut = layoutWorkflow(w, { showData: true, collapsed: ["g"] });
  assert.ok(shut.edges.some((e) => e.kind === "data" && e.from === "cfg" && e.to === "g"));
  assert.strictEqual(layoutVisibleKey("g.inner", new Set(["g"])), "g");
  assert.strictEqual(layoutVisibleKey("g", new Set(["g"])), "g");
});

test("dependency edges are dashed into a node with a condition only in the drawing, and loop-prev edges are separate", () => {
  const w = wf([{ id: "g", loop_group: { nodes: [{ id: "a", bash: "x" }, { id: "b", depends_on: ["a"], bash: "echo $LOOP_PREV.a.output" }], max_iterations: 2, until_bash: "true" } }]);
  const res = layoutWorkflow(w, { showData: true });
  assert.ok(res.edges.some((e) => e.kind === "dep" && e.from === "g.a" && e.to === "g.b"));
  assert.ok(res.edges.some((e) => e.kind === "prev" && e.from === "g.a" && e.to === "g.b"));
  assert.ok(!layoutWorkflow(w, { showData: false }).edges.some((e) => e.kind === "prev"));
});

test("offsets move a node and its container grows to hold it", () => {
  const w = wf([{ id: "g", loop_group: { nodes: [{ id: "a", bash: "x" }], max_iterations: 2, until_bash: "true" } }]);
  const base = layoutWorkflow(w, {});
  const moved = layoutWorkflow(w, { offsets: { "g.a": { dx: 500, dy: 0 } } });
  assert.strictEqual(moved.nodes["g.a"].x, base.nodes["g.a"].x + 500);
  assert.ok(moved.containers.g.x + moved.containers.g.w >= moved.nodes["g.a"].x + moved.nodes["g.a"].w);
  const shifted = layoutWorkflow(w, { offsets: { g: { dx: 40, dy: 10 } } });
  assert.strictEqual(shifted.nodes["g.a"].x, base.nodes["g.a"].x + 40);
});

test("a cycle still lays out", () => {
  const w = wf([{ id: "a", depends_on: ["b"], bash: "x" }, { id: "b", depends_on: ["a"], bash: "y" }]);
  const res = layoutWorkflow(w, {});
  assert.ok(res.nodes.a && res.nodes.b);
  assert.ok(!overlap(res.nodes.a, res.nodes.b));
});

const fileOf = (name, writers, readers, deleters) => ({ key: "file:artifacts:" + name, id: "artifacts:" + name, name, where: "artifacts", dir: false, external: !writers.length, writers, readers, deleters: deleters || [] });

// ---- files as lanes ----

const chain = (n) => wf(Array.from({ length: n }, (_, i) => ({ id: "n" + i, depends_on: i ? ["n" + (i - 1)] : undefined, bash: "x" })));
const centre = (b) => b.x + b.w / 2;
const lanesFor = (w, files, options) => layoutWorkflow(w, Object.assign({ lanes: files }, options));

test("lanes: one lane per file, a dot at the centre of each node that touches it, rows numbered from 0", () => {
  const w = chain(3);
  const lay = lanesFor(w, [fileOf("out.txt", ["n0"], ["n2"]), fileOf("tmp.txt", ["n1"], [], ["n2"])]);
  assert.strictEqual(lay.lanes.length, 2);
  assert.deepStrictEqual(lay.edges.filter((e) => e.kind !== "dep"), []);
  const out = lay.lanes.find((l) => l.name === "out.txt");
  assert.deepStrictEqual(out.dots.map((d) => [d.node, d.kind, d.x]), [["n0", "w", centre(lay.nodes.n0)], ["n2", "r", centre(lay.nodes.n2)]]);
  assert.strictEqual(lay.laneH, LAYOUT_DEFAULTS.laneH);
  lay.lanes.forEach((l, i) => {
    assert.strictEqual(l.y, i * lay.laneH + lay.laneH / 2, "the row's middle in the lane pane");
    assert.ok(l.dots.every((d) => d.y === l.y));
  });
  assert.strictEqual(out.x1, out.dots[0].x);
  assert.strictEqual(out.x2, out.dots[1].x);
});

test("lanes take no room in the graph: the nodes, width and height are those of a layout without them", () => {
  const w = chain(3);
  const plain = layoutWorkflow(w, {});
  const withLanes = lanesFor(w, [fileOf("out.txt", ["n0"], ["n2"])]);
  assert.deepStrictEqual(plain.lanes, []);
  assert.deepStrictEqual(withLanes.nodes, plain.nodes);
  assert.strictEqual(withLanes.width, plain.width);
  assert.strictEqual(withLanes.height, plain.height);
});

test("lanes: a node that writes and reads a file gets two dots spread dotSpacing apart around its centre", () => {
  const lay = lanesFor(chain(2), [fileOf("x.txt", ["n0"], ["n0", "n1"], ["n1"])]);
  const [lane] = lay.lanes;
  const at = (node) => lane.dots.filter((d) => d.node === node);
  assert.deepStrictEqual(at("n0").map((d) => d.kind), ["w", "r"]);
  assert.strictEqual(at("n0")[1].x - at("n0")[0].x, LAYOUT_DEFAULTS.dotSpacing);
  assert.strictEqual((at("n0")[0].x + at("n0")[1].x) / 2, centre(lay.nodes.n0));
  assert.deepStrictEqual(at("n1").map((d) => d.kind), ["r", "d"]);
});

test("lanes: dots of nodes in one column are pushed apart but stay inside their own node", () => {
  const w = wf([{ id: "a", bash: "x" }, { id: "b", depends_on: ["a"], bash: "x" }, { id: "c", depends_on: ["a"], bash: "x" }, { id: "d", depends_on: ["a"], bash: "x" }]);
  const lay = lanesFor(w, [fileOf("x.txt", ["b", "c", "d"], [])]);
  const dots = lay.lanes[0].dots;
  assert.strictEqual(dots.length, 3);
  for (let i = 1; i < dots.length; i++) assert.ok(dots[i].x - dots[i - 1].x >= LAYOUT_DEFAULTS.dotSpacing, "dots do not overlap");
  for (const d of dots) assert.ok(d.x >= lay.nodes[d.node].x && d.x <= lay.nodes[d.node].x + lay.nodes[d.node].w, d.node + "'s dot is inside its card");
});

test("lanes are ordered by the x of their first dot, then by name", () => {
  const lay = lanesFor(chain(3), [fileOf("late.txt", ["n2"], []), fileOf("b.txt", ["n0"], ["n1"]), fileOf("a.txt", ["n0"], [])]);
  assert.deepStrictEqual(lay.lanes.map((l) => l.name), ["a.txt", "b.txt", "late.txt"]);
  assert.ok(lay.lanes[0].y < lay.lanes[1].y && lay.lanes[1].y < lay.lanes[2].y);
});

test("lanes: a collapsed loop's files get their dots on the loop's card, and an open loop's own reads sit at its right edge", () => {
  const w = wf([{ id: "pre", bash: "x" }, { id: "cycle", depends_on: ["pre"], loop_group: { max_iterations: 2, until_bash: "true", nodes: [{ id: "r", bash: "x" }] } }]);
  const files = [fileOf("loop.txt", ["cycle.r"], ["cycle"])];
  const shut = lanesFor(w, files, { collapsed: ["cycle"] });
  assert.deepStrictEqual(shut.lanes[0].dots.map((d) => [d.node, d.kind]), [["cycle", "w"], ["cycle", "r"]]);
  assert.strictEqual((shut.lanes[0].dots[0].x + shut.lanes[0].dots[1].x) / 2, centre(shut.nodes.cycle));
  const open = lanesFor(w, files);
  const box = open.nodes.cycle;
  const body = open.nodes["cycle.r"];
  const reader = open.lanes[0].dots.find((d) => d.node === "cycle");
  const writer = open.lanes[0].dots.find((d) => d.node === "cycle.r");
  assert.strictEqual(writer.x, centre(body));
  assert.strictEqual(reader.x, box.x + box.w - 14);
});

test("lanes: an offset moves the dots of the node it moves", () => {
  const w = chain(2);
  const files = [fileOf("x.txt", ["n0"], ["n1"])];
  const base = lanesFor(w, files);
  const moved = lanesFor(w, files, { offsets: { n0: { dx: 300, dy: 0 } } });
  assert.strictEqual(moved.lanes[0].dots.find((d) => d.node === "n0").x, base.lanes[0].dots.find((d) => d.node === "n0").x + 300);
});

test("lanes: a file whose nodes are all missing from the graph gets no lane", () => {
  const lay = lanesFor(chain(2), [fileOf("ghost.txt", ["nowhere"], [])]);
  assert.deepStrictEqual(lay.lanes, []);
});

function realFiles(name, mode) {
  const d = loadDump();
  const byName = Object.fromEntries(d.workflows.map((w) => [w.name, w.model]));
  const model = byName[name];
  return { model, all: fileNodes(workflowFiles(model, { rules, getWorkflow: (n) => byName[n] }), mode, model) };
}

test("on the real build workflow every file passed between nodes gets a lane, and no node or edge is added for it", () => {
  const { model, all } = realFiles("build", "linked");
  assert.ok(all.length >= 10, "build passes files between nodes");
  const plain = layoutWorkflow(model, {});
  const lay = layoutWorkflow(model, { lanes: all });
  assert.strictEqual(lay.lanes.length, all.length);
  assert.deepStrictEqual(lay.edges, plain.edges);
  assert.strictEqual(lay.width, plain.width);
  const state = lay.lanes.find((l) => l.name === "state");
  assert.ok(state.dots.length >= 20, "the state file, touched everywhere, has a dot under each node that touches it");
});

test("every real workflow gets one lane per file in every mode, with all dots on drawn nodes", () => {
  for (const w of loadDump().workflows) {
    for (const mode of ["linked", "undeclared", "all"]) {
      const { model, all } = realFiles(w.name, mode);
      for (const collapsed of [[], flattenNodes(model).filter((e) => e.node.loop_group).map((e) => e.key)]) {
        const lay = layoutWorkflow(model, { lanes: all, collapsed });
        assert.strictEqual(lay.lanes.length, all.length, w.name + " " + mode);
        for (const l of lay.lanes) for (const d of l.dots) assert.ok(lay.nodes[d.node], w.name + ": " + l.name + " has a dot on " + d.node);
      }
    }
  }
});
