import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const mermaid = (text) => {
  const blocks = [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  assert.equal(blocks.length, 1, "one Mermaid block");
  return blocks[0];
};

test("the workflow diagram in README.md and in docs/choosing-a-workflow.md is the same", () => {
  assert.equal(mermaid(read("README.md")), mermaid(read("docs/choosing-a-workflow.md")));
});

test("the diagram names each kit workflow", () => {
  const diagram = mermaid(read("README.md"));
  for (const wf of fs.readdirSync(path.join(root, "workflows"))) assert.ok(diagram.includes(wf), `${wf} is in the diagram`);
});

const docFiles = () => {
  const out = ["README.md", "CLAUDE.md"].filter((f) => fs.existsSync(path.join(root, f)));
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".md")) out.push(rel);
    }
  };
  walk("docs");
  return out;
};

test("every relative link in the documentation points at a file that exists", () => {
  const broken = [];
  for (const file of docFiles()) {
    const text = read(file);
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const clean = target.split("#")[0];
      if (!clean) continue;
      if (!fs.existsSync(path.join(root, path.dirname(file), clean))) broken.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

test("every fenced code block in the documentation names its language", () => {
  const untagged = [];
  // A brief is the approved input to a build run and is not edited afterwards, so it is not held to this rule.
  for (const file of docFiles().filter((f) => !f.startsWith(`docs${path.sep}briefs${path.sep}`))) {
    let open = false;
    read(file).split("\n").forEach((line, i) => {
      const m = line.match(/^```(\S*)/);
      if (!m) return;
      if (!open && m[1] === "") untagged.push(`${file}:${i + 1}`);
      open = !open;
    });
  }
  assert.deepEqual(untagged, []);
});

test("the instruction block in docs/agents/reports.md is the one the templates carry", () => {
  const start = "<!-- archon-kit:reports:start -->";
  const end = "<!-- archon-kit:reports:end -->";
  // A Markdown formatter may add a blank line after the opening comment, so blank lines do not count.
  const block = (text) => text.slice(text.indexOf(start), text.indexOf(end) + end.length).split("\n").filter((l) => l.trim() !== "").join("\n");
  const doc = read("docs/agents/reports.md");
  assert.equal(block(doc), block(read("templates/agents/AGENTS.md")));
  assert.equal(block(read("templates/agents/AGENTS.md")), block(read("templates/agents/CLAUDE.md")));
});

test("README step 3 tells the reader that a run's worktree has no installed dependencies", () => {
  const lines = read("README.md").split("\n");
  const from = lines.findIndex((l) => l.startsWith("3. ") && l.includes(".archon/gates.json"));
  assert.notEqual(from, -1, "README has a step 3 that names .archon/gates.json");
  const rest = lines.slice(from + 1).findIndex((l) => l.startsWith("4. "));
  const step = lines.slice(from, rest === -1 ? undefined : from + 1 + rest).join("\n").toLowerCase();
  assert.match(step, /install/, "step 3 mentions installing");
  assert.match(step, /depend|package/, "step 3 mentions dependencies or packages");
  assert.ok(step.includes("`ordered`"), "step 3 names `ordered`");
  assert.ok(step.includes("`parallel`"), "step 3 names `parallel`");
  assert.match(step, /install[\s\S]*ordered|ordered[\s\S]*install/, "install and ordered appear together");
  assert.match(step, /before/, "step 3 says parallel runs before ordered");
});
