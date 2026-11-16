const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { flattenNodes } = require("../src/model.js");
const { loadDump } = require("./load.js");

// The annotations are one person's data and are not committed, so the tests that read them skip when the file is absent.
const annotationsFile = path.join(__dirname, "..", "data", "annotations.json");
const haveAnnotations = fs.existsSync(annotationsFile);
const annotations = haveAnnotations ? JSON.parse(fs.readFileSync(annotationsFile, "utf8")) : {};
const needsAnnotations = { skip: haveAnnotations ? false : "no data/annotations.json" };

test("every node has a sentence saying what it does", needsAnnotations, () => {
  for (const w of loadDump().workflows) {
    for (const e of flattenNodes(w.model)) {
      const a = annotations[w.name + "/" + e.key];
      assert.ok(a && typeof a.what === "string" && a.what.length > 20, w.name + "/" + e.key + " has no annotation");
      assert.ok(a.what.trim().endsWith("."), w.name + "/" + e.key + ": a sentence ends in a period");
    }
  }
});

test("a node with no comment in the YAML has a reason written for the page", needsAnnotations, () => {
  for (const w of loadDump().workflows) {
    for (const e of flattenNodes(w.model)) {
      if (w.comments[e.id]) continue;
      const a = annotations[w.name + "/" + e.key];
      assert.ok(a.why && a.why.length > 20, w.name + "/" + e.key + " has neither a YAML comment nor a why");
    }
  }
});

test("no annotation names a node that does not exist", needsAnnotations, () => {
  const keys = new Set();
  for (const w of loadDump().workflows) for (const e of flattenNodes(w.model)) keys.add(w.name + "/" + e.key);
  for (const k of Object.keys(annotations)) assert.ok(keys.has(k), k + " is not a node");
});

test("YAML comments are extracted as paragraphs from the lines above a node", () => {
  const { workflows } = loadDump();
  const build = workflows.find((w) => w.name === "build");
  assert.match(build.comments.sync_base, /^Archon cuts a run's worktree from origin\/<base>/);
  assert.match(build.comments.sync_cycle, /Landing is hands-off once the owner approves/);
  assert.match(build.nodesComment, /Both pauses sit inside a loop_group/);
  assert.strictEqual(build.comments.design_ready, undefined);
});
