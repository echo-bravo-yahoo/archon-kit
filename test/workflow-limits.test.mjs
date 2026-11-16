import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(here, "..", "workflows", "build", "build.yaml");
const RESEARCH = path.join(here, "..", "workflows", "research", "research.yaml");

// The value of `key` among the direct keys of node `id`, read from the file's lines as nodeScript in
// workflow-nodes.test.mjs reads a bash block: the node's keys are indented two past its `- id:` line.
function nodeKey(file, id, key) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^ *- id: ${id}$`).test(l));
  assert.ok(start >= 0, `no node ${id} in ${file}`);
  const indent = lines[start].match(/^ */)[0].length;
  const own = new RegExp(`^ {${indent + 2}}${key}: (.*)$`);
  for (let i = start + 1; i < lines.length; i++) {
    if (new RegExp(`^ {0,${indent}}(- id:|\\S)`).test(lines[i])) break;
    const m = lines[i].match(own);
    if (m) return m[1].trim();
  }
  return undefined;
}

const HOUR = "3600000";
const FIVE_MINUTES = "300000";

test("the nodes that run a repository's own commands carry a timeout, in milliseconds", () => {
  for (const id of ["base_gates", "gates", "red_check", "sync_gates", "mut_run"]) assert.equal(nodeKey(BUILD, id, "timeout"), HOUR, id);
  assert.equal(nodeKey(BUILD, "deliver_pr", "timeout"), FIVE_MINUTES, "deliver_pr");
});

test("nodeKey reads only a node's own keys", () => {
  assert.equal(nodeKey(BUILD, "gates_declared", "timeout"), undefined);
  assert.equal(nodeKey(BUILD, "red_check", "depends_on"), "[tests]");
});

test("research_cycle waits for sync_base as well as candidates", () => {
  assert.equal(nodeKey(RESEARCH, "research_cycle", "depends_on"), "[candidates, sync_base]");
});
