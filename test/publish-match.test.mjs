import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MATCH = path.join(here, "..", "scripts", "publish-match.sh");

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
const sh = (cwd, ...args) => execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// A repository with a base commit, then a head commit that adds `changed`. Returns the repository
// and the two refs.
function mk(publish, changed) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "publish-match-")));
  made.push(d);
  sh(d, "git", "init", "-q", "-b", "main");
  sh(d, "git", "config", "user.email", "t@example.com");
  sh(d, "git", "config", "user.name", "t");
  fs.mkdirSync(path.join(d, ".archon"));
  fs.writeFileSync(path.join(d, ".archon/build.json"), JSON.stringify(publish === undefined ? {} : { publish }));
  fs.writeFileSync(path.join(d, "README.md"), "x\n");
  sh(d, "git", "add", "-A");
  sh(d, "git", "commit", "-q", "-m", "base");
  const base = sh(d, "git", "rev-parse", "HEAD").trim();
  for (const f of changed) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), "changed\n");
  }
  fs.writeFileSync(path.join(d, "unrelated.txt"), "u\n");
  sh(d, "git", "add", "-A");
  sh(d, "git", "commit", "-q", "-m", "head");
  return { d, base, head: sh(d, "git", "rev-parse", "HEAD").trim() };
}
const match = (r, base = r.base, head = r.head) => spawnSync("bash", [MATCH, base, head], { cwd: r.d, encoding: "utf8" });
const docs = (extra = {}) => ({ name: "docs-site", command: "true", auto_paths: ["docs/**"], ...extra });

test("a changed file under auto_paths prints one publish entry naming the target and the file", () => {
  const r = mk([docs()], ["docs/guide/a.md"]);
  const out = match(r);
  assert.equal(out.status, 0, out.stderr);
  const list = JSON.parse(out.stdout);
  assert.equal(list.length, 1);
  assert.equal(list[0].workflow, "publish");
  assert.equal(list[0].repo, "");
  assert.deepEqual(list[0].inputs, [{ name: "target", value: "docs-site" }]);
  assert.match(list[0].note, /docs\/guide\/a\.md/);
});

test("nothing under auto_paths, or no publish key, prints []", () => {
  assert.deepEqual(JSON.parse(match(mk([docs()], ["src/a.js"])).stdout), []);
  assert.deepEqual(JSON.parse(match(mk(undefined, ["docs/a.md"])).stdout), []);
});

test("skip_paths removes a change from the match, and a real doc beside a draft still matches", () => {
  const skip = { skip_paths: ["docs/drafts/**"] };
  assert.deepEqual(JSON.parse(match(mk([docs(skip)], ["docs/drafts/x.md"])).stdout), []);
  const both = JSON.parse(match(mk([docs(skip)], ["docs/drafts/x.md", "docs/real.md"])).stdout);
  assert.equal(both.length, 1);
  assert.match(both[0].note, /docs\/real\.md/);
  assert.doesNotMatch(both[0].note, /drafts/);
});

test("** reaches a file two directories deep, and a path outside auto_paths does not match", () => {
  assert.equal(JSON.parse(match(mk([docs()], ["docs/a/b/c.md"])).stdout).length, 1);
  assert.deepEqual(JSON.parse(match(mk([docs()], ["doc/a.md", "notdocs/a.md"])).stdout), []);
});

test("two targets match independently, in declaration order", () => {
  const r = mk([docs(), { name: "api-site", command: "true", auto_paths: ["api/**"] }], ["api/x.md", "docs/y.md"]);
  const list = JSON.parse(match(r).stdout);
  assert.deepEqual(list.map((x) => x.inputs[0].value), ["docs-site", "api-site"]);
});

test("an unknown ref exits non-zero, and no arguments exit 2", () => {
  const r = mk([docs()], ["docs/a.md"]);
  assert.notEqual(match(r, "no-such-ref", r.head).status, 0);
  const none = spawnSync("bash", [MATCH], { cwd: r.d, encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /usage/i);
});
