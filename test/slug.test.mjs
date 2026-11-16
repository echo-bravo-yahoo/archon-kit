import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SLUG = path.join(here, "..", "scripts", "slug.sh");
const RUN = "abcdef123456";
const SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

// Runs `slug.sh make` and checks that what it printed is one slug line.
const make = (args, { run = RUN } = {}) => {
  const r = spawnSync("bash", [SLUG, "make", ...(run === null ? [] : ["--run", run]), ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^[^\n]+\n$/);
  const slug = r.stdout.trim();
  assert.match(slug, SHAPE);
  return slug;
};

test("a model-chosen name is cleaned and gets the run's first six characters", () => {
  assert.equal(make(["--model", "Retry Test Overlap!"]), "retry-test-overlap-abcdef");
});

test("apostrophes inside a word are deleted, not turned into a hyphen", () => {
  assert.equal(make(["--model", "don't retry ’quickly’"]), "dont-retry-quickly-abcdef");
});

test("a repeated prefix is stripped once, and a name that is only the prefix falls back to the text", () => {
  assert.equal(make(["--prefix", "research", "--model", "research-retry-overlap"]), "research-retry-overlap-abcdef");
  assert.equal(make(["--prefix", "research", "--model", "retry-overlap"]), "research-retry-overlap-abcdef");
  assert.equal(make(["--prefix", "research", "--model", "research", "--text", "which node writes the plan"]), "research-which-node-writes-plan-abcdef");
});

test("the text's own leading prefix word is stripped too", () => {
  assert.equal(make(["--prefix", "research", "--text", "research if archon supports retries"]), "research-archon-supports-retries-abcdef");
});

test("a long name is cut at a hyphen so the name part is at most 40 characters", () => {
  const long = "retry-test-overlap-in-the-flaky-integration-suite-after-merge";
  assert.ok(long.length > 40);
  const slug = make(["--model", long]);
  assert.equal(slug, "retry-test-overlap-in-the-flaky-abcdef");
  assert.ok(slug.length - "-abcdef".length <= 40);
});

test("a name whose fortieth character ends a word is kept up to that word", () => {
  const forty = "a".repeat(7) + "-" + "b".repeat(7) + "-" + "c".repeat(7) + "-" + "d".repeat(7) + "-" + "e".repeat(7);
  assert.equal(forty.length, 39);
  assert.equal(make(["--model", `${forty}-ffff`]), `${forty}-abcdef`);
});

test("one word longer than 40 characters is cut at 40", () => {
  assert.equal(make(["--model", "x".repeat(55)]), `${"x".repeat(40)}-abcdef`);
});

test("with no model name the text's words name the slug, without filler", () => {
  assert.equal(make(["--model", "", "--text", "the actual widget device"]), "actual-widget-device-abcdef");
  assert.equal(make(["--text", "Is it possible to keep the site awake while a timer runs"]), "possible-keep-site-awake-while-abcdef");
  assert.equal(make(["--text", "let's improve today"]), "improve-today-abcdef");
  assert.equal(make(["--text", "uh so maybe actually"]), "maybe-abcdef");
  assert.equal(make(["--text", "Fix the landing loop now please"]), "fix-landing-loop-abcdef");
});

test("only the first line of the text is used", () => {
  assert.equal(make(["--text", "Fix the landing loop\nand then rewrite the planner"]), "fix-landing-loop-abcdef");
});

test("the prefix goes in front of a name taken from the text", () => {
  assert.equal(make(["--prefix", "anti-entropy-docs", "--text", "Merge the overlapping retry tests"]), "anti-entropy-docs-merge-overlapping-retry-tests-abcdef");
});

test("with no model name and no usable text the fallback word names the slug, and report is the default", () => {
  assert.equal(make(["--fallback", "build"]), "build-abcdef");
  assert.equal(make([]), "report-abcdef");
  assert.equal(make(["--text", "is it", "--fallback", "build"]), "build-abcdef");
  assert.equal(make(["--model", "!!!", "--text", "***"]), "report-abcdef");
});

test("--keep writes the slug on the first call and returns it, ignoring new input, on the second", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slug-test-"));
  made.push(dir);
  const keep = path.join(dir, "slug.txt");
  assert.equal(make(["--model", "first-name", "--keep", keep]), "first-name-abcdef");
  assert.equal(fs.readFileSync(keep, "utf8"), "first-name-abcdef\n");
  assert.equal(make(["--model", "second-name", "--text", "other words", "--keep", keep], { run: "999999abc" }), "first-name-abcdef");
});

test("an empty --keep file does not count as a kept slug", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slug-test-"));
  made.push(dir);
  const keep = path.join(dir, "slug.txt");
  fs.writeFileSync(keep, "");
  assert.equal(make(["--model", "fresh-name", "--keep", keep]), "fresh-name-abcdef");
  assert.equal(fs.readFileSync(keep, "utf8"), "fresh-name-abcdef\n");
});

test("a run id with capitals or punctuation still gives a slug of letters and digits", () => {
  assert.equal(make(["--model", "x"], { run: "AB-cd_ef123" }), "x-abcdef");
});

test("make without --run, and an unknown subcommand or flag, fail with a usage line", () => {
  for (const args of [["make", "--model", "x"], ["nope"], [], ["make", "--run", RUN, "--bogus", "x"]]) {
    const r = spawnSync("bash", [SLUG, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /usage: slug\.sh make/);
    assert.equal(r.stdout, "");
  }
});
