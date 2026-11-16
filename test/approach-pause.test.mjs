import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { kitHome } from "./kit-home.mjs";

// The approach round's pause: line 2 is the opening paragraph of approach.md when it has one, and the
// fixed sentence when it does not. Runs the bash of the `plan_report` node of build.yaml.
const here = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(here, "..", "workflows", "build", "build.yaml");
const SCRIPTS = path.join(here, "..", "scripts");
const URL_LINE = "http://localhost:8082/site/timer/approach-report.html";
const FIXED = "The approach is ready: the choices still open, the files it touches and the tests that prove it.";
const ANSWERS = "approve starts the full plan from this approach. rework asks for another approach with your note.";

const KIT = kitHome();
const made = [];
const mkdtemp = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return fs.realpathSync(d);
};
after(() => {
  KIT.remove();
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function nodeScript(file, id) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^ *- id: ${id}$`).test(l));
  assert.ok(start >= 0, `no node ${id} in ${file}`);
  const indent = lines[start].match(/^ */)[0].length;
  const key = new RegExp(`^ {${indent + 2}}bash: \\|$`);
  let i = start + 1;
  while (i < lines.length && !key.test(lines[i])) i++;
  const pad = " ".repeat(indent + 4);
  const body = [];
  for (i += 1; i < lines.length; i++) {
    if (lines[i] === "") body.push("");
    else if (lines[i].startsWith(pad)) body.push(lines[i].slice(pad.length));
    else break;
  }
  return `${body.join("\n")}\n`;
}
const quote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const subst = (script, vars) => {
  let out = script;
  for (const [k, v] of Object.entries(vars).sort((a, b) => b[0].length - a[0].length)) out = out.split(k).join(quote(v));
  return out;
};

function fakeHome() {
  const home = mkdtemp("fake-home-");
  const dir = path.join(home, ".archon", "scripts");
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(path.join(SCRIPTS, "state.sh"), path.join(dir, "state.sh"));
  const stub = (name, body) => fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  stub("report.sh", `printf '%s\\n' '${URL_LINE}'`);
  stub("build-settings.sh", `case "$1" in --design-dir) printf '%s\\n' '${home}/design/'"$2" ;; esac`);
  return home;
}

// Runs plan_report in an approach round over an approach.md with `body`; returns stdout lines.
function pause(body) {
  const art = mkdtemp("artifacts-");
  if (body !== null) fs.writeFileSync(path.join(art, "approach.md"), body);
  const dir = mkdtemp("node-script-");
  const script = path.join(dir, "plan_report.sh");
  fs.writeFileSync(script, subst(nodeScript(BUILD, "plan_report"), { "$plan_round.output": "approach", "$intake.output": "timer" }));
  const env = { ...process.env, ARCHON_HOME: KIT.dir, ARTIFACTS_DIR: art, HOME: fakeHome() };
  delete env.ARCHON_HOME;
  const r = spawnSync("bash", [script], { cwd: mkdtemp("plan-report-"), encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.replace(/\n$/, "").split("\n");
}
const LISTS = "Files: src/a.js\nTests: test/a.test.js\nOpen: none\n";
const doc = (para) => `# Approach: timer\n\n${para}\n\n${LISTS}`;
function shape(lines) {
  assert.equal(lines.length, 3, lines.join("\n"));
  assert.equal(lines[0], URL_LINE);
  assert.equal(lines[2], ANSWERS);
  return lines[1];
}

test("the pause shows the opening paragraph as line 2", () => {
  const p = "This adds a timer to the site. It is wanted so people can see how long a task ran. Approve starts the full plan.";
  assert.equal(shape(pause(doc(p))), p);
});

test("a wrapped paragraph is joined into one line", () => {
  const line = shape(pause(doc("This adds a timer to the site.\nIt is wanted so people can see how long a task ran.")));
  assert.equal(line, "This adds a timer to the site. It is wanted so people can see how long a task ran.");
});

test("Markdown in the paragraph is stripped to plain text", () => {
  const line = shape(pause(doc("This adds **bold** and `code` per [the docs](http://example.com/x) with _em_ text and a snake_case name.")));
  assert.equal(line, "This adds bold and code per the docs with em text and a snake_case name.");
  assert.doesNotMatch(line, /[`*[]|\]\(/);
});

test("a long paragraph is cut at the last sentence end within 400 characters", () => {
  const plain = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} says a thing.`).join(" ");
  assert.ok(plain.length > 400);
  const line = shape(pause(doc(plain)));
  assert.ok(line.length <= 400, `length ${line.length}`);
  assert.ok(line.endsWith("."));
  assert.ok(plain.startsWith(line));
  assert.ok(line.length > 300);
});

test("a long single sentence is cut at a space and ends in ...", () => {
  const plain = `${Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ")}.`;
  assert.ok(plain.length > 400);
  const line = shape(pause(doc(plain)));
  assert.ok(line.length <= 400, `length ${line.length}`);
  assert.ok(line.endsWith("..."));
  assert.ok(plain.startsWith(line.slice(0, -3).trimEnd()));
});

for (const [name, body] of [
  ["label lines after the title", `# Approach: timer\n\n${LISTS}`],
  ["a Files heading after the title", "# Approach: timer\n\n## Files\n\n- src/a.js\n"],
  ["a list after the title", "# Approach: timer\n\n- src/a.js\n- src/b.js\n"],
  ["only a title", "# Approach: timer\n"],
]) {
  test(`with no paragraph (${name}) the pause shows the fixed sentence`, () => {
    assert.equal(shape(pause(body)), FIXED);
  });
}

test("with an empty approach.md the pause is unchanged", () => {
  assert.deepEqual(pause(null), ["The approach node wrote no approach.md.", ANSWERS]);
});

test("the approach prompt asks for an opening paragraph and how to answer notes about how it read", () => {
  const text = fs.readFileSync(BUILD, "utf8");
  const start = text.search(/^ *- id: approach$/m);
  assert.ok(start >= 0);
  const rest = text.slice(text.indexOf("\n", start) + 1);
  const next = rest.search(/^ *- id: /m);
  const node = next < 0 ? rest : rest.slice(0, next);
  for (const re of [/opening paragraph/i, /two or three sentences/i, /rewrit/i, /no work/i, /plan-notes\.md/]) {
    assert.match(node, re);
  }
});

test("the approach prompt lists the open choices before the files and the tests, and says so when none is open", () => {
  const text = fs.readFileSync(BUILD, "utf8");
  const start = text.search(/^ *- id: approach$/m);
  const rest = text.slice(text.indexOf("\n", start) + 1);
  const next = rest.search(/^ *- id: /m);
  const node = (next < 0 ? rest : rest.slice(0, next)).replace(/\s+/g, " ");
  const at = (re) => node.search(re);
  assert.ok(at(/the choices still open/) >= 0);
  assert.ok(at(/the choices still open/) < at(/the files the change touches/));
  assert.ok(at(/the files the change touches/) < at(/the tests that will prove it/));
  assert.match(node, /what picking another option changes/);
  assert.match(node, /leaves no choice open, say so in one line before the lists/);
});
