// Loads the real workflows and statistics through `build.py --dump`.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

let cached = null;
function loadDump() {
  if (cached) return cached;
  const dir = path.join(__dirname, "..", ".cache");
  fs.mkdirSync(dir, { recursive: true });
  // One file for each process: node --test runs the test files in parallel, and they must not read each other's half-written dump.
  const file = path.join(dir, "dump-" + process.pid + ".json");
  const r = spawnSync("python3", [path.join(__dirname, "..", "build.py"), "--dump", file], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("build.py --dump failed: " + r.stderr);
  cached = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.rmSync(file, { force: true });
  return cached;
}

function wf(nodes, extra) {
  return Object.assign({ name: "t", description: "d", nodes }, extra || {});
}

module.exports = { loadDump, wf };
