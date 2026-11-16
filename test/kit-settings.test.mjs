import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const KIT_SETTINGS = path.join(here, "..", "scripts", "kit-settings.sh");

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
const home = (kit) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kit-settings-")));
  made.push(d);
  if (kit !== undefined) fs.writeFileSync(path.join(d, "kit.json"), typeof kit === "string" ? kit : JSON.stringify(kit));
  return d;
};
const get = (archonHome, ...args) =>
  spawnSync("bash", [KIT_SETTINGS, ...args], { encoding: "utf8", env: { ...process.env, ARCHON_HOME: archonHome, HOME: "/home/kit-test" } });

test("a missing file prints the built-in default of each key", () => {
  const h = home();
  assert.equal(get(h, "workspace").stdout, "/home/kit-test/workspace\n");
  assert.equal(get(h, "run_env").stdout, "{}\n");
  assert.equal(get(h, "done").stdout, "{}\n");
  assert.equal(get(h, "scratch_dirs").stdout, "[]\n");
  assert.equal(get(h, "handoffs").stdout, "[]\n");
  assert.equal(get(h, "anything-else").stdout, "\n");
});

test("a given default replaces the built-in one", () => {
  assert.equal(get(home(), "workspace", "/elsewhere").stdout, "/elsewhere\n");
  assert.equal(get(home({}), "scratch_dirs", "none").stdout, "none\n");
});

test("a string prints bare and anything else prints as compact JSON", () => {
  const h = home({ workspace: "~/projects", run_env: { A: "1", B: "2" }, scratch_dirs: ["tmp", "scratch"], n: 3 });
  assert.equal(get(h, "workspace").stdout, "~/projects\n");
  assert.equal(get(h, "run_env").stdout, '{"A":"1","B":"2"}\n');
  assert.equal(get(h, "scratch_dirs").stdout, '["tmp","scratch"]\n');
  assert.equal(get(h, "n").stdout, "3\n");
});

test("a key the file lacks prints the default", () => {
  const h = home({ workspace: "/w" });
  assert.equal(get(h, "scratch_dirs").stdout, "[]\n");
});

test("a file that is not valid JSON, or not an object, is an error", () => {
  for (const body of ["{nope", "[1]", '"s"']) {
    const r = get(home(body), "workspace");
    assert.equal(r.status, 1, body);
    assert.match(r.stderr, /cannot read .*kit\.json as a JSON object/);
    assert.equal(r.stdout, "");
  }
});

test("ARCHON_HOME unset reads ~/.archon/kit.json under HOME", () => {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kit-settings-home-")));
  made.push(h);
  fs.mkdirSync(path.join(h, ".archon"));
  fs.writeFileSync(path.join(h, ".archon", "kit.json"), JSON.stringify({ workspace: "/from-home" }));
  const env = { ...process.env, HOME: h };
  delete env.ARCHON_HOME;
  assert.equal(spawnSync("bash", [KIT_SETTINGS, "workspace"], { encoding: "utf8", env }).stdout, "/from-home\n");
});

test("with no key it prints usage and fails", () => {
  const r = get(home(), "");
  assert.notEqual(r.status, 0);
});
