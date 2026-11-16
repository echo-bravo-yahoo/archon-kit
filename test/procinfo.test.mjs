import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(here, "..", "scripts");

const made = [];
const children = [];
const mkdtemp = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return fs.realpathSync(d);
};
after(() => {
  for (const c of children) c.kill();
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const HAS_PROC = fs.existsSync("/proc");
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

// Runs one expression of procinfo.py and returns what it printed as JSON. KIT_PROC_BACKENDS and
// KIT_PROC_ROOT choose the sources, and `path` replaces the PATH so a stub ps or lsof can stand in.
function call(expr, { backends, root, bin } = {}) {
  const env = { ...process.env };
  delete env.KIT_PROC_BACKENDS;
  delete env.KIT_PROC_ROOT;
  if (backends !== undefined) env.KIT_PROC_BACKENDS = backends;
  if (root !== undefined) env.KIT_PROC_ROOT = root;
  if (bin) env.PATH = `${bin}${path.delimiter}${env.PATH}`;
  const code = `import json, sys\nsys.dont_write_bytecode = True\nsys.path.insert(0, ${JSON.stringify(SCRIPTS)})\nimport procinfo\nprint(json.dumps(${expr}))`;
  const r = spawnSync("python3", ["-c", code], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const stub = (dir, name, body) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
};

// A process whose command line names archon, and one that does not. The compound command keeps
// bash from exec'ing sleep, which would drop the name from the command line.
const named = () => {
  const c = spawn("bash", ["-c", "sleep 300; sleep 0", "archon-owner"], { stdio: "ignore" });
  children.push(c);
  return c.pid;
};
const unnamed = () => {
  const c = spawn("bash", ["-c", "sleep 300; sleep 0"], { stdio: "ignore" });
  children.push(c);
  return c.pid;
};
const gonePid = () => spawnSync("true").pid;

test("owner_state: a pid that no process has is dead, whichever sources are on", () => {
  const pid = gonePid();
  for (const backends of [undefined, "ps", "none"]) assert.equal(call(`procinfo.owner_state(${pid})`, { backends }), "dead", String(backends));
});

test("owner_state: a live process that names archon is alive, and one that does not is dead", () => {
  const a = named();
  const b = unnamed();
  for (const backends of [undefined, "proc", "ps"]) {
    if (backends !== "ps" && !HAS_PROC) continue;
    assert.equal(call(`procinfo.owner_state(${a})`, { backends }), "alive", String(backends));
    assert.equal(call(`procinfo.owner_state(${b})`, { backends }), "dead", String(backends));
  }
});

test("owner_state: a live process is unknown, not dead, when no source can show its command line", () => {
  const b = unnamed();
  assert.equal(call(`procinfo.owner_state(${b})`, { backends: "none" }), "unknown");
  assert.equal(call(`procinfo.owner_state(${b})`, { backends: "proc", root: path.join(mkdtemp("procinfo-"), "no-proc") }), "unknown");
});

test("owner_state: a ps that fails leaves the answer unknown, and a ps that prints a command line decides", () => {
  const b = unnamed();
  const bin = mkdtemp("procinfo-bin-");
  stub(bin, "ps", "exit 1");
  assert.equal(call(`procinfo.owner_state(${b})`, { backends: "ps", bin }), "unknown");
  stub(bin, "ps", 'echo "/usr/local/bin/archon serve"');
  assert.equal(call(`procinfo.owner_state(${b})`, { backends: "ps", bin }), "alive");
  stub(bin, "ps", 'echo "/usr/bin/vim notes.txt"');
  assert.equal(call(`procinfo.owner_state(${b})`, { backends: "ps", bin }), "dead");
});

test("owner_state: a value that is not a process id is unknown", () => {
  for (const v of ["0", "-1", "None", "'12'", "True"]) assert.equal(call(`procinfo.owner_state(${v})`), "unknown", v);
});

test("owner_state: the command line comes from KIT_PROC_ROOT, with NULs read as spaces", () => {
  const root = mkdtemp("procinfo-root-");
  const pid = unnamed();
  fs.mkdirSync(path.join(root, String(pid)));
  fs.writeFileSync(path.join(root, String(pid), "cmdline"), "node\0/opt/archon/cli.js\0serve\0");
  assert.equal(call(`procinfo.owner_state(${pid})`, { backends: "proc", root }), "alive");
  fs.writeFileSync(path.join(root, String(pid), "cmdline"), "vim\0notes.txt\0");
  assert.equal(call(`procinfo.owner_state(${pid})`, { backends: "proc", root }), "dead");
});

test("start_ticks: field 22 of stat, counted from the last parenthesis", () => {
  const root = mkdtemp("procinfo-root-");
  fs.mkdirSync(path.join(root, "42"));
  const rest = ["S", ...Array(18).fill("0"), "987654", "0"].join(" ");
  fs.writeFileSync(path.join(root, "42", "stat"), `42 (a (b) c) ${rest}\n`);
  assert.equal(call("procinfo.start_ticks(42)", { backends: "proc", root }), "987654");
  assert.equal(call("procinfo.start_ticks(43)", { backends: "proc", root }), null);
  assert.equal(call("procinfo.have_proc()", { backends: "proc", root }), true);
});

test("start_ticks and have_proc: nothing without a readable /proc, or with the proc source off", () => {
  const missing = path.join(mkdtemp("procinfo-"), "no-proc");
  assert.equal(call("procinfo.have_proc()", { backends: "proc", root: missing }), false);
  assert.equal(call("procinfo.start_ticks(1)", { backends: "proc", root: missing }), null);
  assert.equal(call("procinfo.have_proc()", { backends: "none" }), false);
  assert.equal(call("procinfo.start_ticks(1)", { backends: "ps,lsof" }), null);
});

test("start_ticks: a live process has the start time that /proc/<pid>/stat holds", { skip: !HAS_PROC && "needs /proc" }, () => {
  const pid = unnamed();
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  assert.equal(call(`procinfo.start_ticks(${pid})`), stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
});

test("cwds: lists the links of KIT_PROC_ROOT, leaving out deleted directories and names that are not pids", () => {
  const root = mkdtemp("procinfo-root-");
  const link = (name, target) => {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.symlinkSync(target, path.join(root, name, "cwd"));
  };
  link("100", "/work/a");
  link("200", "/work/b (deleted)");
  link("300", "/work/c");
  link("self", "/work/self");
  link("12ab", "/work/odd");
  fs.mkdirSync(path.join(root, "400"));
  const got = call("sorted(procinfo.cwds())", { backends: "proc", root });
  assert.deepEqual(got, [
    [100, "/work/a"],
    [300, "/work/c"],
  ]);
});

test("cwds: None where no source can list the processes", () => {
  assert.equal(call("procinfo.cwds()", { backends: "none" }), null);
  assert.equal(call("procinfo.cwds()", { backends: "ps" }), null);
  assert.equal(call("procinfo.cwds()", { backends: "proc", root: path.join(mkdtemp("procinfo-"), "no-proc") }), null);
});

test("cwds: reads lsof's field output when /proc is off, and None when lsof prints nothing or fails", () => {
  const bin = mkdtemp("procinfo-bin-");
  stub(bin, "lsof", 'printf "p10\\nn/work/x\\np11\\nn/work/y z\\np12\\nn/work/gone (deleted)\\n"');
  assert.deepEqual(call("procinfo.cwds()", { backends: "lsof", bin }), [
    [10, "/work/x"],
    [11, "/work/y z"],
  ]);
  stub(bin, "lsof", "exit 1");
  assert.equal(call("procinfo.cwds()", { backends: "lsof", bin }), null);
  stub(bin, "lsof", "exit 0");
  assert.equal(call("procinfo.cwds()", { backends: "lsof", bin }), null);
});

test("cwds: the real lsof finds a process that works in a directory", { skip: !has("lsof") && "needs lsof" }, () => {
  const dir = mkdtemp("procinfo-cwd-");
  const c = spawn("bash", ["-c", "sleep 300; sleep 0"], { cwd: dir, stdio: "ignore" });
  children.push(c);
  const found = call("procinfo.cwds()", { backends: "lsof" });
  assert.ok(
    found.some(([pid, cwd]) => pid === c.pid && cwd === dir),
    JSON.stringify(found.slice(0, 5)),
  );
});

test("the real ps shows the command line of a live process", { skip: !has("ps") && "needs ps" }, () => {
  assert.equal(call(`procinfo.owner_state(${named()})`, { backends: "ps" }), "alive");
});
