import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { kitHome } from "./kit-home.mjs";

// base-gates.sh runs in a linked worktree of a throwaway repository, as it does inside a run, against the
// kit's own scripts. Each gate appends a line to a marker file outside the repository, so a test can count
// how often the gates ran.
const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(here, "..", "scripts");

const made = [];
const kits = [];
const mkdtemp = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(d);
  return d;
};
after(() => {
  for (const k of kits) k.remove();
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const sh = (cwd, cmd, ...args) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = (root, rel, body) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
};
const commitAll = (root, message) => {
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", message);
};

// A repository with the given feature gates (commands run in order) committed, and a linked worktree on a
// new branch, which is where a run stands. `marker` counts the runs of every gate written as `mark`.
function mkProject({ ordered, buildJson, noGates = false } = {}) {
  const root = mkdtemp("base-gates-repo-");
  sh(root, "git", "init", "-q", "-b", "main");
  sh(root, "git", "config", "user.email", "t@example.com");
  sh(root, "git", "config", "user.name", "t");
  const marker = path.join(mkdtemp("base-gates-marker-"), "ran");
  write(root, "README.md", "readme\n");
  write(root, "ok.txt", "ok\n");
  if (!noGates) write(root, ".archon/gates.json", { feature: { parallel: [], ordered: (ordered ?? ["mark"]).map((g) => g.replace(/\bmark\b/, `echo run >> ${marker}`)) } });
  if (buildJson !== undefined) write(root, ".archon/build.json", buildJson);
  commitAll(root, "base");
  const wt = path.join(mkdtemp("base-gates-wt-"), "run");
  sh(root, "git", "worktree", "add", "-q", "-b", "run-branch", wt);
  const runs = () => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n").length : 0);
  return { root, wt, runs };
}

function baseGates(p, { state = {} } = {}) {
  const kit = kitHome();
  kits.push(kit);
  const art = mkdtemp("base-gates-art-");
  const env = { ...process.env, ARCHON_HOME: kit.dir, ARTIFACTS_DIR: art };
  for (const [k, v] of Object.entries(state)) execFileSync("bash", [path.join(SCRIPTS, "state.sh"), "set", k, v], { env });
  const run = () => spawnSync("bash", [path.join(SCRIPTS, "base-gates.sh")], { cwd: p.wt, encoding: "utf8", env });
  const stateGet = (k) => execFileSync("bash", [path.join(SCRIPTS, "state.sh"), "get", k], { env, encoding: "utf8" }).trim();
  return { run, art, kit, stateGet };
}

const worktrees = (p) => sh(p.root, "git", "worktree", "list").trim().split("\n").length;

test("a green base prints green, records it, caches it, and leaves the repository and its worktree list as they were", () => {
  const p = mkProject({ ordered: ["mark", "mark"] });
  const b = baseGates(p);
  const r = b.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "green\n");
  assert.equal(b.stateGet("base-gates"), "green");
  assert.equal(p.runs(), 2);
  assert.equal(worktrees(p), 2);
  assert.equal(sh(p.root, "git", "status", "--short"), "");
  assert.equal(sh(p.wt, "git", "status", "--short"), "");
  assert.ok(!fs.existsSync(path.join(b.art, "base", "tree")));
  assert.match(fs.readFileSync(path.join(b.art, "run.log"), "utf8"), /== \S+ base-gates \(exit 0\)/);
});

test("a second run on the same commit prints cached and does not run the gates again", () => {
  const p = mkProject();
  const b = baseGates(p);
  assert.equal(b.run().stdout, "green\n");
  const again = b.run();
  assert.equal(again.stdout, "cached\n");
  assert.equal(b.stateGet("base-gates"), "cached");
  assert.equal(p.runs(), 1);
});

test("a new commit on the base branch is not served from the cache", () => {
  const p = mkProject();
  const b = baseGates(p);
  assert.equal(b.run().stdout, "green\n");
  write(p.root, "later.txt", "later\n");
  commitAll(p.root, "a later commit on main");
  sh(p.wt, "git", "merge", "-q", "--ff-only", "main");
  assert.equal(b.run().stdout, "green\n");
  assert.equal(p.runs(), 2);
});

test("a red base exits 1, names every failing gate, says what to do, records red and caches nothing", () => {
  const p = mkProject({ ordered: ["mark", "false", "mark", "test -f missing.txt"] });
  const b = baseGates(p);
  const r = b.run();
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /The base commit is red, so this run cannot succeed/);
  assert.match(r.stderr, /^ {2}false$/m);
  assert.match(r.stderr, /^ {2}test -f missing\.txt$/m);
  assert.match(r.stderr, /Fix them on the base branch and start the run again/);
  assert.match(r.stderr, /"base_gates": "off"/);
  assert.equal(b.stateGet("base-gates"), "red");
  assert.equal(p.runs(), 2);
  assert.equal(worktrees(p), 2);
  b.run();
  assert.equal(p.runs(), 4);
});

test("the gates run on the commit the branch left the base branch at, not on an adopted run's own commits", () => {
  const p = mkProject({ ordered: ["test -f ok.txt"] });
  sh(p.wt, "git", "rm", "-q", "ok.txt");
  commitAll(p.wt, "the adopted run's change breaks the gate");
  const b = baseGates(p, { state: { "fork-ref": "main" } });
  const r = b.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "green\n");
  const without = baseGates(p);
  assert.equal(without.run().status, 1);
});

test("a gate that rewrites a tracked file does not dirty the run's tree", () => {
  const p = mkProject({ ordered: ["echo changed >> README.md"] });
  const b = baseGates(p);
  assert.equal(b.run().stdout, "green\n");
  assert.equal(sh(p.wt, "git", "status", "--short"), "");
  assert.equal(fs.readFileSync(path.join(p.wt, "README.md"), "utf8"), "readme\n");
});

test('"base_gates": "off" and false skip the check, and a value that is neither on nor off is an error', () => {
  for (const value of ["off", false]) {
    const p = mkProject({ ordered: ["false"], buildJson: { base_gates: value } });
    const b = baseGates(p);
    const r = b.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "skipped\n");
    assert.equal(b.stateGet("base-gates"), "skipped");
  }
  const on = baseGates(mkProject({ ordered: ["false"], buildJson: { base_gates: "on" } })).run();
  assert.equal(on.status, 1);
  const typo = baseGates(mkProject({ buildJson: { base_gates: "of" } })).run();
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /must be "on" or "off", not "of"/);
});

test("a base without a feature gate file is unknown, and the run goes on", () => {
  const p = mkProject({ noGates: true });
  const b = baseGates(p);
  const r = b.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "unknown\n");
  assert.match(r.stderr, /the base commit has no \.archon\/gates\.json/);
  assert.equal(b.stateGet("base-gates"), "unknown");
});

test("a gate set that cannot run because it has no feature set is unknown and not red", () => {
  const p = mkProject();
  write(p.root, ".archon/gates.json", { tests: { parallel: [], ordered: ["true"] } });
  commitAll(p.root, "declare only a tests set");
  sh(p.wt, "git", "merge", "-q", "--ff-only", "main");
  const b = baseGates(p);
  const r = b.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "unknown\n");
  assert.match(r.stderr, /the gates did not run on the base commit/);
});
