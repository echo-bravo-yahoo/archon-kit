import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUN_GATES = path.join(here, "..", "scripts", "run-gates.sh");
const HOME = os.homedir();

const made = [];
const mkdtemp = (prefix) => {
  const d = fs.mkdtempSync(path.join(HOME, prefix));
  made.push(d);
  return fs.realpathSync(d);
};
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

// A repository whose `two-failing` set has two ordered gates that each append a line to ran.txt
// and then fail, and whose `passing` set has two that succeed.
function mkRepo() {
  const root = mkdtemp("run-gates-test-");
  const gates = {
    "two-failing": { parallel: [], ordered: ["echo one >> ran.txt; false", "echo two >> ran.txt; false"] },
    passing: { parallel: [], ordered: ["echo one >> ran.txt", "echo two >> ran.txt"] },
  };
  fs.mkdirSync(path.join(root, ".archon"));
  fs.writeFileSync(path.join(root, ".archon", "gates.json"), JSON.stringify(gates));
  return root;
}

function runGates(root, ...args) {
  const art = mkdtemp("run-gates-art-");
  const r = spawnSync("bash", [RUN_GATES, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ARTIFACTS_DIR: art } });
  const ran = fs.existsSync(path.join(root, "ran.txt")) ? fs.readFileSync(path.join(root, "ran.txt"), "utf8") : "";
  return { status: r.status, stdout: r.stdout, ran };
}

test("without the flag the first failing ordered gate ends the run", () => {
  const r = runGates(mkRepo(), "two-failing");
  assert.equal(r.status, 1);
  assert.equal(r.ran, "one\n");
});

test("--keep-going runs every ordered gate and still exits 1", () => {
  const r = runGates(mkRepo(), "two-failing", "--keep-going");
  assert.equal(r.status, 1);
  assert.equal(r.ran, "one\ntwo\n");
  assert.equal(r.stdout.match(/\*\*FAILED\*\*/g).length, 2);
});

test("--keep-going exits 0 when every gate passes", () => {
  const r = runGates(mkRepo(), "passing", "--keep-going");
  assert.equal(r.status, 0);
  assert.equal(r.ran, "one\ntwo\n");
});

test("--list still prints the commands and runs nothing", () => {
  const r = runGates(mkRepo(), "two-failing", "--list");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "echo one >> ran.txt; false\necho two >> ran.txt; false\n");
  assert.equal(r.ran, "");
});

// A git repository with a tracked file, an ignored name and one committed gate set per entry of `gates`.
function mkGitRepo(gates) {
  const root = mkdtemp("run-gates-git-");
  fs.mkdirSync(path.join(root, ".archon"));
  fs.writeFileSync(path.join(root, ".archon", "gates.json"), JSON.stringify(gates));
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(root, "tracked.txt"), "t\n");
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  return root;
}

function runClean(cmds, ...args) {
  const root = mkGitRepo({ g: { parallel: [], ordered: cmds } });
  const art = mkdtemp("run-gates-art-");
  const r = spawnSync("bash", [RUN_GATES, "g", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ARTIFACTS_DIR: art } });
  const report = fs.readFileSync(path.join(art, "gate-report.md"), "utf8");
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, report, art };
}

const cleanRow = (report) => report.split("\n").find((l) => l.startsWith("| `clean working tree`"));

test("--clean-tree fails when a gate leaves an untracked file", () => {
  const r = runClean(["echo x > new.txt"], "--clean-tree");
  assert.equal(r.status, 1);
  assert.match(cleanRow(r.report), /\*\*FAILED\*\*/);
  assert.match(r.report, /\?\? new\.txt/);
  assert.match(r.stderr, /new\.txt/);
});

test("--clean-tree fails when a gate modifies a tracked file", () => {
  const r = runClean(["echo y >> tracked.txt"], "--clean-tree");
  assert.equal(r.status, 1);
  assert.match(cleanRow(r.report), /\*\*FAILED\*\*/);
  assert.match(r.report, / M tracked\.txt/);
});

test("--clean-tree ignores ignored paths", () => {
  const r = runClean(["echo z > $(echo ig)nored.txt"], "--clean-tree");
  assert.equal(r.status, 0);
  assert.match(cleanRow(r.report), /\| passed \|$/);
  assert.doesNotMatch(r.report, /ignored\.txt/);
});

test("--clean-tree passes on a clean tree", () => {
  const r = runClean(["true"], "--clean-tree");
  assert.equal(r.status, 0);
  assert.match(cleanRow(r.report), /\| passed \|$/);
});

test("a dirty tree passes without --clean-tree and adds no row", () => {
  const r = runClean(["echo x > new.txt"]);
  assert.equal(r.status, 0);
  assert.equal(cleanRow(r.report), undefined);
});

test("--clean-tree checks the tree even when a gate failed", () => {
  const r = runClean(["echo x > new.txt; false"], "--clean-tree");
  assert.equal(r.status, 1);
  assert.equal(r.report.match(/^\| .* \| \*\*FAILED\*\* \|$/gm).length, 2);
  assert.match(r.report, /### Output of failing gate/);
  assert.match(r.report, /\?\? new\.txt/);
});

for (const order of [["--keep-going", "--clean-tree"], ["--clean-tree", "--keep-going"]]) {
  test(`${order.join(" ")} are both honoured`, () => {
    const r = runClean(["echo one >> ran.txt; false", "echo two >> ran.txt; false"], ...order);
    assert.equal(r.status, 1);
    assert.equal(r.report.match(/^\| .* \| \*\*FAILED\*\* \|$/gm).length, 3);
    assert.match(r.report, /\?\? ran\.txt/);
  });
}

test("gate-summary.sh failed names the clean working tree row", () => {
  const r = runClean(["echo x > new.txt"], "--clean-tree");
  const s = spawnSync("bash", [path.join(here, "..", "scripts", "gate-summary.sh"), "failed", path.join(r.art, "gate-report.md")], { encoding: "utf8" });
  assert.equal(s.stdout.trim(), "clean working tree");
});

test("an unknown flag exits 2", () => {
  const root = mkGitRepo({ g: { parallel: [], ordered: ["true"] } });
  const art = mkdtemp("run-gates-art-");
  const r = spawnSync("bash", [RUN_GATES, "g", "--bogus"], { cwd: root, encoding: "utf8", env: { ...process.env, ARTIFACTS_DIR: art } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--bogus|[Uu]sage/);
});
