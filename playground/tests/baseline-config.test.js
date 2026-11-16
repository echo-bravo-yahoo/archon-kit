const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BUILD = path.join(__dirname, "..", "build.py");

// A baseline directory with one workflow and, when `config` is given, a baseline.json.
function baselineDir(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-baseline-config-"));
  fs.mkdirSync(path.join(dir, "personal", "ghost"), { recursive: true });
  fs.writeFileSync(path.join(dir, "personal", "ghost", "ghost.yaml"), "name: ghost\nnodes:\n  - id: a\n    bash: echo\n");
  if (config) fs.writeFileSync(path.join(dir, "baseline.json"), JSON.stringify(config));
  return dir;
}

const run = (args) => spawnSync("python3", [BUILD, ...args], { encoding: "utf8" });

test("a baseline.json label is the page's baseline label, and --label overrides it", () => {
  const dir = baselineDir({ label: "before the cleanup" });
  try {
    const out = path.join(dir, "dump.json");
    assert.strictEqual(run(["--dump", out, "--baseline", dir]).status, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(out, "utf8")).baselineLabel, "before the cleanup");
    assert.strictEqual(run(["--dump", out, "--baseline", dir, "--label", "explicit"]).status, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(out, "utf8")).baselineLabel, "explicit");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a baseline.json out is where the baseline page is written, and the page names refresh.sh as its refresh command", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "playground-baseline-out-"));
  const page = path.join(target, "nested", "index.html");
  const dir = baselineDir({ label: "L", out: page });
  try {
    const r = run(["--baseline", dir, "--no-link"]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^wrote /);
    const html = fs.readFileSync(page, "utf8");
    assert.match(html, /"baselineLabel":"L"/);
    assert.match(html, /"buildCommand":"bash [^"]*\/playground\/refresh\.sh"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test("a baseline page with neither --out nor an out in baseline.json is refused, because it would overwrite the main page", () => {
  const dir = baselineDir({ label: "L" });
  try {
    const r = run(["--baseline", dir, "--no-link"]);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /a baseline page needs --out or an "out" in baseline\.json, because it would overwrite the main page/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
