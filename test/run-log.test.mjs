import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUN_LOG = path.join(here, "..", "scripts", "run-log.sh");

const made = [];
const mkArt = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "run-log-test-"));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const env = (art) => {
  const e = { ...process.env };
  if (art === undefined) delete e.ARTIFACTS_DIR;
  else e.ARTIFACTS_DIR = art;
  return e;
};
const run = (art, args, input) => spawnSync("bash", [RUN_LOG, ...args], { encoding: "utf8", env: env(art), input });
const header = /^== \d\d:\d\d:\d\d (\S+) \(exit (\d+)\)$/;

test("two calls append two entries in order, each under its header", () => {
  const art = mkArt();
  run(art, ["first", "echo", "one"]);
  run(art, ["second", "echo", "two"]);
  const lines = fs.readFileSync(path.join(art, "run.log"), "utf8").split("\n");
  assert.match(lines[0], header);
  assert.equal(lines[0].match(header)[1], "first");
  assert.equal(lines[1], "one");
  assert.equal(lines[2], "");
  assert.match(lines[3], header);
  assert.equal(lines[3].match(header)[1], "second");
  assert.equal(lines[4], "two");
});

test("the command form returns the command's exit status and logs it", () => {
  const art = mkArt();
  const r = run(art, ["land", "bash", "-c", "echo nope >&2; exit 7"]);
  assert.equal(r.status, 7);
  assert.equal(r.stdout, "");
  const log = fs.readFileSync(path.join(art, "run.log"), "utf8");
  assert.match(log.split("\n")[0], /^== \d\d:\d\d:\d\d land \(exit 7\)$/);
  assert.match(log, /^nope$/m);
});

test("the command's standard error is logged with its standard output", () => {
  const art = mkArt();
  run(art, ["both", "bash", "-c", "echo out; echo err >&2"]);
  const log = fs.readFileSync(path.join(art, "run.log"), "utf8");
  assert.match(log, /^out$/m);
  assert.match(log, /^err$/m);
});

test("the stdin form appends standard input and exits 0", () => {
  const art = mkArt();
  const r = run(art, ["report-page", "-"], "boom\nsecond line\n");
  assert.equal(r.status, 0);
  const log = fs.readFileSync(path.join(art, "run.log"), "utf8");
  assert.match(log, /^== \d\d:\d\d:\d\d report-page \(exit 0\)\nboom\nsecond line\n\n$/);
});

test("the command does not read the caller's standard input", () => {
  const art = mkArt();
  const r = run(art, ["reader", "bash", "-c", "cat; echo done"], "from the caller\n");
  assert.equal(r.status, 0);
  const log = fs.readFileSync(path.join(art, "run.log"), "utf8");
  assert.doesNotMatch(log, /from the caller/);
  assert.match(log, /^done$/m);
});

test("eight parallel calls with 200-line outputs leave eight whole entries", async () => {
  const art = mkArt();
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => {
      return new Promise((resolve, reject) => {
        const p = spawn("bash", [RUN_LOG, `job${i}`, "bash", "-c", `for n in $(seq 1 200); do echo "job${i} line $n"; done`], {
          env: env(art),
        });
        p.on("error", reject);
        p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      });
    }),
  );
  const lines = fs.readFileSync(path.join(art, "run.log"), "utf8").split("\n");
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(header);
    if (!m) continue;
    const body = lines.slice(i + 1, i + 201);
    assert.deepEqual(body, Array.from({ length: 200 }, (_, n) => `${m[1]} line ${n + 1}`));
    assert.equal(lines[i + 201], "");
    entries.push(m[1]);
    i += 201;
  }
  assert.deepEqual(entries.sort(), Array.from({ length: 8 }, (_, i) => `job${i}`).sort());
});

test("a missing ARTIFACTS_DIR fails with a message", () => {
  const r = run(undefined, ["x", "echo", "hi"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ARTIFACTS_DIR is not set/);
});

test("a call with no label prints the usage", () => {
  const art = mkArt();
  const r = run(art, []);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage/);
});
