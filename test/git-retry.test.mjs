import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const GIT_RETRY = path.join(here, "..", "scripts", "git-retry");

const made = [];
const mkdtemp = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return fs.realpathSync(d);
};
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const HAS_FUSER = spawnSync("sh", ["-c", "command -v fuser"]).status === 0;
const NEEDS_FUSER = { skip: !HAS_FUSER && "needs fuser: without it git-retry removes no lock" };

// A repository with a file to add. `git add` writes the index, so a lock stops it, which `git status` ignores.
function mkRepo() {
  const repo = mkdtemp("git-retry-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "f.txt"), "x\n");
  return repo;
}
const lockOf = (repo) => path.join(repo, ".git", "index.lock");

// A stat that stands in for the system's: it records nothing and answers like BSD stat, which has
// no -c, or says what `answer` prints for -f.
function statStub(answer) {
  const bin = mkdtemp("git-retry-bin-");
  fs.writeFileSync(path.join(bin, "stat"), `#!/bin/sh\ncase "$1" in\n  -c) echo "stat: illegal option -- c" >&2; exit 1 ;;\n  -f) ${answer} ;;\nesac\nexit 1\n`, { mode: 0o755 });
  return bin;
}

const retry = (repo, args, bin) =>
  spawnSync("bash", [GIT_RETRY, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...(bin ? { PATH: `${bin}${path.delimiter}${process.env.PATH}` } : {}) },
  });

test("a leftover lock that GNU stat dates long ago is removed and the command runs", NEEDS_FUSER, () => {
  const repo = mkRepo();
  fs.writeFileSync(lockOf(repo), "");
  fs.utimesSync(lockOf(repo), 1e9, 1e9);
  const r = retry(repo, ["--wait", "5", "--stale", "60", "git", "add", "f.txt"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /removing .*index\.lock, which no process holds and is \d+s old/);
  assert.ok(!fs.existsSync(lockOf(repo)));
});

test("a leftover lock is removed where stat has no -c and -f %m prints the time, as on macOS", NEEDS_FUSER, () => {
  const repo = mkRepo();
  fs.writeFileSync(lockOf(repo), "");
  const r = retry(repo, ["--wait", "5", "--stale", "60", "git", "add", "f.txt"], statStub("echo 1000000000"));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /removing .*index\.lock, which no process holds and is \d+s old/);
  assert.ok(!fs.existsSync(lockOf(repo)));
});

test("a new lock is not removed, and git-retry gives up with 75 once the wait is over", NEEDS_FUSER, () => {
  const repo = mkRepo();
  fs.writeFileSync(lockOf(repo), "");
  const r = retry(repo, ["--wait", "1", "--stale", "3600", "git", "add", "f.txt"]);
  assert.equal(r.status, 75);
  assert.match(r.stderr, /gave up after 1s/);
  assert.ok(fs.existsSync(lockOf(repo)));
});

test("a stat that prints no time leaves the lock alone, because its age is unknown", NEEDS_FUSER, () => {
  const repo = mkRepo();
  fs.writeFileSync(lockOf(repo), "");
  fs.utimesSync(lockOf(repo), 1e9, 1e9);
  const r = retry(repo, ["--wait", "1", "--stale", "60", "git", "add", "f.txt"], statStub("echo 'not a time'"));
  assert.equal(r.status, 75);
  assert.ok(fs.existsSync(lockOf(repo)));
});
