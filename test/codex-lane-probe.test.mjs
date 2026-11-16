import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The probe needs Codex and Archon for a real run. These tests cover what runs without them: the
// usage text and the preflight that refuses to start.
const PROBE = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-lane-probe.sh");
const BASH = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();

const made = [];
const scratch = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lane-probe-test-")));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

// PATH is an empty directory, so no tool the probe looks for is found.
const probe = (args) => {
  const home = scratch();
  const bin = scratch();
  const r = spawnSync(BASH, [PROBE, ...args], { encoding: "utf8", env: { PATH: bin, HOME: home } });
  return { ...r, home };
};

test("--help prints the usage and exits 0", () => {
  const r = spawnSync(BASH, [PROBE, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^usage: codex-lane-probe\.sh \[--provider codex\|claude\] \[--keep\]/);
  assert.match(r.stdout, /--keep/);
  assert.doesNotMatch(r.stdout, /shellcheck/);
});

test("an unknown option or provider exits 2 with the usage line", () => {
  for (const args of [["--bogus"], ["--provider", "gemini"], ["--provider"]]) {
    const r = spawnSync(BASH, [PROBE, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /^usage: codex-lane-probe\.sh/);
  }
});

test("without codex on PATH the probe exits 2 and names archon provider add codex", () => {
  const r = probe([]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /missing: codex is not on PATH\. Install Codex, then run: archon provider add codex/);
  assert.equal(r.stdout, "");
  assert.deepEqual(fs.readdirSync(r.home), [], "the preflight writes nothing under HOME");
});

test("the preflight names every missing tool at once", () => {
  const r = probe([]);
  for (const tool of ["archon", "jq", "node"]) assert.match(r.stderr, new RegExp(`missing: ${tool} is not on PATH`));
  assert.match(r.stderr, /lane\.sh does not exist\. Run the kit's install\.sh/);
});

test("with --provider claude the probe asks for claude and not codex", () => {
  const r = probe(["--provider", "claude"]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /missing: claude is not on PATH/);
  assert.doesNotMatch(r.stderr, /codex/);
});
