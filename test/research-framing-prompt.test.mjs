import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const text = fs.readFileSync(new URL("../workflows/research/research.yaml", import.meta.url), "utf8");
const lines = text.split("\n");

const promptOf = () => {
  const start = lines.findIndex((l) => /^ *- id: research$/.test(l));
  assert.ok(start >= 0, "research node exists");
  const p = lines.findIndex((l, i) => i > start && /^ *prompt: \|\s*$/.test(l));
  assert.ok(p >= 0, "research node has a block prompt");
  const keyIndent = lines[p].match(/^ */)[0].length;
  const body = [];
  for (let i = p + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") { body.push(""); continue; }
    if (lines[i].match(/^ */)[0].length <= keyIndent) break;
    body.push(lines[i].trim());
  }
  return body.join(" ").replace(/\s+/g, " ");
};
const prompt = promptOf();

test("a shape note rewrites the report from the top", () => {
  assert.match(prompt, /steer\.md/);
  assert.match(prompt, /rewrit\w*[^.]*from the top/i);
  assert.match(prompt, /shape|framing|lead|audience/i);
});

test("the in-place extension instruction is replaced", () => {
  assert.doesNotMatch(prompt, /extend the report in place/i);
});

test("an evidence note extends and a mixed note gets both", () => {
  assert.match(prompt, /extend/i);
  assert.match(prompt, /both/i);
});

test("every round rewrites the sections the note bears on and adds one line to a Rounds section that keeps the earlier lines", () => {
  assert.match(prompt, /change the sections the newest note bears on/i);
  assert.match(prompt, /answer to the note is in the body/i);
  assert.match(prompt, /add one line to a `## Rounds` section at the end of the report/i);
  assert.match(prompt, /keep every earlier line/i);
  assert.doesNotMatch(prompt, /never carries a log of rounds|drop per-round history/i);
});

test("the section list ends with Rounds from the second round on", () => {
  const list = prompt.search(/the open questions, any work the findings suggest and, from the second round on, `Rounds`/);
  assert.ok(list >= 0, "Rounds is the last item of the section list");
});

test("a recommended course of action comes before the question as asked", () => {
  const a = prompt.search(/recommended course of action/i);
  const b = prompt.search(/the question as asked/i);
  assert.ok(a >= 0, "mentions a recommended course of action");
  assert.ok(b >= 0, "mentions the question as asked");
  assert.ok(a < b, "course of action leads");
});

test("an experiment-shaped report proposes an interactive build that records the result", () => {
  assert.match(prompt, /experiment/i);
  assert.match(prompt, /what each outcome means|each outcome/i);
  assert.match(prompt, /interactive[\s\S]{0,200}yes/i);
  assert.match(prompt, /record/i);
});

test("node ids and model tiers are intact", () => {
  for (const id of ["candidates", "research_cycle", "round", "research", "follow_plan", "report_page", "notice", "decision", "follow_up"]) {
    assert.match(text, new RegExp(`^ *- id: ${id}$`, "m"), id);
  }
  for (const m of text.matchAll(/^ *model: *(\S+)/gm)) {
    assert.match(m[1], /^(small|medium|large|@\S+)$/);
  }
});

test("the description no longer says a round extends the same report", () => {
  const i = lines.findIndex((l) => /^description: \|/.test(l));
  const desc = [];
  for (let j = i + 1; j < lines.length && /^ {2}\S|^$/.test(lines[j]); j++) desc.push(lines[j]);
  assert.doesNotMatch(desc.join(" ").replace(/\s+/g, " "), /extends the same report/i);
});
