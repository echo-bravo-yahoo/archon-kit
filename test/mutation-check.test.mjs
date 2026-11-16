import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { kitHome } from "./kit-home.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MUTATION_CHECK = path.join(here, "..", "scripts", "mutation-check.sh");
const HOME = os.homedir();
// The script reads run-gates.sh, state.sh and lane.sh from $ARCHON_HOME, so the tests point it at
// the kit's own files and not at whatever copy the person running them has installed.
const KIT = kitHome();

const made = [];
const mkdtemp = (prefix) => {
  const d = fs.mkdtempSync(path.join(HOME, prefix));
  made.push(d);
  return fs.realpathSync(d);
};
after(() => {
  KIT.remove();
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const sh = (cwd, cmd, ...args) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = (root, rel, body) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

// test.sh prints `ok <word>` for each word src.txt holds and `FAIL <word>` for each it lacks, and
// exits 1 when any is missing. The `tests` gate set runs it.
const TEST_SH = `fail=0
for w in alpha beta; do
  if grep -q "$w" src.txt; then echo "ok $w"; else echo "FAIL $w"; fail=1; fi
done
exit $fail
`;

function mkRepo({ src = "alpha\nbeta\n" } = {}) {
  const root = mkdtemp("mutation-check-test-");
  sh(root, "git", "init", "-q", "-b", "main");
  sh(root, "git", "config", "user.email", "t@example.com");
  sh(root, "git", "config", "user.name", "t");
  write(root, ".archon/gates.json", JSON.stringify({ tests: { parallel: [], ordered: ["sh test.sh"] } }));
  write(root, ".archon/lanes.json", JSON.stringify({ tests: ["test.sh"] }));
  write(root, "src.txt", src);
  write(root, "test.sh", TEST_SH);
  write(root, ".gitignore", "scratch.txt\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "base");
  return root;
}

const ALPHA = { id: "alpha", test: "test.sh", file: "src.txt", from: "alpha", to: "omega", fail_pattern: "^FAIL alpha$" };
const BETA = { id: "beta", test: "test.sh", file: "src.txt", from: "beta", to: "gamma", fail_pattern: "^FAIL beta$" };

// The last value `mutation-status` was set to in the run's state file; null when it was never
// set or was cleared.
const statusIn = (art) => {
  const f = path.join(art, "state");
  if (!fs.existsSync(f)) return null;
  let value = null;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (line.startsWith("mutation-status=")) value = line.slice("mutation-status=".length);
  }
  return value || null;
};

function check(root, mutations, { raw, bug, state } = {}) {
  const art = mkdtemp("mutation-check-art-");
  const tmp = mkdtemp("mutation-check-tmp-");
  write(art, "mutations.json", raw ?? JSON.stringify(mutations));
  if (bug) write(art, "coverage-bug.md", bug);
  if (state) write(art, "state", state);
  const report = path.join(art, "mutation-report.md");
  const r = spawnSync("bash", [MUTATION_CHECK, path.join(art, "mutations.json"), report], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ARCHON_HOME: KIT.dir, ARTIFACTS_DIR: art, TMPDIR: tmp },
  });
  const read = (f) => (fs.existsSync(path.join(art, f)) ? fs.readFileSync(path.join(art, f), "utf8") : null);
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    report: read("mutation-report.md"),
    marker: statusIn(art),
    entries: fs.readdirSync(art).sort(),
    leftover: fs.readdirSync(tmp),
  };
}

const assertRestored = (root) => {
  assert.equal(sh(root, "git", "status", "--porcelain"), "");
  assert.equal(fs.readFileSync(path.join(root, "src.txt"), "utf8"), "alpha\nbeta\n");
};

test("every mutation caught prints caught and records it", () => {
  const root = mkRepo();
  const r = check(root, [ALPHA, BETA]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "caught\n");
  assert.equal(r.marker, "caught");
  assert.match(r.report, /2 of 2 caught/);
  assertRestored(root);
});

test("a run leaves only the report, the gates run writes and the state file, and removes its scratch directory", () => {
  const root = mkRepo();
  for (const mutations of [[ALPHA, BETA], [ALPHA, { ...BETA, to: "beta2" }]]) {
    const r = check(root, mutations);
    assert.deepEqual(r.entries, ["gate-report.md", "gates", "mutation-report.md", "mutations.json", "state"]);
    assert.deepEqual(r.leftover, []);
  }
});

test("a retry clears a caught status left in state by an earlier round", () => {
  const root = mkRepo();
  const r = check(root, [ALPHA, { ...BETA, to: "beta2" }], { state: "plan-loop=settled\nmutation-status=caught\n" });
  assert.equal(r.stdout, "retry\n");
  assert.equal(r.marker, null);
});

test("a surviving mutation prints retry and the report names it", () => {
  const root = mkRepo();
  // "beta2" still contains "beta", so test.sh does not fail.
  const r = check(root, [ALPHA, { ...BETA, to: "beta2" }]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "retry\n");
  assert.equal(r.marker, null);
  assert.match(r.report, /1 of 2 caught/);
  assert.match(r.report, /\| beta \| test\.sh \| src\.txt \| survived/);
  assert.match(r.report, /\| alpha \| test\.sh \| src\.txt \| caught/);
  assertRestored(root);
});

test("tests that fail on the unmodified code print retry", () => {
  const root = mkRepo({ src: "alpha\n" });
  const r = check(root, [ALPHA]);
  assert.equal(r.stdout, "retry\n");
  assert.match(r.report, /tests fail on the unmodified code, so this is not coverage work/);
  assert.equal(sh(root, "git", "status", "--porcelain"), "");
  assert.equal(fs.readFileSync(path.join(root, "src.txt"), "utf8"), "alpha\n");
});

test("a fail_pattern that matches the clean output is invalid", () => {
  const root = mkRepo();
  // `alpha` appears in the passing line `ok alpha`.
  const r = check(root, [{ ...ALPHA, fail_pattern: "alpha" }, BETA]);
  assert.equal(r.stdout, "retry\n");
  assert.match(r.report, /1 of 2 caught/);
  assert.match(r.report, /\| alpha \|.*invalid: fail_pattern matches the output of the passing run/);
  assertRestored(root);
});

test("a fail_pattern that is not a regular expression is invalid", () => {
  const root = mkRepo();
  const r = check(root, [{ ...ALPHA, fail_pattern: "FAIL (alpha" }, BETA]);
  assert.equal(r.stdout, "retry\n");
  assert.match(r.report, /not a valid extended regular expression/);
  assertRestored(root);
});

test("a from that occurs twice is invalid", () => {
  const root = mkRepo();
  const r = check(root, [{ ...ALPHA, from: "a" }, BETA]);
  assert.equal(r.stdout, "retry\n");
  assert.match(r.report, /invalid: from occurs \d+ times in the file, not once/);
  assert.match(r.report, /1 of 2 caught/);
  assertRestored(root);
});

test("a from and to that are equal are invalid", () => {
  const root = mkRepo();
  const r = check(root, [{ ...ALPHA, to: "alpha" }, BETA]);
  assert.equal(r.stdout, "retry\n");
  assert.match(r.report, /from and to are the same/);
  assertRestored(root);
});

test("a mutation of an untracked file is invalid", () => {
  const root = mkRepo();
  write(root, "scratch.txt", "alpha\n"); // ignored, so the tree still counts as clean
  const r = check(root, [{ ...ALPHA, file: "scratch.txt" }, BETA]);
  assert.equal(r.stdout, "retry\n");
  assert.match(r.report, /file is not a tracked file/);
  assertRestored(root);
});

test("a mutation that edits the tests lane prints retry", () => {
  const root = mkRepo();
  const r = check(root, [{ id: "lane", test: "test.sh", file: "test.sh", from: "exit $fail", to: "exit 0", fail_pattern: "^FAIL alpha$" }]);
  assert.equal(r.stdout, "retry\n");
  assert.match(r.report, /edits the tests lane/);
  assertRestored(root);
  assert.equal(fs.readFileSync(path.join(root, "test.sh"), "utf8"), TEST_SH);
});

test("malformed JSON prints retry", () => {
  const root = mkRepo();
  const r = check(root, null, { raw: "[{" });
  assert.equal(r.stdout, "retry\n");
  assert.match(r.report, /not valid JSON/);
  assertRestored(root);
});

test("an entry with a missing field prints retry", () => {
  const root = mkRepo();
  const { fail_pattern, ...partial } = ALPHA;
  const r = check(root, [partial]);
  assert.equal(r.stdout, "retry\n");
  assert.match(r.report, /does not match the schema/);
  assertRestored(root);
});

test("duplicate ids print retry", () => {
  const root = mkRepo();
  const r = check(root, [ALPHA, { ...BETA, id: "alpha" }]);
  assert.equal(r.stdout, "retry\n");
  assert.match(r.report, /does not match the schema/);
  assertRestored(root);
});

test("coverage-bug.md makes the script exit 1 and shows the bug", () => {
  const root = mkRepo();
  const r = check(root, [ALPHA, BETA], { bug: "src.txt drops beta\n" });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /src\.txt drops beta/);
  assertRestored(root);
});

test("a dirty tree makes the script exit 1 and leaves the change alone", () => {
  const root = mkRepo();
  write(root, "src.txt", "alpha\nbeta\nextra\n");
  const r = check(root, [ALPHA, BETA]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.equal(fs.readFileSync(path.join(root, "src.txt"), "utf8"), "alpha\nbeta\nextra\n");
});

test("--schema prints the format and exits 0", () => {
  const r = spawnSync("bash", [MUTATION_CHECK, "--schema"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /JSON array of at most 12 objects/);
  for (const field of ["id", "test", "file", "from", "to", "fail_pattern"]) assert.match(r.stdout, new RegExp(`^  ${field} `, "m"));
});
