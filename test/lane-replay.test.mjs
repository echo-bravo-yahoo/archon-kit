import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// lane-replay.mjs replays a repository's logged build stages in a throwaway worktree of the
// repository's checkout, which it looks for under the `workspace` setting of kit.json. Each test
// names a repository that has no checkout, so the script stops at the checkout's path and the
// path shows which workspace it used.
const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(here, "..", "scripts");
const HAS_JQ = spawnSync("sh", ["-c", "command -v jq"]).status === 0;

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function replay(kit) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lane-replay-")));
  made.push(root);
  const archonHome = path.join(root, "archon");
  fs.mkdirSync(archonHome);
  fs.symlinkSync(SCRIPTS, path.join(archonHome, "scripts"));
  if (kit !== undefined) fs.writeFileSync(path.join(archonHome, "kit.json"), kit);
  const r = spawnSync("node", [path.join(SCRIPTS, "lane-replay.mjs"), "--repo", "demo"], {
    encoding: "utf8",
    env: { ...process.env, HOME: path.join(root, "home"), ARCHON_HOME: archonHome },
  });
  return { root, r };
}

test("the checkout is looked for under ~/workspace when kit.json sets no workspace", () => {
  const { root, r } = replay();
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes(path.join(root, "home", "workspace", "demo")), r.stderr);
});

test("the checkout is looked for under the workspace setting of kit.json", { skip: !HAS_JQ && "needs jq" }, () => {
  const { root, r } = replay(JSON.stringify({ workspace: "/srv/code" }));
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("/srv/code/demo"), r.stderr);
  assert.ok(!r.stderr.includes(path.join(root, "home", "workspace")), r.stderr);
});

test("a kit.json that is not a JSON object stops the script with the reason, and falls back to nothing", { skip: !HAS_JQ && "needs jq" }, () => {
  const { r } = replay("[1]");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read .*kit\.json as a JSON object/);
  assert.ok(!r.stderr.includes("cannot change to"), r.stderr);
});
