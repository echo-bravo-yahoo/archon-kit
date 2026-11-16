import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "plan-excuses.sh");

const made = [];
// An artifacts directory, with spec-approved.json holding `approved` when it is given (a string is written as it is).
const mkArt = (approved) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "plan-excuses-test-"));
  made.push(d);
  if (approved !== undefined) fs.writeFileSync(path.join(d, "spec-approved.json"), typeof approved === "string" ? approved : JSON.stringify(approved));
  return d;
};
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const run = (art, ...args) => {
  const env = { ...process.env };
  if (art === undefined) delete env.ARTIFACTS_DIR;
  else env.ARTIFACTS_DIR = art;
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env });
};

const NONE = { summary: "s", excuses: [] };
const ONE = { summary: "s", excuses: [{ node: "red_check", reason: "the tests pin behaviour already there" }] };
const BOTH = {
  summary: "s",
  excuses: [
    { node: "implement", reason: "docs only" },
    { node: "mutation_cycle", reason: "no source change" },
  ],
};

test("with no spec-approved.json there are no excuses", () => {
  const art = mkArt();
  assert.notEqual(run(art, "has", "red_check").status, 0);
  assert.deepEqual([run(art, "lines").status, run(art, "lines").stdout], [0, ""]);
  assert.notEqual(run(art, "more-tests").status, 0);
});

test("an unreadable spec-approved.json means no excuses", () => {
  const art = mkArt("not json {");
  assert.notEqual(run(art, "has", "red_check").status, 0);
  assert.deepEqual([run(art, "lines").status, run(art, "lines").stdout], [0, ""]);
  assert.notEqual(run(art, "more-tests").status, 0);
});

test("a plan without the excuses key means no excuses", () => {
  const art = mkArt({ summary: "s" });
  assert.notEqual(run(art, "has", "red_check").status, 0);
  assert.equal(run(art, "lines").stdout, "");
  assert.notEqual(run(art, "more-tests").status, 0);
});

test("an empty excuses list means none", () => {
  const art = mkArt(NONE);
  assert.notEqual(run(art, "has", "red_check").status, 0);
  assert.equal(run(art, "lines").stdout, "");
  assert.notEqual(run(art, "more-tests").status, 0);
});

test("has succeeds for the node an excuse names and fails for any other node", () => {
  const art = mkArt(ONE);
  assert.equal(run(art, "has", "red_check").status, 0);
  assert.notEqual(run(art, "has", "implement").status, 0);
  assert.notEqual(run(art, "has", "red").status, 0);
  assert.notEqual(run(art, "has", "mutation_cycle").status, 0);
});

test("has prints nothing, so a caller's stdout stays the node's own", () => {
  const art = mkArt(ONE);
  const r = run(art, "has", "red_check");
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});

test("lines prints one Excused line per excuse, in the plan's order", () => {
  const art = mkArt(BOTH);
  assert.equal(run(art, "lines").stdout, "Excused implement: docs only\nExcused mutation_cycle: no source change\n");
  assert.equal(run(mkArt(ONE), "lines").stdout, "Excused red_check: the tests pin behaviour already there\n");
});

test("more-tests succeeds when the plan excuses implement or mutation_cycle, and not for red_check alone", () => {
  assert.notEqual(run(mkArt(ONE), "more-tests").status, 0);
  assert.equal(run(mkArt({ excuses: [{ node: "implement", reason: "r" }] }), "more-tests").status, 0);
  assert.equal(run(mkArt({ excuses: [{ node: "mutation_cycle", reason: "r" }] }), "more-tests").status, 0);
  assert.equal(run(mkArt(BOTH), "more-tests").status, 0);
});

test("a node name with a quote or a jq operator is matched as text", () => {
  const art = mkArt({ excuses: [{ node: "implement", reason: "r" }] });
  assert.notEqual(run(art, "has", 'implement" or true').status, 0);
  assert.notEqual(run(art, "has", ".").status, 0);
});

test("a missing command or node is a usage error, and so is an unknown command", () => {
  const art = mkArt(ONE);
  assert.notEqual(run(art).status, 0);
  assert.match(run(art).stderr, /usage: plan-excuses\.sh/);
  assert.notEqual(run(art, "has").status, 0);
  const bad = run(art, "bogus");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /usage: plan-excuses\.sh/);
});

test("a run without ARTIFACTS_DIR fails and says so", () => {
  const r = run(undefined, "has", "red_check");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ARTIFACTS_DIR is not set/);
});
