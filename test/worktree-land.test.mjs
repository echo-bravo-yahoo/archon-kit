import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const LAND = path.join(here, "..", "scripts", "worktree-land");

const made = [];
const mkdtemp = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return fs.realpathSync(d);
};
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

// The host's git configuration (hooks, identity) must not decide what the script does.
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// A repository on main with `idle` other worktrees, and one session worktree holding a commit to
// land. The idle worktrees' names are long, so that a few dozen of them make the output of
// `git worktree list` longer than the 4096 bytes that git writes in one piece.
function mkRepo(idle) {
  const root = mkdtemp("worktree-land-test-");
  const main = path.join(root, "main-checkout");
  fs.mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  git(main, "commit", "-q", "--allow-empty", "-m", "init");
  for (let i = 0; i < idle; i++) {
    git(main, "worktree", "add", "-q", path.join(root, `idle-worktree-with-a-long-directory-name-${i}`), "-b", `idle-branch-with-a-long-name-${i}`);
  }
  const session = path.join(root, "session");
  git(main, "worktree", "add", "-q", session, "-b", "session/one");
  fs.writeFileSync(path.join(session, "landed.txt"), "from the session\n");
  git(session, "add", "landed.txt");
  git(session, "commit", "-q", "-m", "add landed.txt");
  return { main, session };
}

const land = (cwd) => spawnSync("bash", [LAND], { cwd, env, encoding: "utf8" });
const bytes = (cwd, ...args) => Buffer.byteLength(git(cwd, ...args));

test("lands the session's commit onto main and resets the session branch", () => {
  const { main, session } = mkRepo(2);
  const r = land(session);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Landed on main\./);
  assert.equal(git(main, "log", "main", "-1", "--format=%s").trim(), "add landed.txt");
  assert.equal(fs.readFileSync(path.join(main, "landed.txt"), "utf8"), "from the session\n");
  assert.equal(git(session, "rev-parse", "HEAD").trim(), git(main, "rev-parse", "main").trim());
});

test("lands when the list of worktrees is longer than one write of git's output", () => {
  const { main, session } = mkRepo(60);
  assert.ok(bytes(main, "worktree", "list") > 4096);
  assert.ok(bytes(main, "worktree", "list", "--porcelain") > 4096);
  const r = land(session);
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /Landed on main\./);
  assert.equal(git(main, "log", "main", "-1", "--format=%s").trim(), "add landed.txt");
});

test("says it was run from the main checkout, not a worktree, even with a long list of worktrees", () => {
  const { main } = mkRepo(60);
  assert.ok(bytes(main, "worktree", "list") > 4096);
  const r = land(main);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Not in a worktree \(in repo root\)/);
});

test("finds the main worktree when its path contains a space", () => {
  const { main, session } = mkRepo(0);
  const spaced = path.join(path.dirname(main), "main checkout");
  fs.renameSync(main, spaced);
  git(spaced, "worktree", "repair", session);
  const r = land(session);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(spaced, "log", "main", "-1", "--format=%s").trim(), "add landed.txt");
});
