import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(here, "..", "scripts");
const SCRIPT = path.join(SCRIPTS, "archon-dead-runs.sh");

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

const TABLES = `
create table remote_agent_workflow_runs (id text primary key, workflow_name text, status text, codebase_id text,
  working_path text, user_message text, metadata text, adopted_from_run_id text, started_at text,
  completed_at text, last_activity_at text, output_root text);
create table remote_agent_workflow_events (id text, workflow_run_id text, event_order integer, event_type text,
  step_index integer, step_name text, data text, created_at text);
create table remote_agent_workflow_event_archive (id text, workflow_run_id text, event_order integer, event_type text,
  step_index integer, step_name text, data text, created_at text);
create table remote_agent_codebases (id text primary key, name text, default_cwd text);
`;

const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

// An Archon home with a database that holds one running run for each owner given. `name` is the
// directory's own name, for the paths that need an odd one.
function mkHome(owners, name = "home") {
  const home = path.join(mkdtemp("dead-runs-"), name);
  fs.mkdirSync(home);
  const db = new DatabaseSync(path.join(home, "archon.db"));
  db.exec(TABLES);
  const ids = {};
  for (const [name, owner] of Object.entries(owners)) {
    const id = crypto.randomUUID();
    ids[name] = id;
    db.prepare(
      "insert into remote_agent_workflow_runs (id, workflow_name, status, codebase_id, working_path, user_message, metadata, started_at, last_activity_at) values (?,?,?,?,?,?,?,?,?)",
    ).run(id, "build", "running", "cb1", "/work", "", JSON.stringify({ execution_owner: owner }), now(), now());
  }
  db.close();
  return { home, ids };
}

const script = (home, args, env = {}) => {
  const e = { ...process.env, ARCHON_HOME: home, ...env };
  if (env.KIT_PROC_BACKENDS === undefined) delete e.KIT_PROC_BACKENDS;
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: e });
};
const ownerOf = (out, id) => out.split("\n").find((l) => l.startsWith(id))?.match(/ owner (\S+)/)?.[1];
const statusOf = (home, id) => {
  const db = new DatabaseSync(path.join(home, "archon.db"), { readOnly: true });
  const row = db.prepare("select status from remote_agent_workflow_runs where id = ?").get(id);
  db.close();
  return row.status;
};

// A process whose command line names archon, and one that does not. The compound command keeps
// bash from exec'ing sleep, which would drop the name from the command line.
const live = (name) => {
  const c = spawn("bash", ["-c", "sleep 300; sleep 0", ...(name ? [name] : [])], { stdio: "ignore" });
  children.push(c);
  return { host: os.hostname(), pid: c.pid, uid: 1000 };
};
const gone = () => ({ host: os.hostname(), pid: spawnSync("true").pid, uid: 1000 });

test("list reads each owner as alive, dead or unknown", () => {
  const { home, ids } = mkHome({ alive: live("archon-owner"), dead: gone(), elsewhere: { host: "another-host.example", pid: 4242, uid: 1000 }, none: {} });
  const r = script(home, ["list"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ownerOf(r.stdout, ids.alive), "alive");
  assert.equal(ownerOf(r.stdout, ids.dead), "dead");
  assert.equal(ownerOf(r.stdout, ids.elsewhere), "unknown");
  assert.equal(ownerOf(r.stdout, ids.none), "unknown");
});

test("list calls a live process that is not Archon dead, and unknown where no source shows command lines", () => {
  const { home, ids } = mkHome({ reused: live() });
  assert.equal(ownerOf(script(home, ["list"]).stdout, ids.reused), "dead");
  const blind = script(home, ["list"], { KIT_PROC_BACKENDS: "none" });
  assert.equal(blind.status, 0, blind.stderr);
  assert.equal(ownerOf(blind.stdout, ids.reused), "unknown");
});

test("mark-failed sets a dead owner's run to failed and refuses an owner it cannot read", () => {
  const { home, ids } = mkHome({ dead: gone(), reused: live() });
  const refused = script(home, ["mark-failed", ids.reused], { KIT_PROC_BACKENDS: "none" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /owner of \S+ is unknown \(pid \d+\); only a dead owner is safe to override/);
  assert.equal(statusOf(home, ids.reused), "running");
  const ok = script(home, ["mark-failed", ids.dead]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(statusOf(home, ids.dead), "failed");
});

test("the script finds procinfo.py beside it in a copied scripts directory and through a symlink", () => {
  const { home, ids } = mkHome({ alive: live("archon-owner") });
  const copy = mkdtemp("dead-runs-copy-");
  fs.cpSync(SCRIPTS, copy, { recursive: true, filter: (src) => !src.includes("__pycache__") });
  const link = path.join(mkdtemp("dead-runs-link-"), "scripts");
  fs.symlinkSync(SCRIPTS, link);
  for (const dir of [copy, link]) {
    const r = spawnSync("bash", [path.join(dir, "archon-dead-runs.sh"), "list"], { encoding: "utf8", env: { ...process.env, ARCHON_HOME: home } });
    assert.equal(r.status, 0, `${dir}: ${r.stderr}`);
    assert.equal(ownerOf(r.stdout, ids.alive), "alive", dir);
  }
});

test("the script finds procinfo.py through a link to it when its own directory lacks the module", () => {
  const { home, ids } = mkHome({ alive: live("archon-owner") });
  const bare = mkdtemp("dead-runs-bare-");
  fs.symlinkSync(SCRIPT, path.join(bare, "archon-dead-runs.sh"));
  assert.ok(!fs.existsSync(path.join(bare, "procinfo.py")));
  const r = spawnSync("bash", [path.join(bare, "archon-dead-runs.sh"), "list"], { encoding: "utf8", env: { ...process.env, ARCHON_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ownerOf(r.stdout, ids.alive), "alive");
});

test("schema passes on a complete database, and names the archive table when it is missing", () => {
  const { home } = mkHome({});
  const ok = script(home, ["schema"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "schema ok\n");
  const db = new DatabaseSync(path.join(home, "archon.db"));
  db.exec("drop table remote_agent_workflow_event_archive");
  db.close();
  const r = script(home, ["schema"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the Archon database lacks remote_agent_workflow_event_archive\.workflow_run_id, event_order, event_type, step_name, data \(.*\); these scripts were tested against Archon 0\.13\.x/);
});

test("schema names each column that was added to the check", () => {
  for (const [table, column] of [
    ["remote_agent_workflow_runs", "output_root"],
    ["remote_agent_workflow_events", "event_order"],
  ]) {
    const { home } = mkHome({});
    const db = new DatabaseSync(path.join(home, "archon.db"));
    db.exec(`alter table ${table} drop column ${column}`);
    db.close();
    const r = script(home, ["schema"]);
    assert.equal(r.status, 1, column);
    assert.match(r.stderr, new RegExp(`lacks ${table}\\.${column}`), column);
  }
});

test("the database opens from an Archon home whose path holds ?, # and %", () => {
  const { home, ids } = mkHome({ dead: gone() }, "a?b#c%25d e");
  const list = script(home, ["list"]);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(ownerOf(list.stdout, ids.dead), "dead");
  assert.equal(script(home, ["schema"]).stdout, "schema ok\n");
});

// workflow-cleanup.py and this script check the same tables, and the comment above each list says so.
test("the SCHEMA of archon-dead-runs.sh is the SCHEMA of workflow-cleanup.py", () => {
  const block = (file) => fs.readFileSync(file, "utf8").match(/^SCHEMA = (\{[\s\S]*?\n\})$/m)[1];
  const parse = (text) => JSON.parse(spawnSync("python3", ["-c", "import ast, json, sys; print(json.dumps(ast.literal_eval(sys.stdin.read())))"], { input: text, encoding: "utf8" }).stdout);
  assert.deepEqual(parse(block(SCRIPT)), parse(block(path.join(SCRIPTS, "workflow-cleanup.py"))));
});
