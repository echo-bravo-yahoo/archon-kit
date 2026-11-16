import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(here, "..", "scripts");

const made = [];
const mkdtemp = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const summary = (...args) => spawnSync("bash", [path.join(SCRIPTS, "gate-summary.sh"), ...args], { encoding: "utf8" });
const reportFile = (body) => {
  const f = path.join(mkdtemp("gate-summary-"), "gate-report.md");
  fs.writeFileSync(f, body);
  return f;
};

const HEAD = "| gate | result |\n| --- | --- |\n";

test("failed prints nothing for a report in which every gate passed", () => {
  const r = summary("failed", reportFile(`${HEAD}| \`npm ci\` | passed |\n| \`npm test\` | passed |\n`));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
});

test("failed prints each failing command in report order, whole, even when it holds a pipe or a backtick", () => {
  const body = `${HEAD}| \`npm ci\` | passed |\n| \`make a | tee log\` | **FAILED** |\n| \`echo \`date\`\` | **FAILED** |\n`;
  const r = summary("failed", reportFile(body));
  assert.equal(r.stdout, "make a | tee log\necho `date`\n");
});

test("failed does not read rows that a failing gate's quoted output happens to contain", () => {
  const body = `${HEAD}| \`npm test\` | **FAILED** |\n\n### Output of failing gate \`npm test\`\n\n\`\`\`\n| \`other\` | **FAILED** |\n| \`more\` | passed |\n\`\`\`\n`;
  const r = summary("failed", reportFile(body));
  assert.equal(r.stdout, "npm test\n");
});

test("not-run prints the commands of the set that have no row, and nothing when every gate ran", () => {
  const repo = mkdtemp("gate-summary-repo-");
  fs.mkdirSync(path.join(repo, ".archon"));
  const gates = { feature: { parallel: [], ordered: ["true", "false", "echo never"] }, whole: { parallel: [], ordered: ["true"] } };
  fs.writeFileSync(path.join(repo, ".archon", "gates.json"), JSON.stringify(gates));
  const art = mkdtemp("gate-summary-art-");
  const env = { ...process.env, ARTIFACTS_DIR: art };
  const gate = (set) => spawnSync("bash", [path.join(SCRIPTS, "run-gates.sh"), set], { cwd: repo, encoding: "utf8", env });
  assert.equal(gate("feature").status, 1);
  const report = path.join(art, "gate-report.md");
  const late = spawnSync("bash", [path.join(SCRIPTS, "gate-summary.sh"), "not-run", report, "feature"], { cwd: repo, encoding: "utf8", env });
  assert.equal(late.status, 0, late.stderr);
  assert.equal(late.stdout, "echo never\n");
  assert.equal(gate("whole").status, 0);
  const none = spawnSync("bash", [path.join(SCRIPTS, "gate-summary.sh"), "not-run", report, "whole"], { cwd: repo, encoding: "utf8", env });
  assert.equal(none.stdout, "");
});

test("a missing report is an error and a missing subcommand or set name is a usage error", () => {
  assert.equal(summary("failed", "/no/such/report.md").status, 1);
  assert.equal(summary().status, 2);
  assert.equal(summary("failed").status, 2);
  assert.equal(summary("not-run", reportFile(HEAD)).status, 2);
  assert.equal(summary("other", reportFile(HEAD)).status, 2);
});
