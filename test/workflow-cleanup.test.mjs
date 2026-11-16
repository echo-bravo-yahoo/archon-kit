import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { runNodeBash } from "./node-script.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(here, "..", "scripts");
const SCRIPT = path.join(SCRIPTS, "workflow-cleanup.py");
const CLEANUP = path.join(here, "..", "workflows", "workflow-cleanup", "workflow-cleanup.yaml");

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

const sh = (cwd, cmd, ...args) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
// The program reads start times from /proc and lists the processes in a directory from /proc or lsof.
const HAS_PROC = fs.existsSync("/proc");
const HAS_LSOF = spawnSync("sh", ["-c", "command -v lsof"]).status === 0;
const NEEDS_PROC = { skip: !HAS_PROC && "needs /proc" };
const NEEDS_CWDS = { skip: !HAS_PROC && !HAS_LSOF && "needs /proc or lsof" };
const write = (root, rel, body = "x\n") => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};
const commitIn = (dir, file, body = "work\n", msg = "work") => {
  write(dir, file, body);
  sh(dir, "git", "add", "-A");
  sh(dir, "git", "commit", "-q", "-m", msg);
};
const ts = (minutesAgo) => new Date(Date.now() - minutesAgo * 60e3).toISOString().slice(0, 19).replace("T", " ");
const isoAgo = (days) => new Date(Date.now() - days * 86400e3).toISOString();

// A stand-in for archon, gh and archon-dead-runs.sh. It appends its argv to $STUB_LOG, and runs the
// SQL named by an environment variable so a test can say what a resume or a wait leaves behind.
const STUB = `#!/usr/bin/env python3
import json, os, sqlite3, sys
tool = os.path.basename(sys.argv[0])
a = sys.argv[1:]
log = os.environ.get("STUB_LOG")
n = 0
if log:
    if os.path.exists(log):
        n = sum(1 for l in open(log) if '"workflow", "run"' in l)
    with open(log, "a") as f:
        f.write(json.dumps({"tool": tool, "argv": a, "cwd": os.getcwd(), "env": os.environ.get("KIT_TEST_VAR", "")}) + "\\n")
def sql(var):
    s = os.environ.get(var)
    if s:
        c = sqlite3.connect(os.path.join(os.environ["ARCHON_HOME"], "archon.db"), timeout=30)
        c.executescript(s)
        c.commit()
        c.close()
if tool == "gh":
    print(os.environ.get("STUB_GH_PRS", "[]"))
elif tool == "archon":
    if a[:2] == ["workflow", "run"]:
        sql("STUB_RUN_SQL")
        print("Run id: stubrun%04d" % (n + 1))
    elif a[:2] == ["workflow", "resume"]:
        sql("STUB_RESUME_SQL")
    elif a[:2] == ["workflow", "wait"]:
        sql("STUB_WAIT_SQL")
else:
    sql("STUB_DEAD_SQL")
`;

const SCHEMA = `
create table remote_agent_workflow_runs (id text primary key, workflow_name text, status text, codebase_id text,
  working_path text, user_message text, metadata text, adopted_from_run_id text, started_at text,
  completed_at text, last_activity_at text, output_root text);
create table remote_agent_workflow_events (id text, workflow_run_id text, event_order integer, event_type text,
  step_index integer, step_name text, data text, created_at text);
create table remote_agent_workflow_event_archive (id text, workflow_run_id text, event_order integer, event_type text,
  step_index integer, step_name text, data text, created_at text);
create table remote_agent_codebases (id text primary key, name text, default_cwd text);
`;

// A HOME of its own holding the helper scripts the program calls, stubs for the tools it must not
// really run, a database with the columns it reads, and a repository `proj` with a bare remote.
function mkEnv({ gate = "true" } = {}) {
  const root = mkdtemp("wc-test-");
  const home = path.join(root, "home");
  const repo = path.join(root, "proj");
  const remote = path.join(root, "proj-remote.git");
  const bin = path.join(root, "bin");
  for (const d of [home, repo, bin]) fs.mkdirSync(d, { recursive: true });
  // Every kit script, copied into the scratch ARCHON_HOME, except the two that are stubbed or run
  // from the kit directly.
  for (const entry of fs.readdirSync(SCRIPTS, { withFileTypes: true })) {
    const name = entry.name;
    if (["archon-dead-runs.sh", "workflow-cleanup.py", "__pycache__"].includes(name)) continue;
    // Subdirectories such as scripts/report/ are copied whole.
    if (entry.isDirectory()) {
      fs.cpSync(path.join(SCRIPTS, name), path.join(home, ".archon/scripts", name), { recursive: true });
      continue;
    }
    const dst = path.join(home, ".archon/scripts", name);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(SCRIPTS, name), dst);
  }
  for (const name of ["archon", "gh"]) fs.writeFileSync(path.join(bin, name), STUB, { mode: 0o755 });
  write(home, ".archon/scripts/archon-dead-runs.sh", STUB);
  fs.chmodSync(path.join(home, ".archon/scripts/archon-dead-runs.sh"), 0o755);

  sh(repo, "git", "init", "-q", "-b", "main");
  sh(repo, "git", "config", "user.email", "t@example.com");
  sh(repo, "git", "config", "user.name", "t");
  write(repo, "README.md", "proj\n");
  write(repo, ".archon/gates.json", JSON.stringify({ feature: { parallel: [], ordered: [gate] }, tests: { parallel: [], ordered: [gate] } }));
  // The repository's own workflow-done.json, the layer for workflows that the kit does not ship.
  write(
    repo,
    ".archon/workflow-done.json",
    JSON.stringify({
      "deploy-config": { git: "none", attention_nodes: ["install", "verify"], effects: { install: "the live config on staging" } },
      "deploy-device": { git: "none", attention_nodes: ["push", "verify", "manifest"], effects: { push: "the release on the device" } },
    }),
  );
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-q", "-m", "base");
  sh(root, "git", "init", "-q", "--bare", remote);
  sh(repo, "git", "remote", "add", "origin", remote);
  sh(repo, "git", "push", "-q", "origin", "main");

  const dbPath = path.join(home, ".archon/archon.db");
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  db.prepare("insert into remote_agent_codebases (id, name, default_cwd) values (?, ?, ?)").run("cb1", "scratch/proj", repo);

  const e = {
    root,
    home,
    repo,
    remote,
    db,
    wtRoot: path.join(home, ".archon/workspaces/x/proj/worktrees"),
    log: path.join(root, "stub.log"),
    ledgerPath: path.join(home, ".archon/state/workflow-cleanup/ledger.jsonl"),
    env: {
      ...process.env,
      HOME: home,
      ARCHON_HOME: path.join(home, ".archon"),
      PATH: `${bin}:${process.env.PATH}`,
      STUB_LOG: path.join(root, "stub.log"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  };
  return e;
}

// Writes kit.json in the scratch ARCHON_HOME (merging into what is there).
const setKit = (e, value) => {
  const file = path.join(e.home, ".archon/kit.json");
  const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  write(path.dirname(file), "kit.json", JSON.stringify({ ...old, ...value }));
};

const run = (e, args, extra = {}) =>
  spawnSync("python3", ["-I", SCRIPT, ...args], { cwd: e.root, encoding: "utf8", env: { ...e.env, ...extra }, timeout: 120000 });
const runAsync = (e, args) =>
  new Promise((resolve) => {
    const c = spawn("python3", ["-I", SCRIPT, ...args], { cwd: e.root, env: e.env });
    let err = "";
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => resolve({ code, err }));
  });

const stubLog = (e) =>
  fs.existsSync(e.log)
    ? fs
        .readFileSync(e.log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const calls = (e, tool, ...prefix) => stubLog(e).filter((c) => c.tool === tool && prefix.every((p, i) => c.argv[i] === p));
const ledger = (e) =>
  fs.existsSync(e.ledgerPath)
    ? fs
        .readFileSync(e.ledgerPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const seedLedger = (e, entries) => {
  fs.mkdirSync(path.dirname(e.ledgerPath), { recursive: true });
  fs.appendFileSync(e.ledgerPath, entries.map((x) => JSON.stringify({ ts: new Date().toISOString(), detail: "", signature: "", child: null, ...x })).join("\n") + "\n");
};

// ---- owners -------------------------------------------------------------------------------

const aliveOwner = () => {
  // A compound command keeps bash from exec'ing sleep, which would drop "archon-owner" from the command line.
  const c = spawn("bash", ["-c", "sleep 300; sleep 0", "archon-owner"], { stdio: "ignore" });
  children.push(c);
  return { host: os.hostname(), pid: c.pid, uid: 1000 };
};
const deadOwner = () => {
  const c = spawnSync("true");
  return { host: os.hostname(), pid: c.pid ?? 4000000, uid: 1000 };
};

// ---- runs and events ----------------------------------------------------------------------

const done = (...steps) => steps.map((s) => ({ type: "node_completed", step: s, data: { node: { id: s.split(".").pop() } } }));
const failedEv = (node, o = {}) => ({
  type: "workflow_failed",
  data: { error: o.error ?? "DAG workflow failed: something broke", exit_reason: o.exit ?? "node_error", terminal_record: { first_failed_node: node } },
  at: o.at,
});
const cancelledEv = (reason) => ({ type: "workflow_cancelled", data: { cancel_reason: reason } });
const answeredEv = (step, decision) => ({ type: "wait_answered", step, data: { answer: { decision, text: "" } } });

function addRun(e, o) {
  const id = o.id ?? crypto.randomUUID();
  const live = o.status === "running" || o.status === "paused";
  const ended = ts(o.endedAgo ?? 600);
  const meta = {
    ...(o.owner ? { execution_owner: o.owner } : {}),
    ...(o.inputs ? { inputs: o.inputs } : {}),
    ...(o.source ? { workflow_source: { root: o.source } } : {}),
  };
  e.db
    .prepare(
      "insert into remote_agent_workflow_runs (id, workflow_name, status, codebase_id, working_path, user_message, metadata, adopted_from_run_id, started_at, completed_at, last_activity_at) values (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(id, o.workflow, o.status, "cb1", o.path ?? null, o.message ?? "", JSON.stringify(meta), o.adopted ?? null, o.startedAt ?? ts((o.endedAgo ?? 600) + 5), live ? null : (o.completedAt ?? ended), o.lastAt ?? o.completedAt ?? ended);
  let order = 0;
  for (const ev of o.events ?? []) {
    e.db
      .prepare("insert into remote_agent_workflow_events (id, workflow_run_id, event_order, event_type, step_index, step_name, data, created_at) values (?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), id, order++, ev.type, 0, ev.step ?? null, JSON.stringify(ev.data ?? {}), ev.at ?? ended);
  }
  return id;
}

// The work a run left on disk, in each of the states the program tells apart.
function mkWork(e, state, name) {
  const p = path.join(e.wtRoot, name);
  if (state === "none") return p;
  fs.mkdirSync(e.wtRoot, { recursive: true });
  if (state === "detached" || state === "detached-dirty") {
    sh(e.repo, "git", "worktree", "add", "-q", "--detach", p, "main");
    if (state === "detached-dirty") write(p, "scratch.txt", "wip\n");
    return p;
  }
  sh(e.repo, "git", "worktree", "add", "-q", "-b", name, p, "main");
  if (state === "clean") return p;
  if (state === "unsaved") {
    write(p, "scratch.txt", "wip\n");
    return p;
  }
  commitIn(p, `${name}.txt`);
  if (state === "branch") return p;
  if (state === "landed") {
    const sha = sh(p, "git", "rev-parse", "HEAD").trim();
    sh(e.repo, "git", "commit", "--allow-empty", "-q", "-m", "other");
    sh(e.repo, "git", "cherry-pick", sha);
    return p;
  }
  if (state === "pushed" || state === "pr") {
    sh(p, "git", "push", "-q", "origin", name);
    return p;
  }
  throw new Error(`unknown work state ${state}`);
}

function scenario(e, spec) {
  const id = spec.id ?? crypto.randomUUID();
  const name = spec.name ?? `wt-${id.slice(0, 8)}`;
  const p = mkWork(e, spec.work ?? "none", name);
  addRun(e, { ...spec, id, path: p });
  return { id, path: p, name };
}

function inspect(e, id, { dry = "no", ...extra } = {}) {
  const state = path.join(e.root, `state-${id.slice(0, 8)}.txt`);
  const out = path.join(e.root, `verdict-${id.slice(0, 8)}.json`);
  const r = run(e, ["inspect", "--run", id, "--dry", dry, "--state", state, "--out", out], extra);
  return {
    r,
    route: r.stdout.trim(),
    state: fs.existsSync(state) ? fs.readFileSync(state, "utf8").trim() : null,
    verdict: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null,
  };
}
function rescue(e, id, { spend = "no", dry = "no", retry = false, ...extra } = {}) {
  const state = path.join(e.root, `rstate-${id.slice(0, 8)}.txt`);
  const out = path.join(e.root, `rverdict-${id.slice(0, 8)}.json`);
  const r = run(e, ["rescue", "--run", id, "--spend", spend, "--dry", dry, "--state", state, "--out", out, ...(retry ? ["--retry"] : [])], extra);
  return {
    r,
    state: fs.existsSync(state) ? fs.readFileSync(state, "utf8").trim() : null,
    verdict: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null,
  };
}
const candidates = (e, extra = {}) => {
  const out = path.join(e.root, "candidates.json");
  const r = run(e, ["candidates", "--out", out], extra);
  return { r, list: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null, out };
};
const exists = (p) => fs.existsSync(p);
const branches = (e) => sh(e.repo, "git", "branch", "--format=%(refname:short)").trim().split("\n");

// ---- candidates ---------------------------------------------------------------------------

test("candidates: lists a completed run with a worktree and a dead run", () => {
  const e = mkEnv();
  const a = scenario(e, { workflow: "research", status: "completed", work: "landed", events: done("decision") });
  const b = scenario(e, { workflow: "build", status: "running", owner: deadOwner(), work: "branch", endedAgo: 3 });
  const { r, list } = candidates(e);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(list.map((c) => c.run).sort(), [a.id, b.id].sort());
  assert.equal(list.find((c) => c.run === b.id).kind, "dead");
  assert.match(r.stdout, new RegExp(a.id.slice(0, 8)));
});

test("candidates: leaves out live, paused, self and finished runs", () => {
  const e = mkEnv();
  scenario(e, { workflow: "build", status: "running", owner: aliveOwner(), work: "branch" });
  scenario(e, { workflow: "build", status: "paused", work: "branch" });
  scenario(e, { workflow: "workflow-cleanup", status: "completed", work: "clean" });
  const finished = scenario(e, { workflow: "research", status: "completed", work: "clean" });
  seedLedger(e, [{ run: finished.id, action: "closed" }]);
  const failed = scenario(e, { workflow: "build", status: "failed", work: "none", events: [failedEv("plan_decision")] });
  seedLedger(e, [{ run: failed.id, action: "answered" }]);
  const { r, list } = candidates(e);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(list, []);
});

test("candidates: a run with a leftover worktree is listed the moment it ends", () => {
  const e = mkEnv();
  const done = scenario(e, { workflow: "research", status: "completed", work: "clean", endedAgo: 0 });
  const failed = scenario(e, { workflow: "build", status: "failed", work: "branch", endedAgo: 0, events: [failedEv("plan_decision")] });
  const cancelled = scenario(e, { workflow: "build", status: "cancelled", work: "branch", endedAgo: 1, events: [cancelledEv("operator")] });
  const { list } = candidates(e);
  assert.deepEqual(list.map((c) => c.run).sort(), [done.id, failed.id, cancelled.id].sort());
});

test("candidates: a failed run with no worktree is listed whatever its age", () => {
  const e = mkEnv();
  const ids = [0, 5 * 1440, 15 * 1440, 400 * 1440].map(
    (endedAgo) => scenario(e, { workflow: "build", status: "failed", work: "none", endedAgo, events: [failedEv("plan_decision")] }).id,
  );
  const { list } = candidates(e);
  assert.deepEqual(list.map((c) => c.run).sort(), ids.sort());
});

test("candidates: a failed run with no worktree is listed again while its only ledger entries are queued, and fan-out stops after two", () => {
  const e = mkEnv();
  const fresh = () => scenario(e, { workflow: "build", status: "failed", work: "none", events: [failedEv("plan_decision")] }).id;
  const once = fresh();
  const twice = fresh();
  const tried = fresh();
  seedLedger(e, [
    { run: once, action: "queued", child: "c1" },
    { run: twice, action: "queued", child: "c1" },
    { run: twice, action: "queued", child: "c2" },
    { run: tried, action: "queued", child: "c1" },
    { run: tried, action: "rung", detail: "retry" },
  ]);
  const { list, out } = candidates(e);
  assert.deepEqual(list.map((c) => `${c.run}:${c.queued}`).sort(), [`${once}:1`, `${twice}:2`].sort());
  const r = run(e, ["fan-out", "--candidates", out, "--dry", "no"]);
  assert.equal(r.status, 0, r.stderr);
  const starts = calls(e, "archon", "workflow", "run");
  assert.equal(starts.length, 1);
  assert.ok(starts[0].argv.includes(`run=${once}`));
  assert.match(r.stdout, /skipped .*queued twice/);
});

test("candidates: a run in the main checkout is not a leftover worktree", () => {
  const e = mkEnv();
  addRun(e, { workflow: "research", status: "completed", path: e.repo, events: done("decision") });
  assert.deepEqual(candidates(e).list, []);
});

test("candidates: a run another cleanup run is already working on is left out", () => {
  const e = mkEnv();
  const a = scenario(e, { workflow: "research", status: "completed", work: "landed", events: done("decision") });
  addRun(e, { workflow: "workflow-cleanup", status: "paused", inputs: { run: a.id } });
  assert.deepEqual(candidates(e).list, []);
});

test("candidates: a repository that is gone is listed as skipped", () => {
  const e = mkEnv();
  e.db.prepare("update remote_agent_codebases set default_cwd = ? where id = 'cb1'").run(path.join(e.root, "gone"));
  scenario(e, { workflow: "build", status: "failed", work: "none", events: [failedEv("plan_decision")] });
  const { list } = candidates(e);
  assert.equal(list.length, 1);
  assert.match(list[0].skip, /not on disk|registered/);
});

test("fan-out: starts one cleanup run per candidate, and grants spending to at most three", () => {
  const e = mkEnv();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(scenario(e, { workflow: "build", status: "running", owner: deadOwner(), work: "branch", endedAgo: 100 + i }).id);
  const { list, out } = candidates(e);
  assert.equal(list.length, 5);
  const r = run(e, ["fan-out", "--candidates", out, "--dry", "no"]);
  assert.equal(r.status, 0, r.stderr);
  const starts = calls(e, "archon", "workflow", "run");
  assert.equal(starts.length, 5);
  for (const s of starts) {
    assert.equal(s.argv[2], "workflow-cleanup");
    assert.equal(s.cwd, e.repo);
    assert.ok(s.argv.includes("dry=no"));
  }
  const spend = starts.map((s) => s.argv.find((a) => a.startsWith("spend=")));
  assert.equal(spend.filter((x) => x === "spend=yes").length, 3);
  const queued = ledger(e).filter((x) => x.action === "queued");
  assert.equal(queued.length, 5);
  assert.deepEqual(queued.map((x) => x.run).sort(), ids.sort());
  assert.ok(queued.every((x) => /^stubrun/.test(x.child)));
});

test("fan-out: a rerun starts nothing for a run already queued twice or already in the ledger", () => {
  const e = mkEnv();
  const a = scenario(e, { workflow: "build", status: "running", owner: deadOwner(), work: "branch" });
  const b = scenario(e, { workflow: "build", status: "running", owner: deadOwner(), work: "branch" });
  seedLedger(e, [
    { run: a.id, action: "queued", child: "c1" },
    { run: a.id, action: "queued", child: "c2" },
    { run: b.id, action: "closed" },
  ]);
  const { list, out } = candidates(e);
  assert.deepEqual(list.map((c) => c.run), [a.id]);
  const r = run(e, ["fan-out", "--candidates", out, "--dry", "no"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(calls(e, "archon", "workflow", "run").length, 0);
  assert.match(r.stdout, /skipped/);
});

test("fan-out: --dry yes names the route each run would get and starts nothing", () => {
  const e = mkEnv();
  const a = scenario(e, { workflow: "research", status: "completed", work: "landed", events: done("decision") });
  const { out } = candidates(e);
  const r = run(e, ["fan-out", "--candidates", out, "--dry", "yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(a.id.slice(0, 8)));
  assert.match(r.stdout, /close/);
  assert.equal(calls(e, "archon", "workflow", "run").length, 0);
  assert.deepEqual(ledger(e), []);
});

test("fan-out: a candidate whose repository is gone is skipped", () => {
  const e = mkEnv();
  e.db.prepare("update remote_agent_codebases set default_cwd = ? where id = 'cb1'").run(path.join(e.root, "gone"));
  addRun(e, { workflow: "build", status: "failed", endedAgo: 600, events: [failedEv("plan_decision")] });
  const { out } = candidates(e);
  const r = run(e, ["fan-out", "--candidates", out, "--dry", "no"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skipped/);
  assert.equal(calls(e, "archon", "workflow", "run").length, 0);
});

// ---- work state ---------------------------------------------------------------------------

for (const [work, expected] of [
  ["none", "none"],
  ["clean", "landed"],
  ["landed", "landed"],
  ["branch", "branch"],
  ["unsaved", "unsaved"],
  ["pushed", "pushed"],
  ["detached", "landed"],
  ["detached-dirty", "unsaved"],
]) {
  test(`work state: ${work} is ${expected}`, () => {
    const e = mkEnv();
    const s = scenario(e, { workflow: "probe", status: "completed", work });
    const { r, verdict } = inspect(e, s.id);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(verdict.work.state, expected);
    assert.equal(verdict.work.saved, expected !== "unsaved");
  });
}

test("work state: a cherry-picked branch counts as landed although its SHAs differ", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "probe", status: "completed", work: "landed" });
  assert.notEqual(sh(s.path, "git", "rev-parse", "HEAD").trim(), sh(e.repo, "git", "rev-parse", "HEAD").trim());
  assert.equal(inspect(e, s.id).verdict.work.state, "landed");
});

test("work state: commits on a detached HEAD are unsaved", () => {
  const e = mkEnv();
  const p = path.join(e.wtRoot, "det");
  fs.mkdirSync(e.wtRoot, { recursive: true });
  sh(e.repo, "git", "worktree", "add", "-q", "--detach", p, "main");
  commitIn(p, "det.txt");
  const id = addRun(e, { workflow: "probe", status: "completed", path: p });
  assert.equal(inspect(e, id).verdict.work.state, "unsaved");
});

test("work state: a pushed branch with an open pull request is pr", () => {
  const e = mkEnv();
  e.env.STUB_GH_PRS = JSON.stringify([{ state: "OPEN", number: 7 }]);
  const s = scenario(e, { workflow: "probe", status: "completed", work: "pr" });
  const { verdict } = inspect(e, s.id);
  assert.equal(verdict.work.state, "pr");
  assert.ok(calls(e, "gh", "pr", "list").length >= 1);
});

test("work state: a pushed branch whose pull request is closed unmerged stays pushed", () => {
  const e = mkEnv();
  e.env.STUB_GH_PRS = JSON.stringify([{ state: "CLOSED", number: 7 }]);
  const s = scenario(e, { workflow: "probe", status: "completed", work: "pushed" });
  assert.equal(inspect(e, s.id).verdict.work.state, "pushed");
});

test("work state: the main checkout is none, whatever it holds", () => {
  const e = mkEnv();
  write(e.repo, "dirty.txt");
  const id = addRun(e, { workflow: "probe", status: "completed", path: e.repo });
  const { verdict, route } = inspect(e, id);
  assert.equal(verdict.work.state, "none");
  assert.equal(route, "close");
});

// ---- route --------------------------------------------------------------------------------

const ROUTES = [
  ["a running run with a live owner", { workflow: "build", status: "running", owner: aliveOwner, work: "branch", endedAgo: 3 }, "skip"],
  ["a paused run", { workflow: "build", status: "paused", work: "branch" }, "skip"],
  ["a completed run with saved work that finished", { workflow: "research", status: "completed", work: "landed", events: done("decision") }, "close"],
  ["a completed run with no worktree", { workflow: "research", status: "completed", work: "none", events: done("decision") }, "close"],
  ["a completed run missing its finishing node", { workflow: "research", status: "completed", work: "landed", events: done("candidates") }, "attention"],
  ["a completed run with unsaved work", { workflow: "research", status: "completed", work: "unsaved", events: done("decision") }, "rescue"],
  ["a completed build whose commits are only on its branch", { workflow: "build", status: "completed", work: "branch", events: done("sync_cycle") }, "attention"],
  ["a completed build that landed", { workflow: "build", status: "completed", work: "landed", events: done("sync_cycle", "cleanup") }, "close"],
  ["a completed research run with commits on its branch", { workflow: "research", status: "completed", work: "branch", events: done("decision") }, "close"],
  ["a completed run of a workflow with no entry", { workflow: "probe-x", status: "completed", work: "landed" }, "close"],
  ["a completed run of a workflow with no entry and unsaved work", { workflow: "probe-x", status: "completed", work: "unsaved" }, "rescue"],
  ["a run the owner cancelled, work on a branch", { workflow: "build", status: "cancelled", work: "branch", events: [cancelledEv("operator")] }, "close"],
  ["a run halted by a node, work landed", { workflow: "build", status: "cancelled", work: "landed", events: [cancelledEv("halt_node")] }, "close"],
  ["a run the owner cancelled, work unsaved", { workflow: "build", status: "cancelled", work: "unsaved", events: [cancelledEv("operator")] }, "rescue"],
  ["a run the engine refused, counted as failed", { workflow: "build", status: "cancelled", work: "landed", events: [cancelledEv("precondition_failed")] }, "attention"],
  ["a build that failed in cleanup after it landed", { workflow: "build", status: "failed", work: "none", events: [...done("sync_cycle", "handoff"), failedEv("cleanup")] }, "close"],
  ["a build that failed in handoff with its work landed", { workflow: "build", status: "failed", work: "landed", events: [...done("sync_cycle"), failedEv("handoff")] }, "attention"],
  ["a build that failed in cleanup before it finished", { workflow: "build", status: "failed", work: "none", events: [failedEv("cleanup")] }, "attention"],
  ["a build that failed in plan_decision", { workflow: "build", status: "failed", work: "none", events: [failedEv("plan_decision")] }, "attention"],
  ["a failed run with unsaved work", { workflow: "build", status: "failed", work: "unsaved", events: [failedEv("plan_decision")] }, "rescue"],
  ["a research run that failed its credential preflight", { workflow: "research", status: "failed", work: "none", events: [failedEv("preflight", { error: "Credential preflight failed: no token" })] }, "attention"],
  ["a failed run of a workflow with no entry", { workflow: "probe-y", status: "failed", work: "landed", events: [failedEv("cleanup")] }, "attention"],
  ["a dead run", { workflow: "build", status: "running", owner: deadOwner, work: "branch" }, "rescue"],
  ["a dead run of a workflow with no entry", { workflow: "probe-z", status: "running", owner: deadOwner, work: "branch" }, "attention"],
  [
    "a launch that timed out creating its workspace",
    { workflow: "anti-entropy", status: "failed", work: "none", events: [failedEv(null, { exit: "launch_failed", error: "Timed out creating workspace after 60s" })] },
    "rescue",
  ],
  ["a launch that failed for another reason", { workflow: "anti-entropy", status: "failed", work: "none", events: [failedEv(null, { exit: "launch_failed", error: "no such repository" })] }, "attention"],
];
for (const [name, spec, expected] of ROUTES) {
  test(`route: ${name} goes to ${expected}`, () => {
    const e = mkEnv();
    const s = scenario(e, { ...spec, owner: typeof spec.owner === "function" ? spec.owner() : spec.owner });
    const { r, route, state, verdict } = inspect(e, s.id);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(route, expected, JSON.stringify(verdict));
    assert.equal(state, expected);
    assert.equal(verdict.route, expected);
    assert.equal(verdict.run, s.id);
  });
}

test("route: a recurring signature sends a housekeeping failure to attention", () => {
  const e = mkEnv();
  const bad = { workflow: "build", status: "failed", work: "none", events: [...done("sync_cycle"), failedEv("cleanup", { error: "git worktree remove failed at 1234" })] };
  scenario(e, { ...bad, endedAgo: 900 });
  const s = scenario(e, { ...bad, endedAgo: 600, events: [...done("sync_cycle"), failedEv("cleanup", { error: "git worktree remove failed at 98765" })] });
  const { route, verdict } = inspect(e, s.id);
  assert.equal(route, "attention");
  assert.equal(verdict.failure.recurring, true);
  assert.equal(verdict.failure.class, "housekeeping");
  assert.equal(verdict.failure.recurrence.length, 2);
});

test("route: an answered entry in the ledger resets a recurring signature", () => {
  const e = mkEnv();
  const bad = (n) => ({ workflow: "build", status: "failed", work: "none", events: [...done("sync_cycle"), failedEv("cleanup", { error: `git worktree remove failed at ${n}` })] });
  const first = scenario(e, { ...bad(11), endedAgo: 900 });
  const second = scenario(e, { ...bad(22), endedAgo: 600 });
  const sig = inspect(e, second.id).verdict.failure.signature;
  // Answered between the two failures, so only the later one is newer than the answer.
  seedLedger(e, [{ run: first.id, action: "answered", signature: sig, ts: isoAgo(0.5) }]);
  const { route, verdict } = inspect(e, second.id);
  assert.equal(verdict.failure.recurring, false);
  assert.equal(route, "close");
});

test("route: a failure from long ago does not count toward recurrence", () => {
  const e = mkEnv();
  const bad = (n) => ({ workflow: "build", status: "failed", work: "none", events: [...done("sync_cycle"), failedEv("cleanup", { error: `git worktree remove failed at ${n}` })] });
  scenario(e, { ...bad(11), endedAgo: 40 * 1440 });
  const s = scenario(e, { ...bad(22), endedAgo: 600 });
  assert.equal(inspect(e, s.id).route, "close");
});

test("route: a rescue that worked still goes to attention when the failure is systemic", () => {
  const e = mkEnv();
  const spec = (error) => ({ workflow: "build", status: "failed", work: "landed", events: [failedEv("sync_cycle.sync_land", { error })] });
  const ok = scenario(e, spec("landing failed"));
  seedLedger(e, [{ run: ok.id, action: "rung", detail: "land ok landed" }]);
  assert.equal(inspect(e, ok.id).route, "close");

  const sys = scenario(e, spec("Credential preflight failed: no token"));
  seedLedger(e, [{ run: sys.id, action: "rung", detail: "land ok landed" }]);
  const { route, verdict } = inspect(e, sys.id);
  assert.equal(verdict.failure.class, "systemic");
  assert.equal(route, "attention");
});

test("route: a recurring signature sends a rescued run to attention", () => {
  const e = mkEnv();
  const spec = (n) => ({ workflow: "build", status: "failed", work: "landed", events: [failedEv("sync_cycle.sync_land", { error: `landing failed in round ${n}` })] });
  scenario(e, { ...spec(1), endedAgo: 900 });
  const s = scenario(e, spec(2));
  seedLedger(e, [{ run: s.id, action: "rung", detail: "land ok landed" }]);
  const { route, verdict } = inspect(e, s.id);
  assert.equal(verdict.failure.recurring, true);
  assert.equal(route, "attention");
});

test("route: a failed run adopted by a completed run is closed", () => {
  const e = mkEnv();
  const old = scenario(e, { workflow: "build", status: "failed", work: "none", events: [failedEv("plan_decision")] });
  addRun(e, { workflow: "build", status: "completed", adopted: old.id, events: done("sync_cycle", "cleanup") });
  assert.equal(inspect(e, old.id).route, "close");
});

test("route: a rescue whose new run waits at a pause is waiting", () => {
  const e = mkEnv();
  const old = scenario(e, { workflow: "build", status: "failed", work: "none", events: [failedEv("plan_decision")] });
  const child = addRun(e, { workflow: "build", status: "paused", adopted: old.id });
  seedLedger(e, [{ run: old.id, action: "rung", detail: "adopt ok started", child }]);
  const { route, verdict } = inspect(e, old.id);
  assert.equal(route, "waiting");
  assert.equal(verdict.child, child);
});

test("registry: the repository's file replaces kit.json's done, which replaces the kit's file, entry by entry", () => {
  const e = mkEnv();
  const kitFile = path.join(e.root, "kit-done.json");
  const repoFile = path.join(e.repo, ".archon/workflow-done.json");
  const cls = (wf) => {
    const s = scenario(e, { workflow: wf, status: "failed", work: "none", events: [failedEv("step_a", { error: "x" })] });
    return inspect(e, s.id, { WC_REGISTRY: kitFile }).verdict.failure.class;
  };
  const layers = (kit, kitJson, repo) => {
    fs.writeFileSync(kitFile, JSON.stringify(kit));
    setKit(e, { done: kitJson });
    fs.writeFileSync(repoFile, JSON.stringify(repo));
  };
  layers({}, {}, {});
  assert.equal(cls("layered"), "other");
  layers({ layered: { attention_nodes: ["step_a"] } }, {}, {});
  assert.equal(cls("layered"), "systemic");
  layers({ layered: { attention_nodes: ["step_a"] } }, { layered: { housekeeping: ["step_a"] } }, {});
  assert.equal(cls("layered"), "housekeeping");
  layers({ layered: { attention_nodes: ["step_a"] } }, { layered: { housekeeping: ["step_a"] } }, { layered: { attention_nodes: ["step_a"] } });
  assert.equal(cls("layered"), "systemic");
  layers({ layered: { housekeeping: ["step_a"] }, only_kit: { attention_nodes: ["step_a"] } }, { only_json: { attention_nodes: ["step_a"] } }, { only_repo: { attention_nodes: ["step_a"] } });
  assert.deepEqual(["layered", "only_kit", "only_json", "only_repo", "unlisted"].map(cls), ["housekeeping", "systemic", "systemic", "systemic", "other"]);
});

test("registry: a layer that is not a JSON object is ignored", () => {
  const e = mkEnv();
  const kitFile = path.join(e.root, "kit-done.json");
  fs.writeFileSync(kitFile, JSON.stringify({ layered: { attention_nodes: ["step_a"] } }));
  fs.writeFileSync(path.join(e.repo, ".archon/workflow-done.json"), "[1, 2]");
  setKit(e, { done: "nope" });
  const s = scenario(e, { workflow: "layered", status: "failed", work: "none", events: [failedEv("step_a", { error: "x" })] });
  assert.equal(inspect(e, s.id, { WC_REGISTRY: kitFile }).verdict.failure.class, "systemic");
});

test("definition: the current definition is found under any folder of the global workflows directory", () => {
  for (const folder of ["kit", "team", "personal"]) {
    for (const [same, want] of [[false, true], [true, false]]) {
      const { e, s } = adoptEnv({ same });
      fs.rmSync(path.join(e.home, ".archon/workflows/kit"), { recursive: true });
      write(e.home, `.archon/workflows/${folder}/build/build.yaml`, same ? "name: build\n# old\n" : "name: build\n# fixed\n");
      assert.equal(factsFor(e, s.id).json.changes.definition_changed, want, `${folder}, same=${same}`);
    }
  }
  const { e, s } = adoptEnv({ same: false });
  fs.rmSync(path.join(e.home, ".archon/workflows/kit"), { recursive: true });
  assert.equal(factsFor(e, s.id).json.changes.definition_changed, false, "no current definition");
});

test("schema: a database that lacks a column the program uses is refused with one line that names the table", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "build", status: "failed", work: "none", events: [failedEv("plan_decision")] });
  e.db.exec("alter table remote_agent_workflow_runs drop column adopted_from_run_id");
  const r = inspect(e, s.id).r;
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^workflow-cleanup: the Archon database lacks remote_agent_workflow_runs\.adopted_from_run_id \(.*\); this program was tested against Archon 0\.13\.x\n$/);
});

test("schema: a database without the table that archives deleted events is refused", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "build", status: "failed", work: "none", events: [failedEv("plan_decision")] });
  e.db.exec("drop table remote_agent_workflow_event_archive");
  const r = inspect(e, s.id).r;
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^workflow-cleanup: the Archon database lacks remote_agent_workflow_event_archive\.workflow_run_id, event_order, event_type, step_name, data \(.*\)/);
});

test("the database opens from an Archon home whose path holds ?, # and %", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "build", status: "running", owner: deadOwner(), work: "none", endedAgo: 3 });
  const odd = path.join(mkdtemp("wc-odd-"), "a?b#c%25d e");
  fs.mkdirSync(odd);
  fs.copyFileSync(path.join(e.home, ".archon/archon.db"), path.join(odd, "archon.db"));
  const out = path.join(e.root, "odd-candidates.json");
  const r = run(e, ["candidates", "--out", out], { ARCHON_HOME: odd });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")).map((c) => c.run), [s.id]);
});

test("run_env: variables of kit.json reach the archon calls that wait for and resume a run", () => {
  const e = mkEnv();
  setKit(e, { run_env: { KIT_TEST_VAR: "on" } });
  const s = scenario(e, { workflow: "build", status: "running", owner: deadOwner(), work: "branch" });
  const { r } = rescue(e, s.id, { spend: "yes" });
  assert.equal(r.status, 0, r.stderr);
  const seen = calls(e, "archon", "workflow", "resume");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].env, "on");
});

test("failure classes: lane, guard and credential errors are systemic, others are other", () => {
  const e = mkEnv();
  const cls = (wf, node, error = "x") => {
    const s = scenario(e, { workflow: wf, status: "failed", work: "none", events: [failedEv(node, { error })] });
    return inspect(e, s.id).verdict.failure.class;
  };
  assert.equal(cls("build", "build_cycle.lane_impl"), "systemic");
  assert.equal(cls("build", "build_cycle.repo_guard"), "systemic");
  assert.equal(cls("build", "gates_declared"), "systemic");
  assert.equal(cls("deploy-device", "verify"), "systemic");
  assert.equal(cls("research", "preflight", "Cannot determine git repository"), "systemic");
  assert.equal(cls("build", "sync_cycle.sync_gates"), "other");
  assert.equal(cls("build", "cleanup"), "housekeeping");
  assert.notEqual(cls("build", "build_cycle.handoff"), "housekeeping");
});

test("inspect: a dry run writes dry for an attention route and touches no ledger", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "build", status: "failed", work: "none", events: [failedEv("plan_decision")] });
  const { route, state } = inspect(e, s.id, { dry: "yes" });
  assert.equal(route, "attention");
  assert.equal(state, "dry");
  assert.deepEqual(ledger(e), []);
});

test("inspect: the verdict names the facts the report needs", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "build", status: "failed", work: "unsaved", message: "do the thing", events: [failedEv("plan_decision", { error: "line1\nline2" })] });
  const { verdict } = inspect(e, s.id);
  assert.equal(verdict.workflow, "build");
  assert.equal(verdict.status, "failed");
  assert.equal(verdict.kind, "failed");
  assert.equal(verdict.repo, e.repo);
  assert.equal(verdict.working_path, s.path);
  assert.equal(verdict.failure.node, "plan_decision");
  assert.equal(verdict.failure.exit_reason, "node_error");
  assert.match(verdict.failure.signature, /^build\|plan_decision\|node_error\|/);
  assert.ok(Array.isArray(verdict.work.dirty_files));
});

test("signature: digits and hex runs are replaced and the head is cut to 70 characters", () => {
  const e = mkEnv();
  const long = `boom ${"abcdef012345 ".repeat(2)}${"word ".repeat(40)}`;
  const s = scenario(e, { workflow: "build", status: "failed", work: "none", events: [failedEv("plan_decision", { error: long })] });
  const sig = inspect(e, s.id).verdict.failure.signature;
  const head = sig.split("|").slice(3).join("|");
  assert.ok(head.length <= 70, head);
  assert.ok(head.startsWith("boom N N"), head);
  assert.ok(!/\d/.test(sig.split("|")[3]));
});

// ---- rungs --------------------------------------------------------------------------------

test("commit-wip: commits unsaved work onto the run's own branch", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "build", status: "cancelled", work: "unsaved", events: [cancelledEv("operator")] });
  const { r, state } = rescue(e, s.id);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state, "close");
  assert.equal(sh(s.path, "git", "status", "--porcelain").trim(), "");
  assert.equal(sh(s.path, "git", "branch", "--show-current").trim(), s.name);
  const msg = sh(s.path, "git", "log", "-1", "--format=%s").trim();
  assert.equal(msg, `wip: preserve build run ${s.id.slice(0, 8)} (workflow-cleanup)`);
  assert.ok(ledger(e).some((x) => x.run === s.id && x.action === "rung" && x.detail.startsWith("commit-wip ok")));
});

test("commit-wip: a detached HEAD gets a branch first", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "research", status: "completed", work: "detached-dirty", events: done("decision") });
  const { r, state } = rescue(e, s.id);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state, "close");
  const branch = `wip/research-${s.id.slice(0, 8)}`;
  assert.equal(sh(s.path, "git", "branch", "--show-current").trim(), branch);
  assert.ok(branches(e).includes(branch));
  assert.equal(sh(s.path, "git", "status", "--porcelain").trim(), "");
});

test("commit-wip: a refusing hook fails the rung and never retries with --no-verify", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "build", status: "cancelled", work: "unsaved", events: [cancelledEv("operator")] });
  const hooks = path.join(e.repo, ".git/hooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const { state } = rescue(e, s.id);
  assert.equal(state, "attention");
  assert.notEqual(sh(s.path, "git", "status", "--porcelain").trim(), "");
  assert.ok(ledger(e).some((x) => x.run === s.id && x.action === "rung" && x.detail.startsWith("commit-wip failed")));
});

function buildLandEnv({ gate = "true", approve = true, advanceMain = false, artifacts = {} } = {}) {
  const e = mkEnv({ gate });
  const events = [...(approve ? [answeredEv("build_cycle.final_gate", "approve")] : []), failedEv("sync_cycle.sync_land", { error: "landing failed" })];
  const id = crypto.randomUUID();
  const arts = path.join(e.home, ".archon/workspaces/x/proj/artifacts/runs", id);
  fs.mkdirSync(arts, { recursive: true });
  for (const [f, body] of Object.entries(artifacts)) write(arts, f, body);
  const s = scenario(e, { id, workflow: "build", status: "failed", work: "branch", events });
  if (advanceMain) sh(e.repo, "git", "commit", "--allow-empty", "-q", "-m", "moved");
  return { e, s };
}

test("land: lands an approved build whose gates are green", () => {
  const { e, s } = buildLandEnv();
  const { r, state, verdict } = rescue(e, s.id);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state, "close");
  assert.match(sh(e.repo, "git", "log", "--format=%s").trim(), /work/);
  assert.equal(verdict.work.state, "landed");
  assert.ok(ledger(e).some((x) => x.run === s.id && x.action === "rung" && x.detail.startsWith("land ok")));
  assert.equal(sh(s.path, "git", "status", "--porcelain").trim(), "");
});

test("land: a draft-pr build recorded in its state file is not landed", () => {
  const { e, s } = buildLandEnv({ artifacts: { state: "deliver=draft-pr\n" } });
  const { state } = rescue(e, s.id);
  assert.equal(state, "attention");
  assert.doesNotMatch(sh(e.repo, "git", "log", "--format=%s").trim(), /work/);
  assert.equal(ledger(e).filter((x) => x.run === s.id && x.action === "rung").length, 0);
});

test("land: a draft-pr build from before the state file, recorded in deliver.txt, is not landed", () => {
  const { e, s } = buildLandEnv({ artifacts: { "deliver.txt": "draft-pr\n" } });
  const { state } = rescue(e, s.id);
  assert.equal(state, "attention");
  assert.doesNotMatch(sh(e.repo, "git", "log", "--format=%s").trim(), /work/);
});

test("land: a build whose state file says land is landed", () => {
  const { e, s } = buildLandEnv({ artifacts: { state: "deliver=land\n" } });
  const { state } = rescue(e, s.id);
  assert.equal(state, "close");
  assert.match(sh(e.repo, "git", "log", "--format=%s").trim(), /work/);
});

test("land: an unapproved build is never landed", () => {
  const { e, s } = buildLandEnv({ approve: false });
  const { state } = rescue(e, s.id);
  assert.equal(state, "attention");
  assert.doesNotMatch(sh(e.repo, "git", "log", "--format=%s").trim(), /work/);
});

test("land: a build that skipped its final pause under auto_land counts as approved", () => {
  const { e, s } = buildLandEnv({ approve: false, artifacts: { state: "deliver=land\nauto-land=yes\n" } });
  const { r, state, verdict } = rescue(e, s.id);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state, "close");
  assert.match(sh(e.repo, "git", "log", "--format=%s").trim(), /work/);
  assert.equal(verdict.work.state, "landed");
  assert.ok(ledger(e).some((x) => x.run === s.id && x.action === "rung" && x.detail.startsWith("land ok")));
});

test("land: an auto-land value other than yes, cleared by a later round, does not stand in for an approval", () => {
  const { e, s } = buildLandEnv({ approve: false, artifacts: { state: "deliver=land\nauto-land=yes\nauto-land=\n" } });
  const { state } = rescue(e, s.id);
  assert.equal(state, "attention");
  assert.doesNotMatch(sh(e.repo, "git", "log", "--format=%s").trim(), /work/);
});

test("land: auto-land does not land a draft-pr build", () => {
  const { e, s } = buildLandEnv({ approve: false, artifacts: { state: "deliver=draft-pr\nauto-land=yes\n" } });
  const { state } = rescue(e, s.id);
  assert.equal(state, "attention");
  assert.doesNotMatch(sh(e.repo, "git", "log", "--format=%s").trim(), /work/);
});

test("land: red gates stop the landing and fail the rung", () => {
  const { e, s } = buildLandEnv({ gate: "false" });
  const { state } = rescue(e, s.id);
  assert.equal(state, "attention");
  assert.doesNotMatch(sh(e.repo, "git", "log", "--format=%s").trim(), /work/);
  assert.ok(ledger(e).some((x) => x.run === s.id && x.action === "rung" && x.detail.startsWith("land failed")));
});

test("land: a base that moved on is not an ancestor, so nothing lands", () => {
  const { e, s } = buildLandEnv({ advanceMain: true });
  const { state } = rescue(e, s.id);
  assert.equal(state, "attention");
  assert.doesNotMatch(sh(e.repo, "git", "log", "--format=%s").trim(), /work/);
  assert.equal(ledger(e).filter((x) => x.action === "rung").length, 0);
});

test("resume: backs up, marks the run failed, resumes and waits for a dead run", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "build", status: "running", owner: deadOwner(), work: "branch" });
  const { r } = rescue(e, s.id, { spend: "yes" });
  assert.equal(r.status, 0, r.stderr);
  const seq = stubLog(e).map((c) => `${c.tool} ${c.argv.slice(0, 2).join(" ")}`);
  assert.deepEqual(seq, [`archon-dead-runs.sh backup ${s.id}`, `archon-dead-runs.sh mark-failed ${s.id}`, `archon workflow resume`, `archon workflow wait`]);
  const resume = calls(e, "archon", "workflow", "resume")[0];
  assert.deepEqual(resume.argv, ["workflow", "resume", s.id, "--detach"]);
  assert.equal(resume.cwd, s.path);
  assert.deepEqual(calls(e, "archon", "workflow", "wait")[0].argv.slice(0, 3), ["workflow", "wait", s.id]);
});

test("resume: a run that waits at a pause afterwards ends the rescue as waiting", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "build", status: "running", owner: deadOwner(), work: "branch" });
  const sql = `update remote_agent_workflow_runs set status = 'paused' where id = '${s.id}';`;
  const { state, verdict } = rescue(e, s.id, { spend: "yes", STUB_WAIT_SQL: sql });
  assert.equal(state, "waiting");
  assert.equal(verdict.child, s.id);
});

test("resume: a run that completes afterwards is closed", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "research", status: "running", owner: deadOwner(), work: "landed", events: done("decision") });
  const sql = `update remote_agent_workflow_runs set status = 'completed', completed_at = '${ts(1)}' where id = '${s.id}';`;
  const { state, verdict, r } = rescue(e, s.id, { spend: "yes", STUB_WAIT_SQL: sql });
  assert.equal(state, "close", `${r.stdout}${r.stderr}${JSON.stringify(verdict)}`);
  assert.match(verdict.reason, /rescued by a resume/);
});

test("relaunch: starts the same workflow again with the original inputs and message", () => {
  const e = mkEnv();
  const s = scenario(e, {
    workflow: "anti-entropy",
    status: "failed",
    work: "none",
    inputs: { focus: "docs" },
    message: "look at the docs",
    events: [failedEv(null, { exit: "launch_failed", error: "Timed out creating workspace after 60s" })],
  });
  const { r } = rescue(e, s.id, { spend: "yes" });
  assert.equal(r.status, 0, r.stderr);
  const start = calls(e, "archon", "workflow", "run")[0];
  assert.deepEqual(start.argv, ["workflow", "run", "anti-entropy", "--detach", "--input", "focus=docs", "--base", "main", "look at the docs"]);
  assert.equal(start.cwd, e.repo);
  const rung = ledger(e).find((x) => x.action === "rung" && x.detail.startsWith("relaunch"));
  assert.equal(rung.run, s.id);
  assert.match(rung.child, /^stubrun/);
});

test("relaunch: is not repeated once a run was started from this one", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "anti-entropy", status: "failed", work: "none", events: [failedEv(null, { exit: "launch_failed", error: "Timed out creating workspace" })] });
  seedLedger(e, [{ run: s.id, action: "rung", detail: "relaunch failed child failed", child: "old1" }]);
  const { state } = rescue(e, s.id, { spend: "yes" });
  assert.equal(state, "attention");
  assert.equal(calls(e, "archon", "workflow", "run").length, 0);
});

function adoptEnv({ same = false, files = ["plan.md"], state = "plan-decision=approve\n", message = "improve the tasks view", inputs, adopted } = {}) {
  const e = mkEnv();
  const id = crypto.randomUUID();
  const captured = path.join(e.root, "captured");
  write(captured, "global/workflows/kit/build/build.yaml", "name: build\n# old\n");
  write(e.home, ".archon/workflows/kit/build/build.yaml", same ? "name: build\n# old\n" : "name: build\n# fixed\n");
  const arts = path.join(e.home, ".archon/workspaces/x/proj/artifacts/runs", id);
  for (const f of files) write(arts, f, "x\n");
  if (state) write(arts, "state", state);
  fs.mkdirSync(arts, { recursive: true });
  const s = scenario(e, { id, workflow: "build", status: "failed", work: "branch", source: captured, message, inputs, adopted, events: [failedEv("plan_decision")] });
  return { e, s };
}

test("adopt: starts a build that adopts a failed run, with the message the run started from", () => {
  const { e, s } = adoptEnv();
  const { r } = rescue(e, s.id, { spend: "yes" });
  assert.equal(r.status, 0, r.stderr);
  const start = calls(e, "archon", "workflow", "run")[0];
  assert.deepEqual(start.argv, ["workflow", "run", "build", "--detach", "--adopt", s.id, "improve the tasks view"]);
  assert.equal(start.cwd, e.repo);
  assert.equal(calls(e, "archon", "workflow", "wait").length, 1);
});

test("adopt: passes the design the run started from, then --adopt", () => {
  const { e, s } = adoptEnv({ inputs: { design: "timer" }, message: "" });
  const { r } = rescue(e, s.id, { spend: "yes" });
  assert.equal(r.status, 0, r.stderr);
  const start = calls(e, "archon", "workflow", "run")[0];
  assert.deepEqual(start.argv, ["workflow", "run", "build", "--detach", "--input", "design=timer", "--adopt", s.id]);
});

test("adopt: needs a design or a message for the build's intake node", () => {
  const { e, s } = adoptEnv({ message: "" });
  const { state } = rescue(e, s.id, { spend: "yes" });
  assert.equal(state, "attention");
  assert.equal(calls(e, "archon", "workflow", "run").length, 0);
});

test("adopt: a run that was itself an adoption is not adopted again", () => {
  const { e, s } = adoptEnv({ adopted: "00000000-0000-0000-0000-000000000000" });
  const { state } = rescue(e, s.id, { spend: "yes" });
  assert.equal(state, "attention");
  assert.equal(calls(e, "archon", "workflow", "run").length, 0);
});

test("adopt: a run whose state file records an approved plan is adopted", () => {
  const { e, s } = adoptEnv({ files: ["plan.md"], state: "plan-decision=approve\n" });
  const { r } = rescue(e, s.id, { spend: "yes" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(e, "archon", "workflow", "run")[0].argv, ["workflow", "run", "build", "--detach", "--adopt", s.id, "improve the tasks view"]);
});

test("adopt: a run made before plan-decision was recorded is adopted when it kept tests-sha in its state file or in tests.sha", () => {
  for (const opts of [{ files: ["plan.md"], state: "tests-sha=abc123\n" }, { files: ["plan.md", "tests.sha"], state: "" }]) {
    const { e, s } = adoptEnv(opts);
    const { r } = rescue(e, s.id, { spend: "yes" });
    assert.equal(r.status, 0, `${JSON.stringify(opts)}: ${r.stderr}`);
    assert.equal(calls(e, "archon", "workflow", "run").length, 1, JSON.stringify(opts));
  }
});

test("adopt: a run whose plan was never approved does not qualify, and neither does one with no plan", () => {
  for (const opts of [{ files: ["plan.md"], state: "plan-loop=open\n" }, { files: [], state: "plan-decision=approve\n" }]) {
    const { e, s } = adoptEnv(opts);
    const { state } = rescue(e, s.id, { spend: "yes" });
    assert.equal(state, "attention", JSON.stringify(opts));
    assert.equal(calls(e, "archon", "workflow", "run").length, 0, JSON.stringify(opts));
  }
});

test("adopt: needs a definition that differs from the captured one", () => {
  const { e, s } = adoptEnv({ same: true });
  const { state } = rescue(e, s.id, { spend: "yes" });
  assert.equal(state, "attention");
  assert.equal(calls(e, "archon", "workflow", "run").length, 0);
});

test("spend: --spend no runs no rung that spends", () => {
  const { e, s } = adoptEnv();
  const dead = scenario(e, { workflow: "build", status: "running", owner: deadOwner(), work: "branch" });
  const relaunch = scenario(e, { workflow: "anti-entropy", status: "failed", work: "none", events: [failedEv(null, { exit: "launch_failed", error: "Timed out creating workspace" })] });
  for (const id of [s.id, dead.id, relaunch.id]) assert.equal(rescue(e, id, { spend: "no" }).state, "attention");
  assert.equal(stubLog(e).length, 0);
});

test("rungs: each runs once per run, and at most three run", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "build", status: "running", owner: deadOwner(), work: "branch" });
  assert.equal(rescue(e, s.id, { spend: "yes" }).r.status, 0);
  assert.equal(calls(e, "archon", "workflow", "resume").length, 1);
  assert.equal(rescue(e, s.id, { spend: "yes" }).state, "attention");
  assert.equal(calls(e, "archon", "workflow", "resume").length, 1);

  const t = scenario(e, { workflow: "build", status: "running", owner: deadOwner(), work: "branch" });
  seedLedger(e, ["a", "b", "c"].map((x) => ({ run: t.id, action: "rung", detail: `${x} failed nothing` })));
  assert.equal(rescue(e, t.id, { spend: "yes" }).state, "attention");
  assert.equal(calls(e, "archon", "workflow", "resume").length, 1);
});

test("rescue --retry: runs up to three rungs and lets each run once more", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "build", status: "running", owner: deadOwner(), work: "branch" });
  seedLedger(e, [{ run: s.id, action: "rung", detail: "resume failed run died again" }]);
  assert.equal(rescue(e, s.id, { spend: "yes" }).state, "attention");
  assert.equal(calls(e, "archon", "workflow", "resume").length, 0);
  const { r } = rescue(e, s.id, { spend: "yes", retry: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(calls(e, "archon", "workflow", "resume").length, 1);
});

test("rescue: a dry run says which rung it would run and changes nothing", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "build", status: "cancelled", work: "unsaved", events: [cancelledEv("operator")] });
  const { r, state } = rescue(e, s.id, { dry: "yes" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state, "dry");
  assert.match(r.stdout + r.stderr, /commit-wip/);
  assert.notEqual(sh(s.path, "git", "status", "--porcelain").trim(), "");
  assert.deepEqual(ledger(e), []);
  assert.equal(stubLog(e).length, 0);
});

test("rescue: a run that no longer needs a rescue reports its route", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "research", status: "completed", work: "landed", events: done("decision") });
  assert.equal(rescue(e, s.id).state, "close");
  const live = scenario(e, { workflow: "build", status: "paused", work: "branch" });
  assert.equal(rescue(e, live.id).state, "skip");
});

// ---- settle -------------------------------------------------------------------------------

test("settle: removes a landed worktree and its branch", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "research", status: "completed", work: "landed", events: done("decision") });
  const r = run(e, ["settle", "--run", s.id, "--dry", "no"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!exists(s.path));
  assert.ok(!branches(e).includes(s.name));
  assert.equal(r.stdout.trim().split("\n").length, 1);
  assert.match(r.stdout, new RegExp(s.name));
});

test("settle: removes the worktree of a branch with unlanded commits and keeps the branch", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "build", status: "cancelled", work: "branch", events: [cancelledEv("operator")] });
  const tip = sh(s.path, "git", "rev-parse", "--short", "HEAD").trim();
  const r = run(e, ["settle", "--run", s.id, "--dry", "no"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!exists(s.path));
  assert.ok(branches(e).includes(s.name));
  assert.match(r.stdout, new RegExp(tip));
  assert.match(r.stdout, /kept/);
});

test("settle: refuses a dirty worktree", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "build", status: "cancelled", work: "unsaved", events: [cancelledEv("operator")] });
  const r = run(e, ["settle", "--run", s.id, "--dry", "no"]);
  assert.equal(r.status, 1);
  assert.ok(exists(s.path));
  assert.ok(exists(path.join(s.path, "scratch.txt")));
});

test("settle: refuses a detached HEAD that holds commits", () => {
  const e = mkEnv();
  const p = path.join(e.wtRoot, "det");
  fs.mkdirSync(e.wtRoot, { recursive: true });
  sh(e.repo, "git", "worktree", "add", "-q", "--detach", p, "main");
  commitIn(p, "det.txt");
  const id = addRun(e, { workflow: "probe", status: "completed", path: p });
  assert.equal(run(e, ["settle", "--run", id, "--dry", "no"]).status, 1);
  assert.ok(exists(p));
});

test("settle: --save-first commits the work, removes the worktree and keeps the branch", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "build", status: "failed", work: "unsaved", events: [failedEv("plan_decision")] });
  const r = run(e, ["settle", "--run", s.id, "--dry", "no", "--save-first"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!exists(s.path));
  assert.ok(branches(e).includes(s.name));
  assert.match(sh(e.repo, "git", "log", s.name, "-1", "--format=%s"), /wip: preserve build run/);
});

test("settle: --discard removes dirty work and the unlanded branch, and logs the old tip", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "build", status: "failed", work: "unsaved", events: [failedEv("plan_decision")] });
  commitIn(s.path, "kept.txt", "k\n", "committed");
  write(s.path, "scratch.txt", "dirty\n");
  const tip = sh(s.path, "git", "rev-parse", "--short", "HEAD").trim();
  const r = run(e, ["settle", "--run", s.id, "--dry", "no", "--discard"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!exists(s.path));
  assert.ok(!branches(e).includes(s.name));
  assert.match(r.stdout, new RegExp(tip));
});

test("settle: leaves a worktree that a live run is using", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "research", status: "completed", work: "landed", events: done("decision") });
  addRun(e, { workflow: "build", status: "running", owner: aliveOwner(), path: s.path, endedAgo: 3 });
  const r = run(e, ["settle", "--run", s.id, "--dry", "no"]);
  assert.equal(r.status, 1);
  assert.ok(exists(s.path));
});

test("settle: leaves a worktree that a paused run is using", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "research", status: "completed", work: "landed", events: done("decision") });
  addRun(e, { workflow: "build", status: "paused", path: s.path });
  assert.equal(run(e, ["settle", "--run", s.id, "--dry", "no"]).status, 1);
  assert.ok(exists(s.path));
});

test("settle: does nothing under --dry yes", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "research", status: "completed", work: "landed", events: done("decision") });
  const r = run(e, ["settle", "--run", s.id, "--dry", "yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(exists(s.path));
  assert.ok(branches(e).includes(s.name));
  assert.match(r.stdout, /would remove/);
});

test("settle: never removes the main checkout", () => {
  const e = mkEnv();
  const id = addRun(e, { workflow: "research", status: "completed", path: e.repo, events: done("decision") });
  const r = run(e, ["settle", "--run", id, "--dry", "no"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(exists(path.join(e.repo, ".git")));
});

test("settle: a worktree that is already gone is not an error", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "research", status: "completed", work: "none", events: done("decision") });
  assert.equal(run(e, ["settle", "--run", s.id, "--dry", "no"]).status, 0);
});

// ---- report and handoff -------------------------------------------------------------------

function attentionRun(e, errorLines = 100) {
  const error = Array.from({ length: errorLines }, (_, i) => `error line ${i + 1}`).join("\n");
  const s = scenario(e, { workflow: "build", status: "failed", work: "unsaved", message: "do the thing", events: [failedEv("build_cycle.lane_impl", { error })] });
  const { verdict } = inspect(e, s.id);
  const vfile = path.join(e.root, "verdict.json");
  fs.writeFileSync(vfile, JSON.stringify(verdict));
  return { s, vfile };
}

// ---- facts, diagnosis and the report ------------------------------------------------------

const artifactsOf = (e, id) => path.join(e.home, ".archon/workspaces/x/proj/artifacts/runs", id);
const writeTranscript = (e, id, rows) => {
  const p = path.join(e.home, ".archon/workspaces/x/proj/logs", `${id}.jsonl`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
};
const at = (sec, min = 52) => `2026-11-07T20:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.000Z`;
const tr = {
  start: (content, t) => ({ type: "workflow_start", workflow_name: "wf", content, ts: t }),
  begin: (step, t, loop = []) => ({ type: "node_start", step, execution: { invocation: { id: `${step}@${t}`, loopPath: loop } }, ts: t }),
  end: (step, t, ms = 100) => ({ type: "node_complete", step, execution: { timing: { durationMs: ms } }, ts: t }),
  fail: (step, t, ms, error = "boom") => ({ type: "node_error", step, execution: { timing: { durationMs: ms } }, error, ts: t }),
  wait: (step, t) => ({ type: "node_suspended", step, execution: {}, ts: t }),
  skip: (step, cause, t) => ({ type: "node_skipped", step, cause, ts: t }),
  out: (step, code, stdout, stderr, t) => ({ type: "exec_output", step, content: "<bash>", exit_code: code, stdout_tail: stdout, stderr_tail: stderr, ts: t }),
  resume: (t) => ({ type: "workflow_resume", ts: t }),
};
const commitAt = (dir, file, body, msg, date) => {
  write(dir, file, body);
  sh(dir, "git", "add", "-A");
  execFileSync("git", ["commit", "-q", "-m", msg], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stdio: ["ignore", "pipe", "pipe"],
  });
};

// A failed run, with the transcript and artifact files a test names.
function failedRun(e, { workflow = "deploy-config", node = "verify", work = "landed", error, transcript, files = {}, ...rest } = {}) {
  const err = error ?? `DAG workflow '${workflow}' completed with failures: '${node}': Bash node '${node}' failed [exit 1]: boom`;
  const s = scenario(e, { workflow, status: "failed", work, events: [failedEv(node, { error: err })], ...rest });
  if (transcript) writeTranscript(e, s.id, transcript(s.id));
  for (const [rel, body] of Object.entries(files)) write(artifactsOf(e, s.id), rel, body);
  return s;
}

function factsFor(e, id, { out, extra = {} } = {}) {
  const { verdict } = inspect(e, id);
  const vfile = path.join(e.root, `fv-${id.slice(0, 8)}.json`);
  fs.writeFileSync(vfile, JSON.stringify(verdict));
  const dir = out ?? path.join(e.root, `facts-${id.slice(0, 8)}`);
  const r = run(e, ["facts", "--verdict", vfile, "--out", dir], extra);
  const read = (n) => (fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n), "utf8") : null);
  return { r, word: r.stdout.trim(), dir, vfile, verdict, md: read("facts.md"), json: read("facts.json") ? JSON.parse(read("facts.json")) : null, diagnosis: read("diagnosis.json") };
}

const diag = (o = {}) => ({
  summary: "the stage changed a file outside its lane",
  happened: "The build stopped at lane_impl. The stage changed a file outside its lane.",
  expected: "unexpected",
  expected_why: "The planner should have kept the stage in its lane.",
  fixed_by: "",
  defect: "repo",
  defect_where: "check-lane.sh",
  rescue: "none-needed",
  rescue_how: "",
  work_value: "minor",
  work_why: "The file is a scratch edit.",
  recommend: "follow-up",
  recommend_why: "The defect is in the repository.",
  question: "Why did the stage leave its lane?",
  follow_up: { workflow: "build", repo: "", inputs: [], note: "Keep the stage inside its lane." },
  confidence: "high",
  evidence: [
    { claim: "The stage changed one file", source: "facts.md, Work", confirmed: true },
    { claim: "The planner did not list the file", source: "plan.md", confirmed: false },
  ],
  ...o,
});

test("facts: the timeline gives each node's state, time and exit, collapses loops, groups skipped nodes and marks resumes", () => {
  const e = mkEnv();
  const loop = (i) => [{ groupId: "build_cycle", iteration: i }];
  const s = failedRun(e, {
    workflow: "build",
    node: "build_cycle.lane_impl",
    work: "none",
    transcript: () => [
      tr.start("do the thing", at(0)),
      tr.begin("prepare", at(1)),
      tr.out("prepare", 0, "prepared", "", at(1)),
      tr.end("prepare", at(2), 600),
      tr.begin("round", at(3), loop(1)),
      tr.end("round", at(3), 50),
      tr.begin("round", at(4), loop(2)),
      tr.end("round", at(4), 70),
      tr.begin("ready", at(5)),
      tr.wait("ready", at(5)),
      tr.resume(at(30)),
      tr.end("ready", at(31), 1500000),
      tr.begin("lane_impl", at(32)),
      tr.out("lane_impl", 1, "", "…[truncated to last 2000 chars]\nassets/a.bin\nassets/b.bin", at(33)),
      tr.fail("lane_impl", at(33), 900, "Bash node 'lane_impl' failed [exit 1]: x"),
      tr.skip("ship", { kind: "upstream_failed", origin: "lane_impl" }, at(34)),
      tr.skip("land", { kind: "upstream_failed", origin: "lane_impl" }, at(34)),
      tr.skip("prepare", "prior_success", at(35)),
      { type: "exec_output", step: "build_cycle-iteration-2", exit_code: 1, ts: at(36) },
    ],
  });
  const f = factsFor(e, s.id);
  assert.equal(f.r.status, 0, f.r.stderr);
  assert.equal(f.word, "fresh");
  const items = f.json.timeline.items;
  const row = (n) => items.find((x) => x.node === n);
  assert.equal(row("prepare").state, "completed");
  assert.equal(row("prepare").ms, 600);
  assert.equal(row("prepare").exit, 0);
  assert.equal(row("round").count, 2);
  assert.equal(row("round").ms, 120);
  assert.equal(row("lane_impl").state, "failed");
  assert.equal(row("lane_impl").exit, 1);
  assert.equal(items.find((x) => x.resumed).after, "ready");
  assert.equal(items.some((x) => (x.node || "").includes("iteration")), false);
  const skipped = items.find((x) => x.skipped);
  assert.deepEqual(skipped.skipped, ["ship", "land"]);
  assert.equal(skipped.cause, "upstream failed at lane_impl");
  assert.equal(items.filter((x) => x.node === "prepare").length, 1);
  const failing = f.json.outputs.find((o) => o.role === "failing node");
  assert.equal(failing.node, "lane_impl");
  assert.equal(failing.clipped, true);
  assert.match(failing.stderr, /^assets\/a\.bin/);
  assert.equal(f.json.outputs.some((o) => o.node === "prepare"), false);
  assert.match(f.md, /`round` completed ×2/);
  assert.match(f.md, /2 nodes skipped, upstream failed at lane_impl: `ship`, `land`/);
  assert.match(f.md, /resumed after the pause at `ready`/);
  assert.match(f.md, /Archon kept only the last 2,000 characters/);
  assert.match(f.md, /`lane_impl` failed, exit 1/);
});

test("facts: the timeline is cut to 40 rows, dropping skipped nodes first", () => {
  const e = mkEnv();
  const rows = [tr.start("x", at(0))];
  for (let i = 0; i < 30; i++) rows.push(tr.begin(`n${i}`, at(1)), tr.end(`n${i}`, at(1), 10));
  for (let i = 0; i < 20; i++) rows.push(tr.skip(`s${i}`, `cause ${i}`, at(2)));
  rows.push(tr.begin("last", at(3)), tr.fail("last", at(3), 5));
  const s = failedRun(e, { node: "last", transcript: () => rows });
  const f = factsFor(e, s.id);
  assert.equal(f.json.timeline.items.length, 40);
  assert.equal(f.json.timeline.items.filter((x) => x.node).length, 31);
  assert.equal(f.json.timeline.items.filter((x) => x.skipped).length, 9);
  assert.equal(f.json.timeline.omitted, 11);
});

test("facts: more than 40 rows leaves the oldest out and counts them", () => {
  const e = mkEnv();
  const rows = [tr.start("x", at(0))];
  for (let i = 0; i < 50; i++) rows.push(tr.begin(`n${i}`, at(1)), tr.end(`n${i}`, at(1), 10));
  rows.push(tr.begin("last", at(3)), tr.fail("last", at(3), 5));
  const s = failedRun(e, { node: "last", transcript: () => rows });
  const f = factsFor(e, s.id);
  assert.equal(f.json.timeline.items.length, 40);
  assert.equal(f.json.timeline.omitted, 11);
  assert.equal(f.json.timeline.items.at(-1).node, "last");
  assert.match(f.md, /\[11 earlier rows left out\]/);
});

test("facts: the task's title comes from the brief a message left in the artifacts, and a plan's heading wins", () => {
  const e = mkEnv();
  const briefOnly = failedRun(e, { workflow: "build", node: "intake", work: "none", files: { "brief/my-slug/brief.md": "# Fix the loop\n\nbody\n" } });
  assert.equal(factsFor(e, briefOnly.id).json.task.heading, "Fix the loop");
  const both = failedRun(e, {
    workflow: "build",
    node: "intake",
    work: "none",
    files: { "brief/my-slug/brief.md": "# Fix the loop\n\nbody\n", "plan.md": "# Plan: the loop\n\nbody\n" },
  });
  assert.equal(factsFor(e, both.id).json.task.heading, "Plan: the loop");
});

test("facts: the task shows the message, the inputs, the plan's title and how the run began", () => {
  const e = mkEnv();
  const parent = failedRun(e, { workflow: "build", node: "sync_cycle", work: "none", message: "improve the tasks view" });
  const child = failedRun(e, {
    workflow: "build",
    node: "intake",
    work: "none",
    message: "",
    inputs: { design: "tasks" },
    adopted: parent.id,
    files: { "plan.md": "# Plan: the tasks view\n\nbody\n" },
    transcript: () => [tr.start("", at(0)), tr.begin("intake", at(1)), tr.fail("intake", at(1), 5)],
  });
  seedLedger(e, [{ run: parent.id, action: "rung", detail: "adopt ok the adopting run waits", child: child.id }]);
  const c = factsFor(e, child.id);
  assert.equal(c.json.task.message, "");
  assert.deepEqual(c.json.task.inputs, { design: "tasks" });
  assert.equal(c.json.task.heading, "Plan: the tasks view");
  assert.match(c.md, /- Message: \(empty\)/);
  assert.match(c.md, /- Inputs: `design=tasks`/);
  assert.match(c.md, /Title of its plan or brief: Plan: the tasks view/);
  assert.match(c.md, new RegExp(`It adopted the failed run ${parent.id.slice(0, 8)}`));
  assert.match(c.md, new RegExp(`The \`adopt\` rung of the cleanup of run ${parent.id.slice(0, 8)} started it`));
  const p = factsFor(e, parent.id);
  assert.match(p.md, new RegExp(`Run ${child.id.slice(0, 8)}, started from this one, is failed`));
  assert.match(p.md, /- Message:\n```text\nimprove the tasks view\n```/);
});

test("facts: an effect row says whether the node that changes something outside git completed, failed or never ran", () => {
  const e = mkEnv();
  const done = failedRun(e, {
    node: "verify",
    transcript: () => [
      tr.start("install", at(0)),
      tr.begin("install", at(1)),
      tr.out("install", 0, "backup: /x/staging.conf.json\nuploaded to staging", "", at(2)),
      tr.end("install", at(2), 6000),
      tr.begin("verify", at(3)),
      tr.out("verify", 1, "", "staging differs from the fragment in these tasks:\n  job-alpha", at(4)),
      tr.fail("verify", at(4), 3500),
    ],
  });
  const a = factsFor(e, done.id);
  assert.deepEqual(a.json.effects, [{ node: "install", what: "the live config on staging", state: "completed" }]);
  assert.match(a.md, /- the live config on staging: node `install` completed\./);
  const inst = a.json.outputs.find((o) => o.node === "install");
  assert.match(inst.stdout, /uploaded to staging/);
  assert.match(a.md, /Output of `install`, the last node that finished/);
  assert.match(a.md, /job-alpha/);

  const never = failedRun(e, {
    node: "dry_run",
    transcript: () => [tr.start("install", at(0)), tr.begin("dry_run", at(1)), tr.out("dry_run", 1, "cp: cannot create regular file 'x': File exists", "", at(2)), tr.fail("dry_run", at(2), 3900), tr.skip("install", { kind: "upstream_failed", origin: "dry_run" }, at(3))],
  });
  const b = factsFor(e, never.id);
  assert.deepEqual(b.json.effects.map((x) => x.state), ["never ran"]);
  assert.match(b.md, /node `install` never ran\./);
  assert.match(b.md, /cp: cannot create regular file 'x': File exists/);

  const push = failedRun(e, {
    workflow: "deploy-device",
    node: "push",
    work: "none",
    transcript: () => [tr.start("push", at(0)), tr.begin("push", at(1)), tr.out("push", 5, "Gave up after 600 s and 121 attempt(s).", "push.sh exited 5", at(2)), tr.fail("push", at(2), 600078)],
  });
  const c = factsFor(e, push.id);
  assert.match(c.md, /- the release on the device: node `push` failed\./);
  assert.match(c.md, /Gave up after 600 s and 121 attempt\(s\)\./);
  assert.match(c.md, /exit 5, 600 s/);

  const other = failedRun(e, { workflow: "research", node: "decision", work: "none", transcript: () => [tr.start("q", at(0)), tr.begin("decision", at(1)), tr.fail("decision", at(1), 5)] });
  assert.equal(factsFor(e, other.id).json.effects, undefined);
});

test("facts: a run with no transcript still gets facts, with its effects unknown and a gap noted", () => {
  const e = mkEnv();
  const s = failedRun(e, { node: "verify" });
  const f = factsFor(e, s.id);
  assert.equal(f.word, "fresh");
  assert.equal(f.json.timeline, undefined);
  assert.match(f.json.errors.transcript, /no transcript/);
  assert.match(f.json.effects[0].state, /unknown/);
  assert.match(f.md, /## Gaps in these facts/);
});

test("facts: a transcript that cannot be read leaves that section out and nothing else", () => {
  const e = mkEnv();
  const s = failedRun(e, { node: "verify" });
  fs.mkdirSync(path.join(e.home, ".archon/workspaces/x/proj/logs", `${s.id}.jsonl`), { recursive: true });
  const f = factsFor(e, s.id);
  assert.equal(f.r.status, 0, f.r.stderr);
  assert.equal(f.word, "fresh");
  assert.equal(f.json.timeline, undefined);
  assert.match(f.json.errors.transcript, /IsADirectoryError/);
  assert.ok(f.json.work);
  assert.match(f.md, /## Gaps in these facts/);
});

test("facts: prints none and exits 0 when the verdict or the output directory is unusable", () => {
  const e = mkEnv();
  const bad = path.join(e.root, "bad.json");
  fs.writeFileSync(bad, "not json");
  const r1 = run(e, ["facts", "--verdict", bad, "--out", path.join(e.root, "o1")]);
  assert.equal(r1.status, 0);
  assert.equal(r1.stdout.trim(), "none");
  const s = failedRun(e, { node: "verify" });
  const { verdict } = inspect(e, s.id);
  const v = path.join(e.root, "v.json");
  fs.writeFileSync(v, JSON.stringify(verdict));
  const blocker = path.join(e.root, "blocker");
  fs.writeFileSync(blocker, "a file where the directory should be");
  const r2 = run(e, ["facts", "--verdict", v, "--out", blocker]);
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout.trim(), "none");
  assert.match(r2.stderr, /facts:/);
});

test("facts: a run the engine refused to resume still gets facts from its transcript", () => {
  const e = mkEnv();
  const s = scenario(e, {
    workflow: "build",
    status: "cancelled",
    work: "none",
    events: [cancelledEv("precondition_failed")],
  });
  writeTranscript(e, s.id, [tr.start("", at(0)), tr.begin("lane_impl", at(1)), tr.out("lane_impl", 1, "", "this stage changed nothing", at(2)), tr.fail("lane_impl", at(2), 100)]);
  write(artifactsOf(e, s.id), "blocked.md", "# Blocked: two assertions\n\nThe branch is build/platform-icons.\n");
  const f = factsFor(e, s.id);
  assert.equal(f.word, "fresh");
  assert.equal(f.json.failure.exit_reason, "precondition_failed");
  assert.equal(f.json.failure.node, null);
  assert.match(f.md, /this stage changed nothing/);
  assert.match(f.md, /`blocked\.md`, first 30 lines/);
  assert.match(f.md, /build\/platform-icons/);
});

test("facts: a completed run that left unsaved work has facts and no failure section", () => {
  const e = mkEnv();
  const s = scenario(e, { workflow: "research", status: "completed", work: "unsaved", events: done("decision") });
  const f = factsFor(e, s.id);
  assert.equal(f.word, "fresh");
  assert.equal(f.json.failure, undefined);
  assert.equal(f.json.history, undefined);
  assert.doesNotMatch(f.md, /Failed at/);
  assert.match(f.md, /The work is unsaved \(1 changed file\)/);
});

test("facts: the real start comes from the transcript, because a resume rewrites started_at", () => {
  const e = mkEnv();
  const s = failedRun(e, {
    startedAt: "2026-11-07 21:56:58",
    transcript: () => [tr.start("install", at(33)), tr.begin("verify", at(34)), tr.fail("verify", at(35), 5)],
  });
  const f = factsFor(e, s.id);
  assert.equal(f.json.header.started, "2026-11-07T20:52:33Z");
});

test("facts: runs of the same workflow that started in the same second or overlapped are listed, others are not", () => {
  const e = mkEnv();
  const mine = failedRun(e, { startedAt: "2026-11-07 20:52:33", completedAt: "2026-11-07 20:52:40", lastAt: "2026-11-07 20:52:40" });
  const twin = failedRun(e, { startedAt: "2026-11-07 20:52:33", completedAt: "2026-11-07 20:52:41", lastAt: "2026-11-07 20:52:41" });
  const overlapping = failedRun(e, { startedAt: "2026-11-07 20:00:00", completedAt: "2026-11-07 20:52:36", lastAt: "2026-11-07 20:52:36" });
  const earlier = failedRun(e, { startedAt: "2026-11-07 19:00:00", completedAt: "2026-11-07 19:30:00", lastAt: "2026-11-07 19:30:00" });
  const other = failedRun(e, { workflow: "deploy-device", node: "push", startedAt: "2026-11-07 20:52:33", completedAt: "2026-11-07 20:52:41", lastAt: "2026-11-07 20:52:41" });
  const f = factsFor(e, mine.id);
  const ids = f.json.concurrent.map((x) => x.run);
  assert.deepEqual(ids.slice(0, 1), [twin.id.slice(0, 8)]);
  assert.ok(ids.includes(overlapping.id.slice(0, 8)));
  assert.ok(!ids.includes(earlier.id.slice(0, 8)));
  assert.ok(!ids.includes(other.id.slice(0, 8)));
  assert.equal(f.json.concurrent[0].gap_s, 0);
  assert.match(f.md, new RegExp(`\`${twin.id.slice(0, 8)}\` started at 11-07 20:52:33 UTC \\(the same second\\), status \`failed\``));
});

test("facts: the node's definition comes from the captured workflow and stops at the next node", () => {
  const e = mkEnv();
  const src = path.join(e.root, "captured");
  write(
    src,
    "wf/deploy-config.yaml",
    ["name: deploy-config", "nodes:", "  # about prepare", "  - id: prepare", "    bash: echo hi", "  - id: dry_run", "    depends_on: [prepare]", "    bash: |", '      bash "${ARCHON_HOME:-$HOME/.archon}/scripts/foo.sh" tools/helper.sh', "      echo done", "", "  # about ready", "  - id: ready", "    wait: x", ""].join("\n"),
  );
  const s = failedRun(e, { node: "dry_run", source: src });
  const f = factsFor(e, s.id);
  assert.match(f.json.definition, /^  - id: dry_run\n    depends_on: \[prepare\]/);
  assert.match(f.json.definition, /echo done$/);
  assert.doesNotMatch(f.json.definition, /ready|prepare\n/);
  assert.match(f.md, /## Definition of the failing node\n\n```yaml\n  - id: dry_run/);
  const g = failedRun(e, { node: "build_cycle.nowhere", source: src });
  assert.equal(factsFor(e, g.id).json.definition, "");
});

test("facts: commits since the run started that touch the files its failing node names are listed, in the kit's clone and the run's repository", () => {
  const e = mkEnv();
  const kit = path.join(e.root, "kit-clone");
  fs.mkdirSync(kit, { recursive: true });
  sh(kit, "git", "init", "-q", "-b", "main");
  sh(kit, "git", "config", "user.email", "t@example.com");
  sh(kit, "git", "config", "user.name", "t");
  commitAt(kit, "scripts/foo.sh", "v1\n", "scripts: old foo", "2025-01-01T00:00:00Z");
  commitAt(kit, "scripts/other.sh", "v1\n", "scripts: other", "2026-11-08T10:00:00Z");
  commitAt(kit, "scripts/foo.sh", "v2\n", "scripts: fix foo", "2026-11-08T11:00:00Z");
  commitAt(kit, "workflows/deploy-config/deploy-config.yaml", "name: x\n", "workflows: tweak deploy-config", "2026-11-08T12:00:00Z");
  write(path.join(e.home, ".archon"), "kit-installed.json", JSON.stringify({ source: kit }));
  commitAt(e.repo, "tools/helper.sh", "v1\n", "tools: old helper", "2025-01-01T00:00:00Z");
  commitAt(e.repo, "tools/helper.sh", "v2\n", "tools: fix helper", "2026-11-08T11:00:00Z");
  commitAt(e.repo, "tools/unrelated.sh", "v1\n", "tools: unrelated", "2026-11-08T11:30:00Z");
  const src = path.join(e.root, "captured");
  write(src, "wf/deploy-config.yaml", ["nodes:", "  - id: dry_run", '    bash: bash "${ARCHON_HOME:-$HOME/.archon}/scripts/foo.sh" tools/helper.sh', ""].join("\n"));
  const s = failedRun(e, { node: "dry_run", source: src, transcript: () => [tr.start("x", "2026-11-07T20:52:00.000Z"), tr.begin("dry_run", at(1)), tr.fail("dry_run", at(2), 5)] });
  const f = factsFor(e, s.id);
  assert.equal(f.json.changes.since, "2026-11-07T20:52:00Z");
  assert.deepEqual(f.json.changes.kit.map((l) => l.slice(8)), ["workflows: tweak deploy-config", "scripts: fix foo"]);
  assert.deepEqual(f.json.changes.kit_paths, ["workflows/deploy-config", "scripts/foo.sh"]);
  assert.deepEqual(f.json.changes.repo.map((l) => l.slice(8)), ["tools: fix helper"]);
  assert.equal(f.json.changes.definition_changed, false);
  assert.match(f.md, /## Changes since the run started/);
  assert.match(f.md, /- Commits in the Archon kit repository \(since 2026-11-07T20:52:00Z\):/);
  assert.match(f.md, /scripts: fix foo/);
  assert.doesNotMatch(f.md, /tools: unrelated|scripts: other|old foo|old helper/);
});

test("facts: a host with no recorded kit clone leaves the kit section out", () => {
  const e = mkEnv();
  const src = path.join(e.root, "captured");
  write(src, "wf/deploy-config.yaml", "nodes:\n  - id: verify\n    bash: a\n");
  const s = failedRun(e, { node: "verify", source: src });
  const f = factsFor(e, s.id);
  assert.equal(f.json.changes.kit, null);
  assert.doesNotMatch(f.md, /Archon kit repository/);
  write(path.join(e.home, ".archon"), "kit-installed.json", JSON.stringify({ source: path.join(e.root, "gone") }));
  assert.equal(factsFor(e, failedRun(e, { node: "verify", source: src }).id).json.changes.kit, null);
});

test("facts: a workflow definition that differs from the captured copy is said so", () => {
  const e = mkEnv();
  const src = path.join(e.root, "captured");
  write(src, "wf/deploy-config.yaml", "nodes:\n  - id: verify\n    bash: a\n");
  write(e.home, ".archon/workflows/kit/deploy-config/deploy-config.yaml", "nodes:\n  - id: verify\n    bash: b\n");
  const s = failedRun(e, { node: "verify", source: src });
  const f = factsFor(e, s.id);
  assert.equal(f.json.changes.definition_changed, true);
  assert.match(f.md, /The workflow definition differs from the copy captured when the run started\./);
});

test("facts: the work section lists the commits and changes of a branch, and says plainly that a landed run has none", () => {
  const e = mkEnv();
  const branch = failedRun(e, { workflow: "build", node: "gates", work: "branch" });
  const f = factsFor(e, branch.id);
  assert.equal(f.json.work.state, "branch");
  assert.equal(f.json.work.log.length, 1);
  assert.match(f.json.work.log[0], /^[0-9a-f]+ work$/);
  assert.match(f.json.work.stat[0], /\.txt +\| 1 \+/);
  assert.match(f.md, /The work is committed only on the local branch/);
  assert.match(f.md, /Commits not in `main`:/);
  const landed = failedRun(e, { workflow: "build", node: "gates", work: "landed" });
  const g = factsFor(e, landed.id);
  assert.deepEqual(g.json.work.log, []);
  assert.match(g.md, /The work is landed on the base branch\./);
  const unsaved = failedRun(e, { workflow: "build", node: "gates", work: "unsaved" });
  const h = factsFor(e, unsaved.id);
  assert.deepEqual(h.json.work.dirty, ["?? scratch.txt"]);
  assert.match(h.md, /1 uncommitted file:/);
});

test("facts: earlier failures with the same signature show their cause and what the owner did, and leave the run itself out", () => {
  const e = mkEnv();
  const err = (cause) => `DAG workflow 'deploy-config' completed with failures: 'verify': Bash node 'verify' failed [exit 1]: ${cause}`;
  const older = failedRun(e, { node: "verify", error: err("staging differs in job-alpha"), endedAgo: 3000 });
  const child = scenario(e, { workflow: "research", status: "completed", work: "none", events: done("decision") });
  const unanswered = failedRun(e, { node: "verify", error: err("staging differs in job-beta"), endedAgo: 2000 });
  const mine = failedRun(e, { node: "verify", error: err("staging differs in job-gamma"), endedAgo: 10 });
  seedLedger(e, [
    { run: older.id, action: "answered", detail: "research" },
    { run: older.id, action: "handed-off", detail: "research", child: child.id },
  ]);
  const f = factsFor(e, mine.id);
  const rows = f.json.history.rows;
  assert.deepEqual(rows.map((r) => r.run), [unanswered.id.slice(0, 8), older.id.slice(0, 8)]);
  assert.equal(rows[0].outcome, "not answered");
  assert.equal(rows[1].outcome, `answered research -> run ${child.id.slice(0, 8)} completed`);
  assert.equal(rows[1].cause, "staging differs in job-alpha");
  assert.match(f.md, /## Earlier runs that failed the same way/);
  assert.match(f.md, /Outcome: answered research -> run/);
  assert.ok(!rows.some((r) => r.run === mine.id.slice(0, 8)));
});

test("facts: with no other failure of the signature, the section says none failed in the last 30 days", () => {
  const e = mkEnv();
  const s = failedRun(e, { node: "verify" });
  const f = factsFor(e, s.id);
  assert.deepEqual(f.json.history, { rows: [], more: 0 });
  assert.match(f.md, /No other run has failed this way in the last 30 days\./);
});

test("facts: the artifact files are listed with sizes, and the files that explain a run are opened", () => {
  const e = mkEnv();
  const long = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
  const s = failedRun(e, {
    node: "verify",
    files: {
      "blocked.md": `# Blocked: two assertions\n${long}\n`,
      "restore.txt": "restore it with this command\n",
      "small.log": "small log line\n",
      "big.log": "x".repeat(21 << 10),
      "plan.md": "# Plan\n",
      ".archon/hidden.txt": "hidden\n",
      "gates/ord-0.log": "gate output\n",
    },
  });
  const f = factsFor(e, s.id);
  const names = f.json.artifacts.files.map((x) => x.path);
  assert.deepEqual(names.sort(), ["big.log", "blocked.md", "gates/ord-0.log", "plan.md", "restore.txt", "small.log"]);
  assert.equal(f.json.artifacts.files.find((x) => x.path === "plan.md").size, 7);
  const heads = f.json.artifacts.heads.map((x) => x.path);
  assert.deepEqual(heads, ["blocked.md", "restore.txt", "gates/ord-0.log", "small.log"]);
  const blocked = f.json.artifacts.heads[0].text.split("\n");
  assert.equal(blocked.length, 30);
  assert.equal(blocked[0], "# Blocked: two assertions");
  assert.match(f.md, /- `plan\.md` \(7 bytes\)/);
  assert.match(f.md, /`restore\.txt`, first 30 lines/);
  assert.doesNotMatch(f.md, /hidden|big\.log`, first/);
});

test("facts: the artifact heads together stay within 60 KB", () => {
  const e = mkEnv();
  const files = {};
  for (let i = 0; i < 20; i++) files[`blocked-${i}.md`] = ("y".repeat(900) + "\n").repeat(30);
  const s = failedRun(e, { node: "verify", files });
  const f = factsFor(e, s.id);
  const total = f.json.artifacts.heads.reduce((n, x) => n + Buffer.byteLength(x.text), 0);
  assert.ok(total <= 60 << 10, `heads hold ${total} bytes`);
  assert.ok(f.json.artifacts.heads.length >= 10);
});

test("facts: the facts file is capped at 100 KB", () => {
  const e = mkEnv();
  const files = {};
  for (let i = 0; i < 12; i++) files[`resolution-${i}.md`] = "z".repeat(5000);
  const rows = [tr.start("m".repeat(5000), at(0))];
  for (let i = 0; i < 40; i++) rows.push(tr.begin(`n${i}`, at(1)), tr.out(`n${i}`, 1, "o".repeat(3000), "", at(1)), tr.fail(`n${i}`, at(1), 5, "e".repeat(3000)));
  const s = failedRun(e, { node: "n39", files, transcript: () => rows });
  const f = factsFor(e, s.id);
  assert.ok(Buffer.byteLength(f.md) <= (100 << 10) + 64);
});

test("facts: the cache hands a diagnosis back only for the same facts", () => {
  const e = mkEnv();
  const s = failedRun(e, { node: "verify", files: { "install.log": "uploaded\n" } });
  const first = factsFor(e, s.id);
  assert.equal(first.word, "fresh");
  assert.equal(first.diagnosis, null);
  const raw = path.join(e.root, "diagnose.json");
  fs.writeFileSync(raw, JSON.stringify(diag()));
  const kept = run(e, ["diagnosis", "--run", s.id, "--facts-word", "fresh", "--raw", raw, "--dir", first.dir]);
  assert.equal(kept.status, 0, kept.stderr);
  assert.equal(kept.stdout.trim(), "ok");
  assert.equal(JSON.parse(fs.readFileSync(path.join(first.dir, "diagnosis.json"), "utf8")).recommend, "follow-up");
  const cache = JSON.parse(fs.readFileSync(path.join(e.home, ".archon/state/workflow-cleanup/diagnoses", `${s.id}.json`), "utf8"));
  assert.match(cache.facts_sha, /^[0-9a-f]{64}$/);
  assert.equal(cache.diagnosis.summary, "the stage changed a file outside its lane");

  fs.rmSync(path.join(first.dir, "diagnosis.json"));
  const again = factsFor(e, s.id);
  assert.equal(again.word, "cached");
  assert.equal(JSON.parse(again.diagnosis).recommend, "follow-up");
  const same = run(e, ["diagnosis", "--run", s.id, "--facts-word", "cached", "--raw", path.join(e.root, "missing.json"), "--dir", again.dir]);
  assert.equal(same.stdout.trim(), "cached");
  assert.ok(exists(path.join(again.dir, "diagnosis.json")));

  write(artifactsOf(e, s.id), "new-evidence.md", "another file\n");
  const changed = factsFor(e, s.id);
  assert.equal(changed.word, "fresh");
  assert.equal(changed.diagnosis, null);
});

test("diagnosis: keeps a diagnosis that parses and names an answer, and prints none for anything else", () => {
  const e = mkEnv();
  const s = failedRun(e, { node: "verify" });
  const f = factsFor(e, s.id);
  const save = (text, word = "fresh") => {
    const raw = path.join(e.root, "raw.json");
    fs.writeFileSync(raw, text);
    return run(e, ["diagnosis", "--run", s.id, "--facts-word", word, "--raw", raw, "--dir", f.dir]);
  };
  const dfile = path.join(f.dir, "diagnosis.json");
  assert.equal(save(JSON.stringify(JSON.stringify(diag()))).stdout.trim(), "ok");
  assert.equal(JSON.parse(fs.readFileSync(dfile, "utf8")).recommend, "follow-up");
  for (const bad of ["", "not json", "[]", JSON.stringify({ summary: "x" }), JSON.stringify({ recommend: "  " })]) {
    const r = save(bad);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "none", bad);
    assert.equal(exists(dfile), false, bad);
  }
  assert.equal(run(e, ["diagnosis", "--run", s.id, "--facts-word", "none", "--raw", path.join(e.root, "gone"), "--dir", f.dir]).stdout.trim(), "none");
});

// ---- the report ---------------------------------------------------------------------------

function reportFor(e, vfile, { facts, diagnosis } = {}) {
  const args = ["report", "--verdict", vfile, "--out", path.join(e.root, "report.md")];
  if (facts) {
    fs.writeFileSync(path.join(e.root, "facts.json"), JSON.stringify(facts));
    args.push("--facts", path.join(e.root, "facts.json"));
  }
  if (diagnosis) {
    fs.writeFileSync(path.join(e.root, "diagnosis.json"), JSON.stringify(diagnosis));
    args.push("--diagnosis", path.join(e.root, "diagnosis.json"));
  }
  const r = run(e, args);
  return { r, md: fs.existsSync(path.join(e.root, "report.md")) ? fs.readFileSync(path.join(e.root, "report.md"), "utf8") : null };
}

function diagnosedReport(e, d, extra = {}) {
  const s = failedRun(e, { workflow: "build", node: "build_cycle.lane_impl", work: "unsaved", transcript: () => [tr.start("x", at(0)), tr.begin("lane_impl", at(1)), tr.out("lane_impl", 1, "", "paths outside the lane", at(2)), tr.fail("lane_impl", at(2), 5)], ...extra });
  const f = factsFor(e, s.id);
  return { s, f, ...reportFor(e, f.vfile, { facts: f.json, diagnosis: d }) };
}

test("report: a diagnosis puts the title, the recommended answer and one section for each question first, then the facts", () => {
  const e = mkEnv();
  const { s, r, md } = diagnosedReport(e, diag({ fixed_by: "", rescue: "needed", rescue_how: "git -C /w switch -c rescue\ngit -C /w commit -am wip" }));
  assert.equal(r.status, 0, r.stderr);
  const lines = md.split("\n");
  assert.equal(lines[0], `# Cleanup of build run ${s.id.slice(0, 8)}: the stage changed a file outside its lane`);
  assert.equal(lines[2], "Recommended answer: follow-up. The defect is in the repository.");
  assert.equal(lines[4], "Confidence: high.");
  assert.equal(lines[6], "The follow-up is `build`: Keep the stage inside its lane.");
  assert.doesNotMatch(md, /The diagnosing agent recommended|Question for the research run/);
  const headings = lines.filter((l) => l.startsWith("## "));
  assert.deepEqual(headings, ["## What happened", "## Whether it was expected", "## Rescue", "## Value of the work", "## Evidence", "## Facts"]);
  assert.ok(md.indexOf("## What happened") < md.indexOf("## Facts"));
  assert.match(md, /## What happened\n\nThe build stopped at lane_impl\./);
  assert.match(md, /## Whether it was expected\n\nThis failure was not expected\. The planner should have kept the stage in its lane\./);
  assert.match(md, /## Rescue\n\nA rescue is needed\.\n\n```text\ngit -C \/w switch -c rescue\ngit -C \/w commit -am wip\n```/);
  assert.match(md, /## Value of the work\n\nThe work is minor\. The file is a scratch edit\./);
  assert.match(md, /- confirmed: The stage changed one file \(facts\.md, Work\)\./);
  assert.match(md, /- inferred: The planner did not list the file \(plan\.md\)\./);
  assert.match(md, /### Timeline/);
  assert.match(md, /paths outside the lane/);
  assert.doesNotMatch(md, /### Definition of the failing node|first 30 lines|### Changes since/);
  assert.doesNotMatch(md, /Failure signature/);
  assert.equal(r.stdout.trim(), "The stage changed a file outside its lane. Recommended: follow-up.");
});

test("report: a fix that is named in the facts stays, and one that is not is dropped", () => {
  const e = mkEnv();
  const s = failedRun(e, { workflow: "build", node: "gates" });
  const f = factsFor(e, s.id);
  const facts = { ...f.json, changes: { since: "x", kit: ["abc1234 scripts: fix the cp race"], repo: [], definition_changed: false } };
  const kept = reportFor(e, f.vfile, { facts, diagnosis: diag({ fixed_by: "abc1234" }) });
  assert.match(kept.md, /It has been fixed since by abc1234\./);
  const dropped = reportFor(e, f.vfile, { facts, diagnosis: diag({ fixed_by: "deadbee" }) });
  assert.doesNotMatch(dropped.md, /fixed since/);
});

test("report: without a diagnosis the summary says so and the facts follow", () => {
  const e = mkEnv();
  const s = failedRun(e, { workflow: "build", node: "gates", work: "none" });
  const f = factsFor(e, s.id);
  const { r, md } = reportFor(e, f.vfile, { facts: f.json });
  assert.equal(r.status, 0, r.stderr);
  const lines = md.split("\n");
  assert.equal(lines[0], `# Cleanup of build run ${s.id.slice(0, 8)}`);
  assert.equal(lines[2], "No diagnosis (the diagnosing agent produced none). Facts below.");
  assert.doesNotMatch(md, /Recommended answer/);
  assert.deepEqual(lines.filter((l) => l.startsWith("## ")), ["## Facts"]);
  assert.match(md, /### Timeline|### Run/);
  assert.equal(r.stdout.trim(), `build run ${s.id.slice(0, 8)} failed at gates; its work is absent (no worktree is left). No rescue rung applies to the failure at gates.`);
});

test("report: with neither facts nor a diagnosis it falls back to the verdict, with the last 40 lines of the error", () => {
  const e = mkEnv();
  const { s, vfile } = attentionRun(e);
  const { r, md } = reportFor(e, vfile);
  assert.equal(r.status, 0, r.stderr);
  assert.match(md, /^# Cleanup of build run /);
  assert.match(md, /No diagnosis/);
  assert.match(md, /error line 100/);
  assert.match(md, /error line 61\b/);
  assert.doesNotMatch(md, /error line 60\b/);
  assert.match(md, /build_cycle\.lane_impl/);
  assert.match(md, new RegExp(s.id.slice(0, 8)));
  assert.match(md, /unsaved/);
  assert.equal(r.stdout.trim().split("\n").length, 1);
  assert.match(r.stdout, /build/);
});

test("report: the guards turn an answer that does not fit the defect, low confidence, discard and an unknown answer into research", () => {
  const e = mkEnv();
  const fu = (workflow, extra = {}) => ({ workflow, repo: "", inputs: [], note: "the change", ...extra });
  const cases = [
    ["a repo defect with accept and a rescue needed", { defect: "repo", recommend: "accept", rescue: "needed" }, "research", /`accept` does not fix|which `accept` does not fix/],
    ["a repo defect with accept and an optional rescue", { defect: "repo", recommend: "accept", rescue: "optional" }, "research", /which `accept` does not fix/],
    ["a repo defect with accept and important work", { defect: "repo", recommend: "accept", work_value: "important" }, "research", /which `accept` does not fix/],
    ["a repo defect with accept and work of unknown value", { defect: "repo", recommend: "accept", work_value: "unknown" }, "research", /which `accept` does not fix/],
    ["a global-workflow defect with accept and important work", { defect: "global-workflow", recommend: "accept", work_value: "important" }, "research", /defect in `global-workflow`/],
    ["accept with nothing to lose but low confidence", { defect: "repo", recommend: "accept", confidence: "low" }, "research", /confidence was low/],
    ["accept with nothing to lose but an environment defect asked for follow-up", { defect: "environment", recommend: "follow-up" }, "research", /defect in `environment`/],
    ["an environment defect with follow-up", { defect: "environment", recommend: "follow-up" }, "research", /defect in `environment`/],
    ["an operator defect with follow-up", { defect: "operator", recommend: "follow-up" }, "research", /defect in `operator`/],
    ["low confidence", { defect: "repo", recommend: "follow-up", confidence: "low" }, "research", /confidence was low/],
    ["discard", { recommend: "discard" }, "research", /named no answer/],
    ["an unknown answer", { recommend: "delete" }, "research", /named no answer/],
    ["the old answer build", { recommend: "build" }, "research", /named no answer/],
    ["an unknown defect with follow-up", { defect: "bogus", recommend: "follow-up" }, "research", /could not place the defect/],
    ["an unspecified confidence", { confidence: "", recommend: "follow-up" }, "research", /confidence was low/],
    ["a follow-up that names no workflow", { follow_up: fu("") }, "research", /follow-up the agent named cannot start \(it names no workflow\)/],
    ["a follow-up that names a workflow that is not a candidate", { follow_up: fu("deploy-everything") }, "research", /cannot start \(.*declares no such hand-off/],
    ["a follow-up that names a repository build cannot start in", { follow_up: fu("build", { repo: "nowhere" }) }, "research", /cannot start \(.*build in nowhere: build cannot run there/],
  ];
  for (const [name, patch, want, why] of cases) {
    const { md, r } = diagnosedReport(e, diag(patch));
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.match(md, new RegExp(`\\nRecommended answer: ${want}\\.`), name);
    assert.match(md, why, name);
    assert.match(r.stdout.trim(), new RegExp(`Recommended: ${want}\\.$`), name);
  }
  const kept = [
    [{ defect: "repo", recommend: "follow-up" }, "follow-up"],
    [{ defect: "global-workflow", recommend: "follow-up" }, "follow-up"],
    [{ defect: "environment", recommend: "retry" }, "retry"],
    [{ defect: "operator", recommend: "accept" }, "accept"],
    [{ defect: "none", recommend: "accept" }, "accept"],
    [{ defect: "repo", recommend: "accept" }, "accept"],
    [{ defect: "repo", recommend: "accept", work_value: "none" }, "accept"],
    [{ defect: "global-workflow", recommend: "accept" }, "accept"],
    [{ defect: "unknown", recommend: "accept" }, "accept"],
    [{ defect: "unknown", recommend: "research" }, "research"],
    [{ defect: "repo", recommend: "research", confidence: "low" }, "research"],
  ];
  for (const [patch, want] of kept) {
    const { md } = diagnosedReport(e, diag(patch));
    assert.match(md, new RegExp(`\\nRecommended answer: ${want}\\.`), JSON.stringify(patch));
    assert.doesNotMatch(md, /settles the cause first/, JSON.stringify(patch));
  }
});

test("report: a defect that the facts show was fixed since allows accept and retry, and an unverified fix does not", () => {
  const e = mkEnv();
  const s = failedRun(e, { workflow: "build", node: "gates" });
  const f = factsFor(e, s.id);
  const facts = { ...f.json, changes: { since: "x", kit: ["abc1234 scripts: fix the cp race"], repo: [], definition_changed: false } };
  for (const [defect, recommend] of [["repo", "accept"], ["global-workflow", "accept"], ["global-workflow", "retry"]]) {
    const r = reportFor(e, f.vfile, { facts, diagnosis: diag({ defect, recommend, fixed_by: "abc1234" }) });
    assert.match(r.md, new RegExp(`\\nRecommended answer: ${recommend}\\.`), `${defect} ${recommend}`);
    assert.match(r.md, /It has been fixed since by abc1234\./);
  }
  const lost = { rescue: "needed" };
  const unseen = reportFor(e, f.vfile, { facts, diagnosis: diag({ defect: "repo", recommend: "accept", fixed_by: "deadbee", ...lost }) });
  assert.match(unseen.md, /Recommended answer: research\./);
  const nameOnly = reportFor(e, f.vfile, { facts, diagnosis: diag({ defect: "repo", recommend: "accept", fixed_by: "the repair stage", ...lost }) });
  assert.match(nameOnly.md, /Recommended answer: research\./);
  const noFacts = reportFor(e, f.vfile, { diagnosis: diag({ defect: "repo", recommend: "accept", fixed_by: "abc1234", ...lost }) });
  assert.match(noFacts.md, /Recommended answer: research\./);
  const lowConfidence = reportFor(e, f.vfile, { facts, diagnosis: diag({ defect: "repo", recommend: "accept", fixed_by: "abc1234", confidence: "low", ...lost }) });
  assert.match(lowConfidence.md, /Recommended answer: research\./);
});

test("report: a corrected recommendation keeps the agent's question, or makes one from the summary", () => {
  const e = mkEnv();
  const withQ = diagnosedReport(e, diag({ defect: "repo", recommend: "accept", rescue: "needed", question: "Which stage owns the file?" }));
  assert.match(withQ.md, /Recommended answer: research\. A research run settles the cause first, because the agent placed the defect in `repo`, which `accept` does not fix\./);
  const noQ = diagnosedReport(e, diag({ confidence: "low", question: "" }));
  assert.match(noQ.md, /Recommended answer: research\./);
  assert.match(noQ.md, /Question for the research run: Find the cause of this failure and say whether its work needs rescuing: the stage changed a file outside its lane/);
});

test("report: the page prints the confidence, the answer the agent gave and its reason when a guard changed it, and the research question", () => {
  const e = mkEnv();
  const changed = diagnosedReport(e, diag({ defect: "repo", recommend: "accept", rescue: "needed", recommend_why: "The file is scratch.", confidence: "medium", question: "Which stage owns the file?" }));
  const lines = changed.md.split("\n");
  assert.match(lines[2], /^Recommended answer: research\. A research run settles the cause first, because /);
  assert.equal(lines[4], "Confidence: medium.");
  assert.equal(lines[6], "The diagnosing agent recommended `accept`: The file is scratch.");
  assert.equal(lines[8], "Question for the research run: Which stage owns the file?");
  assert.equal(lines[10], "## What happened");
  const noReason = diagnosedReport(e, diag({ defect: "repo", recommend: "accept", rescue: "needed", recommend_why: "" }));
  assert.match(noReason.md, /\nThe diagnosing agent recommended `accept`: it gave no reason\.\n/);
  const own = diagnosedReport(e, diag({ defect: "unknown", recommend: "research", question: "What wrote the file?" }));
  assert.match(own.md, /\nConfidence: high\.\n\nQuestion for the research run: What wrote the file\?\n\n## What happened/);
  assert.doesNotMatch(own.md, /The diagnosing agent recommended/);
  const kept = diagnosedReport(e, diag({ defect: "repo", recommend: "accept" }));
  assert.match(kept.md, /\nRecommended answer: accept\. The defect is in the repository\.\n\nConfidence: high\.\n\n## What happened/);
  assert.doesNotMatch(kept.md, /The diagnosing agent recommended|Question for the research run/);
});

test("handoff: a diagnosis puts what the report established, then the question or task, then the facts, after the owner's note", () => {
  const e = mkEnv();
  const { s, f, md } = diagnosedReport(e, diag());
  fs.writeFileSync(path.join(e.root, "report.md"), md);
  const dfile = path.join(e.root, "diagnosis.json");
  const note = path.join(e.root, "note.txt");
  fs.writeFileSync(note, "please look at the lane");
  const report = path.join(e.root, "report.md");
  for (const wf of ["research", "follow-up"]) {
    const r = run(e, ["handoff", "--run", s.id, "--workflow", wf, "--report", report, "--note", note, "--diagnosis", dfile]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, wf === "research" ? /^started research, run stubrun/ : /^started build, run stubrun/);
  }
  const [research, build] = calls(e, "archon", "workflow", "run").map((c) => c.argv[c.argv.length - 1]);
  for (const [msg, heading] of [[research, "## Question"], [build, "## Task"]]) {
    assert.ok(msg.startsWith("please look at the lane\n\n# Cleanup of build run "));
    const order = ["## Established by the cleanup report", heading, "## Facts"].map((h) => msg.indexOf(h));
    assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2], order.join(","));
    assert.match(msg, /The build stopped at lane_impl\./);
    assert.match(msg, /The defect is in the repo in check-lane\.sh\./);
    assert.match(msg, /- confirmed: The stage changed one file \(facts\.md, Work\)\./);
    assert.match(msg, /### Timeline/);
    assert.doesNotMatch(msg, /## What happened|## Rescue|## Evidence/);
  }
  assert.match(research, /## Question\n\nWhy did the stage leave its lane\?/);
  assert.match(build, /## Task\n\nMake the change that the report recommends\./);
  assert.ok(build.endsWith("## Scope of this run\n\nKeep the stage inside its lane."));
  void f;
});

test("handoff: a research hand-off after a corrected recommendation carries the question", () => {
  const e = mkEnv();
  const { s, md } = diagnosedReport(e, diag({ defect: "unknown", recommend: "research", question: "Is the lane list stale?", follow_up: { workflow: "", repo: "", inputs: [], note: "" } }));
  fs.writeFileSync(path.join(e.root, "report.md"), md);
  const note = path.join(e.root, "note.txt");
  fs.writeFileSync(note, "");
  const r = run(e, ["handoff", "--run", s.id, "--workflow", "research", "--report", path.join(e.root, "report.md"), "--note", note, "--diagnosis", path.join(e.root, "diagnosis.json")]);
  assert.equal(r.status, 0, r.stderr);
  const msg = calls(e, "archon", "workflow", "run")[0].argv.at(-1);
  assert.ok(msg.startsWith("# Cleanup of build run "));
  assert.match(msg, /## Question\n\nIs the lane list stale\?/);
});

test("handoff: a missing or unusable diagnosis file hands over the report as it is", () => {
  const e = mkEnv();
  const { s, vfile } = attentionRun(e, 5);
  const report = path.join(e.root, "report.md");
  run(e, ["report", "--verdict", vfile, "--out", report]);
  const note = path.join(e.root, "note.txt");
  fs.writeFileSync(note, "");
  const bad = path.join(e.root, "bad-diagnosis.json");
  fs.writeFileSync(bad, "nope");
  for (const d of [path.join(e.root, "absent.json"), bad]) {
    assert.equal(run(e, ["handoff", "--run", s.id, "--workflow", "research", "--report", report, "--note", note, "--diagnosis", d]).status, 0);
  }
  for (const c of calls(e, "archon", "workflow", "run")) {
    assert.equal(c.argv.at(-1), fs.readFileSync(report, "utf8"));
    assert.doesNotMatch(c.argv.at(-1), /Established by/);
  }
});

test("handoff: research starts from the repository with the report as it is, and follow-up needs a diagnosis that recommends one", () => {
  const e = mkEnv();
  const { s, vfile } = attentionRun(e);
  const report = path.join(e.root, "report.md");
  run(e, ["report", "--verdict", vfile, "--out", report]);
  const note = path.join(e.root, "note.txt");
  fs.writeFileSync(note, "please look at the lane");
  const r = run(e, ["handoff", "--run", s.id, "--workflow", "research", "--report", report, "--note", note]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^started research, run stubrun/);
  const [start] = calls(e, "archon", "workflow", "run");
  assert.equal(start.argv[2], "research");
  assert.equal(start.cwd, e.repo);
  const msg = start.argv.at(-1);
  assert.ok(msg.startsWith("please look at the lane"));
  assert.match(msg, /error line 100/);
  assert.doesNotMatch(msg, /error line 60\b/);
  const none = run(e, ["handoff", "--run", s.id, "--workflow", "follow-up", "--report", report, "--note", note]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /recommends no follow-up that can start/);
  assert.equal(calls(e, "archon", "workflow", "run").length, 1);
});

// A diagnosis that recommends a follow-up, a report built from it, and the files handoff reads.
function followUpEnv(e, patch) {
  const { s, f, md } = diagnosedReport(e, diag(patch));
  fs.writeFileSync(path.join(e.root, "report.md"), md);
  fs.writeFileSync(path.join(e.root, "note.txt"), "");
  const args = ["handoff", "--run", s.id, "--workflow", "follow-up", "--report", path.join(e.root, "report.md"), "--note", path.join(e.root, "note.txt"), "--diagnosis", path.join(e.root, "diagnosis.json")];
  return { s, f, md, args };
}

// A workspace under the scratch ARCHON_HOME's kit.json: `site` holds a workflow that a global
// hand-off names, `ready` passes build's start-up checks, `bare` declares nothing.
function mkWorkspace(e) {
  const ws = path.join(e.home, "workspace");
  const init = (name) => {
    const d = path.join(ws, name);
    fs.mkdirSync(d, { recursive: true });
    sh(d, "git", "init", "-q", "-b", "main");
    sh(d, "git", "config", "user.email", "t@example.com");
    sh(d, "git", "config", "user.name", "t");
    write(d, "a", "a\n");
    sh(d, "git", "add", "-A");
    sh(d, "git", "commit", "-q", "-m", "base");
    return d;
  };
  const site = init("site");
  write(site, ".archon/workflows/publish-docs/publish-docs.yaml", "");
  const ready = init("ready");
  write(ready, ".archon/gates.json", JSON.stringify({ feature: { ordered: ["true"] }, tests: { ordered: ["true"] } }));
  write(ready, ".archon/lanes.json", JSON.stringify({ tests: ["test/**"] }));
  write(ready, ".claude/settings.json", JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "node /x/lane-hook.mjs" }] }] } }));
  init("bare");
  setKit(e, { workspace: ws, handoffs: [{ workflow: "publish-docs", repo: "site", use_when: "the work changes files that the site repository publishes.", ask: [] }] });
  return { ws, site, ready };
}

test("handoff: a follow-up that names a candidate in another repository starts there, with the report as its message and no ref", () => {
  const e = mkEnv();
  const w = mkWorkspace(e);
  const { args } = followUpEnv(e, { follow_up: { workflow: "build", repo: "ready", inputs: [], note: "fix the lane list" } });
  const r = run(e, args);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^started build, run stubrun/);
  const [start] = calls(e, "archon", "workflow", "run");
  assert.equal(start.cwd, w.ready);
  assert.deepEqual(start.argv.slice(0, 3), ["workflow", "run", "build"]);
  assert.ok(!start.argv.includes("--input"));
  assert.match(start.argv.at(-1), /^# Cleanup of build run [\s\S]*## Scope of this run\n\nfix the lane list$/);
});

test("handoff: a global hand-off follow-up starts in its own repository with no ref", () => {
  const e = mkEnv();
  const w = mkWorkspace(e);
  const { args } = followUpEnv(e, { defect: "global-workflow", follow_up: { workflow: "publish-docs", repo: "", inputs: [], note: "fix the script" } });
  const r = run(e, args);
  assert.equal(r.status, 0, r.stderr);
  const [start] = calls(e, "archon", "workflow", "run");
  assert.equal(start.cwd, w.site);
  assert.equal(start.argv[2], "publish-docs");
  assert.ok(!start.argv.includes("--input"));
});

test("handoff: a follow-up in a repository that is not build-ready is dropped, and the pause recommends research", () => {
  const e = mkEnv();
  mkWorkspace(e);
  const { md, args } = followUpEnv(e, { follow_up: { workflow: "build", repo: "bare", inputs: [], note: "x" } });
  assert.match(md, /\nRecommended answer: research\./);
  assert.match(md, /cannot start \(.*build in bare: build cannot run there/);
  const r = run(e, args);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /recommends no follow-up that can start/);
  assert.equal(calls(e, "archon", "workflow", "run").length, 0);
});

test("handoff: a follow-up for a global hand-off whose workflow file is missing is dropped", () => {
  const e = mkEnv();
  const w = mkWorkspace(e);
  fs.rmSync(path.join(w.site, ".archon"), { recursive: true });
  const { md } = followUpEnv(e, { defect: "global-workflow", follow_up: { workflow: "publish-docs", repo: "", inputs: [], note: "x" } });
  assert.match(md, /\nRecommended answer: research\./);
});

// A diagnosis as a pause raised before `follow-up` existed wrote it: it recommends one workflow and
// carries a `fix` text.
const legacyDiag = (patch) => {
  const { follow_up, ...rest } = diag({ recommend: "build", ...patch });
  return { ...rest, fix: "Keep the stage inside its lane." };
};

test("handoff: the old answers, one for each workflow, still start their workflow, for a pause raised before follow-up existed", () => {
  const e = mkEnv();
  const w = mkWorkspace(e);
  const { s, md } = diagnosedReport(e, legacyDiag());
  fs.writeFileSync(path.join(e.root, "report.md"), md);
  fs.writeFileSync(path.join(e.root, "note.txt"), "go ahead");
  const args = (wf) => ["handoff", "--run", s.id, "--workflow", wf, "--report", path.join(e.root, "report.md"), "--note", path.join(e.root, "note.txt"), "--diagnosis", path.join(e.root, "diagnosis.json")];
  const build = run(e, args("build"));
  assert.equal(build.status, 0, build.stderr);
  assert.match(build.stdout, /^started build, run stubrun/);
  setKit(e, { handoffs: [{ workflow: "publish-docs", repo: "site", use_when: "x", ask: [] }] });
  write(w.site, ".archon/workflows/publish-docs/publish-docs.yaml", "");
  const ok = run(e, args("publish-docs"));
  assert.equal(ok.status, 0, ok.stderr);
  const starts = calls(e, "archon", "workflow", "run");
  assert.deepEqual(starts.map((c) => c.argv[2]), ["build", "publish-docs"]);
  assert.equal(starts[0].cwd, e.repo);
  assert.equal(starts[1].cwd, w.site);
  for (const c of starts) {
    const msg = c.argv.at(-1);
    assert.ok(msg.startsWith("go ahead\n\n# Cleanup of build run "));
    assert.ok(msg.endsWith("## Scope of this run\n\nKeep the stage inside its lane."));
  }
});

test("handoff: an old answer that names a workflow outside the candidate list is refused and starts nothing", () => {
  const e = mkEnv();
  mkWorkspace(e);
  const { s, md } = diagnosedReport(e, legacyDiag());
  fs.writeFileSync(path.join(e.root, "report.md"), md);
  fs.writeFileSync(path.join(e.root, "note.txt"), "");
  const r = run(e, ["handoff", "--run", s.id, "--workflow", "deploy-everything", "--report", path.join(e.root, "report.md"), "--note", path.join(e.root, "note.txt"), "--diagnosis", path.join(e.root, "diagnosis.json")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /deploy-everything cannot start: .*declares no such hand-off/);
  assert.equal(run(e, ["handoff", "--run", s.id, "--workflow", "../x", "--report", path.join(e.root, "report.md"), "--note", path.join(e.root, "note.txt")]).status, 2);
  assert.equal(calls(e, "archon", "workflow", "run").length, 0);
});

test("a diagnosis cached by an old pause is read as the new follow-up answer, and record accepts the old answers", () => {
  const e = mkEnv();
  mkWorkspace(e);
  const { md } = diagnosedReport(e, legacyDiag());
  assert.match(md, /\nRecommended answer: follow-up\./);
  assert.match(md, /The follow-up is `build`: Keep the stage inside its lane\./);
  for (const decision of ["build", "publish-docs"]) {
    run(e, recordArgs(e, `run-${decision}`, { state: "attention", decision, handoff: `started ${decision}, run child1\n` }));
    assert.deepEqual(actions(e, `run-${decision}`), ["answered", "handed-off"]);
  }
});

test("follow-candidates prints what research offers for the run's repository, and none when it cannot", () => {
  const e = mkEnv();
  const w = mkWorkspace(e);
  const s = scenario(e, { workflow: "build", status: "failed", work: "unsaved", events: [failedEv("plan_decision")] });
  const r = run(e, ["follow-candidates", "--run", s.id]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^build in ready — /m);
  assert.match(r.stdout, /^publish-docs — use when the work changes files that the site repository publishes\. It starts in the site repository/m);
  assert.doesNotMatch(r.stdout, /build in bare|build in site/);
  fs.rmSync(w.ws, { recursive: true });
  fs.rmSync(path.join(e.repo, ".git"), { recursive: true });
  assert.equal(run(e, ["follow-candidates", "--run", s.id]).stdout, "none\n");
});

// ---- record -------------------------------------------------------------------------------

function recordArgs(e, id, { state, decision = "none", dry = "no", handoff = "", verdict = {} }) {
  const v = path.join(e.root, `rec-v-${id.slice(0, 6)}.json`);
  fs.writeFileSync(v, JSON.stringify({ run: id, workflow: "build", failure: { signature: "build|plan_decision|node_error|boom" }, ...verdict }));
  const h = path.join(e.root, `rec-h-${id.slice(0, 6)}.txt`);
  if (handoff) fs.writeFileSync(h, handoff);
  return ["record", "--run", id, "--dry", dry, "--state", state, "--decision", decision, "--handoff", h, "--verdict", v];
}
const actions = (e, id) => ledger(e).filter((x) => x.run === id).map((x) => x.action);

test("record: a close with no answer is closed", () => {
  const e = mkEnv();
  const r = run(e, recordArgs(e, "run-close", { state: "close" }));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(actions(e, "run-close"), ["closed"]);
  assert.match(ledger(e)[0].ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
});

test("record: waiting is rescued, with the child run's id", () => {
  const e = mkEnv();
  run(e, recordArgs(e, "run-wait", { state: "waiting", verdict: { child: "child-1" } }));
  const [entry] = ledger(e);
  assert.equal(entry.action, "rescued");
  assert.equal(entry.child, "child-1");
});

test("record: an answered attention pause records the answer and its effect", () => {
  const e = mkEnv();
  run(e, recordArgs(e, "run-build", { state: "attention", decision: "follow-up", handoff: "started build, run buildrun1\n" }));
  assert.deepEqual(actions(e, "run-build"), ["answered", "handed-off"]);
  const handed = ledger(e).find((x) => x.action === "handed-off");
  assert.equal(handed.child, "buildrun1");
  assert.equal(ledger(e).find((x) => x.action === "answered").signature, "build|plan_decision|node_error|boom");

  run(e, recordArgs(e, "run-accept", { state: "attention", decision: "accept" }));
  assert.deepEqual(actions(e, "run-accept"), ["answered", "accepted"]);
  run(e, recordArgs(e, "run-discard", { state: "attention", decision: "discard" }));
  assert.deepEqual(actions(e, "run-discard"), ["answered", "discarded"]);
  run(e, recordArgs(e, "run-retry", { state: "close", decision: "retry" }));
  assert.deepEqual(actions(e, "run-retry"), ["answered", "closed"]);
});

test("record: skip, dry and a dry run write nothing", () => {
  const e = mkEnv();
  for (const state of ["skip", "dry"]) assert.equal(run(e, recordArgs(e, "r1", { state })).status, 0);
  assert.equal(run(e, recordArgs(e, "r2", { state: "close", dry: "yes" })).status, 0);
  assert.deepEqual(ledger(e), []);
});

test("record: concurrent processes append whole lines", async () => {
  const e = mkEnv();
  const args = Array.from({ length: 12 }, (_, i) => recordArgs(e, `run-${String(i).padStart(2, "0")}-x`, { state: "close" }));
  const results = await Promise.all(args.map((a) => runAsync(e, a)));
  for (const r of results) assert.equal(r.code, 0, r.err);
  const raw = fs.readFileSync(e.ledgerPath, "utf8");
  assert.ok(raw.endsWith("\n"));
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 12);
  for (const l of lines) assert.equal(JSON.parse(l).action, "closed");
});

// ---- usage --------------------------------------------------------------------------------

test("usage: an unknown subcommand or missing option exits 2 and a missing run exits 1", () => {
  const e = mkEnv();
  assert.equal(run(e, ["frobnicate"]).status, 2);
  assert.equal(run(e, ["inspect"]).status, 2);
  assert.equal(run(e, ["inspect", "--run", "nope", "--dry", "no", "--state", path.join(e.root, "s"), "--out", path.join(e.root, "o")]).status, 1);
});

test("usage: a run id prefix selects a run and an ambiguous prefix is refused", () => {
  const e = mkEnv();
  const a = scenario(e, { id: "abc11111-0000-0000-0000-000000000000", workflow: "probe", status: "completed", work: "none" });
  scenario(e, { id: "abc22222-0000-0000-0000-000000000000", workflow: "probe", status: "completed", work: "none" });
  assert.equal(inspect(e, a.id.slice(0, 8)).route, "close");
  assert.equal(inspect(e, "abc").r.status, 1);
});

// ---- worktrees ----------------------------------------------------------------------------

// The pass over a project's worktrees.
const wt = (e, args, extra = {}) => run(e, args, extra);
const sweep = (e, dry = "no", extra = {}) => wt(e, ["worktrees", "--dry", dry, "--repo", e.repo], extra);

function mkWt(e, name, { commits = [], dirty = {}, detached = false } = {}) {
  const p = path.join(e.wtRoot, name);
  fs.mkdirSync(e.wtRoot, { recursive: true });
  if (detached) sh(e.repo, "git", "worktree", "add", "-q", "--detach", p, "main");
  else sh(e.repo, "git", "worktree", "add", "-q", p, "-b", name);
  for (const f of commits) commitIn(p, f, `${name} ${f}\n`, `add ${f}`);
  for (const [f, body] of Object.entries(dirty)) write(p, f, body);
  return p;
}
const landByCherryPick = (e, name) => {
  sh(e.repo, "git", "commit", "--allow-empty", "-q", "-m", "other");
  sh(e.repo, "git", "cherry-pick", `main..${name}`);
};
const startTicks = (pid) => {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
};
const lockWith = (e, p, reason) => sh(e.repo, "git", "worktree", "lock", "--reason", reason, p);
const lockClaude = (e, p, pid, start) => lockWith(e, p, `claude session x (pid ${pid} start ${start})`);
const sleeper = (cwd) => {
  const c = spawn("bash", ["-c", "sleep 300; sleep 0"], { cwd, stdio: "ignore" });
  children.push(c);
  return c;
};
const listed = (e) => sh(e.repo, "git", "worktree", "list", "--porcelain");
const wtLedger = (e, p, action) => ledger(e).filter((x) => x.run === `wt:${p}` && (!action || x.action === action));

function wtInspect(e, p, { dry = "no", ...extra } = {}) {
  const tag = crypto.randomUUID().slice(0, 6);
  const f = { state: path.join(e.root, `wt-state-${tag}.txt`), facts: path.join(e.root, `wt-facts-${tag}.md`), verdict: path.join(e.root, `wt-verdict-${tag}.json`) };
  const r = wt(e, ["wt-inspect", "--worktree", p, "--dry", dry, "--state", f.state, "--facts", f.facts, "--verdict", f.verdict], extra);
  const read = (x) => (fs.existsSync(x) ? fs.readFileSync(x, "utf8") : null);
  return { r, ...f, route: read(f.state)?.trim() ?? null, factsText: read(f.facts), verdictJson: read(f.verdict) ? JSON.parse(read(f.verdict)) : null };
}
function wtJudge(e, p, stateFile, assess, verdictFile) {
  const file = path.join(e.root, `wt-assess-${crypto.randomUUID().slice(0, 6)}.json`);
  fs.writeFileSync(file, typeof assess === "string" ? assess : JSON.stringify(assess));
  return wt(e, ["wt-judge", "--state", stateFile, "--assess", file, "--worktree", p, ...(verdictFile ? ["--verdict", verdictFile] : [])]);
}
const wtAct = (e, p, decision, { dry = "no", ...extra } = {}) => wt(e, ["wt-act", "--worktree", p, "--decision", decision, "--dry", dry], extra);

// Deleting what holds nothing.

test("worktrees: a clean worktree whose commits were cherry-picked into main is deleted with its branch", () => {
  const e = mkEnv();
  const p = mkWt(e, "cp", { commits: ["cp.txt", "cp2.txt"] });
  landByCherryPick(e, "cp");
  assert.notEqual(sh(p, "git", "rev-parse", "HEAD").trim(), sh(e.repo, "git", "rev-parse", "HEAD").trim());
  const tip = sh(p, "git", "rev-parse", "--short", "HEAD").trim();
  const r = sweep(e);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!exists(p));
  assert.ok(!branches(e).includes("cp"));
  assert.match(r.stdout, /cp\s+deleted/);
  const [d, ...rest] = wtLedger(e, p, "wt-deleted");
  assert.equal(rest.length, 0);
  assert.equal(d.detail, `cp ${tip}`);
  assert.equal(calls(e, "archon").length, 0);
});

test("worktrees: a squash-merged branch has other patches but the same files, and is deleted with its branch", () => {
  const e = mkEnv();
  const p = mkWt(e, "sq", { commits: ["a.txt", "b.txt"] });
  sh(e.repo, "git", "merge", "--squash", "sq");
  sh(e.repo, "git", "commit", "-q", "-m", "squash");
  assert.match(sh(p, "git", "cherry", "main", "HEAD"), /^\+/m);
  const r = sweep(e);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!exists(p));
  assert.ok(!branches(e).includes("sq"));
  assert.match(r.stdout, /every file it changed matches main/);
  assert.equal(wtLedger(e, p, "wt-deleted").length, 1);
});

test("worktrees: a branch that main reverted is deleted, because its files match main", () => {
  const e = mkEnv();
  const p = mkWt(e, "rv", { commits: ["rv.txt"] });
  sh(e.repo, "git", "merge", "-q", "--no-ff", "-m", "merge rv", "rv");
  sh(e.repo, "git", "revert", "--no-edit", "-m", "1", "HEAD");
  assert.equal(sweep(e).status, 0);
  assert.ok(!exists(p));
  assert.ok(!branches(e).includes("rv"));
});

test("worktrees: a detached HEAD that main contains is deleted", () => {
  const e = mkEnv();
  const p = mkWt(e, "det", { detached: true });
  const before = branches(e);
  const r = sweep(e);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!exists(p));
  assert.deepEqual(branches(e), before);
  assert.match(wtLedger(e, p, "wt-deleted")[0].detail, /^- [0-9a-f]+$/);
});

test("worktrees: content under a scratch directory of kit.json does not keep a landed worktree", () => {
  const e = mkEnv();
  setKit(e, { scratch_dirs: ["scratchpad"] });
  const p = mkWt(e, "scratch", { dirty: { "scratchpad/notes.txt": "n\n" } });
  assert.equal(sweep(e).status, 0);
  assert.ok(!exists(p));
});

test("worktrees: with no scratch_dirs, untracked content in any directory counts as uncommitted work", () => {
  const e = mkEnv();
  const p = mkWt(e, "scratch", { dirty: { "scratchpad/notes.txt": "n\n" } });
  const r = sweep(e);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(exists(p));
  assert.match(r.stdout, /assess \(1 uncommitted file\)/);
  const q = mkWt(e, "scratch-two", { dirty: { "other/notes.txt": "n\n" } });
  setKit(e, { scratch_dirs: ["scratchpad"] });
  assert.equal(sweep(e).status, 0);
  assert.ok(exists(q), "a directory kit.json does not name is not scratch");
});

// Assessing what might hold something.

test("worktrees: a dirty worktree whose commits are in main, and one with unlanded commits, are assessed and not deleted", () => {
  const e = mkEnv();
  const dirty = mkWt(e, "dirty", { dirty: { "scratch.txt": "wip\n" } });
  const ahead = mkWt(e, "ahead", { commits: ["ahead.txt"] });
  const r = sweep(e);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(exists(dirty) && exists(ahead));
  assert.match(r.stdout, /dirty\s+assess \(1 uncommitted file\)/);
  assert.match(r.stdout, /ahead\s+assess \(1 unlanded commit\)/);
  const starts = calls(e, "archon", "workflow", "run");
  assert.equal(starts.length, 2);
  for (const s of starts) {
    assert.equal(s.argv[2], "workflow-cleanup");
    assert.equal(s.cwd, e.repo);
    assert.ok(s.argv.includes("dry=no"));
  }
  assert.deepEqual(starts.map((s) => s.argv.find((a) => a.startsWith("worktree="))).sort(), [`worktree=${ahead}`, `worktree=${dirty}`].sort());
  const queued = ledger(e).filter((x) => x.action === "wt-queued");
  assert.deepEqual(queued.map((x) => x.run).sort(), [`wt:${ahead}`, `wt:${dirty}`].sort());
  assert.ok(queued.every((x) => /^stubrun/.test(x.child)));
});

test("worktrees: a detached HEAD with commits main lacks is assessed", () => {
  const e = mkEnv();
  const p = mkWt(e, "det", { detached: true });
  commitIn(p, "det.txt");
  const r = sweep(e);
  assert.match(r.stdout, /det\s+assess/);
  assert.equal(calls(e, "archon", "workflow", "run").length, 1);
});

test("worktrees: four worktrees to assess start three runs, and the fourth waits for the next sweep", () => {
  const e = mkEnv();
  for (const n of ["a", "b", "c", "d"]) mkWt(e, n, { commits: [`${n}.txt`] });
  const r = sweep(e);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(calls(e, "archon", "workflow", "run").length, 3);
  assert.equal(ledger(e).filter((x) => x.action === "wt-queued").length, 3);
  assert.match(r.stdout, /not started, 3 per sweep/);
});

// Leaving alone what is in use.

const IN_USE = [
  ["a process works inside it", (e, p) => sleeper(p), /ignore: in use \(process \d+ works inside it\)/, NEEDS_CWDS],
  [
    "a live Claude session holds its lock",
    (e, p) => {
      const c = sleeper(e.root);
      lockClaude(e, p, c.pid, startTicks(c.pid));
    },
    /ignore: in use \(a live Claude session holds its lock\)/,
    NEEDS_PROC,
  ],
  ["its lock has another reason", (e, p) => lockWith(e, p, "manual hold"), /ignore: locked \(manual hold\)/],
  ["a live run owns it", (e, p) => addRun(e, { workflow: "build", status: "running", owner: aliveOwner(), path: p }), /ignore: in use \(run \w+ is working or paused\)/],
  ["a run with no verdict owns it", (e, p) => addRun(e, { workflow: "build", status: "completed", path: p, events: done("sync_cycle") }), /ignore: in use \(run \w+ has no verdict yet\)/],
];
for (const [name, setup, pattern, needs] of IN_USE) {
  test(`worktrees: a clean worktree in main stays when ${name}`, needs ?? {}, () => {
    const e = mkEnv();
    const p = mkWt(e, "busy");
    setup(e, p);
    const r = sweep(e);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(exists(p));
    assert.match(r.stdout, pattern);
    assert.deepEqual(ledger(e), []);
    assert.equal(calls(e, "archon").length, 0);
  });
}

test("worktrees: age decides nothing, so a worktree made a moment ago is deleted and a dirty one edited a moment ago is assessed", () => {
  const e = mkEnv();
  const fresh = mkWt(e, "fresh");
  const edited = mkWt(e, "edited", { dirty: { "scratch.txt": "wip\n" } });
  const r = sweep(e);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!exists(fresh));
  assert.ok(exists(edited));
  assert.match(r.stdout, /edited\s+assess/);
});

test("worktrees: a Claude lock whose process is gone is removed, and the clean worktree in main is deleted", NEEDS_PROC, () => {
  const e = mkEnv();
  const p = mkWt(e, "stale");
  lockClaude(e, p, deadOwner().pid, "12345");
  const r = sweep(e);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!exists(p));
  assert.ok(!listed(e).includes("stale"));
  assert.equal(wtLedger(e, p, "wt-deleted").length, 1);
});

test("worktrees: a Claude lock whose pid was reused by another process counts as gone", NEEDS_PROC, () => {
  const e = mkEnv();
  const p = mkWt(e, "reused");
  const c = sleeper(e.root);
  lockClaude(e, p, c.pid, String(Number(startTicks(c.pid)) + 1));
  assert.equal(sweep(e).status, 0);
  assert.ok(!exists(p));
});

test("the program finds procinfo.py through a link to it when its own directory lacks the module", () => {
  const bare = mkdtemp("wc-bare-");
  fs.symlinkSync(SCRIPT, path.join(bare, "workflow-cleanup.py"));
  assert.ok(!exists(path.join(bare, "procinfo.py")));
  const r = spawnSync("python3", ["-I", path.join(bare, "workflow-cleanup.py"), "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /usage: workflow-cleanup\.py/);
});

// Where /proc does not exist the program asks ps and lsof, and where those fail too it says it
// cannot tell. Cannot tell never means dead, free or stale.

test("worktrees: with no way to list the processes in a directory, a clean worktree stays and the reason says why", () => {
  const e = mkEnv();
  const p = mkWt(e, "blind");
  const r = sweep(e, "no", { KIT_PROC_BACKENDS: "none" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(exists(p));
  assert.match(r.stdout, /ignore: in use \(this system cannot show which processes work inside it\)/);
  assert.deepEqual(ledger(e), []);
  assert.equal(calls(e, "archon").length, 0);
});

test("worktrees: with no /proc, a Claude lock counts as a live session and the worktree stays locked", () => {
  const e = mkEnv();
  const p = mkWt(e, "unsure");
  lockClaude(e, p, deadOwner().pid, "12345");
  const r = sweep(e, "no", { KIT_PROC_BACKENDS: "none" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(exists(p));
  assert.match(r.stdout, /ignore: in use \(a live Claude session holds its lock\)/);
  assert.ok(listed(e).includes("unsure"));
});

// A directory of stub tools that stand in for ps and lsof, put first on the PATH.
const stubTools = (tools) => {
  const bin = mkdtemp("wc-tools-");
  for (const [name, body] of Object.entries(tools)) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
};

test("worktrees: with /proc off, the process lsof lists in a worktree keeps it", () => {
  const e = mkEnv();
  const p = mkWt(e, "busy");
  const bin = stubTools({ lsof: `printf 'p4242\\nn${p}/src\\np4243\\nn/elsewhere\\n'` });
  const r = sweep(e, "no", { KIT_PROC_BACKENDS: "lsof", PATH: `${bin}:${e.env.PATH}` });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(exists(p));
  assert.match(r.stdout, /ignore: in use \(process 4242 works inside it\)/);
});

test("worktrees: with /proc off and an lsof that lists no process in a worktree, a clean worktree is deleted", () => {
  const e = mkEnv();
  const p = mkWt(e, "idle");
  const bin = stubTools({ lsof: "printf 'p4243\\nn/elsewhere\\n'" });
  const r = sweep(e, "no", { KIT_PROC_BACKENDS: "lsof", PATH: `${bin}:${e.env.PATH}` });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!exists(p));
});

test("candidates: a run whose owner pid is another live process reads dead, and not dead where no source shows command lines", () => {
  const e = mkEnv();
  const other = sleeper(e.root);
  const s = scenario(e, { workflow: "build", status: "running", owner: { host: os.hostname(), pid: other.pid, uid: 1000 }, work: "branch", endedAgo: 3 });
  const seen = candidates(e);
  assert.equal(seen.list.find((c) => c.run === s.id)?.kind, "dead");
  const blind = candidates(e, { KIT_PROC_BACKENDS: "none" });
  assert.equal(blind.r.status, 0, blind.r.stderr);
  assert.deepEqual(blind.list, []);
});

test("candidates: with /proc off, what ps prints decides whether the owner is Archon", () => {
  const e = mkEnv();
  const run = scenario(e, { workflow: "build", status: "running", owner: aliveOwner(), work: "branch" });
  const other = stubTools({ ps: 'echo "/usr/bin/vim notes.txt"' });
  const dead = candidates(e, { KIT_PROC_BACKENDS: "ps", PATH: `${other}:${e.env.PATH}` });
  assert.equal(dead.r.status, 0, dead.r.stderr);
  assert.deepEqual(
    dead.list.map((c) => c.run),
    [run.id],
  );
  const archon = stubTools({ ps: 'echo "/usr/bin/node /opt/archon/cli.js serve"' });
  const live = candidates(e, { KIT_PROC_BACKENDS: "ps", PATH: `${archon}:${e.env.PATH}` });
  assert.deepEqual(live.list, []);
});

test("worktrees: a worktree owned by a run with a closed entry in the ledger is judged like any other", () => {
  const e = mkEnv();
  const p = mkWt(e, "closed");
  const id = addRun(e, { workflow: "build", status: "completed", path: p, events: done("sync_cycle") });
  seedLedger(e, [{ run: id, action: "closed" }]);
  assert.equal(sweep(e).status, 0);
  assert.ok(!exists(p));
});

test("worktrees: a worktree left by a finished workflow-cleanup run is not held back by that run", () => {
  const e = mkEnv();
  const p = mkWt(e, "wcleft");
  addRun(e, { workflow: "workflow-cleanup", status: "failed", path: p, events: [failedEv("cleanup")] });
  assert.equal(sweep(e).status, 0);
  assert.ok(!exists(p));
});

// What the owner declined or the agent kept.

test("worktrees: a decline for this path and branch stops the assessment", () => {
  const e = mkEnv();
  const p = mkWt(e, "declined", { commits: ["d.txt"] });
  seedLedger(e, [{ run: `wt:${p}`, action: "wt-declined", detail: "declined" }]);
  const r = sweep(e);
  assert.match(r.stdout, /ignore: declined/);
  assert.equal(calls(e, "archon").length, 0);
});

test("worktrees: a declined worktree that has landed in main is deleted", () => {
  const e = mkEnv();
  const p = mkWt(e, "declined", { commits: ["d.txt"] });
  seedLedger(e, [{ run: `wt:${p}`, action: "wt-declined", detail: "declined" }]);
  landByCherryPick(e, "declined");
  assert.equal(sweep(e).status, 0);
  assert.ok(!exists(p));
  assert.ok(!branches(e).includes("declined"));
});

test("worktrees: a decline for another branch at the same path does not cover a new branch", () => {
  const e = mkEnv();
  const p = mkWt(e, "reborn", { commits: ["r.txt"] });
  seedLedger(e, [{ run: `wt:${p}`, action: "wt-declined", detail: "an-earlier-branch" }]);
  sweep(e);
  assert.equal(calls(e, "archon", "workflow", "run").length, 1);
});

test("worktrees: an assessment of keep holds until the content changes", () => {
  const e = mkEnv();
  const p = mkWt(e, "kept", { commits: ["k.txt"] });
  const ins = wtInspect(e, p);
  assert.equal(ins.route, "assess");
  const j = wtJudge(e, p, ins.state, { verdict: "keep", reason: "adds a feature main lacks" });
  assert.equal(j.stdout.trim(), "keep");
  const r = sweep(e);
  assert.match(r.stdout, /ignore: assessed as worth keeping/);
  assert.equal(calls(e, "archon", "workflow", "run").length, 0);
  commitIn(p, "k2.txt");
  sweep(e);
  assert.equal(calls(e, "archon", "workflow", "run").length, 1);
});

test("worktrees: a run already assessing the worktree stops a second one", () => {
  const e = mkEnv();
  const p = mkWt(e, "busy", { commits: ["b.txt"] });
  addRun(e, { workflow: "workflow-cleanup", status: "paused", inputs: { worktree: p, dry: "no" } });
  const r = sweep(e);
  assert.match(r.stdout, /ignore: run \w+ is already assessing it/);
  assert.equal(calls(e, "archon", "workflow", "run").length, 0);
});

// Modes of the pass.

test("worktrees: --dry yes changes nothing, calls nothing and says what it would do", () => {
  const e = mkEnv();
  const gone = mkWt(e, "gone");
  const look = mkWt(e, "look", { commits: ["l.txt"] });
  const r = sweep(e, "yes");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gone\s+would delete/);
  assert.match(r.stdout, /look\s+would assess/);
  assert.ok(exists(gone) && exists(look));
  assert.deepEqual(stubLog(e), []);
  assert.deepEqual(ledger(e), []);
});

test("worktrees: a repository with neither main nor master is skipped without an error", () => {
  const e = mkEnv();
  sh(e.repo, "git", "branch", "-m", "main", "trunk");
  const r = sweep(e);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skipped/);
});

test("worktrees: run from a linked worktree, it finds the project's other worktrees", () => {
  const e = mkEnv();
  const here = mkWt(e, "here");
  const there = mkWt(e, "there");
  const r = spawnSync("python3", ["-I", SCRIPT, "worktrees", "--dry", "yes"], { cwd: here, encoding: "utf8", env: e.env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /there\s+would delete/);
  assert.match(r.stdout, /here\s+ignore: in use \(process/);
  assert.ok(exists(there));
});

test("worktrees: a repository without worktrees says so", () => {
  const e = mkEnv();
  const r = sweep(e);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no linked worktrees/);
});

// wt-inspect.

test("wt-inspect: skips a worktree that is gone, in use or declined", NEEDS_CWDS, () => {
  const e = mkEnv();
  assert.equal(wtInspect(e, path.join(e.wtRoot, "nowhere")).route, "skip");
  const busy = mkWt(e, "busy", { dirty: { "x.txt": "x\n" } });
  sleeper(busy);
  assert.equal(wtInspect(e, busy).route, "skip");
  const declined = mkWt(e, "declined", { dirty: { "x.txt": "x\n" } });
  seedLedger(e, [{ run: `wt:${declined}`, action: "wt-declined", detail: "declined" }]);
  const d = wtInspect(e, declined);
  assert.equal(d.route, "skip");
  assert.equal(d.factsText, null);
});

test("wt-inspect: routes delete for a clean worktree that main contains", () => {
  const e = mkEnv();
  const p = mkWt(e, "clean");
  const i = wtInspect(e, p);
  assert.equal(i.r.status, 0, i.r.stderr);
  assert.equal(i.route, "delete");
  assert.equal(i.r.stdout.trim(), "delete");
  assert.ok(exists(p));
});

test("wt-inspect: a run that is itself assessing the worktree does not count as another assessor", () => {
  const e = mkEnv();
  const p = mkWt(e, "mine", { commits: ["m.txt"] });
  const id = addRun(e, { workflow: "workflow-cleanup", status: "running", owner: aliveOwner(), inputs: { worktree: p, dry: "no" } });
  const artifacts = path.join(e.root, "artifacts", id);
  fs.mkdirSync(artifacts, { recursive: true });
  assert.equal(wtInspect(e, p).route, "skip");
  assert.equal(wtInspect(e, p, { ARTIFACTS_DIR: artifacts }).route, "assess");
});

test("wt-inspect: --dry yes routes assess to dry and writes no facts", () => {
  const e = mkEnv();
  const p = mkWt(e, "look", { commits: ["l.txt"] });
  const i = wtInspect(e, p, { dry: "yes" });
  assert.equal(i.route, "dry");
  assert.equal(i.factsText, null);
  assert.deepEqual(ledger(e), []);
});

test("wt-inspect: the facts file has each section, and labels each uncommitted file against main", () => {
  const e = mkEnv();
  const p = mkWt(e, "facts", { commits: ["f.txt"] });
  write(e.repo, "same.txt", "same\n");
  write(e.repo, "other.txt", "v1\n");
  sh(e.repo, "git", "add", "-A");
  sh(e.repo, "git", "commit", "-q", "-m", "add same and other");
  write(p, "same.txt", "same\n");
  write(p, "other.txt", "v2\n");
  write(p, "new.txt", "line one\nline two\n");
  fs.rmSync(path.join(p, "README.md"));
  lockWith(e, p, "manual hold");
  const i = wtInspect(e, p, { dry: "no" });
  assert.equal(i.r.status, 0, i.r.stderr);
  assert.equal(i.route, "skip");
  sh(e.repo, "git", "worktree", "unlock", p);
  const j = wtInspect(e, p);
  assert.equal(j.route, "assess");
  const f = j.factsText;
  assert.match(f, /- path: .*facts/);
  assert.match(f, /- branch: facts/);
  assert.match(f, /- base branch: main/);
  assert.match(f, new RegExp(`- head: ${sh(p, "git", "rev-parse", "HEAD").trim()}`));
  assert.match(f, /## Unlanded commits[^\n]*\n\n\+ [0-9a-f]+ add f\.txt/);
  assert.match(f, /## Changes since the merge-base[^\n]*\n\nf\.txt +\| 1 \+/);
  assert.match(f, /identical-to-main {2}same\.txt/);
  assert.match(f, /differs-from-main {2}other\.txt/);
  assert.match(f, /absent-in-main {2}new\.txt/);
  assert.match(f, /deleted {2}README\.md/);
  assert.match(f, /## Commits on main since the merge-base that touched these paths\n\n[0-9a-f]+ add same and other/);
  assert.match(f, /## Diff of the branch against its merge-base\n\n[^]*\+facts f\.txt/);
  assert.match(f, /## Diff of the uncommitted changes against HEAD\n\n[^]*-proj/);
  assert.match(f, /## Untracked files[^\n]*\n\n[^]*--- new\.txt\nline one\nline two/);
  assert.match(j.verdictJson.fingerprint, /^[0-9a-f]{40}$/);
  assert.equal(j.verdictJson.branch, "facts");
  assert.equal(j.verdictJson.unlanded.length, 1);
});

test("wt-inspect: a lock reason shows in the facts header", NEEDS_PROC, () => {
  const e = mkEnv();
  const p = mkWt(e, "stale", { commits: ["s.txt"] });
  lockClaude(e, p, deadOwner().pid, "12345");
  const i = wtInspect(e, p);
  assert.equal(i.route, "assess");
  assert.match(i.factsText, /- lock: claude session x \(pid \d+ start 12345\)/);
});

test("wt-inspect: caps each diff at 40 KB, each untracked sample at 4 KB and the file at 100 KB, with markers", () => {
  const e = mkEnv();
  const p = mkWt(e, "big");
  const lines = (word, n) => (word.repeat(10) + "\n").repeat(n);
  commitIn(p, "big.txt", lines("abcdefghij", 1500), "big commit");
  write(p, "more.txt", lines("klmnopqrst", 600));
  sh(p, "git", "add", "more.txt");
  for (let n = 0; n < 10; n++) write(p, `sample-${n}.txt`, "z".repeat(5000) + "\n");
  const i = wtInspect(e, p);
  assert.equal(i.route, "assess", i.r.stderr);
  const marks = i.factsText.match(/\[truncated \d+ bytes\]/g) ?? [];
  assert.ok(marks.length >= 3, `${marks.length} markers`);
  assert.ok(Buffer.byteLength(i.factsText) <= 100 * 1024 + 64, String(Buffer.byteLength(i.factsText)));
});

test("worktrees: a dirty worktree with a diff over 128 KB is assessed like any other", () => {
  const e = mkEnv();
  const p = mkWt(e, "huge", { dirty: { "huge.txt": ("abcdefghij".repeat(10) + "\n").repeat(2200) } });
  sh(p, "git", "add", "huge.txt");
  const r = sweep(e);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /huge\s+assess \(1 uncommitted file\)/);
  assert.equal(calls(e, "archon", "workflow", "run").length, 1);
});

test("worktrees: a worktree the scan leaves out is listed as ignored, with the scan's warning", () => {
  const e = mkEnv();
  const kept = mkWt(e, "kept", { commits: ["k.txt"] });
  const lost = mkWt(e, "lost");
  // A scan that drops one worktree and says so on stderr, as worktree-cleanup.sh does for an entry it cannot build.
  const script = path.join(e.home, ".archon/scripts/worktree-cleanup.sh");
  fs.renameSync(script, `${script}.real`);
  fs.writeFileSync(
    script,
    `#!/bin/bash\nif [ "$1" = scan ]; then\n  ${script}.real "$@" | jq --arg p "${lost}" 'map(select(.path != $p))'\n  echo "worktree-cleanup.sh: could not scan ${lost}, leaving it out" >&2\nelse\n  exec ${script}.real "$@"\nfi\n`,
    { mode: 0o755 },
  );
  const r = sweep(e);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /lost\s+ignore: worktree-cleanup\.sh scan did not list it\n/);
  assert.match(r.stdout, new RegExp(`scan: worktree-cleanup\\.sh: could not scan ${lost}, leaving it out`));
  assert.match(r.stdout, /kept\s+assess/);
  assert.ok(exists(lost));
});

test("wt-inspect: a cached abandon verdict routes abandon until the content changes", () => {
  const e = mkEnv();
  const p = mkWt(e, "cached", { commits: ["c.txt"] });
  const first = wtInspect(e, p);
  assert.equal(first.route, "assess");
  assert.equal(wtJudge(e, p, first.state, { verdict: "abandon", reason: "it is trivial" }).stdout.trim(), "abandon");
  const second = wtInspect(e, p);
  assert.equal(second.route, "abandon");
  assert.ok(second.factsText.includes("## Unlanded commits"));
  commitIn(p, "c2.txt");
  assert.equal(wtInspect(e, p).route, "assess");
});

// wt-judge, wt-report and wt-act.

test("wt-judge: records the verdict with the content's fingerprint and rewrites the state", () => {
  const e = mkEnv();
  const p = mkWt(e, "judged", { commits: ["j.txt"] });
  const i = wtInspect(e, p);
  const r = wtJudge(e, p, i.state, { verdict: "abandon", reason: "Main has   the same\nwork." });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "abandon");
  assert.equal(fs.readFileSync(i.state, "utf8").trim(), "abandon");
  const [entry] = wtLedger(e, p, "wt-assessed");
  assert.equal(entry.detail, "abandon Main has the same work.");
  assert.equal(entry.signature, i.verdictJson.fingerprint);
});

test("wt-judge: with --verdict, the verdict is recorded for the content the assessor read", () => {
  const e = mkEnv();
  const p = mkWt(e, "edited", { commits: ["e.txt"] });
  const i = wtInspect(e, p);
  commitIn(p, "e2.txt");
  const r = wtJudge(e, p, i.state, { verdict: "keep", reason: "adds a feature main lacks" }, i.verdict);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "keep");
  const [entry] = wtLedger(e, p, "wt-assessed");
  assert.equal(entry.signature, i.verdictJson.fingerprint);
  assert.equal(sweep(e).status, 0);
  assert.equal(calls(e, "archon", "workflow", "run").length, 1, "the edited content has not been assessed");
});

test("wt-judge: leaves a state that is not assess, and reads an unusable verdict as keep", () => {
  const e = mkEnv();
  const p = mkWt(e, "judged", { commits: ["j.txt"] });
  const st = path.join(e.root, "st.txt");
  fs.writeFileSync(st, "delete\n");
  assert.equal(wtJudge(e, p, st, "").stdout.trim(), "delete");
  assert.equal(wt(e, ["wt-judge", "--state", path.join(e.root, "missing.txt"), "--assess", path.join(e.root, "none.json"), "--worktree", ""]).stdout.trim(), "none");
  assert.deepEqual(ledger(e), []);
  for (const unusable of ["not json", { verdict: "burn", reason: "x" }, ""]) {
    fs.writeFileSync(st, "assess\n");
    assert.equal(wtJudge(e, p, st, unusable).stdout.trim(), "keep");
    assert.equal(fs.readFileSync(st, "utf8").trim(), "keep");
  }
});

test("wt-judge: a worktree that is gone by then is skipped", () => {
  const e = mkEnv();
  const st = path.join(e.root, "st.txt");
  fs.writeFileSync(st, "assess\n");
  assert.equal(wtJudge(e, path.join(e.wtRoot, "nowhere"), st, { verdict: "abandon", reason: "x" }).stdout.trim(), "skip");
  assert.deepEqual(ledger(e), []);
});

test("wt-report: writes a report with the agent's reason and prints a one-line headline", () => {
  const e = mkEnv();
  const p = mkWt(e, "reported", { commits: ["r.txt"], dirty: { "scratch.txt": "wip\n" } });
  const i = wtInspect(e, p);
  wtJudge(e, p, i.state, { verdict: "abandon", reason: "Main already has this work." });
  const out = path.join(e.root, "wt-report.md");
  const r = wt(e, ["wt-report", "--worktree", p, "--facts", i.facts, "--verdict", i.verdict, "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split("\n").length, 1);
  assert.equal(r.stdout, "Recommended: delete (the assessor found nothing worth keeping). Worktree reported (branch reported) holds 1 unlanded commit and 1 uncommitted file: Main already has this work.\n");
  const md = fs.readFileSync(out, "utf8");
  assert.match(md, /^# Worktree reported\n\nRecommended: delete \(the assessor found nothing worth keeping\)\./);
  assert.match(md, /## Why the assessor would delete it\n\nMain already has this work\./);
  assert.match(md, /## Unlanded commits\n\n```text\n\+ [0-9a-f]+ add r\.txt/);
  assert.match(md, /differs-from-main|absent-in-main/);
});

test("wt-report: lists only the files that differ from main, counts the identical ones once, and shows only the commits that touched the listed files", () => {
  const e = mkEnv();
  const p = mkWt(e, "counted", { commits: ["c.txt"] });
  commitAt(e.repo, "same.txt", "same\n", "add same", "2026-11-01T00:00:00Z");
  commitAt(e.repo, "other.txt", "v1\n", "add other", "2026-11-01T00:00:01Z");
  write(p, "same.txt", "same\n");
  write(p, "other.txt", "v2\n");
  write(p, "new.txt", "new\n");
  fs.rmSync(path.join(p, "README.md"));
  const i = wtInspect(e, p);
  assert.equal(i.route, "assess", i.r.stderr);
  wtJudge(e, p, i.state, { verdict: "abandon", reason: "Main has it." }, i.verdict);
  const out = path.join(e.root, "wt-report.md");
  const r = wt(e, ["wt-report", "--worktree", p, "--facts", i.facts, "--verdict", i.verdict, "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "Recommended: delete (the assessor found nothing worth keeping). Worktree counted (branch counted) holds 1 unlanded commit and 4 uncommitted files: Main has it.");
  const md = fs.readFileSync(out, "utf8");
  assert.match(md, /- Why it is not clean: 1 unlanded commit and 4 uncommitted files\./);
  const block = md.match(/## Uncommitted files\n\n([^]*?)\n\n## /)[1];
  assert.match(block, /^4 files in all\. 3 differ from main or are missing there, and 1 are identical to main and not listed\./);
  assert.match(block, /differs-from-main {2}other\.txt/);
  assert.match(block, /absent-in-main {2}new\.txt/);
  assert.match(block, /deleted {2}README\.md/);
  assert.doesNotMatch(block, /identical-to-main/);
  assert.equal(block.split("\n").filter((l) => /^(differs|absent|deleted)/.test(l)).length, 3);
  const commits = md.match(/## Commits on main that touched the listed files\n\n```text\n([^]*?)\n```/)[1];
  assert.match(commits, /add other/);
  assert.doesNotMatch(commits, /add same/);
  assert.match(fs.readFileSync(i.facts, "utf8"), /add same/);
});

test("wt-report: a verdict file from before the identical count still reports", () => {
  const e = mkEnv();
  const p = mkWt(e, "oldverdict", { commits: ["o.txt"], dirty: { "scratch.txt": "wip\n" } });
  const i = wtInspect(e, p);
  wtJudge(e, p, i.state, { verdict: "abandon", reason: "Trivial." }, i.verdict);
  const v = JSON.parse(fs.readFileSync(i.verdict, "utf8"));
  delete v.identical_count;
  fs.writeFileSync(i.verdict, JSON.stringify(v));
  const r = wt(e, ["wt-report", "--worktree", p, "--facts", i.facts, "--verdict", i.verdict, "--out", path.join(e.root, "o.md")]);
  assert.equal(r.status, 0, r.stderr);
});

test("wt-report: refuses a verdict file that names no worktree", () => {
  const e = mkEnv();
  const v = path.join(e.root, "v.json");
  fs.writeFileSync(v, "{}");
  assert.equal(wt(e, ["wt-report", "--worktree", e.repo, "--facts", v, "--verdict", v, "--out", path.join(e.root, "o.md")]).status, 1);
});

test("wt-act: delete saves uncommitted work, removes the worktree and branch, and prints the line that restores them", () => {
  const e = mkEnv();
  const p = mkWt(e, "doomed", { commits: ["d.txt"], dirty: { "scratch.txt": "wip\n" } });
  const r = wtAct(e, p, "delete");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!exists(p));
  assert.ok(!branches(e).includes("doomed"));
  const m = r.stdout.match(/restore with: git branch doomed ([0-9a-f]+)/);
  assert.ok(m, r.stdout);
  assert.equal(sh(e.repo, "git", "show", `${m[1]}:scratch.txt`), "wip\n");
  assert.equal(sh(e.repo, "git", "show", `${m[1]}:d.txt`), "doomed d.txt\n");
  assert.equal(wtLedger(e, p, "wt-deleted")[0].detail, `doomed ${m[1]}`);
});

test("wt-act: delete on a detached HEAD saves the work on a wip branch first", () => {
  const e = mkEnv();
  const p = mkWt(e, "det", { detached: true, dirty: { "scratch.txt": "wip\n" } });
  const r = wtAct(e, p, "delete");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!exists(p));
  const m = r.stdout.match(/restore with: git branch (wip\/workflow-cleanup-\S+) ([0-9a-f]+)/);
  assert.ok(m, r.stdout);
  assert.equal(sh(e.repo, "git", "show", `${m[2]}:scratch.txt`), "wip\n");
  assert.ok(!branches(e).includes(m[1]));
});

test("wt-act: a refusing pre-commit hook leaves the worktree and branch in place and fails", () => {
  const e = mkEnv();
  const p = mkWt(e, "kept", { commits: ["k.txt"], dirty: { "scratch.txt": "wip\n" } });
  const hooks = path.join(e.repo, ".git/hooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const r = wtAct(e, p, "delete");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not save the work/);
  assert.ok(exists(path.join(p, "scratch.txt")));
  assert.ok(branches(e).includes("kept"));
  assert.deepEqual(wtLedger(e, p), []);
});

test("wt-act: delete refuses a worktree that is in use again", NEEDS_CWDS, () => {
  const e = mkEnv();
  const p = mkWt(e, "busy", { dirty: { "scratch.txt": "wip\n" } });
  sleeper(p);
  const r = wtAct(e, p, "delete");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /in use/);
  assert.ok(exists(p));
});

test("wt-act: delete of a worktree that is already gone is not an error", () => {
  const e = mkEnv();
  const r = wtAct(e, path.join(e.wtRoot, "nowhere"), "delete");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already gone/);
});

test("wt-act: keep records the branch as declined and touches nothing", () => {
  const e = mkEnv();
  const p = mkWt(e, "kept", { commits: ["k.txt"] });
  const r = wtAct(e, p, "keep");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(exists(p));
  assert.deepEqual(wtLedger(e, p).map((x) => [x.action, x.detail]), [["wt-declined", "kept"]]);
  sweep(e);
  assert.equal(calls(e, "archon", "workflow", "run").length, 0);
});

test("wt-act: --dry yes changes and records nothing", () => {
  const e = mkEnv();
  const p = mkWt(e, "dry", { commits: ["d.txt"], dirty: { "scratch.txt": "wip\n" } });
  assert.match(wtAct(e, p, "delete", { dry: "yes" }).stdout, /would delete/);
  assert.match(wtAct(e, p, "keep", { dry: "yes" }).stdout, /would record/);
  assert.ok(exists(path.join(p, "scratch.txt")));
  assert.deepEqual(ledger(e), []);
});

test("record: the worktree mode writes nothing", () => {
  const e = mkEnv();
  assert.equal(run(e, recordArgs(e, "", { state: "worktree" })).status, 0);
  assert.deepEqual(ledger(e), []);
});

// ---- the report pages' addresses ----------------------------------------------------------------

// Runs the bash of the cleanup workflow's node `id` in the scratch repository, against the scratch
// ARCHON_HOME, whose report-base-url makes report.sh print an address. `art` is a directory named like a run id.
function pageNode(e, id, art, extraEnv = {}) {
  write(e.home, ".archon/report-base-url", "https://reports.example\n");
  fs.copyFileSync(SCRIPT, path.join(e.home, ".archon/scripts/workflow-cleanup.py"));
  return runNodeBash(CLEANUP, id, { cwd: e.repo, env: { ...e.env, ARTIFACTS_DIR: art, ...extraEnv } });
}
const runDir = (e) => {
  const art = path.join(e.root, "abcdef123456");
  fs.mkdirSync(art, { recursive: true });
  return art;
};

test("report_page names the report's directory from the diagnosis's slug and the run id", () => {
  const e = mkEnv();
  const art = runDir(e);
  write(art, "report.md", "# Cleanup of build run abc\n\nBody.\n");
  write(art, "diagnosis.json", JSON.stringify({ recommend: "accept", slug: "stale-lock-after-rebase" }));
  write(art, "verdict.json", JSON.stringify({ workflow: "build" }));
  const r = pageNode(e, "report_page", art);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "https://reports.example/proj/workflow-cleanup-stale-lock-after-rebase-abcdef/\n");
  assert.ok(fs.existsSync(path.join(e.home, ".archon/designs/proj/workflow-cleanup-stale-lock-after-rebase-abcdef/index.html")));
});

test("report_page falls back to the run's workflow name when the diagnosis has no slug or there is none", () => {
  for (const diagnosis of [{ recommend: "accept" }, null]) {
    const e = mkEnv();
    const art = runDir(e);
    write(art, "report.md", "# Cleanup\n\nBody.\n");
    write(art, "verdict.json", JSON.stringify({ workflow: "deploy-config" }));
    if (diagnosis) write(art, "diagnosis.json", JSON.stringify(diagnosis));
    const r = pageNode(e, "report_page", art);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "https://reports.example/proj/workflow-cleanup-deploy-config-abcdef/\n");
  }
});

test("report_page keeps the first address when a later call of the same run has another slug", () => {
  const e = mkEnv();
  const art = runDir(e);
  write(art, "report.md", "# Cleanup\n\nBody.\n");
  write(art, "verdict.json", JSON.stringify({ workflow: "build" }));
  write(art, "diagnosis.json", JSON.stringify({ recommend: "accept", slug: "first-name" }));
  const first = pageNode(e, "report_page", art);
  write(art, "diagnosis.json", JSON.stringify({ recommend: "retry", slug: "second-name" }));
  const second = pageNode(e, "report_page", art);
  assert.equal(first.stdout, "https://reports.example/proj/workflow-cleanup-first-name-abcdef/\n");
  assert.equal(second.stdout, first.stdout);
});

test("wt_page names the report's directory from the assessor's slug, else from the worktree's name", () => {
  for (const [assess, want] of [
    [{ verdict: "abandon", reason: "Main has it.", slug: "stale-scratch-branch" }, "workflow-cleanup-stale-scratch-branch-abcdef"],
    [{ verdict: "abandon", reason: "Main has it." }, "workflow-cleanup-reported-abcdef"],
  ]) {
    const e = mkEnv();
    const art = runDir(e);
    const p = mkWt(e, "reported", { commits: ["r.txt"], dirty: { "scratch.txt": "wip\n" } });
    const i = wt(e, ["wt-inspect", "--worktree", p, "--dry", "no", "--state", path.join(art, "wt-state.txt"), "--facts", path.join(art, "wt-facts.md"), "--verdict", path.join(art, "wt-verdict.json")]);
    assert.equal(i.status, 0, i.stderr);
    write(art, "wt-assess.json", JSON.stringify(assess));
    const r = pageNode(e, "wt_page", art, { INPUTS_WORKTREE: p });
    assert.equal(r.status, 0, r.stderr);
    const [link, headline] = r.stdout.trim().split("\n");
    assert.equal(link, `https://reports.example/proj/${want}/`);
    assert.match(headline, /^Recommended: delete/);
  }
});

// ---- a completed build with a hand-off it did not start -----------------------------------------

// A completed build that landed, whose artifacts directory holds what the run recorded. `started` is
// the handoffs-started.json content (null for none), and `output` the handoff node's stdout.
function openHandoffRun(e, { approved = [{ workflow: "deploy-staging", repo: "", inputs: [], note: "" }], started = null, output = "", endedAgo = 600, work = "landed" } = {}) {
  const id = crypto.randomUUID();
  const art = path.join(e.home, ".archon/workspaces/x/proj/artifacts/runs", id);
  fs.mkdirSync(art, { recursive: true });
  if (approved) write(art, "handoffs-approved.json", JSON.stringify(approved));
  if (started) write(art, "handoffs-started.json", JSON.stringify(started));
  const events = [...done("sync_cycle"), { type: "node_completed", step: "handoff", data: { node: { id: "handoff" }, node_output: output } }, ...done("cleanup")];
  const s = scenario(e, { id, workflow: "build", status: "completed", work, events, endedAgo });
  return s;
}

test("route: a completed build whose handoff reported did not start goes to attention and names the hand-off", () => {
  const e = mkEnv();
  const s = openHandoffRun(e, { output: "did not start deploy-staging: boom\n" });
  const { r, route, verdict } = inspect(e, s.id);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(route, "attention", JSON.stringify(verdict));
  assert.match(JSON.stringify(verdict), /deploy-staging/);
});

test("route: a completed build whose hand-offs all started closes, by the node's output or by the record", () => {
  const e = mkEnv();
  const byOutput = openHandoffRun(e, { output: "started deploy-staging, run abc\n" });
  assert.equal(inspect(e, byOutput.id).route, "close");
  const byRecord = openHandoffRun(e, { started: [{ workflow: "deploy-staging", repo: "", inputs: [], run: "abc" }] });
  assert.equal(inspect(e, byRecord.id).route, "close");
  const none = openHandoffRun(e, { approved: null });
  assert.equal(inspect(e, none.id).route, "close");
});

test("candidates: a completed build with an unstarted hand-off is listed for 14 days and not after", () => {
  const e = mkEnv();
  const recent = openHandoffRun(e, { output: "did not start deploy-staging: boom\n", endedAgo: 2 * 1440, work: "none" });
  const old = openHandoffRun(e, { output: "did not start deploy-staging: boom\n", endedAgo: 20 * 1440, work: "none" });
  const fine = openHandoffRun(e, { output: "started deploy-staging, run abc\n", endedAgo: 2 * 1440, work: "none" });
  const ids = candidates(e).list.map((c) => c.run);
  assert.ok(ids.includes(recent.id), "recent run with an open hand-off is not listed");
  assert.ok(!ids.includes(old.id), "old run is listed");
  assert.ok(!ids.includes(fine.id), "run with every hand-off started is listed");
});

test("route: a publish run that failed at run does not close, and a completed one does", () => {
  const e = mkEnv();
  const bad = scenario(e, { workflow: "publish", status: "failed", work: "none", events: [...done("resolve"), failedEv("run")] });
  assert.notEqual(inspect(e, bad.id).route, "close");
  const ok = scenario(e, { workflow: "publish", status: "completed", work: "none", events: done("resolve", "run", "verify") });
  assert.equal(inspect(e, ok.id).route, "close");
});
