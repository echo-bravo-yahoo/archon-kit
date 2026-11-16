import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { kitHome } from "./kit-home.mjs";
import { nodeScript, runNodeBash } from "./node-script.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLISH = path.join(here, "..", "workflows", "publish", "publish.yaml");

const KIT = kitHome();
const made = [];
const mkdtemp = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(d);
  return d;
};
after(() => {
  KIT.remove();
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
const sh = (cwd, ...args) => execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const TARGET = { name: "docs-site", command: "true", auto_paths: ["docs/**"], in_main: false };

// A repository on main with two commits and a build.json declaring `target`. Returns the repository
// and the two commits.
function mkRepo(target = TARGET) {
  const d = mkdtemp("publish-wf-");
  sh(d, "git", "init", "-q", "-b", "main");
  sh(d, "git", "config", "user.email", "t@example.com");
  sh(d, "git", "config", "user.name", "t");
  fs.mkdirSync(path.join(d, ".archon"));
  fs.writeFileSync(path.join(d, ".archon/build.json"), JSON.stringify({ publish: [target] }));
  fs.mkdirSync(path.join(d, "docs"));
  fs.writeFileSync(path.join(d, "docs/a.md"), "one\n");
  sh(d, "git", "add", "-A");
  sh(d, "git", "commit", "-q", "-m", "one");
  const first = sh(d, "git", "rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(d, "docs/a.md"), "two\n");
  sh(d, "git", "commit", "-qam", "two");
  return { d, first, second: sh(d, "git", "rev-parse", "HEAD").trim() };
}
const resolve = (cwd, target, ref = "") => {
  const art = mkdtemp("publish-art-");
  const r = runNodeBash(PUBLISH, "resolve", { cwd, vars: {}, env: { ARCHON_HOME: KIT.dir, ARTIFACTS_DIR: art, INPUTS_TARGET: target, INPUTS_REF: ref } });
  return { r, art, file: path.join(art, "publish-target.json") };
};

test("resolve fails for a target that build.json does not declare", () => {
  const { d } = mkRepo();
  const { r } = resolve(d, "nope");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no publish target named nope/);
});

test("resolve checks out the ref in the run's worktree, records the target and prints go", () => {
  const { d, first } = mkRepo();
  const { r, file } = resolve(d, "docs-site", first);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "go");
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(rec.name, "docs-site");
  assert.equal(rec.ref, first);
  assert.equal(sh(d, "git", "rev-parse", "HEAD").trim(), first);
});

test("resolve prints confirm for a target that asks for confirmation, and fails for a ref that is not a commit", () => {
  const { d, first } = mkRepo({ ...TARGET, confirm: true });
  assert.equal(resolve(d, "docs-site", first).r.stdout.trim(), "confirm");
  const bad = resolve(d, "docs-site", "no-such-ref");
  assert.equal(bad.r.status, 1);
});

test("resolve with an empty ref uses the tip of the base branch", () => {
  const { d, second } = mkRepo();
  const { r, file } = resolve(d, "docs-site");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).ref, second);
});

test("resolve for an in_main target refuses uncommitted changes under auto_paths, but not outside them", () => {
  const { d, second } = mkRepo({ ...TARGET, in_main: true });
  fs.writeFileSync(path.join(d, "docs/a.md"), "dirty\n");
  const dirty = resolve(d, "docs-site", second);
  assert.equal(dirty.r.status, 1);
  assert.match(dirty.r.stderr, /uncommitted changes/);
  sh(d, "git", "checkout", "--", "docs/a.md");
  fs.writeFileSync(path.join(d, "elsewhere.txt"), "x\n");
  const outside = resolve(d, "docs-site", second);
  assert.equal(outside.r.status, 0, outside.r.stderr);
});

test("resolve for an in_main target refuses a ref that the main checkout does not contain", () => {
  const { d, first } = mkRepo({ ...TARGET, in_main: true });
  sh(d, "git", "checkout", "-q", "-b", "side", first);
  fs.writeFileSync(path.join(d, "side.txt"), "s\n");
  sh(d, "git", "add", "-A");
  sh(d, "git", "commit", "-q", "-m", "side");
  const sideTip = sh(d, "git", "rev-parse", "HEAD").trim();
  sh(d, "git", "checkout", "-q", "main");
  const r = resolve(d, "docs-site", sideTip).r;
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not in the main checkout/);
});

test("run takes a lock per repository before it runs the command", () => {
  const script = nodeScript(PUBLISH, "run");
  assert.match(script, /flock/);
  assert.match(script, /state\/publish-/);
});
