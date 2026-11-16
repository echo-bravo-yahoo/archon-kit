import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROVENANCE = path.join(here, "..", "scripts", "sync-provenance.sh");

const made = [];
const mkdtemp = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return fs.realpathSync(d);
};
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const sh = (cwd, cmd, ...args) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = (root, rel, body = "x\n") => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};
const head = (root) => sh(root, "git", "rev-parse", "HEAD").trim();

// A repository whose `rel` holds `base`, a branch `feat` that changes it to `branch`, and a `main`
// that changed it to `main` meanwhile. The rebase of `feat` onto `main` stops, `resolution` is
// written, and the rebase continues. Returns the repository and the tip of `feat` before the rebase.
function rebased({ lanes = { protected: ["kit/**"] }, rel = "kit/x.mjs", base, branch, main, resolution }) {
  const root = mkdtemp("sync-provenance-test-");
  sh(root, "git", "init", "-q", "-b", "main");
  sh(root, "git", "config", "user.email", "t@example.com");
  sh(root, "git", "config", "user.name", "t");
  write(root, ".archon/lanes.json", JSON.stringify(lanes));
  write(root, rel, base);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "base");
  sh(root, "git", "checkout", "-q", "-b", "feat");
  write(root, rel, branch);
  sh(root, "git", "commit", "-q", "-am", "branch");
  const pre = head(root);
  sh(root, "git", "checkout", "-q", "main");
  write(root, rel, main);
  sh(root, "git", "commit", "-q", "-am", "main");
  sh(root, "git", "checkout", "-q", "feat");
  const stopped = spawnSync("git", ["rebase", "main"], { cwd: root, encoding: "utf8" });
  assert.notEqual(stopped.status, 0, "the rebase should stop at a conflict");
  write(root, rel, resolution);
  sh(root, "git", "add", rel);
  execFileSync("git", ["rebase", "--continue"], { cwd: root, encoding: "utf8", stdio: "pipe", env: { ...process.env, GIT_EDITOR: "true" } });
  return { root, pre };
}

const provenance = (root, ...args) => spawnSync("bash", [PROVENANCE, ...args], { cwd: root, encoding: "utf8" });

test("a resolution that keeps the branch's comment line passes", () => {
  const { root, pre } = rebased({
    base: "a\nb\nc\n",
    branch: "a\n// note from the branch\nc\n",
    main: "a\nmain-b\nc\n",
    resolution: "a\n// note from the branch\nmain-b\nc\n",
  });
  const r = provenance(root, "main", pre);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
});

test("a resolution that holds a line neither side wrote fails and names the file", () => {
  const { root, pre } = rebased({
    base: "a\nb\nc\n",
    branch: "a\nbranch-b\nc\n",
    main: "a\nmain-b\nc\n",
    resolution: "a\nbranch-b\ninvented line\nc\n",
  });
  const r = provenance(root, "main", pre);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "kit/x.mjs\n");
});

test("a resolution that only deletes lines passes", () => {
  const { root, pre } = rebased({
    base: "a\nb\nc\n",
    branch: "a\nbranch-b\nc\n",
    main: "a\nmain-b\nc\n",
    resolution: "a\nc\n",
  });
  assert.equal(provenance(root, "main", pre).status, 0);
});

test("a line that only the base has passes when the resolution moves it", () => {
  const { root, pre } = rebased({
    base: "a\nb\nc\n",
    branch: "a\nbranch-b\nc\n",
    main: "a\nmain-b\nc\n",
    resolution: "a\nbranch-b\nc\nmain-b\n",
  });
  assert.equal(provenance(root, "main", pre).status, 0);
});

test("a new line in a file outside the guarded set passes", () => {
  const { root, pre } = rebased({
    rel: "src/a.js",
    base: "a\nb\nc\n",
    branch: "a\nbranch-b\nc\n",
    main: "a\nmain-b\nc\n",
    resolution: "a\ninvented line\nc\n",
  });
  const r = provenance(root, "main", pre);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("a new line in .archon/gates.json fails even when lanes.json declares no protected set", () => {
  const { root, pre } = rebased({
    lanes: { tests: ["test/**"] },
    rel: ".archon/gates.json",
    base: "a\nb\nc\n",
    branch: "a\nbranch-b\nc\n",
    main: "a\nmain-b\nc\n",
    resolution: "a\ninvented line\nc\n",
  });
  const r = provenance(root, "main", pre);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, ".archon/gates.json\n");
});

test("a binary protected file passes when it equals its blob before the rebase and fails otherwise", () => {
  const bytes = (last) => Buffer.from([0, 1, 2, last]);
  const equal = rebased({ rel: "kit/bin.dat", base: bytes(3), branch: bytes(9), main: bytes(7), resolution: bytes(9) });
  assert.equal(provenance(equal.root, "main", equal.pre).status, 0);
  const other = rebased({ rel: "kit/bin.dat", base: bytes(3), branch: bytes(9), main: bytes(7), resolution: bytes(5) });
  const r = provenance(other.root, "main", other.pre);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "kit/bin.dat\n");
});

test("a missing argument is a usage error", () => {
  const { root, pre } = rebased({ base: "a\n", branch: "b\n", main: "c\n", resolution: "b\n" });
  assert.equal(provenance(root).status, 2);
  assert.equal(provenance(root, "main").status, 2);
  assert.equal(provenance(root, "main", pre, "extra").status, 2);
});
