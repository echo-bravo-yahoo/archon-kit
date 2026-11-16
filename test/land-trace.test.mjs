import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nodeScript, subst } from "./node-script.mjs";

// Runs the bash of build's sync_land against a stub worktree-land, to check what run.log and the node's
// output hold when the landing loop's script succeeds or fails.
const here = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(here, "..", "workflows", "build", "build.yaml");
const SCRIPTS = path.join(here, "..", "scripts");

const made = [];
const mkdtemp = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return fs.realpathSync(d);
};
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const sh = (cwd, cmd, ...args) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const stateGet = (art, key) =>
  execFileSync("bash", [path.join(SCRIPTS, "state.sh"), "get", key], { env: { ...process.env, ARTIFACTS_DIR: art }, encoding: "utf8" }).trim();
const stateSet = (art, key, value) =>
  execFileSync("bash", [path.join(SCRIPTS, "state.sh"), "set", key, value], { env: { ...process.env, ARTIFACTS_DIR: art }, encoding: "utf8" });

// An ARCHON_HOME whose scripts are links to the kit's, except worktree-land, which is `stub`.
function landing(stub) {
  const home = mkdtemp("land-home-");
  const scripts = path.join(home, "scripts");
  fs.mkdirSync(scripts);
  for (const f of fs.readdirSync(SCRIPTS)) {
    if (f !== "worktree-land") fs.symlinkSync(path.join(SCRIPTS, f), path.join(scripts, f));
  }
  fs.writeFileSync(path.join(scripts, "worktree-land"), `#!/bin/bash\n${stub}\n`, { mode: 0o755 });
  const root = mkdtemp("land-repo-");
  sh(root, "git", "init", "-q", "-b", "main");
  sh(root, "git", "config", "user.email", "t@example.com");
  sh(root, "git", "config", "user.name", "t");
  fs.writeFileSync(path.join(root, "README.md"), "x\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "base");
  const art = mkdtemp("land-art-");
  stateSet(art, "sync-base", sh(root, "git", "rev-parse", "HEAD").trim());
  return { home, root, art };
}

function syncLand(l) {
  const dir = mkdtemp("land-node-");
  const script = path.join(dir, "sync_land.sh");
  fs.writeFileSync(script, subst(nodeScript(BUILD, "sync_land"), { "$sync_gates.output": "green", "$sync_base.output": "main" }));
  return spawnSync("bash", [script], { cwd: l.root, encoding: "utf8", env: { ...process.env, ARCHON_HOME: l.home, ARTIFACTS_DIR: l.art } });
}
const runLog = (l) => (fs.existsSync(path.join(l.art, "run.log")) ? fs.readFileSync(path.join(l.art, "run.log"), "utf8") : "");

// The lines of the last entry of run.log after its header, without the blank line that ends it.
function lastEntry(l) {
  const lines = runLog(l).split("\n");
  const at = lines.map((x, i) => (/^== \S+ land /.test(x) ? i : -1)).filter((i) => i >= 0).pop();
  assert.ok(at !== undefined, "no land entry in run.log");
  const body = lines.slice(at + 1);
  const end = body.indexOf("");
  return end < 0 ? body : body.slice(0, end);
}
const LABEL = /trace of worktree-land/;
const TRACE = /^worktree-land:\d+: /;
const labelAt = (e) => e.findIndex((x) => LABEL.exec(x));

const fail141 = `set -euo pipefail
echo first
echo second >&2
touch x
yes | head -1 > /dev/null`;

test("a landing that succeeds leaves its output in run.log and no trace", () => {
  const l = landing(`echo "warning: something" >&2\necho ok`);
  const r = syncLand(l);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "landed\n");
  const log = runLog(l);
  assert.match(log, /warning: something/);
  assert.match(log, /^ok$/m);
  assert.doesNotMatch(log, LABEL);
  assert.doesNotMatch(log, /^worktree-land:\d+: /m);
  assert.equal(stateGet(l.art, "land-failures"), "0");
});

test("a landing that prints a multi-line value leaks no trace line into run.log", () => {
  const l = landing(`V=$'a\\nb'\necho "$V"`);
  const r = syncLand(l);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastEntry(l), ["a", "b"]);
  assert.doesNotMatch(runLog(l), /worktree-land:/);
});

test("a landing that fails with 141 logs its output, a label line, then the trace ending at the failing command", () => {
  const l = landing(fail141);
  const r = syncLand(l);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "failed\n");
  assert.equal(stateGet(l.art, "land-failures"), "1");
  const e = lastEntry(l);
  const label = labelAt(e);
  assert.ok(label > 0, e.join("\n"));
  assert.ok(e.indexOf("first") >= 0 && e.indexOf("first") < label);
  assert.ok(e.indexOf("second") >= 0 && e.indexOf("second") < label);
  const trace = e.slice(label + 1);
  assert.ok(trace.length > 0);
  for (const line of trace) assert.match(line, TRACE);
  assert.match(trace[trace.length - 1], /head -1/);
  assert.ok(trace.some((x) => /echo first/.test(x)));
});

test("the trace holds the last 80 commands", () => {
  const l = landing(`${":\n".repeat(300)}exit 141`);
  syncLand(l);
  const e = lastEntry(l);
  const label = labelAt(e);
  assert.ok(label >= 0, e.join("\n"));
  const trace = e.slice(label + 1);
  assert.equal(trace.length, 80);
  assert.match(trace[79], /exit 141/);
});

test("a command that spans lines is one trace line", () => {
  const l = landing(`cat <<EOF > /dev/null
one
two
EOF
case x in
  x)
    echo hi > /dev/null
    ;;
esac
exit 141`);
  syncLand(l);
  const e = lastEntry(l);
  const label = labelAt(e);
  assert.ok(label >= 0, e.join("\n"));
  const trace = e.slice(label + 1);
  assert.ok(trace.length > 0);
  for (const line of trace) assert.match(line, TRACE);
});

test("two failing rounds fail the run, and the failing round's stderr shows the script's output", () => {
  const l = landing(`echo stub-output\nexit 141`);
  const first = syncLand(l);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, "failed\n");
  assert.match(first.stderr, /stub-output/);
  assert.match(first.stderr, LABEL);
  const second = syncLand(l);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /worktree-land failed 2 rounds in a row; see run\.log\. The worktree is kept\./);
  assert.equal(stateGet(l.art, "land-failures"), "2");
});

test("the trace files are removed after a success and after a failure", () => {
  for (const [stub, expectTrace] of [["echo ok", false], ["exit 141", true]]) {
    const l = landing(stub);
    syncLand(l);
    if (expectTrace) assert.match(runLog(l), LABEL);
    assert.ok(!fs.existsSync(path.join(l.art, "land-trace.txt")));
    assert.ok(!fs.existsSync(path.join(l.art, "land-trace-env.sh")));
  }
});

test("the trace names only commands of worktree-land", () => {
  const l = landing(fail141);
  syncLand(l);
  const e = lastEntry(l);
  const label = labelAt(e);
  assert.ok(label >= 0, e.join("\n"));
  for (const line of e.slice(label + 1)) assert.doesNotMatch(line, /flock|run-log\.sh/);
});

test("worktree-land gets no arguments and a success prints only landed on stdout", () => {
  const l = landing(`[ "$#" -eq 0 ] || { echo "args: $*" >&2; exit 2; }\necho ok`);
  const r = syncLand(l);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "landed\n");
});
