import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const START = path.join(here, "..", "scripts", "start-run.sh");

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

const HANDOFFS = [
  { workflow: "deploy-staging", pass_ref: true, use_when: "the change alters deployed code" },
  { workflow: "update-config", pass_ref: true, ask: ["fragment"], use_when: "the change alters a fragment" },
  { workflow: "plain", use_when: "something else" },
];

const put = (d, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
  fs.writeFileSync(path.join(d, rel), typeof body === "string" ? body : JSON.stringify(body));
};

// What `build` checks before it starts: both gate sets, a tests lane and the lane hook.
const makeBuildReady = (d) => {
  put(d, ".archon/gates.json", { feature: { ordered: ["true"] }, tests: { ordered: ["true"] } });
  put(d, ".archon/lanes.json", { tests: ["test/**"] });
  put(d, ".claude/settings.json", { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "node /x/lane-hook.mjs" }] }] } });
};

// The global hand-off that every mkEnv writes to its kit.json. It is available only where the
// workspace holds `site/.archon/workflows/publish-docs/publish-docs.yaml` (mkWorkspace).
const GLOBAL = [{ workflow: "publish-docs", repo: "site", use_when: "the work changes files that the site repository publishes.", ask: [] }];

const CHECK_LATER = "check-later — use when the work leaves a claim that only a later look can confirm, such as that a fix held, a migration finished or a deprecation was removed. Give when as a relative time such as +7 days, which counts from when the follow-up starts, and a claim that can be checked from the repository. Inputs to supply: when, claim.";
const BUILD_HERE = /^build — use when the work changes the repository/;

// A repository whose build.json declares HANDOFFS (and that `build` can start in unless ready is
// false), and a fake `archon` that records each call in calls.log and prints a run id, or fails
// for the workflow named in FAIL.
function mkEnv(handoffs = HANDOFFS, { ready = true } = {}) {
  const root = mkdtemp("start-run-test-");
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, ".archon"), { recursive: true });
  sh(repo, "git", "init", "-q", "-b", "main");
  if (ready) makeBuildReady(repo);
  if (handoffs) fs.writeFileSync(path.join(repo, ".archon/build.json"), JSON.stringify({ handoffs }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const log = path.join(root, "calls.log");
  fs.writeFileSync(
    path.join(bin, "archon"),
    `#!/usr/bin/env bash
{ printf 'cwd=%s kit_test=%s\\n' "$PWD" "\${KIT_TEST:-}"; for a in "$@"; do printf '  arg=%s\\n' "$a"; done; } >> "${log}"
jq -cn --arg cwd "$PWD" '{cwd: $cwd, args: $ARGS.positional}' --args -- "$@" >> "${log}.jsonl"
[ "$3" != "\${FAIL:-}" ] || { echo "Error: no such workflow $3" >&2; exit 1; }
printf 'Discovery: something\\nRun id: run-%s\\n' "$3"
`,
    { mode: 0o755 },
  );
  // START_RUN_WORKSPACE points at an empty tree unless a test passes a stand-in, so the live
  // ~/workspace does not decide what `candidates` prints.
  const ws = path.join(root, "ws");
  fs.mkdirSync(ws);
  // ARCHON_HOME is a scratch directory, so the kit.json of the person running the tests does not
  // decide what the script prints.
  const home = path.join(root, "archon-home");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "kit.json"), JSON.stringify({ handoffs: GLOBAL }));
  return { root, repo, log, home, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, START_RUN_WORKSPACE: ws, ARCHON_HOME: home } };
}
const setKit = (e, value) => fs.writeFileSync(path.join(e.home, "kit.json"), JSON.stringify(value));

// A workspace of git repositories: `site` (holding the publish-docs workflow unless global is false),
// `ready`, which passes build's start-up checks, and `bare`, which declares nothing.
function mkWorkspace({ global = true } = {}) {
  const ws = mkdtemp("start-run-ws-");
  const init = (name) => {
    const d = path.join(ws, name);
    fs.mkdirSync(d);
    sh(d, "git", "init", "-q", "-b", "main");
    return d;
  };
  const site = init("site");
  if (global) put(site, ".archon/workflows/publish-docs/publish-docs.yaml", "");
  const ready = init("ready");
  makeBuildReady(ready);
  const bare = init("bare");
  return { ws, site, ready, bare };
}

const run = (e, args, extraEnv = {}, cwd = e.repo) => spawnSync("bash", [START, ...args], { cwd, encoding: "utf8", env: { ...e.env, ...extraEnv } });
const writeJson = (e, name, value) => {
  const p = path.join(e.root, name);
  fs.writeFileSync(p, JSON.stringify(value));
  return p;
};
const calls = (e) => (fs.existsSync(e.log) ? fs.readFileSync(e.log, "utf8") : "");
// Each fake-archon call as { cwd, args }, in order.
const jsonCalls = (e) => (fs.existsSync(`${e.log}.jsonl`) ? fs.readFileSync(`${e.log}.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("candidates lists each declared workflow with its use_when text and asked inputs", () => {
  const e = mkEnv();
  const r = run(e, ["candidates"]);
  assert.equal(r.status, 0);
  assert.equal(
    r.stdout,
    [
      "deploy-staging — use when the change alters deployed code. Inputs to supply: none.",
      "update-config — use when the change alters a fragment. Inputs to supply: fragment.",
      "plain — use when something else. Inputs to supply: none.",
      CHECK_LATER,
      "",
    ].join("\n"),
  );
});

test("candidates --also build lists build first and check-later last", () => {
  const e = mkEnv();
  const lines = run(e, ["candidates", "--also", "build"]).stdout.split("\n");
  assert.match(lines[0], BUILD_HERE);
  assert.match(lines[1], /^deploy-staging — /);
  assert.equal(lines[4], CHECK_LATER);
  assert.equal(lines.length, 6);
});

test("candidates --also build leaves the plain build line out where build cannot start", () => {
  const e = mkEnv(HANDOFFS, { ready: false });
  const out = run(e, ["candidates", "--also", "build"]).stdout;
  assert.doesNotMatch(out, /^build — /m);
  assert.match(out, /^deploy-staging — /m);
  assert.match(out, /^check-later — /m);
});

test("candidates --also build says build cannot change files elsewhere, and lists the repositories and workflows that can", () => {
  const e = mkEnv();
  const w = mkWorkspace();
  const out = run(e, ["candidates", "--also", "build"], { START_RUN_WORKSPACE: w.ws }).stdout;
  const lines = out.split("\n");
  assert.match(lines[0], /^build — use when the work changes the repository's own files; .*cannot change files outside this repository/);
  assert.match(out, /^build in ready — .*set repo to ready\. Inputs to supply: none\. Optional: interactive=yes, when the work cannot finish without the owner trying something and reporting back partway, such as trying a build on a device\.$/m);
  assert.doesNotMatch(out, /build in bare/);
  assert.doesNotMatch(out, /build in site/);
  assert.match(out, /^publish-docs — use when the work changes files that the site repository publishes\. It starts in the site repository, not in this one\. Inputs to supply: none\.$/m);
  const without = mkWorkspace({ global: false });
  assert.doesNotMatch(run(e, ["candidates", "--also", "build"], { START_RUN_WORKSPACE: without.ws }).stdout, /publish-docs/);
  assert.doesNotMatch(run(e, ["candidates"], { START_RUN_WORKSPACE: w.ws }).stdout, /build in|publish-docs/);
});

test("candidates --also build tells the proposer that both build lines take the optional input interactive=yes", () => {
  const e = mkEnv();
  const w = mkWorkspace();
  const lines = run(e, ["candidates", "--also", "build"], { START_RUN_WORKSPACE: w.ws }).stdout.split("\n");
  const note = "Inputs to supply: none. Optional: interactive=yes, when the work cannot finish without the owner trying something and reporting back partway, such as trying a build on a device.";
  assert.ok(lines[0].endsWith(note), lines[0]);
  const other = lines.find((l) => l.startsWith("build in ready"));
  assert.ok(other.endsWith(note), other);
  assert.doesNotMatch(lines.find((l) => l.startsWith("deploy-staging")), /interactive/);
  assert.doesNotMatch(lines.find((l) => l.startsWith("publish-docs")), /interactive/);
});

test("candidates --also build leaves the repository it runs in out of the list", () => {
  const e = mkEnv();
  const w = mkWorkspace();
  const r = run(e, ["candidates", "--also", "build"], { START_RUN_WORKSPACE: w.ws }, w.ready);
  assert.doesNotMatch(r.stdout, /build in ready/);
});

test("candidates prints only check-later for a repository that declares none, and build before it under --also", () => {
  const e = mkEnv(null);
  assert.equal(run(e, ["candidates"]).stdout, `${CHECK_LATER}\n`);
  const lines = run(e, ["candidates", "--also", "build"]).stdout.trimEnd().split("\n");
  assert.match(lines[0], BUILD_HERE);
  assert.deepEqual(lines.slice(1), [CHECK_LATER]);
});

test("candidates lists no check-later outside a git repository, and none the repository declares itself", () => {
  const e = mkEnv();
  const outside = mkdtemp("start-run-nogit-");
  assert.equal(run(e, ["candidates"], {}, outside).stdout, "");
  assert.equal(run(e, ["candidates", "--also", "build"], {}, outside).stdout, "");
  const own = mkEnv([{ workflow: "check-later", use_when: "the repository says so", ask: ["when", "claim"] }]);
  assert.equal(run(own, ["candidates"]).stdout, "check-later — use when the repository says so. Inputs to supply: when, claim.\n");
});

test("check keeps a declared entry, with its inputs and note", () => {
  const e = mkEnv();
  const p = writeJson(e, "p.json", [{ workflow: "update-config", inputs: [{ name: "fragment", value: "cfg/staging-today.json" }], note: "install it" }]);
  const r = run(e, ["check", p]);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  assert.deepEqual(JSON.parse(r.stdout), [{ workflow: "update-config", repo: "", inputs: [{ name: "fragment", value: "cfg/staging-today.json" }], note: "install it" }]);
});

test("check removes an undeclared workflow and says so on stderr", () => {
  const e = mkEnv();
  const p = writeJson(e, "p.json", [{ workflow: "rm-rf", inputs: [], note: "" }, { workflow: "deploy-staging", inputs: [], note: "" }]);
  const r = run(e, ["check", p]);
  assert.deepEqual(JSON.parse(r.stdout).map((x) => x.workflow), ["deploy-staging"]);
  assert.match(r.stderr, /dropped rm-rf: the repository declares no such hand-off/);
});

test("check removes an entry whose input names differ from the declaration's ask", () => {
  const e = mkEnv();
  const p = writeJson(e, "p.json", [
    { workflow: "deploy-staging", inputs: [{ name: "ref", value: "x" }], note: "" },
    { workflow: "update-config", inputs: [{ name: "path", value: "x" }], note: "" },
    { workflow: "update-config", inputs: [], note: "" },
  ]);
  const r = run(e, ["check", p]);
  assert.deepEqual(JSON.parse(r.stdout), []);
  assert.match(r.stderr, /dropped deploy-staging: it takes no input ref/);
  assert.match(r.stderr, /dropped update-config: it takes no input path/);
  assert.match(r.stderr, /dropped update-config: it needs the input fragment/);
});

test("check keeps build only under --also build", () => {
  const e = mkEnv();
  const p = writeJson(e, "p.json", [{ workflow: "build", inputs: [], note: "do it" }]);
  assert.deepEqual(JSON.parse(run(e, ["check", p]).stdout), []);
  assert.deepEqual(JSON.parse(run(e, ["check", "--also", "build", p]).stdout).map((x) => x.workflow), ["build"]);
});

test("check --also build keeps a build entry that carries interactive=yes, here and in another repository", () => {
  const e = mkEnv();
  const w = mkWorkspace();
  const yes = [{ name: "interactive", value: "yes" }];
  const p = writeJson(e, "p.json", [
    { workflow: "build", repo: "", inputs: yes, note: "try it here" },
    { workflow: "build", repo: "ready", inputs: yes, note: "and there" },
  ]);
  const r = run(e, ["check", "--also", "build", p], { START_RUN_WORKSPACE: w.ws });
  assert.equal(r.stderr, "");
  assert.deepEqual(JSON.parse(r.stdout), [
    { workflow: "build", repo: "", inputs: yes, note: "try it here" },
    { workflow: "build", repo: "ready", inputs: yes, note: "and there" },
  ]);
});

test("check --also build keeps a build entry with and without interactive as two entries", () => {
  const e = mkEnv();
  const p = writeJson(e, "p.json", [
    { workflow: "build", inputs: [], note: "plain" },
    { workflow: "build", inputs: [{ name: "interactive", value: "yes" }], note: "plain" },
  ]);
  assert.equal(JSON.parse(run(e, ["check", "--also", "build", p]).stdout).length, 2);
});

test("check --also build drops a build entry whose interactive is not yes, and one with any other input", () => {
  const e = mkEnv();
  const bad = (inputs) => {
    const p = writeJson(e, "p.json", [{ workflow: "build", inputs, note: "x" }]);
    return run(e, ["check", "--also", "build", p]);
  };
  for (const value of ["no", "", "true", "YES"]) {
    const r = bad([{ name: "interactive", value }]);
    assert.deepEqual(JSON.parse(r.stdout), [], value);
    assert.match(r.stderr, /start-run: dropped build: interactive must be yes/, value);
  }
  const other = bad([{ name: "deliver", value: "draft-pr" }]);
  assert.deepEqual(JSON.parse(other.stdout), []);
  assert.match(other.stderr, /dropped build: it takes no input deliver/);
  const mixed = bad([{ name: "interactive", value: "yes" }, { name: "deliver", value: "draft-pr" }]);
  assert.deepEqual(JSON.parse(mixed.stdout), []);
  assert.match(mixed.stderr, /it takes no input deliver/);
});

test("check drops interactive on a workflow other than build, and on build where build is not proposable", () => {
  const e = mkEnv();
  const yes = [{ name: "interactive", value: "yes" }];
  const p = writeJson(e, "p.json", [
    { workflow: "deploy-staging", inputs: yes, note: "" },
    { workflow: "build", inputs: yes, note: "" },
  ]);
  const r = run(e, ["check", p]);
  assert.deepEqual(JSON.parse(r.stdout), []);
  assert.match(r.stderr, /dropped deploy-staging: it takes no input interactive/);
  assert.match(r.stderr, /dropped build: the repository declares no such hand-off/);
});

test("check keeps interactive on a build that the repository declares as a hand-off", () => {
  const e = mkEnv([{ workflow: "build", use_when: "declared here", ask: [] }]);
  const p = writeJson(e, "p.json", [{ workflow: "build", inputs: [{ name: "interactive", value: "yes" }], note: "" }]);
  const r = run(e, ["check", p]);
  assert.equal(r.stderr, "");
  assert.equal(JSON.parse(r.stdout).length, 1);
});

test("check --also build keeps build in a ready repository and publish-docs, and empties repo for publish-docs", () => {
  const e = mkEnv();
  const w = mkWorkspace();
  const p = writeJson(e, "p.json", [
    { workflow: "build", repo: "ready", inputs: [], note: "in ready" },
    { workflow: "publish-docs", repo: "", inputs: [], note: "the mirror" },
    { workflow: "build", inputs: [], note: "here" },
  ]);
  const r = run(e, ["check", "--also", "build", p], { START_RUN_WORKSPACE: w.ws });
  assert.equal(r.stderr, "");
  assert.deepEqual(JSON.parse(r.stdout), [
    { workflow: "build", repo: "ready", inputs: [], note: "in ready" },
    { workflow: "publish-docs", repo: "", inputs: [], note: "the mirror" },
    { workflow: "build", repo: "", inputs: [], note: "here" },
  ]);
});

test("check --also build drops a repo that build cannot start in, a hand-off with a repo, and a repo that is a path", () => {
  const e = mkEnv();
  const w = mkWorkspace();
  const p = writeJson(e, "p.json", [
    { workflow: "build", repo: "bare", inputs: [], note: "" },
    { workflow: "deploy-staging", repo: "ready", inputs: [], note: "" },
    { workflow: "build", repo: "../x", inputs: [], note: "" },
    { workflow: "publish-docs", repo: "ready", inputs: [], note: "" },
    { workflow: "build", repo: "site", inputs: [], note: "" },
  ]);
  const r = run(e, ["check", "--also", "build", p], { START_RUN_WORKSPACE: w.ws });
  assert.deepEqual(JSON.parse(r.stdout), []);
  assert.match(r.stderr, /dropped build in bare: build cannot run there/);
  assert.match(r.stderr, /dropped deploy-staging in ready: only build runs in another repository/);
  assert.match(r.stderr, /dropped build in \.\.\/x: build cannot run there/);
  assert.match(r.stderr, /dropped publish-docs in ready: only build runs in another repository/);
  assert.match(r.stderr, /dropped build in site: build cannot run there/);
});

test("check --also build drops publish-docs when site does not hold it, and a repo name equal to this repository counts as empty", () => {
  const e = mkEnv();
  const w = mkWorkspace({ global: false });
  const p = writeJson(e, "p.json", [
    { workflow: "publish-docs", inputs: [], note: "" },
    { workflow: "build", repo: "repo", inputs: [], note: "" },
  ]);
  const r = run(e, ["check", "--also", "build", p], { START_RUN_WORKSPACE: w.ws });
  assert.deepEqual(JSON.parse(r.stdout), [{ workflow: "build", repo: "", inputs: [], note: "" }]);
  assert.match(r.stderr, /dropped publish-docs: the repository declares no such hand-off/);
});

const lateEntry = (when, claim, extra = {}) => ({
  workflow: "check-later",
  repo: "",
  inputs: [{ name: "when", value: when }, { name: "claim", value: claim }],
  note: "",
  ...extra,
});

test("check keeps a check-later that the repository does not declare, in both modes", () => {
  const e = mkEnv();
  const entry = lateEntry("+7 days", "the retry fix held");
  const p = writeJson(e, "p.json", [entry]);
  for (const args of [["check", p], ["check", "--also", "build", p]]) {
    const r = run(e, args);
    assert.equal(r.stderr, "");
    assert.deepEqual(JSON.parse(r.stdout), [entry]);
  }
  const iso = lateEntry("2099-01-01T00:00:00Z", "the migration finished");
  assert.deepEqual(JSON.parse(run(e, ["check", writeJson(e, "iso.json", [iso])]).stdout), [iso]);
});

test("check drops a check-later whose when is not a future instant", () => {
  const e = mkEnv();
  const p = writeJson(e, "p.json", [lateEntry("yesterday", "x"), lateEntry("2020-01-01T00:00:00Z", "x"), lateEntry("not a time", "x")]);
  const r = run(e, ["check", p]);
  assert.deepEqual(JSON.parse(r.stdout), []);
  assert.match(r.stderr, /dropped check-later: when "yesterday": instant .* is not in the future/);
  assert.match(r.stderr, /dropped check-later: when "2020-01-01T00:00:00Z": instant 2020-01-01T00:00:00Z is not in the future/);
  assert.match(r.stderr, /dropped check-later: when "not a time": .*invalid date/);
});

test("check drops a check-later with a missing, extra or empty input, or with a repo", () => {
  const e = mkEnv();
  const w = mkWorkspace();
  const p = writeJson(e, "p.json", [
    { workflow: "check-later", inputs: [{ name: "claim", value: "x" }], note: "" },
    { workflow: "check-later", inputs: [{ name: "when", value: "+1 day" }], note: "" },
    lateEntry("+1 day", "x", { inputs: [{ name: "when", value: "+1 day" }, { name: "claim", value: "x" }, { name: "ref", value: "abc" }] }),
    lateEntry("+1 day", "  "),
    lateEntry("", "x"),
    lateEntry("+1 day", "x", { repo: "ready" }),
  ]);
  const r = run(e, ["check", "--also", "build", p], { START_RUN_WORKSPACE: w.ws });
  assert.deepEqual(JSON.parse(r.stdout), []);
  assert.match(r.stderr, /dropped check-later: it needs the input when/);
  assert.match(r.stderr, /dropped check-later: it needs the input claim/);
  assert.match(r.stderr, /dropped check-later: it takes no input ref/);
  assert.equal((r.stderr.match(/dropped check-later: when and claim cannot be empty/g) ?? []).length, 2);
  assert.match(r.stderr, /dropped check-later in ready: only build runs in another repository/);
});

test("check drops a check-later outside a git repository", () => {
  const e = mkEnv();
  const outside = mkdtemp("start-run-nogit-");
  const r = run(e, ["check", writeJson(e, "p.json", [lateEntry("+1 day", "x")])], {}, outside);
  assert.deepEqual(JSON.parse(r.stdout), []);
  assert.match(r.stderr, /dropped check-later: the repository declares no such hand-off/);
});

test("check does not call a check-later with another claim a repeat", () => {
  const e = mkEnv();
  const p = writeJson(e, "p.json", [lateEntry("+1 day", "a"), lateEntry("+1 day", "b"), lateEntry("+1 day", "a")]);
  const r = run(e, ["check", p]);
  assert.deepEqual(JSON.parse(r.stdout).map((x) => x.inputs[1].value), ["a", "b"]);
  assert.match(r.stderr, /dropped check-later: already proposed/);
});

test("check drops a repeat of an entry and every entry past the fifth", () => {
  const e = mkEnv();
  const w = mkWorkspace();
  const entry = (workflow, extra = {}) => ({ workflow, inputs: [], note: "", ...extra });
  const p = writeJson(e, "p.json", [
    entry("build"),
    entry("build", { note: "again" }),
    entry("build", { repo: "ready" }),
    entry("publish-docs"),
    entry("deploy-staging"),
    entry("plain"),
    entry("update-config", { inputs: [{ name: "fragment", value: "a.json" }] }),
  ]);
  const r = run(e, ["check", "--also", "build", p], { START_RUN_WORKSPACE: w.ws });
  assert.deepEqual(JSON.parse(r.stdout).map((x) => `${x.workflow}:${x.repo}`), ["build:", "build:ready", "publish-docs:", "deploy-staging:", "plain:"]);
  assert.match(r.stderr, /dropped build: already proposed/);
  assert.match(r.stderr, /dropped update-config: at most five follow-ups/);
});

test("check does not call a hand-off for another fragment a repeat", () => {
  const e = mkEnv();
  const entry = (fragment) => ({ workflow: "update-config", inputs: [{ name: "fragment", value: fragment }], note: "" });
  const p = writeJson(e, "p.json", [entry("a.json"), entry("b.json"), entry("a.json")]);
  const r = run(e, ["check", p]);
  assert.deepEqual(JSON.parse(r.stdout).map((x) => x.inputs[0].value), ["a.json", "b.json"]);
  assert.match(r.stderr, /dropped update-config: already proposed/);
});

test("check prints [] for a proposal that is not an array", () => {
  const e = mkEnv();
  const p = path.join(e.root, "bad.json");
  fs.writeFileSync(p, "{not json");
  const r = run(e, ["check", p]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "[]");
  assert.match(r.stderr, /not a JSON array/);
});

test("check - reads the proposal from standard input and prints what the file form prints", () => {
  const e = mkEnv();
  const proposal = [
    { workflow: "update-config", inputs: [{ name: "fragment", value: "cfg/staging-today.json" }], note: "install it" },
    { workflow: "rm-rf", inputs: [], note: "" },
    { workflow: "deploy-staging", inputs: [{ name: "ref", value: "x" }], note: "" },
  ];
  const p = writeJson(e, "p.json", proposal);
  const fromFile = run(e, ["check", p]);
  const fromStdin = spawnSync("bash", [START, "check", "-"], { cwd: e.repo, encoding: "utf8", env: e.env, input: JSON.stringify(proposal) });
  assert.equal(fromStdin.status, 0);
  assert.equal(fromStdin.stdout, fromFile.stdout);
  assert.equal(fromStdin.stderr, fromFile.stderr);
  assert.deepEqual(JSON.parse(fromStdin.stdout).map((x) => x.workflow), ["update-config"]);
  assert.match(fromStdin.stderr, /dropped rm-rf: the repository declares no such hand-off/);
  assert.match(fromStdin.stderr, /dropped deploy-staging: it takes no input ref/);
});

test("check - prints [] and one line on stderr for empty input", () => {
  const e = mkEnv();
  const r = spawnSync("bash", [START, "check", "-"], { cwd: e.repo, encoding: "utf8", env: e.env, input: "" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "[]");
  assert.equal(r.stderr.trimEnd().split("\n").length, 1);
  assert.match(r.stderr, /not a JSON array/);
});

test("start runs each entry from the main checkout, passing ref only where declared, with run_env from kit.json set", () => {
  const e = mkEnv();
  setKit(e, { handoffs: GLOBAL, run_env: { KIT_TEST: "1" } });
  const p = writeJson(e, "c.json", [
    { workflow: "deploy-staging", inputs: [], note: "" },
    { workflow: "update-config", inputs: [{ name: "fragment", value: "cfg/staging-today.json" }], note: "install" },
    { workflow: "plain", inputs: [], note: "hello" },
  ]);
  const r = run(e, ["start", p, "abc123"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "started deploy-staging, run run-deploy-staging\nstarted update-config, run run-update-config\nstarted plain, run run-plain\n");
  const log = calls(e);
  assert.match(log, new RegExp(`cwd=${e.repo}`));
  assert.match(log, /kit_test=1/);
  assert.match(log, /arg=workflow\n {2}arg=run\n {2}arg=deploy-staging\n {2}arg=--detach\n {2}arg=--input\n {2}arg=ref=abc123\n/);
  assert.match(log, /arg=update-config\n {2}arg=--detach\n {2}arg=--input\n {2}arg=ref=abc123\n {2}arg=--input\n {2}arg=fragment=cfg\/staging-today\.json\n {2}arg=install\n/);
  assert.match(log, /arg=plain\n {2}arg=--detach\n {2}arg=hello\n/);
});

test("start passes interactive=yes to a build and adds no ref", () => {
  const e = mkEnv();
  const p = writeJson(e, "c.json", [{ workflow: "build", repo: "", inputs: [{ name: "interactive", value: "yes" }], note: "try it on the device" }]);
  const r = run(e, ["start", p, "abc123"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "started build, run run-build\n");
  assert.deepEqual(jsonCalls(e).map((c) => c.args), [["workflow", "run", "build", "--detach", "--input", "interactive=yes", "try it on the device"]]);
});

test("start uses the message file as the message and appends a note under a scope heading", () => {
  const e = mkEnv();
  const p = writeJson(e, "c.json", [
    { workflow: "plain", inputs: [], note: "only the parser" },
    { workflow: "deploy-staging", inputs: [], note: "" },
  ]);
  const msg = path.join(e.root, "brief.md");
  fs.writeFileSync(msg, "# the brief\n");
  run(e, ["start", p, "abc123", msg]);
  const sent = jsonCalls(e).map((c) => c.args.at(-1));
  assert.deepEqual(sent, ["# the brief\n\n## Scope of this run\n\nonly the parser", "# the brief"]);
});

test("start runs a publish-docs in the site repository and a build with a repo in that repository, with no ref", () => {
  const e = mkEnv();
  const w = mkWorkspace();
  const p = writeJson(e, "c.json", [
    { workflow: "publish-docs", repo: "", inputs: [], note: "the mirror" },
    { workflow: "build", repo: "ready", inputs: [], note: "the build" },
    { workflow: "update-config", repo: "", inputs: [{ name: "fragment", value: "f.json" }], note: "" },
  ]);
  const msg = path.join(e.root, "brief.md");
  fs.writeFileSync(msg, "brief text");
  const r = run(e, ["start", p, "abc123", msg], { START_RUN_WORKSPACE: w.ws });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "started publish-docs, run run-publish-docs\nstarted build, run run-build\nstarted update-config, run run-update-config\n");
  const [docsRun, build, configRun] = jsonCalls(e);
  assert.equal(docsRun.cwd, w.site);
  assert.equal(build.cwd, w.ready);
  assert.equal(configRun.cwd, e.repo);
  assert.deepEqual(docsRun.args, ["workflow", "run", "publish-docs", "--detach", "brief text\n\n## Scope of this run\n\nthe mirror"]);
  assert.deepEqual(build.args, ["workflow", "run", "build", "--detach", "brief text\n\n## Scope of this run\n\nthe build"]);
  assert.deepEqual(configRun.args, ["workflow", "run", "update-config", "--detach", "--input", "ref=abc123", "--input", "fragment=f.json", "brief text"]);
});

test("start leaves a publish-docs that the repository declares in the repository", () => {
  const e = mkEnv([{ workflow: "publish-docs", use_when: "x" }]);
  const w = mkWorkspace();
  const p = writeJson(e, "c.json", [{ workflow: "publish-docs", repo: "", inputs: [], note: "n" }]);
  run(e, ["start", p, "abc123"], { START_RUN_WORKSPACE: w.ws });
  assert.equal(jsonCalls(e)[0].cwd, e.repo);
});

test("start of a fan-out gives each run the brief and its own scope, in order", () => {
  const e = mkEnv();
  const w = mkWorkspace();
  const p = writeJson(e, "c.json", [
    { workflow: "publish-docs", repo: "", inputs: [], note: "scripts" },
    { workflow: "build", repo: "ready", inputs: [], note: "the ready part" },
    { workflow: "build", repo: "", inputs: [], note: "" },
  ]);
  const msg = path.join(e.root, "brief.md");
  fs.writeFileSync(msg, "# brief\n");
  const r = run(e, ["start", p, "abc123", msg], { START_RUN_WORKSPACE: w.ws });
  assert.equal(r.status, 0, r.stderr);
  const got = jsonCalls(e).map((c) => ({ cwd: c.cwd, workflow: c.args[2], message: c.args.at(-1) }));
  assert.deepEqual(got, [
    { cwd: w.site, workflow: "publish-docs", message: "# brief\n\n## Scope of this run\n\nscripts" },
    { cwd: w.ready, workflow: "build", message: "# brief\n\n## Scope of this run\n\nthe ready part" },
    { cwd: e.repo, workflow: "build", message: "# brief" },
  ]);
});

test("start runs a check-later here with its two inputs, no ref and no message", () => {
  const e = mkEnv();
  const p = writeJson(e, "c.json", [lateEntry("+7 days", "the retry fix held", { note: "a note that the workflow ignores" })]);
  const msg = path.join(e.root, "brief.md");
  fs.writeFileSync(msg, "# the research brief\n");
  for (const extra of [[], [msg]]) {
    fs.rmSync(`${e.log}.jsonl`, { force: true });
    const r = run(e, ["start", p, "abc123", ...extra]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "started check-later, run run-check-later\n");
    const [call] = jsonCalls(e);
    assert.equal(call.cwd, e.repo);
    assert.deepEqual(call.args, ["workflow", "run", "check-later", "--detach", "--input", "when=+7 days", "--input", "claim=the retry fix held"]);
  }
});

test("start exits 0 when an entry fails to start and carries on with the rest", () => {
  const e = mkEnv();
  const p = writeJson(e, "c.json", [{ workflow: "deploy-staging", inputs: [], note: "" }, { workflow: "plain", inputs: [], note: "" }]);
  const r = run(e, ["start", p, "abc123"], { FAIL: "deploy-staging" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^did not start deploy-staging: .*no such workflow deploy-staging/m);
  assert.match(r.stdout, /^started plain, run run-plain$/m);
});

test("start --strict exits 1 when an entry fails to start", () => {
  const e = mkEnv();
  const p = writeJson(e, "c.json", [{ workflow: "deploy-staging", inputs: [], note: "" }, { workflow: "plain", inputs: [], note: "" }]);
  const r = run(e, ["start", "--strict", p, "abc123"], { FAIL: "deploy-staging" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^started plain, run run-plain$/m);
  assert.equal(run(e, ["start", "--strict", p, "abc123"]).status, 0);
});

test("run prints the run id, and passes inputs, adopt and the message through", () => {
  const e = mkEnv();
  const r = run(e, ["run", "build", "--input", "design=x", "--adopt", "old-run", "do the work"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "run-build\n");
  assert.match(calls(e), /arg=build\n {2}arg=--detach\n {2}arg=--input\n {2}arg=design=x\n {2}arg=--adopt\n {2}arg=old-run\n {2}arg=do the work\n/);
});

test("run starts the run from the main checkout when called from a linked worktree", () => {
  const e = mkEnv();
  sh(e.repo, "git", "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const wt = path.join(e.root, "wt");
  sh(e.repo, "git", "worktree", "add", "-q", wt, "-b", "side");
  const r = run(e, ["run", "plain"], {}, wt);
  assert.equal(r.status, 0);
  assert.match(calls(e), new RegExp(`cwd=${e.repo} `));
});

test("run fails and shows archon's message when archon does not start the run", () => {
  const e = mkEnv();
  const r = run(e, ["run", "deploy-staging"], { FAIL: "deploy-staging" });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /archon did not start deploy-staging/);
});

// A commit, then the remote-tracking branches in `branches`, with origin/HEAD pointing at `head`
// when one is given: what the script can read about origin without the network.
const withOrigin = (repo, branches, head) => {
  sh(repo, "git", "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  for (const b of branches) sh(repo, "git", "update-ref", `refs/remotes/origin/${b}`, "HEAD");
  if (head) sh(repo, "git", "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${head}`);
};
const lastRun = (e) => jsonCalls(e).at(-1).args;

test("run passes the base branch that build.json names, between the other options and the message", () => {
  const e = mkEnv();
  put(e.repo, ".archon/build.json", { base: "release" });
  const id = "0a1b2c3d-0000-4000-8000-000000000000";
  const r = run(e, ["run", "build", "--input", "design=x", "do the work"], { ARTIFACTS_DIR: path.join(e.root, id) });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastRun(e), ["workflow", "run", "build", "--detach", "--input", "design=x", "--config-from-run", id, "--base", "release", "do the work"]);
});

test("run passes no --base with --adopt, because archon rejects the two together", () => {
  const e = mkEnv();
  put(e.repo, ".archon/build.json", { base: "release" });
  withOrigin(e.repo, ["main"]);
  const r = run(e, ["run", "build", "--adopt", "old-run", "do the work"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastRun(e), ["workflow", "run", "build", "--detach", "--adopt", "old-run", "do the work"]);
});

test("run passes the branch origin/HEAD names when build.json sets no base", () => {
  const e = mkEnv();
  withOrigin(e.repo, ["main", "trunk"], "trunk");
  assert.equal(run(e, ["run", "plain"]).status, 0);
  assert.deepEqual(lastRun(e), ["workflow", "run", "plain", "--detach", "--base", "trunk"]);
});

test("run prefers build.json's base over origin/HEAD", () => {
  const e = mkEnv();
  put(e.repo, ".archon/build.json", { base: "release" });
  withOrigin(e.repo, ["main", "trunk"], "trunk");
  assert.equal(run(e, ["run", "plain"]).status, 0);
  assert.deepEqual(lastRun(e), ["workflow", "run", "plain", "--detach", "--base", "release"]);
});

test("run passes main when origin has main and origin/HEAD is not set, even if origin also has master", () => {
  const e = mkEnv();
  withOrigin(e.repo, ["master", "main"]);
  assert.equal(run(e, ["run", "plain"]).status, 0);
  assert.deepEqual(lastRun(e), ["workflow", "run", "plain", "--detach", "--base", "main"]);
});

test("run passes master when origin has master and no main", () => {
  const e = mkEnv();
  withOrigin(e.repo, ["master", "feature"]);
  assert.equal(run(e, ["run", "plain"]).status, 0);
  assert.deepEqual(lastRun(e), ["workflow", "run", "plain", "--detach", "--base", "master"]);
});

test("run passes no --base when nothing local names the base branch, so archon asks the remote", () => {
  const e = mkEnv();
  withOrigin(e.repo, ["feature"]);
  assert.equal(run(e, ["run", "plain"]).status, 0);
  assert.deepEqual(lastRun(e), ["workflow", "run", "plain", "--detach"]);
});

test("run starts nothing and shows the reason when build.json is not valid JSON", () => {
  const e = mkEnv();
  put(e.repo, ".archon/build.json", "{nope");
  const r = run(e, ["run", "plain"]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /cannot read \.archon\/build\.json/);
  assert.deepEqual(jsonCalls(e), []);
});

test("start gives a hand-off in another repository that repository's base branch", () => {
  const e = mkEnv();
  const w = mkWorkspace();
  put(w.site, ".archon/build.json", { base: "docs" });
  const p = writeJson(e, "c.json", [{ workflow: "publish-docs", repo: "", inputs: [], note: "the mirror" }]);
  const r = run(e, ["start", p, "abc123"], { START_RUN_WORKSPACE: w.ws });
  assert.equal(r.status, 0, r.stderr);
  const [docsRun] = jsonCalls(e);
  assert.equal(docsRun.cwd, w.site);
  assert.deepEqual(docsRun.args, ["workflow", "run", "publish-docs", "--detach", "--base", "docs", "the mirror"]);
});

test("candidates --also build lists a global hand-off whose workflow file exists and leaves out one whose file is missing", () => {
  const e = mkEnv();
  const w = mkWorkspace();
  const out = run(e, ["candidates", "--also", "build"]).stdout;
  assert.doesNotMatch(out, /publish-docs/);
  const there = run(e, ["candidates", "--also", "build"], { START_RUN_WORKSPACE: w.ws }).stdout;
  assert.match(there, /^publish-docs — /m);
  const none = mkWorkspace({ global: false });
  assert.doesNotMatch(run(e, ["candidates", "--also", "build"], { START_RUN_WORKSPACE: none.ws }).stdout, /publish-docs/);
});

test("candidates lists a global hand-off with its asked inputs, and not the one a repository declares itself", () => {
  const e = mkEnv([{ workflow: "publish-docs", use_when: "this repository's own words" }]);
  const w = mkWorkspace();
  setKit(e, { handoffs: [...GLOBAL, { workflow: "sync-notes", repo: "site", use_when: "notes change.", ask: ["folder", "mode"] }] });
  put(w.site, ".archon/workflows/sync-notes/sync-notes.yaml", "");
  const out = run(e, ["candidates", "--also", "build"], { START_RUN_WORKSPACE: w.ws }).stdout;
  assert.equal(out.match(/^publish-docs — /gm).length, 1);
  assert.match(out, /^publish-docs — use when this repository's own words\. Inputs to supply: none\.$/m);
  assert.match(out, /^sync-notes — use when notes change\. It starts in the site repository, not in this one\. Inputs to supply: folder, mode\.$/m);
});

test("a global hand-off cannot take the name build or check-later, and an unsafe repo name is ignored", () => {
  const e = mkEnv();
  const w = mkWorkspace();
  setKit(e, {
    handoffs: [
      { workflow: "build", repo: "site", use_when: "x" },
      { workflow: "check-later", repo: "site", use_when: "x" },
      { workflow: "publish-docs", repo: "../site", use_when: "x" },
      { workflow: "publish-docs", use_when: "x" },
    ],
  });
  const r = run(e, ["candidates", "--also", "build"], { START_RUN_WORKSPACE: w.ws });
  assert.doesNotMatch(r.stdout, /It starts in/);
  assert.match(r.stderr, /ignoring the kit\.json hand-off build: that name is built in/);
});

test("a kit.json handoffs value that is not an array is ignored with one line on stderr", () => {
  const e = mkEnv();
  const w = mkWorkspace();
  setKit(e, { handoffs: "nope" });
  const r = run(e, ["candidates", "--also", "build"], { START_RUN_WORKSPACE: w.ws });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /publish-docs/);
  assert.match(r.stderr, /handoffs in kit\.json is not an array/);
});

test("check --also build accepts a global hand-off with its asked inputs only, and empties a repo that names its repository", () => {
  const e = mkEnv();
  const w = mkWorkspace();
  setKit(e, { handoffs: [{ workflow: "publish-docs", repo: "site", use_when: "x", ask: ["folder"] }] });
  const folder = [{ name: "folder", value: "docs" }];
  const p = writeJson(e, "p.json", [
    { workflow: "publish-docs", repo: "site", inputs: folder, note: "named repo" },
    { workflow: "publish-docs", repo: "", inputs: [{ name: "folder", value: "other" }, { name: "extra", value: "1" }], note: "extra input" },
    { workflow: "publish-docs", repo: "", inputs: [], note: "missing input" },
  ]);
  const r = run(e, ["check", "--also", "build", p], { START_RUN_WORKSPACE: w.ws });
  assert.deepEqual(JSON.parse(r.stdout), [{ workflow: "publish-docs", repo: "", inputs: folder, note: "named repo" }]);
  assert.match(r.stderr, /dropped publish-docs: it takes no input extra/);
  assert.match(r.stderr, /dropped publish-docs: it needs the input folder/);
});

test("check without --also build drops a global hand-off", () => {
  const e = mkEnv();
  const w = mkWorkspace();
  const p = writeJson(e, "p.json", [{ workflow: "publish-docs", inputs: [], note: "" }]);
  const r = run(e, ["check", p], { START_RUN_WORKSPACE: w.ws });
  assert.deepEqual(JSON.parse(r.stdout), []);
  assert.match(r.stderr, /dropped publish-docs: the repository declares no such hand-off/);
});

test("check lets a repository's own declaration of a hand-off win over the global one", () => {
  const e = mkEnv([{ workflow: "publish-docs", use_when: "x", ask: ["fragment"] }]);
  const w = mkWorkspace();
  const p = writeJson(e, "p.json", [
    { workflow: "publish-docs", inputs: [], note: "no input" },
    { workflow: "publish-docs", inputs: [{ name: "fragment", value: "a" }], note: "with input" },
  ]);
  const r = run(e, ["check", "--also", "build", p], { START_RUN_WORKSPACE: w.ws });
  assert.deepEqual(JSON.parse(r.stdout).map((x) => x.note), ["with input"]);
});

test("start runs a global hand-off in its own repository with no ref, even when it asks for inputs", () => {
  const e = mkEnv();
  const w = mkWorkspace();
  setKit(e, { handoffs: [{ workflow: "publish-docs", repo: "site", use_when: "x", ask: ["folder"], pass_ref: true }] });
  const p = writeJson(e, "c.json", [{ workflow: "publish-docs", repo: "", inputs: [{ name: "folder", value: "docs" }], note: "n" }]);
  const r = run(e, ["start", p, "abc123"], { START_RUN_WORKSPACE: w.ws });
  assert.equal(r.status, 0, r.stderr);
  const [call] = jsonCalls(e);
  assert.equal(call.cwd, w.site);
  assert.deepEqual(call.args, ["workflow", "run", "publish-docs", "--detach", "--input", "folder=docs", "n"]);
});

test("start does not start a global hand-off whose workflow file is missing in its repository", () => {
  const e = mkEnv();
  const w = mkWorkspace({ global: false });
  const p = writeJson(e, "c.json", [{ workflow: "publish-docs", repo: "", inputs: [], note: "n" }]);
  run(e, ["start", p, "abc123"], { START_RUN_WORKSPACE: w.ws });
  assert.equal(jsonCalls(e)[0].cwd, e.repo);
});

test("candidates --also build does not offer a sibling repository that has no feature gate set", () => {
  const e = mkEnv();
  const w = mkWorkspace();
  const out = run(e, ["candidates", "--also", "build"], { START_RUN_WORKSPACE: w.ws }).stdout;
  assert.doesNotMatch(out, /build in site/);
  assert.doesNotMatch(out, /build in bare/);
  assert.match(out, /build in ready/);
});

test("the workspace comes from kit.json when START_RUN_WORKSPACE is unset, and a leading ~ expands to HOME", () => {
  const e = mkEnv();
  const w = mkWorkspace();
  const env = { ...e.env };
  delete env.START_RUN_WORKSPACE;
  const out = (extra) => spawnSync("bash", [START, "candidates", "--also", "build"], { cwd: e.repo, encoding: "utf8", env: { ...env, ...extra } }).stdout;
  assert.doesNotMatch(out({}), /build in ready/);
  setKit(e, { workspace: w.ws, handoffs: GLOBAL });
  assert.match(out({}), /build in ready/);
  const home = mkdtemp("start-run-home-");
  fs.symlinkSync(w.ws, path.join(home, "projects"));
  setKit(e, { workspace: "~/projects", handoffs: GLOBAL });
  assert.match(out({ HOME: home }), /build in ready/);
});

test("run sets every run_env variable of kit.json for the run, and nothing else when there are none", () => {
  const e = mkEnv();
  setKit(e, { run_env: { KIT_TEST: "yes", "bad name": "x", N: 3 } });
  assert.equal(run(e, ["run", "plain"]).status, 0);
  assert.match(calls(e), /kit_test=yes/);
  fs.rmSync(e.log);
  setKit(e, {});
  run(e, ["run", "plain"]);
  assert.match(calls(e), /kit_test=\n/);
});

test("run starts with the config layer of the run named by ARTIFACTS_DIR only when its basename is a run id", () => {
  const e = mkEnv();
  const id = "0b4f6c1e-8a2d-4f7e-9c3b-5d6a7e8f9a0b";
  run(e, ["run", "plain", "msg"], { ARTIFACTS_DIR: `/somewhere/artifacts/runs/${id}` });
  assert.deepEqual(jsonCalls(e)[0].args, ["workflow", "run", "plain", "--detach", "--config-from-run", id, "msg"]);
  fs.rmSync(`${e.log}.jsonl`);
  run(e, ["run", "plain"], { ARTIFACTS_DIR: "/somewhere/artifacts/runs/not-a-uuid" });
  assert.deepEqual(jsonCalls(e)[0].args, ["workflow", "run", "plain", "--detach"]);
  fs.rmSync(`${e.log}.jsonl`);
  run(e, ["run", "plain"]);
  assert.deepEqual(jsonCalls(e)[0].args, ["workflow", "run", "plain", "--detach"]);
});

test("a kit.json that is not valid JSON stops start-run.sh with one message", () => {
  const e = mkEnv();
  fs.writeFileSync(path.join(e.home, "kit.json"), "{nope");
  const env = { ...e.env };
  delete env.START_RUN_WORKSPACE;
  const r = spawnSync("bash", [START, "candidates"], { cwd: e.repo, encoding: "utf8", env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read .*kit\.json as a JSON object/);
});

// ---- optional inputs ------------------------------------------------------------------------------

const OPTIONAL_DEPLOY = [{ workflow: "deploy-staging", pass_ref: true, optional: ["via", "region"], use_when: "the build changes what is deployed" }];

test("candidates ends a declared entry with its optional inputs", () => {
  const e = mkEnv(OPTIONAL_DEPLOY);
  const r = run(e, ["candidates"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.split("\n")[0], "deploy-staging — use when the build changes what is deployed. Inputs to supply: none. Optional: via, region.");
});

test("check keeps a hand-off that carries some, all or none of its optional inputs", () => {
  const e = mkEnv(OPTIONAL_DEPLOY);
  const inputs = (...names) => names.map((name) => ({ name, value: name === "region" ? "eu" : "cli" }));
  const p = writeJson(e, "p.json", [
    { workflow: "deploy-staging", inputs: inputs("region"), note: "" },
    { workflow: "deploy-staging", inputs: inputs("via", "region"), note: "" },
    { workflow: "deploy-staging", inputs: [], note: "" },
  ]);
  const r = run(e, ["check", p]);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  assert.deepEqual(JSON.parse(r.stdout).map((x) => x.inputs.map((i) => i.name)), [["region"], ["via", "region"], []]);
});

test("check still drops a hand-off with an input that is neither asked for nor optional", () => {
  const e = mkEnv(OPTIONAL_DEPLOY);
  const p = writeJson(e, "p.json", [{ workflow: "deploy-staging", inputs: [{ name: "fault", value: "x" }], note: "" }]);
  const r = run(e, ["check", p]);
  assert.deepEqual(JSON.parse(r.stdout), []);
  assert.match(r.stderr, /dropped deploy-staging: it takes no input fault/);
});

test("check does not let one workflow's optional inputs through on another", () => {
  const e = mkEnv([...OPTIONAL_DEPLOY, { workflow: "plain", use_when: "something else" }]);
  const p = writeJson(e, "p.json", [{ workflow: "plain", inputs: [{ name: "region", value: "eu" }], note: "" }]);
  const r = run(e, ["check", p]);
  assert.deepEqual(JSON.parse(r.stdout), []);
  assert.match(r.stderr, /dropped plain: it takes no input region/);
});

test("start passes ref first and then an optional input to a hand-off", () => {
  const e = mkEnv(OPTIONAL_DEPLOY);
  const p = writeJson(e, "c.json", [{ workflow: "deploy-staging", inputs: [{ name: "region", value: "eu" }], note: "" }]);
  const r = run(e, ["start", p, "abc123"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "started deploy-staging, run run-deploy-staging\n");
  assert.deepEqual(jsonCalls(e).map((c) => c.args), [["workflow", "run", "deploy-staging", "--detach", "--input", "ref=abc123", "--input", "region=eu"]]);
});

test("a global hand-off lists its optional inputs and accepts them, and rejects any other", () => {
  const e = mkEnv();
  const w = mkWorkspace();
  setKit(e, { handoffs: [{ workflow: "publish-docs", repo: "site", use_when: "docs change.", ask: [], optional: ["draft"] }] });
  const out = run(e, ["candidates", "--also", "build"], { START_RUN_WORKSPACE: w.ws }).stdout;
  assert.match(out, /^publish-docs — use when docs change\. It starts in the site repository, not in this one\. Inputs to supply: none\. Optional: draft\.$/m);
  const p = writeJson(e, "p.json", [
    { workflow: "publish-docs", inputs: [{ name: "draft", value: "yes" }], note: "ok" },
    { workflow: "publish-docs", inputs: [{ name: "other", value: "x" }], note: "bad" },
  ]);
  const r = run(e, ["check", "--also", "build", p], { START_RUN_WORKSPACE: w.ws });
  assert.deepEqual(JSON.parse(r.stdout).map((x) => x.note), ["ok"]);
  assert.match(r.stderr, /dropped publish-docs: it takes no input other/);
});

// ---- publish: the hand-off a repository gets from its `publish` targets ------------------------

const PUBLISH = [{ name: "docs-site", use_when: "the change alters a doc" }];
const mkPublishEnv = (handoffs) => {
  const e = mkEnv(null);
  fs.writeFileSync(path.join(e.repo, ".archon/build.json"), JSON.stringify({ publish: PUBLISH, ...(handoffs ? { handoffs } : {}) }));
  return e;
};
const publishEntry = (target) => ({ workflow: "publish", inputs: [{ name: "target", value: target }], note: "" });

test("candidates lists a publish hand-off for a repository that declares publish targets and no hand-offs", () => {
  const e = mkPublishEnv();
  const line = run(e, ["candidates"]).stdout.split("\n").find((l) => l.startsWith("publish — "));
  assert.ok(line, "no publish line");
  assert.match(line, /^publish — use when docs-site: the change alters a doc\./);
  assert.match(line, /Inputs to supply: target\.$/);
});

test("candidates adds no publish line when the repository declares publish itself, and check accepts any target", () => {
  const e = mkPublishEnv([{ workflow: "publish", use_when: "mine", ask: ["target"], pass_ref: true }]);
  const lines = run(e, ["candidates"]).stdout.split("\n").filter((l) => l.startsWith("publish — "));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^publish — use when mine/);
  const p = writeJson(e, "p.json", [publishEntry("anything")]);
  assert.deepEqual(JSON.parse(run(e, ["check", p]).stdout).map((x) => x.workflow), ["publish"]);
});

test("check drops a publish entry for a target that build.json does not declare, and keeps a declared one", () => {
  const e = mkPublishEnv();
  const bad = run(e, ["check", writeJson(e, "bad.json", [publishEntry("nope")])]);
  assert.equal(bad.status, 0);
  assert.deepEqual(JSON.parse(bad.stdout), []);
  assert.match(bad.stderr, /dropped publish: no target named nope/);
  const good = run(e, ["check", writeJson(e, "good.json", [publishEntry("docs-site")])]);
  assert.deepEqual(JSON.parse(good.stdout).map((x) => x.workflow), ["publish"]);
});

test("start passes ref and target to archon for a publish entry", () => {
  const e = mkPublishEnv();
  const p = writeJson(e, "c.json", [publishEntry("docs-site")]);
  const r = run(e, ["start", p, "abc123"], { START_RUN_RETRY_SLEEP: "0" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^started publish, run run-publish$/m);
  const args = jsonCalls(e)[0].args;
  assert.ok(args.includes("ref=abc123"), JSON.stringify(args));
  assert.ok(args.includes("target=docs-site"), JSON.stringify(args));
});

// ---- start --retries ---------------------------------------------------------------------------

// A fake `archon` that fails its first `failures` calls, then prints a run id.
const flaky = (e, failures) => {
  const counter = path.join(e.root, "count");
  fs.writeFileSync(counter, "0");
  fs.writeFileSync(
    path.join(e.root, "bin", "archon"),
    `#!/usr/bin/env bash
n=$(( $(cat "${counter}") + 1 )); echo "$n" > "${counter}"
jq -cn --arg cwd "$PWD" '{cwd: $cwd, args: $ARGS.positional}' --args -- "$@" >> "${e.log}.jsonl"
[ "$n" -gt ${failures} ] || { echo "Error: launch failed" >&2; exit 1; }
printf 'Run id: run-%s\\n' "$3"
`,
    { mode: 0o755 },
  );
};

test("start --strict --retries 3 starts an entry that fails twice and succeeds on the third try", () => {
  const e = mkEnv();
  flaky(e, 2);
  const p = writeJson(e, "c.json", [{ workflow: "plain", inputs: [], note: "" }]);
  const r = run(e, ["start", "--strict", "--retries", "3", p, "abc123"], { START_RUN_RETRY_SLEEP: "0" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^started plain, run run-plain$/m);
  assert.equal(jsonCalls(e).length, 3);
});

test("start --retries accepts its flags in either order", () => {
  const e = mkEnv();
  flaky(e, 1);
  const p = writeJson(e, "c.json", [{ workflow: "plain", inputs: [], note: "" }]);
  const r = run(e, ["start", "--retries", "2", "--strict", p, "abc123"], { START_RUN_RETRY_SLEEP: "0" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(jsonCalls(e).length, 2);
});

test("start --strict --retries 3 exits 1 and says did not start after three failed calls", () => {
  const e = mkEnv();
  const p = writeJson(e, "c.json", [{ workflow: "deploy-staging", inputs: [], note: "" }]);
  const r = run(e, ["start", "--strict", "--retries", "3", p, "abc123"], { FAIL: "deploy-staging", START_RUN_RETRY_SLEEP: "0" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^did not start deploy-staging/m);
  assert.equal(jsonCalls(e).length, 3);
});

test("start without --retries makes one call per entry", () => {
  const e = mkEnv();
  const p = writeJson(e, "c.json", [{ workflow: "deploy-staging", inputs: [], note: "" }]);
  const r = run(e, ["start", "--strict", p, "abc123"], { FAIL: "deploy-staging", START_RUN_RETRY_SLEEP: "0" });
  assert.equal(r.status, 1);
  assert.equal(jsonCalls(e).length, 1);
});
