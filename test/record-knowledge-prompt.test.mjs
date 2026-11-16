import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const lines = fs
  .readFileSync(path.join(root, "workflows/build/build.yaml"), "utf8")
  .split("\n");

const specRange = () => {
  const start = lines.findIndex((l) => /^ *- id: spec$/.test(l));
  assert.ok(start >= 0, "the spec node exists");
  const indent = lines[start].match(/^ */)[0].length;
  const next = new RegExp(`^ {0,${indent}}- id:`);
  let end = lines.findIndex((l, i) => i > start && next.test(l));
  if (end < 0) end = lines.length;
  return [start, end];
};

const specBlock = () => {
  const [s, e] = specRange();
  const block = lines.slice(s, e).join("\n");
  assert.ok(block.trim(), "the spec block is not empty");
  return block;
};

const otherNodes = () => {
  const [s, e] = specRange();
  return [...lines.slice(0, s), ...lines.slice(e)].join("\n");
};

const rule = (block) => {
  const found = block.split(/\n\s*\n/).filter((p) => /lasting knowledge/i.test(p));
  assert.equal(found.length, 1, "exactly one paragraph about lasting knowledge in spec");
  return found[0].replace(/\s+/g, " ").trim();
};

test("the spec rule names its key terms", () => {
  const p = rule(specBlock());
  for (const re of [
    /later reader/i,
    /could not get from the code/i,
    /already records/i,
    /in place/i,
    /place you chose/i,
    /\bwhy\b/i,
    /nearest existing document/i,
    /leave recording out/i,
    /new documentation structure/i,
    /convention/i,
    /records nothing/i,
  ]) {
    assert.match(p, re);
  }
});

test("the spec rule names no specific place", () => {
  const p = rule(specBlock());
  assert.ok(!p.includes("/"), "no slash");
  assert.doesNotMatch(p, /\b[\w-]+\.[a-z]{1,5}\b/i);
  assert.doesNotMatch(p, /\b(docs|README|CHANGELOG)\b/i);
});

test("the rule is in the spec prompt only", () => {
  assert.doesNotMatch(otherNodes(), /lasting knowledge/i);
});

test("the spec node keeps its wiring and the stage nodes remain", () => {
  const block = specBlock();
  assert.match(block, /^\s*depends_on: \[plan_round\]$/m);
  assert.match(block, /^\s*when: /m);
  for (const id of [
    "spec",
    "plan_decision",
    "tests_go",
    "tests",
    "red_check",
    "mutation_cycle",
    "build_go",
    "build_cycle",
  ]) {
    assert.ok(lines.some((l) => new RegExp(`^ *- id: ${id}$`).test(l)), `node ${id}`);
  }
});

test("the spec rule contains no dollar sign", () => {
  assert.ok(!rule(specBlock()).includes("$"));
});

test("the spec rule follows the brief-coverage sentence", () => {
  const block = specBlock().replace(/[ \t]+/g, " ");
  const at = block.indexOf("A plan for a brief covers what the brief asks.");
  assert.ok(at >= 0, "the sentence is present");
  const ruleAt = block.search(/lasting knowledge/i);
  assert.ok(ruleAt > at, "the rule comes after it");
});
