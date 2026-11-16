import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(here, "..", "scripts", "state.sh");

const made = [];
const mkArt = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "state-test-"));
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
const run = (art, ...args) => spawnSync("bash", [STATE, ...args], { encoding: "utf8", env: env(art) });

test("get of an unset key prints nothing and exits 0", () => {
  const art = mkArt();
  const r = run(art, "get", "plan-loop");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("set then get round-trips the value", () => {
  const art = mkArt();
  assert.equal(run(art, "set", "plan-loop", "settled").status, 0);
  assert.equal(run(art, "get", "plan-loop").stdout, "settled\n");
  assert.equal(fs.readFileSync(path.join(art, "state"), "utf8"), "plan-loop=settled\n");
});

test("a later set wins", () => {
  const art = mkArt();
  run(art, "set", "build-loop", "open");
  run(art, "set", "build-loop", "settled");
  assert.equal(run(art, "get", "build-loop").stdout, "settled\n");
});

test("setting an empty value makes get print nothing", () => {
  const art = mkArt();
  run(art, "set", "gates-status", "green");
  assert.equal(run(art, "set", "gates-status", "").status, 0);
  const r = run(art, "get", "gates-status");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("a value may contain an equals sign and spaces", () => {
  const art = mkArt();
  run(art, "set", "sync-base", "a=b c");
  assert.equal(run(art, "get", "sync-base").stdout, "a=b c\n");
});

test("get returns only the value of its own key when another key starts with it", () => {
  const art = mkArt();
  run(art, "set", "build", "short");
  run(art, "set", "build-loop", "long");
  assert.equal(run(art, "get", "build").stdout, "short\n");
  assert.equal(run(art, "get", "build-loop").stdout, "long\n");
  assert.equal(run(art, "get", "buil").stdout, "");
});

test("a multi-line value is refused and nothing is written", () => {
  const art = mkArt();
  const r = run(art, "set", "k", "one\ntwo");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /one line/);
  assert.equal(fs.existsSync(path.join(art, "state")), false);
});

test("a bad key is refused", () => {
  const art = mkArt();
  for (const key of ["Bad", "a_b", "a=b", "a b"]) {
    const r = run(art, "set", key, "x");
    assert.equal(r.status, 2, key);
    assert.match(r.stderr, /bad key/);
  }
});

test("a missing key or command prints the usage", () => {
  const art = mkArt();
  assert.equal(run(art).status, 2);
  assert.equal(run(art, "get").status, 2);
  const r = run(art, "frob", "k");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

test("a missing ARTIFACTS_DIR fails with a message", () => {
  for (const args of [["set", "k", "v"], ["get", "k"]]) {
    const r = run(undefined, ...args);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ARTIFACTS_DIR is not set/);
  }
});

test("eight parallel sets leave eight whole lines", async () => {
  const art = mkArt();
  const value = (i) => `${i}-${"x".repeat(900)}`;
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => {
      return new Promise((resolve, reject) => {
        const p = spawn("bash", [STATE, "set", `k${i}`, value(i)], { env: env(art) });
        p.on("error", reject);
        p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      });
    }),
  );
  const lines = fs.readFileSync(path.join(art, "state"), "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 8);
  assert.deepEqual(lines.sort(), Array.from({ length: 8 }, (_, i) => `k${i}=${value(i)}`).sort());
});
