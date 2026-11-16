import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { kitHome } from "./kit-home.mjs";

// run-sync.sh runs against a throwaway repository whose linked worktree stands for a paused run's worktree, and
// a scratch ARCHON_HOME whose database holds that run's row.
const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(here, "..", "scripts");
const RUN_ID = "abcdef0123456789abcdef0123456789";

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

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (root, rel, body) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};
const commit = (root, message) => {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
};

// main holds `shared.txt`. The run's branch changes line 1 of it. On main, `fix` adds fix.txt, `other` adds other.txt and
// `clash` changes line 1 of shared.txt too, so a cherry-pick of `clash` conflicts and a merge of main does.
function mkRun({ status = "paused", forkRef = "main", workflow = "build" } = {}) {
  const root = mkdtemp("run-sync-repo-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  write(root, "shared.txt", "one\ntwo\n");
  commit(root, "base");
  const wt = path.join(mkdtemp("run-sync-wt-"), "run");
  git(root, "worktree", "add", "-q", "-b", "run-branch", wt);
  write(wt, "shared.txt", "run one\ntwo\n");
  commit(wt, "the run's change");
  const shas = {};
  write(root, "fix.txt", "fix\n");
  shas.fix = commit(root, "fix: the base branch fix");
  write(root, "other.txt", "other\n");
  shas.other = commit(root, "other: an unrelated change");
  write(root, "shared.txt", "main one\ntwo\n");
  shas.clash = commit(root, "clash: a change to the same line");
  const kit = kitHome();
  kits.push(kit);
  const artifacts = path.join(kit.dir, "workspaces", "w", "artifacts", "runs", RUN_ID);
  fs.mkdirSync(artifacts, { recursive: true });
  if (forkRef) execFileSync("bash", [path.join(SCRIPTS, "state.sh"), "set", "fork-ref", forkRef], { env: { ...process.env, ARTIFACTS_DIR: artifacts } });
  const db = new DatabaseSync(path.join(kit.dir, "archon.db"));
  db.exec("create table remote_agent_workflow_runs (id text primary key, status text, working_path text, output_root text, workflow_name text)");
  db.prepare("insert into remote_agent_workflow_runs values (?, ?, ?, ?, ?)").run(RUN_ID, status, wt, path.join(kit.dir, "workspaces", "w"), workflow);
  db.close();
  const sync = (...args) => spawnSync("bash", [path.join(SCRIPTS, "run-sync.sh"), ...args], { encoding: "utf8", env: { ...process.env, ARCHON_HOME: kit.dir } });
  return { root, wt, shas, kit, sync };
}

const inProgress = (wt) => ["MERGE_HEAD", "CHERRY_PICK_HEAD"].some((f) => fs.existsSync(git(wt, "rev-parse", "--path-format=absolute", "--git-path", f)));

test("commits given by name are cherry-picked with -x, in order, and the run id can be a prefix", () => {
  const r = mkRun();
  const before = git(r.wt, "rev-parse", "HEAD");
  const out = r.sync(RUN_ID.slice(0, 8), r.shas.fix, r.shas.other);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /run abcdef\w+: 2 commit\(s\) added to the branch/);
  assert.match(out.stdout, /archon workflow respond abcdef\w+ rework/);
  assert.equal(fs.readFileSync(path.join(r.wt, "fix.txt"), "utf8"), "fix\n");
  assert.equal(fs.readFileSync(path.join(r.wt, "other.txt"), "utf8"), "other\n");
  assert.equal(fs.readFileSync(path.join(r.wt, "shared.txt"), "utf8"), "run one\ntwo\n");
  assert.equal(git(r.wt, "log", "--format=%s", `${before}..HEAD`), "other: an unrelated change\nfix: the base branch fix");
  assert.match(git(r.wt, "log", "-1", "--format=%b", "HEAD~1"), new RegExp(`\\(cherry picked from commit ${r.shas.fix}\\)`));
  assert.equal(git(r.wt, "status", "--porcelain"), "");
  assert.ok(!inProgress(r.wt));
});

test("the run is found in a database whose path holds ?, # and %", () => {
  const r = mkRun();
  const odd = path.join(mkdtemp("run-sync-odd-"), "a?b#c%25d e");
  fs.mkdirSync(odd);
  fs.copyFileSync(path.join(r.kit.dir, "archon.db"), path.join(odd, "archon.db"));
  fs.symlinkSync(path.join(SCRIPTS), path.join(odd, "scripts"));
  const out = spawnSync("bash", [path.join(SCRIPTS, "run-sync.sh"), RUN_ID, r.shas.fix], { encoding: "utf8", env: { ...process.env, ARCHON_HOME: odd } });
  assert.equal(out.status, 0, out.stderr);
  assert.ok(fs.existsSync(path.join(r.wt, "fix.txt")));
});

test("a cherry-pick that conflicts leaves the branch where it was, even when an earlier commit of the call applied", () => {
  const r = mkRun();
  const before = git(r.wt, "rev-parse", "HEAD");
  const out = r.sync(RUN_ID, r.shas.fix, r.shas.clash);
  assert.equal(out.status, 1);
  assert.match(out.stderr, new RegExp(`cherry-picking ${r.shas.clash} conflicts in: shared\\.txt\\. The branch is back at ${before.slice(0, 7)}`));
  assert.equal(git(r.wt, "rev-parse", "HEAD"), before);
  assert.ok(!fs.existsSync(path.join(r.wt, "fix.txt")));
  assert.equal(git(r.wt, "status", "--porcelain"), "");
  assert.ok(!inProgress(r.wt));
});

test("a commit that was already cherry-picked, or is an ancestor of the branch, is skipped and changes nothing", () => {
  const r = mkRun();
  assert.equal(r.sync(RUN_ID, r.shas.fix).status, 0);
  const tip = git(r.wt, "rev-parse", "HEAD");
  const again = r.sync(RUN_ID, r.shas.fix);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, new RegExp(`${r.shas.fix} changes nothing in this branch, so it was skipped`));
  assert.match(again.stdout, /0 commit\(s\) added/);
  assert.equal(git(r.wt, "rev-parse", "HEAD"), tip);
  assert.equal(git(r.wt, "status", "--porcelain"), "");
  assert.ok(!inProgress(r.wt));
  const ancestor = git(r.wt, "rev-parse", "HEAD~1");
  const same = r.sync(RUN_ID, ancestor);
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, new RegExp(`${ancestor} is already in the branch`));
  assert.equal(git(r.wt, "rev-parse", "HEAD"), tip);
});

test("a commit that does not exist is an error that leaves the branch where it was", () => {
  const r = mkRun();
  const before = git(r.wt, "rev-parse", "HEAD");
  const out = r.sync(RUN_ID, r.shas.fix, "0000000000000000000000000000000000000001");
  assert.equal(out.status, 1);
  assert.match(out.stderr, /no commit 0000000000000000000000000000000000000001 in the repository/);
  assert.equal(git(r.wt, "rev-parse", "HEAD"), before);
});

test("with no commits it merges the fork-ref when that merges cleanly", () => {
  const r = mkRun();
  git(r.root, "reset", "-q", "--hard", r.shas.other);
  const out = r.sync(RUN_ID);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /commit\(s\) added to the branch/);
  assert.equal(fs.readFileSync(path.join(r.wt, "other.txt"), "utf8"), "other\n");
  assert.equal(git(r.wt, "log", "--merges", "--format=%s", "-1"), "Merge branch 'main' into run-branch");
  assert.equal(git(r.wt, "status", "--porcelain"), "");
  const again = r.sync(RUN_ID);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already contains main/);
});

test("a merge that conflicts is aborted, names the files and suggests naming the commit that fixes the failure", () => {
  const r = mkRun();
  const before = git(r.wt, "rev-parse", "HEAD");
  const out = r.sync(RUN_ID);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /merging main conflicts in: shared\.txt\. The branch is back at/);
  assert.match(out.stderr, /archon-kit run-sync abcdef\w+ <commit>/);
  assert.equal(git(r.wt, "rev-parse", "HEAD"), before);
  assert.equal(git(r.wt, "status", "--porcelain"), "");
  assert.ok(!inProgress(r.wt));
});

test("with no commits and no fork-ref in the state there is nothing to merge", () => {
  const r = mkRun({ forkRef: "" });
  const out = r.sync(RUN_ID);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /has no fork-ref in its state/);
});

test("a failed run takes a sync and is told to adopt the run, and a run that is neither paused nor failed is refused", () => {
  const failed = mkRun({ status: "failed" });
  const ok = failed.sync(RUN_ID, failed.shas.fix);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(fs.existsSync(path.join(failed.wt, "fix.txt")));
  assert.match(ok.stdout, /archon workflow run build --adopt abcdef\w+ --detach/);
  assert.doesNotMatch(ok.stdout, /archon workflow respond/);
  const other = mkRun({ status: "failed", workflow: "research" });
  assert.doesNotMatch(other.sync(RUN_ID, other.shas.fix).stdout, /--adopt/);
  for (const status of ["running", "completed", "cancelled"]) {
    const r = mkRun({ status });
    const out = r.sync(RUN_ID, r.shas.fix);
    assert.equal(out.status, 1, status);
    assert.match(out.stderr, new RegExp(`run abcdef\\w+ is ${status}; only a paused or failed run can take a sync`));
    assert.ok(!fs.existsSync(path.join(r.wt, "fix.txt")));
  }
});

test("a dirty worktree and an unknown or missing run id are refused", () => {
  const dirty = mkRun();
  write(dirty.wt, "shared.txt", "edited by hand\n");
  const b = dirty.sync(RUN_ID, dirty.shas.fix);
  assert.equal(b.status, 1);
  assert.match(b.stderr, /has uncommitted changes/);

  const c = dirty.sync("ffffffff", dirty.shas.fix);
  assert.equal(c.status, 1);
  assert.match(c.stderr, /matches 0 runs/);
  assert.equal(dirty.sync().status, 2);
});

test("archon-kit run-sync passes its arguments to the script and prints a usage error with none", () => {
  const r = mkRun();
  const kit = path.join(SCRIPTS, "archon-kit");
  const env = { ...process.env, ARCHON_HOME: r.kit.dir };
  const ok = spawnSync("bash", [kit, "run-sync", RUN_ID, r.shas.fix], { encoding: "utf8", env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(fs.existsSync(path.join(r.wt, "fix.txt")));
  const none = spawnSync("bash", [kit, "run-sync"], { encoding: "utf8", env });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /usage: archon-kit run-sync <run-id> \[commit\.\.\.\]/);
  assert.match(spawnSync("bash", [kit, "help"], { encoding: "utf8", env }).stdout, /run-sync RUN \[COMMIT\.\.\.\]/);
});
