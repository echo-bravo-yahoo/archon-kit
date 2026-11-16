const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// The repositories whose workflows the page draws are the ones under the `workspace` setting of
// kit.json, which defaults to ~/workspace. Each test builds a scratch HOME and Archon home, so it
// reads nothing of the host's.
const BUILD = path.join(__dirname, "..", "build.py");
const HAS_JQ = spawnSync("sh", ["-c", "command -v jq"]).status === 0;
const NEEDS_JQ = { skip: !HAS_JQ && "kit-settings.sh needs jq to read kit.json" };

const made = [];
const scratch = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "playground-workspace-")));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

// <root>/<repo>/.archon/workflows/<name>/<name>.yaml
const repoWorkflow = (root, repo, name) => {
  const dir = path.join(root, repo, ".archon", "workflows", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), `name: ${name}\nnodes:\n  - id: a\n    bash: echo\n`);
};

// A scratch HOME that holds ~/workspace/repoA with the workflow `foo`, and an Archon home that is
// empty apart from the kit.json given.
function world(kit) {
  const root = scratch();
  const home = path.join(root, "home");
  const archonHome = path.join(root, "archon");
  fs.mkdirSync(archonHome, { recursive: true });
  repoWorkflow(path.join(home, "workspace"), "repoA", "foo");
  if (kit !== undefined) fs.writeFileSync(path.join(archonHome, "kit.json"), typeof kit === "string" ? kit : JSON.stringify(kit));
  return { root, home, archonHome };
}

function dump(w) {
  const out = path.join(w.root, "dump.json");
  const r = spawnSync("python3", [BUILD, "--dump", out, "--no-link"], {
    encoding: "utf8",
    env: { ...process.env, HOME: w.home, ARCHON_HOME: w.archonHome },
  });
  const workflows = r.status === 0 ? JSON.parse(fs.readFileSync(out, "utf8")).workflows.map((x) => [x.name, x.repo, x.path]) : null;
  return { r, workflows };
}

test("with no kit.json the repositories are read from ~/workspace, and a workflow shows the repository it is in", () => {
  const w = world();
  const { r, workflows } = dump(w);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(workflows, [["foo", "repoA", "~/workspace/repoA/.archon/workflows/foo/foo.yaml"]]);
});

test("the workspace setting of kit.json moves the repositories, and ~/workspace is no longer read", NEEDS_JQ, () => {
  const w = world();
  const code = path.join(w.root, "code");
  repoWorkflow(code, "repoB", "bar");
  fs.writeFileSync(path.join(w.archonHome, "kit.json"), JSON.stringify({ workspace: code }));
  const { r, workflows } = dump(w);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(workflows, [["bar", "repoB", path.join(code, "repoB/.archon/workflows/bar/bar.yaml")]]);
});

test("a kit.json that is not a JSON object stops the build and says why", NEEDS_JQ, () => {
  const w = world("[1]");
  const { r } = dump(w);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /cannot read .*kit\.json as a JSON object/);
});

test("a workspace that is not a directory is noted, and the page still builds", NEEDS_JQ, () => {
  const w = world({ workspace: "/nonexistent-workspace" });
  const { r, workflows } = dump(w);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /note: the workspace \/nonexistent-workspace is not a directory/);
  assert.deepStrictEqual(workflows, []);
});
