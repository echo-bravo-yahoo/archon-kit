// Drives the served page in headless Chromium. Run it from a directory where `playwright` resolves:
//   cd <that directory> && node playground/tests/browser.mjs
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const require = createRequire(path.join(process.cwd(), "noop.js"));
const { chromium } = require("playwright");
const URL = process.env.PLAYGROUND_URL || "http://localhost:8082/archon/workflow-playground/index.html";
const SHOTS = process.env.PLAYGROUND_SHOTS || "";

const NAMES = ["build", "research", "check-later", "review-change"];
let passed = 0;
const step = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log("ok   " + name);
  } catch (e) {
    console.log("FAIL " + name + "\n     " + String(e.stack || e).split("\n").slice(0, 6).join("\n     "));
    process.exitCode = 1;
  }
};

// A step that has nothing to exercise on this host's workflows says so, so a skip does not read as a pass.
const skip = (why) => console.log("     skipped: " + why);

const browser = await chromium.launch();
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
const problems = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") problems.push("console " + m.type() + ": " + m.text());
});
page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
await page.addInitScript(() => {
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
});
await page.goto(URL, { waitUntil: "load" });
await page.waitForSelector("svg.graph");

const drawn = () => page.evaluate(() => document.querySelectorAll("svg.graph g.node").length + document.querySelectorAll("svg.graph g.container").length);
const issues = () => page.evaluate(() => [...document.querySelectorAll("#tab-pane .issue")].map((e) => e.dataset.severity + ":" + e.dataset.rule));
const pick = async (name) => {
  await page.selectOption("#wf-select", name);
  await page.waitForTimeout(50);
};
const tab = (id) => page.click('[data-tab="' + id + '"]');
const node = (key) => page.locator('g.node[data-key="' + key + '"]');

await step("every workflow draws a card or a container for each of its nodes", async () => {
  const names = await page.$$eval("#wf-select option", (os) => os.map((o) => o.value));
  assert.ok(names.length >= 1);
  for (const name of names) {
    await pick(name);
    const want = await page.evaluate(() => Object.keys(window.__playground.state.layout.nodes).length);
    assert.equal(await drawn(), want, name);
  }
});

await step("a kit workflow's picker label names its group", async () => {
  const labels = await page.$$eval("#wf-select option", (os) => os.map((o) => o.textContent));
  assert.ok(labels.includes("build (kit)"), labels.join(", "));
});

await step("the real workflows show no validation issues", async () => {
  await tab("validation");
  for (const name of NAMES) {
    await pick(name);
    assert.deepEqual(await issues(), [], name);
  }
});

if (SHOTS) {
  await pick("build");
  await page.screenshot({ path: path.join(SHOTS, "build.png") });
}

const files = async (v) => {
  await page.selectOption("#files-mode", v);
  await page.waitForTimeout(50);
};
const canvasBox = () => page.locator("#canvas").boundingBox();
const scrollOf = (id) => page.evaluate((i) => [document.getElementById(i).scrollLeft, document.getElementById(i).scrollTop], id);
const midX = async (loc) => {
  const b = await loc.boundingBox();
  return b.x + b.width / 2;
};
// What the lane steps point at, read from the page's own layout: the file with the most dots, a node with a dot,
// the node with a dot farthest to the right, another file, and a loop that has files in its body.
const targets = () =>
  page.evaluate(() => {
    const { lanes, nodes } = window.__playground.state.layout;
    const plain = (k) => nodes[k] && !nodes[k].loop;
    const dots = lanes.flatMap((l) => l.dots.filter((d) => plain(d.node)));
    const busiest = lanes.reduce((a, l) => (l.dots.length > a.dots.length ? l : a), lanes[0]);
    const loop = Object.keys(nodes).find((k) => nodes[k].loop && lanes.some((l) => l.dots.some((d) => d.node.startsWith(k + "."))));
    return {
      count: lanes.length,
      busiest: busiest.id,
      touching: new Set(busiest.dots.map((d) => d.node).filter((k) => nodes[k])).size,
      card: dots[0].node,
      far: dots.reduce((a, d) => (d.x > a.x ? d : a), dots[0]).node,
      other: lanes.find((l) => l.id !== busiest.id).id,
      loop: loop || null,
    };
  });
const fresh = async () => {
  await pick("build");
  await files("linked");
  await page.click('[data-action="expand-all"]');
  await page.evaluate(() => { document.getElementById("canvas").scrollLeft = 0; document.getElementById("canvas").scrollTop = 0; document.getElementById("lanes-scroll").scrollTop = 0; });
  await page.mouse.move(5, 5);
};
const resetOffsets = () =>
  page.evaluate(() => {
    const st = window.__playground.state;
    st.view[st.wf].offsets = {};
    uSaveView();
    uRenderCanvas();
  });

await step("the Files menu offers Hidden and the three file sets, and no other way to draw files remains", async () => {
  const options = await page.$$eval("#files-mode option", (os) => os.map((o) => o.value));
  assert.deepEqual(options, ["off", "linked", "undeclared", "all"]);
  assert.equal(await page.inputValue("#files-mode"), "linked");
  assert.equal(await page.locator("#files-style").count(), 0);
  await pick("build");
  assert.equal(await page.locator("g.filenode, g.chip-g, path.edge.filew, path.edge.filer, path.edge.filed, line.stem").count(), 0);
});

await step("Lanes: build has a lane per file in a pane under the graph, outside the graph's scroller", async () => {
  await fresh();
  const linked = (await targets()).count;
  assert.ok(linked >= 1, "build passes files between nodes");
  assert.equal(await page.locator("#lanes line.lane-line").count(), linked);
  assert.equal(await page.locator("#lanes text.lane-label").count(), linked);
  assert.equal(await page.locator("#canvas line.lane-line").count(), 0, "no lane is drawn in the graph");
  const g = await page.locator("#canvas").boundingBox();
  const l = await page.locator("#lanes").boundingBox();
  assert.ok(l.y >= g.y + g.height - 1, "the pane starts where the graph ends");
  assert.ok(Math.abs(l.x - g.x) < 1 && Math.abs(l.width - g.width) < 1, "and is as wide");
  assert.ok(g.height > 120, "the graph keeps room: " + g.height);
  const w = Number(await page.getAttribute("#canvas svg.graph", "width"));
  assert.ok(w < 12000, "canvas " + w + " px wide");
  await files("all");
  const all = await page.locator("#lanes line.lane-line").count();
  assert.equal(all, (await targets()).count);
  assert.ok(all > linked, "all files adds to the files passed between nodes");
  await files("undeclared");
  assert.ok((await page.locator("#lanes line.lane-line").count()) < linked);
  await files("off");
  assert.equal(await page.evaluate(() => document.getElementById("lanes").hidden), true);
  assert.equal(await page.locator("#lanes text.lane-label").count(), 0);
  await files("linked");
  assert.equal(await page.evaluate(() => document.getElementById("lanes").hidden), false);
});

await step("the lane pane scrolls up and down on its own, and sideways with the graph", async () => {
  await fresh();
  await files("all");
  const lanes = () => page.evaluate(() => ({ top: document.getElementById("lanes-scroll").scrollTop, max: document.getElementById("lanes-scroll").scrollHeight - document.getElementById("lanes-scroll").clientHeight }));
  assert.ok((await lanes()).max > 100, "32 rows do not fit the pane");
  const [, canvasTop] = await scrollOf("canvas");
  await page.evaluate(() => { document.getElementById("lanes-scroll").scrollTop = 150; });
  assert.equal((await lanes()).top, 150);
  assert.equal((await scrollOf("canvas"))[1], canvasTop, "the graph did not move");
  const first = await page.locator("#lanes text.lane-label").first().boundingBox();
  const rowsAtTop = await page.locator("#lanes text.lane-label").first().evaluate((t) => t.getBoundingClientRect().y);
  assert.ok(rowsAtTop < (await page.locator("#lanes").boundingBox()).y + 30, "the first row scrolled out of view: " + first.y);
  // the graph scrolling up and down leaves the pane alone
  await page.evaluate(() => { document.getElementById("canvas").scrollTop = 40; });
  assert.equal((await lanes()).top, 150);
  await page.evaluate(() => { document.getElementById("canvas").scrollTop = 0; document.getElementById("lanes-scroll").scrollTop = 0; });
  // sideways, the track follows the graph, so a dot stays under its node
  const t = await targets();
  const dot = page.locator(`#lanes circle.lane-dot[data-lane-node="${t.card}"]`).first();
  const card = page.locator(`g.node[data-key="${t.card}"] rect.card`);
  assert.ok(Math.abs((await midX(dot)) - (await midX(card))) <= 2, "aligned at rest");
  const toFar = await page.evaluate((k) => { const st = window.__playground.state; return Math.max(0, Math.round((st.layout.nodes[k].x - st.vb.x - 200) * st.zoom)); }, t.far);
  await page.evaluate((x) => { document.getElementById("canvas").scrollLeft = x; }, toFar);
  await page.waitForTimeout(50);
  const [sideways] = await scrollOf("canvas");
  assert.ok(sideways > 0 || toFar === 0, "the graph scrolled");
  assert.equal(await page.evaluate(() => document.getElementById("lane-track").scrollLeft), sideways);
  const far = page.locator(`g.node[data-key="${t.far}"] rect.card`);
  const farDot = page.locator(`#lanes circle.lane-dot[data-lane-node="${t.far}"]`).first();
  assert.ok(Math.abs((await midX(farDot)) - (await midX(far))) <= 2, "aligned after scrolling");
  await page.evaluate(() => { document.getElementById("canvas").scrollLeft = 0; });
  await files("linked");
});

await step("a sideways wheel over the lane pane scrolls the graph, and dragging a row pans both ways", async () => {
  await fresh();
  await files("all");
  const box = await page.locator("#lanes-scroll").boundingBox();
  await page.mouse.move(box.x + 500, box.y + box.height / 2);
  await page.mouse.wheel(400, 0);
  await page.waitForTimeout(100);
  assert.ok((await scrollOf("canvas"))[0] >= 300, "the graph followed the wheel");
  assert.equal(await page.evaluate(() => document.getElementById("lane-track").scrollLeft), (await scrollOf("canvas"))[0]);
  await page.evaluate(() => { document.getElementById("canvas").scrollLeft = 0; });
  const before = await page.evaluate(() => document.getElementById("lanes-scroll").scrollTop);
  await page.mouse.move(box.x + 700, box.y + box.height - 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 400, box.y + 8, { steps: 6 });
  await page.mouse.up();
  const [left] = await scrollOf("canvas");
  const top = await page.evaluate(() => document.getElementById("lanes-scroll").scrollTop);
  assert.ok(left >= 250, "sideways " + left);
  assert.ok(top > before + Math.min(40, box.height / 2), "up and down " + before + " to " + top);
  await page.evaluate(() => { document.getElementById("canvas").scrollLeft = 0; document.getElementById("lanes-scroll").scrollTop = 0; });
  await files("linked");
});

await step("pointing at a file lights its nodes and fades the other lanes; pointing at a node lights its dots", async () => {
  await fresh();
  await page.mouse.move(5, 5);
  assert.equal(await page.locator(".fdim, .fhl, .lane-col").count(), 0);
  const t = await targets();
  assert.ok(t.count >= 2 && t.touching >= 2, "needs two files and a file with two nodes");
  await page.locator(`#lanes g.lane-row[data-lane-file="${t.busiest}"]`).hover();
  assert.equal(await page.locator("g.node.fhl, g.container.fhl").count(), t.touching, "a loop that reads the file lights too");
  assert.equal(await page.locator("#lanes g.lane.fdim").count(), t.count - 1, "every other lane fades");
  assert.equal(await page.locator("#lanes g.lane-row.fdim").count(), t.count - 1);
  await page.mouse.move(5, 5);
  assert.equal(await page.locator(".fdim, .fhl").count(), 0);
  // a node: its dots and a band down its column
  await node(t.card).hover();
  const own = await page.locator(`#lanes circle.lane-dot[data-lane-node="${t.card}"]`).count();
  assert.ok(own >= 1);
  assert.equal(await page.locator("#lanes circle.lane-dot.fhl").count(), own);
  assert.equal(await page.locator("#lanes rect.lane-col").count(), 1);
  assert.ok((await page.locator("#lanes g.lane.fdim").count()) > 0 || own === t.count);
  await page.mouse.move(5, 5);
  assert.equal(await page.locator("#lanes .fdim, #lanes .lane-col").count(), 0);
  // a click on a lane selects the file and lights its nodes until the background is clicked
  await page.locator(`#lanes g.lane-row[data-lane-file="${t.other}"] text`).click();
  assert.equal(await page.evaluate(() => window.__playground.state.fileSel), t.other);
  await page.mouse.move(5, 5);
  assert.ok((await page.locator("g.node.fhl, g.container.fhl").count()) >= 1, "the selected file stays lit");
  await page.click("#canvas svg.graph", { position: { x: 5, y: 5 } });
  assert.equal(await page.locator("g.node.fhl, g.container.fhl").count(), 0);
});

await step("Lanes: collapsing a loop moves its dots onto the loop's card", async () => {
  await fresh();
  const t = await targets();
  if (!t.loop) return skip("no loop in this workflow has a file in its body");
  const before = (await targets()).count;
  const nodes = () => page.$$eval("#lanes circle.lane-dot", (cs) => [...new Set(cs.map((c) => c.getAttribute("data-lane-node")))]);
  assert.ok((await nodes()).some((k) => k.startsWith(t.loop + ".")));
  await page.click('[data-action="collapse-all"]');
  const shut = await nodes();
  assert.ok(shut.includes(t.loop), "the loop card has dots");
  assert.ok(!shut.some((k) => k.startsWith(t.loop + ".")), "no dot is left on a hidden body node");
  assert.equal(await page.locator("#lanes line.lane-line").count(), before);
  await page.click('[data-action="expand-all"]');
});

await step("the pane's top edge resizes it, and the height is remembered", async () => {
  await fresh();
  const h0 = (await page.locator("#lanes").boundingBox()).height;
  const split = await page.locator("#lanes-split").boundingBox();
  await page.mouse.move(split.x + 300, split.y + split.height / 2);
  await page.mouse.down();
  await page.mouse.move(split.x + 300, split.y + split.height / 2 - 60, { steps: 5 });
  await page.mouse.up();
  const h1 = (await page.locator("#lanes").boundingBox()).height;
  const centre = (await page.locator(".center").boundingBox()).height;
  assert.ok(Math.abs(h1 - Math.min(h0 + 60, centre - 120)) <= 3, h0 + " then " + h1 + " in " + centre);
  const g1 = (await page.locator("#canvas").boundingBox()).height;
  assert.ok(g1 >= 119, "the graph keeps room " + g1);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("svg.graph");
  assert.ok(Math.abs((await page.locator("#lanes").boundingBox()).height - h1) <= 3, "after a reload");
  await page.evaluate(() => { localStorage.removeItem("archon-playground:v1:lanes-height"); });
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("svg.graph");
});

await step("a node dragged past the top or left edge can still be scrolled to", async () => {
  await fresh();
  await resetOffsets();
  const t = await targets();
  const card = page.locator(`g.node[data-key="${t.card}"] rect.card`);
  await card.scrollIntoViewIfNeeded();
  const b = await card.boundingBox();
  await page.mouse.move(b.x + 60, b.y + 20);
  await page.mouse.down();
  await page.mouse.move(b.x + 60 - 40, b.y - 250, { steps: 10 });
  await page.mouse.up();
  const cut = await page.evaluate(() => {
    const svg = document.querySelector("#canvas svg.graph");
    const bb = svg.getBBox();
    const vb = window.__playground.state.vb;
    return { left: vb.x - bb.x, top: vb.y - bb.y, right: bb.x + bb.width - (vb.x + vb.W), bottom: bb.y + bb.height - (vb.y + vb.H) };
  });
  for (const [side, over] of Object.entries(cut)) assert.ok(over <= 0.5, side + " is cut off by " + over);
  // the node can be brought into view by scrolling up, and the lanes still sit under their nodes
  await page.evaluate(() => { document.getElementById("canvas").scrollTop = 0; });
  const nb = await page.locator(`g.node[data-key="${t.card}"] rect.card`).boundingBox();
  const cb = await canvasBox();
  assert.ok(nb.y >= cb.y - 1 && nb.y < cb.y + cb.height, "the dragged node's top is on screen at the top of the scroller");
  const dot = page.locator(`#lanes circle.lane-dot[data-lane-node="${t.card}"]`).first();
  assert.ok(Math.abs((await midX(dot)) - (nb.x + nb.width / 2)) <= 2, "its dot follows it");
  await resetOffsets();
});

// What the editing steps work on, read from each workflow's model: its top-level nodes, a dependency between two of
// them, a node that another node reads, a loop, and the last node. No step names a node of one person's workflows.
let shapesMemo = null;
const shapes = async () => {
  if (shapesMemo) return shapesMemo;
  const names = await page.$$eval("#wf-select option", (os) => os.map((o) => o.value));
  shapesMemo = [];
  for (const name of names) {
    await pick(name);
    await page.click('[data-action="expand-all"]');
    shapesMemo.push({
      name,
      ...(await page.evaluate(() => {
        const top = (window.__playground.model().nodes || []).filter((n) => n && n.id);
        const ids = top.map((n) => n.id);
        const edge = top.flatMap((n) => (n.depends_on || []).filter((d) => ids.includes(d)).map((d) => ({ from: d, to: n.id })))[0] || null;
        const read = top.find((n) => top.some((o) => o.id !== n.id && collectRefs(o).nodes.some((r) => r.id === n.id)));
        const loop = top.find((n) => n.loop_group && Array.isArray(n.loop_group.nodes));
        const sinks = ids.filter((id) => !top.some((o) => (o.depends_on || []).includes(id)));
        return { top: ids.length, all: Object.keys(window.__playground.state.layout.nodes).length, edge, read: read ? read.id : null, loop: loop ? { id: loop.id, body: loop.loop_group.nodes.length } : null, root: ids[0], last: sinks[sinks.length - 1] };
      })),
    });
  }
  return shapesMemo;
};
const smallest = async (keep) => (await shapes()).filter(keep).sort((a, b) => a.all - b.all)[0];
const edgeCount = () => page.locator("path.edge:not(.data):not(.prev)").count();

await step("adding a node, an edge, then a cycle and deleting nodes updates the graph and the list", async () => {
  const sh = await smallest((x) => x.edge);
  assert.ok(sh, "a workflow with a dependency to work on");
  const { from: x, to: y } = sh.edge;
  await pick(sh.name);
  await tab("validation");
  const n0 = await drawn();
  const base = await issues();
  await page.click('[data-add="bash"]');
  assert.equal(await drawn(), n0 + 1);
  const added = await page.evaluate(() => window.__playground.state.selected);
  assert.match(added, /^bash/);
  // dependency chips: add, then remove
  const before = await edgeCount();
  await page.click(`[data-dep="${y}"]`);
  assert.equal(await edgeCount(), before + 1);
  await page.click(`[data-dep="${y}"]`);
  assert.equal(await edgeCount(), before);
  // a second node of another kind comes and goes
  await page.click('[data-add="wait"]');
  assert.equal(await drawn(), n0 + 2);
  await page.click('[data-action="delete"]');
  assert.equal(await drawn(), n0 + 1);
  // a cycle: the new node depends on y, and x, which y depends on, depends on the new node
  await node(added).click();
  await page.click(`[data-dep="${y}"]`);
  await node(x).click();
  await page.click(`[data-dep="${added}"]`);
  assert.ok((await issues()).includes("error:cycle"));
  await page.click(`[data-dep="${added}"]`);
  assert.ok(!(await issues()).includes("error:cycle"));
  // an edge made by dragging from an output port to an input port (fit the graph so both ports are on screen)
  await page.click('[data-action="zoom-fit"]');
  const e0 = await edgeCount();
  const out = await page.locator(`[data-port-out="${x}"]`).boundingBox();
  const inn = await page.locator(`[data-port-in="${added}"]`).boundingBox();
  const cb = await canvasBox();
  const visible = (b) => b.x >= cb.x && b.x + b.width <= cb.x + cb.width && b.y >= cb.y && b.y + b.height <= cb.y + cb.height;
  assert.ok(visible(out) && visible(inn), "both ports are on screen at the fitted zoom");
  await page.mouse.move(out.x + out.width / 2, out.y + out.height / 2);
  await page.mouse.down();
  await page.mouse.move(inn.x + inn.width / 2 - 20, inn.y + inn.height / 2, { steps: 6 });
  await page.mouse.move(inn.x + inn.width / 2, inn.y + inn.height / 2, { steps: 4 });
  await page.mouse.up();
  assert.equal(await edgeCount(), e0 + 1);
  // select the edge and remove it
  await page.locator(`path.edge-hit[data-edge="${x}>${added}"]`).dispatchEvent("click");
  await page.click('[data-action="remove-edge"]');
  assert.equal(await edgeCount(), e0);
  // deleting the new node returns the graph
  await node(added).click();
  await page.click('[data-action="delete"]');
  assert.equal(await drawn(), n0);
  assert.deepEqual(await issues(), base);
});

await step("deleting a node that another node reads flags the references, and Reset undoes it", async () => {
  const sh = await smallest((x) => x.read);
  if (!sh) return skip("no node of these workflows reads another's output");
  await pick(sh.name);
  await tab("validation");
  const base = await issues();
  await node(sh.read).click();
  await page.click('[data-action="delete"]');
  assert.ok((await issues()).includes("error:unknown-reference"));
  await tab("changes");
  assert.match(await page.textContent("#tab-pane"), /Nodes removed \(1\)/);
  await tab("yaml");
  await page.click('[data-action="reset"]');
  await tab("validation");
  assert.deepEqual(await issues(), base);
});

await step("the statistics overlay shades the nodes and shows a node's run count", async () => {
  const hits = await page.evaluate(() => Object.entries(STATS.workflows || {}).flatMap(([wf, s]) => Object.entries(s.nodes || {}).filter(([, st]) => !st.aggregate && st.runs > 0).map(([key, st]) => ({ wf, key, runs: st.runs }))));
  let shown = null;
  for (const h of hits) {
    if (!(await page.$$eval("#wf-select option", (os, n) => os.some((o) => o.value === n), h.wf))) continue;
    await pick(h.wf);
    await page.click('[data-action="expand-all"]');
    if (await node(h.key).count()) {
      shown = h;
      break;
    }
  }
  if (!shown) return skip("this Archon home has no run history for a drawn node");
  await page.selectOption("#metric-select", "runs");
  await node(shown.key).click();
  assert.equal(Number(await page.textContent('[data-stat="runs"]')), shown.runs);
  assert.ok((await page.locator("svg.graph rect.shade").count()) >= 1, "a shaded node");
  await page.selectOption("#metric-select", "none");
  assert.equal(await page.locator("svg.graph rect.shade").count(), 0);
});

await step("a collapsed loop's + expands it, and a loop's − collapses it", async () => {
  const sh = await smallest((x) => x.loop);
  assert.ok(sh, "a workflow with a loop");
  await pick(sh.name);
  await page.click('[data-action="expand-all"]');
  assert.equal(await drawn(), sh.all);
  await page.click('[data-action="collapse-all"]');
  assert.equal(await drawn(), sh.top, "only the top-level nodes are left");
  assert.equal(await page.locator("svg.graph g.container").count(), 0);
  const plus = page.locator(`g.node[data-key="${sh.loop.id}"] [data-toggle]`);
  await plus.scrollIntoViewIfNeeded();
  await plus.click();
  assert.equal(await page.locator(`g.container[data-key="${sh.loop.id}"]`).count(), 1);
  assert.equal(await drawn(), sh.top + sh.loop.body, "the loop's body nodes appear");
  await page.locator(`g.container[data-key="${sh.loop.id}"] [data-toggle]`).click();
  assert.equal(await drawn(), sh.top);
  await page.click('[data-action="expand-all"]');
  assert.equal(await drawn(), sh.all);
});

await step("a node shows what it does, why and the comment from the YAML, and the workflow shows its comment", async () => {
  const norm = (t) => t.replace(/\s+/g, " ").trim();
  const withNotes = await page.evaluate(() => WORKFLOWS.flatMap((w) => Object.entries(NOTES[w.name].nodes).filter(([key, n]) => !key.includes(".") && (n.what || n.comment)).map(([key, n]) => ({ wf: w.name, key, ...n }))));
  const note = withNotes.find((n) => n.what && n.why && n.comment) || withNotes.find((n) => n.what && n.comment) || withNotes[0];
  if (!note) skip("no node has a note");
  if (note) {
    await pick(note.wf);
    await node(note.key).click();
    for (const field of ["what", "why", "comment"]) {
      if (!note[field]) {
        assert.equal(await page.locator(`[data-notes="${note.key}"] [data-note="${field}"]`).count(), 0, field + " is shown only when there is one");
        continue;
      }
      assert.ok(norm(await page.textContent(`[data-notes="${note.key}"] [data-note="${field}"]`)).includes(norm(note[field]).slice(0, 40)), note.wf + "/" + note.key + " " + field);
    }
  }
  const commented = await page.evaluate(() => WORKFLOWS.map((w) => ({ wf: w.name, text: NOTES[w.name].nodesComment })).find((w) => w.text));
  if (!commented) skip("no workflow has a comment above its node list");
  if (commented) {
    await pick(commented.wf);
    await page.click("svg.graph", { position: { x: 5, y: 5 } });
    assert.ok(norm(await page.textContent('[data-notes="workflow"]')).includes(norm(commented.text).slice(0, 40)));
  }
});

await step("a simulated run, answering each pause, completes; a failure injected on the first node fails it", async () => {
  const sh = (await shapes()).find((x) => x.name === "build") || (await shapes())[0];
  await pick(sh.name);
  const positive = ["approve", "land", "fresh", "plan", "ask", "pause", "design", "edit", "ready", "go", "green"];
  const answer = async () => {
    for (let i = 0; i < 300; i++) {
      const p = page.locator("[data-prompt]");
      if ((await p.count()) === 0) return;
      const kind = await p.getAttribute("data-prompt");
      const opts = await page.locator("[data-sim-option]").evaluateAll((els) => els.map((e) => e.dataset.simOption));
      await page.click('[data-sim-option="' + (kind === "loop" ? "passes" : opts.includes("approve") ? "approve" : positive.find((x) => opts.includes(x)) || opts[0]) + '"]');
    }
  };
  await tab("sim");
  await page.click('[data-action="sim-start"]');
  await answer();
  assert.equal(await page.locator('[data-result="completed"]').count(), 1);
  assert.match(await page.textContent("#sim-log"), /Run completed/);
  assert.ok(await page.locator(`g.node[data-key="${sh.root}"].sim-completed`).count(), "the first node ran");
  assert.match(await page.textContent('[data-sim="cost"]'), /^\$/);
  // a failure injected on the first node makes the run fail
  await node(sh.root).click();
  await page.click('[data-action="sim-fail"]');
  await tab("sim");
  await page.click('[data-action="sim-start"]');
  await answer();
  assert.equal(await page.locator('[data-result="failed"]').count(), 1);
});

await step("the exported YAML reloads to the edited model, and the download button saves a file", async () => {
  const sh = await smallest((x) => x.last);
  await pick(sh.name);
  await page.click('[data-add="bash"]');
  await page.click(`[data-dep="${sh.last}"]`);
  await page.fill('[data-path="bash"]', "echo 'a: b' # not a comment\nline two");
  await page.fill("#when-raw", "");
  await tab("changes");
  const text = await page.textContent("#tab-pane");
  assert.match(text, /Nodes added \(1\)/);
  assert.match(text, /Edges added \(1\)/);
  await tab("yaml");
  const yamlText = await page.inputValue("#yaml-out");
  const model = await page.evaluate(() => window.__playground.model());
  const py = spawnSync("python3", ["-c", "import sys, json, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))"], { input: yamlText, encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(JSON.parse(py.stdout), model);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-action="download"]')]);
  const saved = fs.readFileSync(await dl.path(), "utf8");
  assert.equal(saved, yamlText);
  assert.equal(dl.suggestedFilename(), sh.name + ".yaml");
  await page.click('[data-action="reset"]');
});

await step("findings: marks, show in graph and the saved marks", async () => {
  await tab("findings");
  const ids = await page.evaluate(() => FINDINGS.map((f) => f.id));
  assert.equal(await page.locator("[data-finding]").count(), ids.length);
  if (!ids.length) return skip("no findings file on this host");
  await page.click(`[data-mark="${ids[0]}:try"]`);
  const marks = { [ids[0]]: "try" };
  if (ids.length > 1) {
    await page.click(`[data-mark="${ids[1]}:dismiss"]`);
    marks[ids[1]] = "dismiss";
  }
  const show = await page.locator("[data-show]:not([disabled])").first().getAttribute("data-show");
  if (show) {
    const [id, wf] = [show.slice(0, show.indexOf(":")), show.slice(show.indexOf(":") + 1)];
    await page.click(`[data-show="${show}"]`);
    assert.equal(await page.evaluate(() => window.__playground.state.wf), wf);
    const want = await page.evaluate(([fid, w]) => FINDINGS.find((f) => String(f.id) === fid).nodes.filter((k) => k.startsWith(w + "/")).map((k) => k.slice(w.length + 1)).filter((k) => window.__playground.state.layout.nodes[k]).length, [id, wf]);
    assert.equal(await page.locator("g.node.hl, g.container.hl").count(), want, "the finding's nodes are highlighted");
  }
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("archon-playground:v1:marks")));
  assert.deepEqual(stored, marks);
});

await step("experiments and positions persist in browser storage", async () => {
  const sh = (await shapes())[0];
  await pick(sh.name);
  await tab("yaml");
  await page.click('[data-action="reset"]');
  const n0 = await drawn();
  await page.fill("#exp-name", "plain");
  await page.click('[data-action="exp-save"]');
  await page.click('[data-add="cancel"]');
  assert.equal(await drawn(), n0 + 1);
  await page.selectOption("#exp-load", "plain");
  await page.click('[data-action="exp-load"]');
  assert.equal(await drawn(), n0);
  const stored = await page.evaluate((n) => JSON.parse(localStorage.getItem("archon-playground:v1:" + n)), sh.name);
  assert.ok(stored.experiments.plain);
});

await step("no CSP violations, console errors or page errors", async () => {
  assert.deepEqual(await page.evaluate(() => window.__csp), []);
  assert.deepEqual(problems, []);
});

await step("the page lays out at phone width without horizontal page scroll", async () => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(100);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, "horizontal overflow " + overflow);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "phone.png") });
});

await browser.close();
console.log(passed + " steps passed" + (process.exitCode ? "; some failed" : ""));
