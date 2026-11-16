import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { kitHome } from "./kit-home.mjs";
import { nodeScript, subst } from "./node-script.mjs";
import { pathWithout } from "./path-without.mjs";

// Runs the bash of single nodes of build.yaml and research.yaml in throwaway repositories, with the
// engine's substitutions replaced by single-quoted literals, against the kit's own scripts. A
// fixture stubs a node's output and cannot run its bash, so these tests are where the bash is checked.
const here = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = path.join(here, "..", "workflows");
const BUILD = path.join(WORKFLOWS, "build", "build.yaml");
const RESEARCH = path.join(WORKFLOWS, "research", "research.yaml");
const SCRIPTS = path.join(here, "..", "scripts");

const KIT = kitHome();
const made = [];
const mkdtemp = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return fs.realpathSync(d);
};
after(() => {
  KIT.remove();
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const sh = (cwd, cmd, ...args) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = (root, rel, body = "x\n") => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const head = (root) => sh(root, "git", "rev-parse", "HEAD").trim();

// Runs a node's script in `cwd`. `vars` are the engine substitutions; `env` adds to the environment.
function runNode(file, id, { cwd, vars = {}, env = {} }) {
  const dir = mkdtemp("node-script-");
  const script = path.join(dir, `${id}.sh`);
  fs.writeFileSync(script, subst(nodeScript(file, id), vars));
  const clean = { ...process.env, ARCHON_HOME: KIT.dir, ...env };
  for (const k of Object.keys(clean)) if (clean[k] === undefined) delete clean[k];
  return spawnSync("bash", [script], { cwd, encoding: "utf8", env: clean });
}

function mkRepo() {
  const root = mkdtemp("workflow-nodes-");
  sh(root, "git", "init", "-q", "-b", "main");
  sh(root, "git", "config", "user.email", "t@example.com");
  sh(root, "git", "config", "user.name", "t");
  return root;
}
const commitAll = (root, message, ...more) => {
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", message, ...more.flatMap((m) => ["-m", m]));
};


const intakeEnv = (art, extra = {}) => ({ ARTIFACTS_DIR: art, INPUTS_DESIGN: "", ADOPTED_RUN_DIR: undefined, ...extra });
const intake = (root, art, { msg = "", name = "", env = {} } = {}) =>
  runNode(BUILD, "intake", {
    cwd: root,
    vars: { "$settings.output": "docs/designs", $ARGUMENTS: msg, "$name.output": name },
    env: intakeEnv(art, env),
  });

// A repository whose branch holds the brief commit that an earlier build run made.
function withBriefCommit(from) {
  const root = mkRepo();
  write(root, "README.md");
  commitAll(root, "base");
  write(root, "docs/designs/my-slug/brief.md", "# my brief\n");
  commitAll(root, "docs: add the my-slug brief", `Archon build run ${from}`);
  return root;
}

test("intake takes the slug from the adopted run's brief commit when the message and design are empty", () => {
  const root = withBriefCommit("run-adopted-1");
  const art = path.join(mkdtemp("artifacts-"), "run-new-2");
  fs.mkdirSync(art);
  const before = head(root);
  const r = intake(root, art, { env: { ADOPTED_RUN_DIR: "/somewhere/run-adopted-1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "my-slug\n");
  assert.equal(head(root), before);
});

test("intake fails with the usual text when nothing is adopted and there is no slug or message", () => {
  const root = withBriefCommit("run-adopted-1");
  const art = mkdtemp("artifacts-");
  const r = intake(root, art);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /build needs a design slug, or a message that states the work/);
});

test("intake names the adopted run when its branch holds no brief commit", () => {
  const root = withBriefCommit("run-other-3");
  const art = mkdtemp("artifacts-");
  const r = intake(root, art, { env: { ADOPTED_RUN_DIR: "/somewhere/run-adopted-1" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /adopted run run-adopted-1 left no brief in its artifacts and no brief commit/);
});

// A repository with one commit and an artifacts directory named like a run id, for the intake nodes
// that build a slug from a message.
function slugRepo() {
  const root = mkRepo();
  write(root, "README.md");
  commitAll(root, "base");
  const art = path.join(mkdtemp("artifacts-"), "abcdef123456");
  fs.mkdirSync(art);
  return { root, art };
}

test("intake with a message and no model name builds the slug from the message's words and the run prefix, and keeps the brief in the artifacts", () => {
  const { root, art } = slugRepo();
  const r = intake(root, art, { msg: "Fix the landing loop now please", env: { ADOPTED_RUN_DIR: "/somewhere/run-adopted-1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "fix-landing-loop-abcdef\n");
  assert.ok(fs.existsSync(path.join(art, "brief/fix-landing-loop-abcdef/brief.md")));
  assert.ok(!fs.existsSync(path.join(root, "docs/designs/fix-landing-loop-abcdef")));
  assert.equal(sh(root, "git", "log", "-1", "--format=%s").trim(), "base");
});

test("intake takes the slug from the name node's output and keeps the brief under it in the artifacts", () => {
  const { root, art } = slugRepo();
  const r = intake(root, art, { msg: "Fix the landing loop now please", name: '{"slug":"landing-loop-fix"}' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "landing-loop-fix-abcdef\n");
  assert.ok(fs.existsSync(path.join(art, "brief/landing-loop-fix-abcdef/brief.md")));
  assert.ok(!fs.existsSync(path.join(root, "docs/designs/landing-loop-fix-abcdef")));
});

test("intake falls back to the message's words when the name node was skipped, failed or named nothing", () => {
  for (const name of ["", "not json", "null", '{"slug":""}', '{"other":"x"}']) {
    const { root, art } = slugRepo();
    const r = intake(root, art, { msg: "Fix the landing loop now please", name });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.equal(r.stdout, "fix-landing-loop-abcdef\n", name);
  }
});

test("intake uses build as the last fallback when the message has no usable words", () => {
  const { root, art } = slugRepo();
  const r = intake(root, art, { msg: "is it so" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "build-abcdef\n");
});

test("intake keeps the design slug it was given, whatever the name node returned", () => {
  const { root, art } = slugRepo();
  write(root, "docs/designs/given-slug/brief.md", "# given\n");
  commitAll(root, "docs: add the given-slug brief");
  const r = intake(root, art, { msg: "Fix the landing loop", name: '{"slug":"other-name"}', env: { INPUTS_DESIGN: "given-slug" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "given-slug\n");
});

// A message's brief stays with the run: nothing is written to the worktree or committed.
test("intake writes a message's brief to the artifacts, commits nothing and leaves the worktree clean", () => {
  const { root, art } = slugRepo();
  const before = head(root);
  const msg = "Fix the landing loop now please";
  const r = intake(root, art, { msg });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "fix-landing-loop-abcdef\n");
  assert.equal(head(root), before);
  assert.equal(sh(root, "git", "status", "--porcelain"), "");
  assert.ok(!fs.existsSync(path.join(root, "docs/designs/fix-landing-loop-abcdef")));
  assert.equal(fs.readFileSync(path.join(art, "brief/fix-landing-loop-abcdef/brief.md"), "utf8"), `# ${msg}\n\n${msg}\n`);
});

test("intake cuts the brief's heading to 70 characters of the message's first line", () => {
  const { root, art } = slugRepo();
  const first = "Fix the landing loop ".repeat(6).trim();
  const r = intake(root, art, { msg: `${first}\nsecond line` });
  assert.equal(r.status, 0, r.stderr);
  const body = fs.readFileSync(path.join(art, "brief", r.stdout.trim(), "brief.md"), "utf8");
  assert.equal(body, `# ${first.slice(0, 70)}\n\n${first}\nsecond line\n`);
});

test("intake uses a committed design in place and makes no artifacts copy", () => {
  const { root, art } = slugRepo();
  write(root, "docs/designs/given/design.html");
  write(root, "docs/designs/given/mockups.mjs");
  commitAll(root, "docs: add the given design");
  const before = head(root);
  const r = intake(root, art, { msg: "ignored message", env: { INPUTS_DESIGN: "given" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "given\n");
  assert.ok(!fs.existsSync(path.join(art, "brief")));
  assert.equal(head(root), before);
  assert.equal(sh(root, "git", "status", "--porcelain"), "");
});

test("intake uses a committed brief.md in place and makes no artifacts copy", () => {
  const { root, art } = slugRepo();
  write(root, "docs/designs/given/brief.md", "# given\n");
  commitAll(root, "docs: add the given brief");
  const before = head(root);
  const r = intake(root, art, { env: { INPUTS_DESIGN: "given" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "given\n");
  assert.ok(!fs.existsSync(path.join(art, "brief")));
  assert.equal(head(root), before);
  assert.equal(sh(root, "git", "status", "--porcelain"), "");
});

test("intake fails when the slug names nothing committed and there is no message or artifacts copy", () => {
  const { root, art } = slugRepo();
  const r = intake(root, art, { env: { INPUTS_DESIGN: "nothing-here" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has no approved design/);
});

const adoptedDir = (files = {}) => {
  const dir = path.join(mkdtemp("adopted-"), "run-adopted-1");
  fs.mkdirSync(dir);
  for (const [rel, body] of Object.entries(files)) write(dir, rel, body);
  return dir;
};

test("intake takes the slug from the adopted run's artifacts and commits nothing", () => {
  const { root, art } = slugRepo();
  const adopted = adoptedDir({ "brief/from-artifacts/brief.md": "# b\n" });
  const before = head(root);
  const r = intake(root, art, { env: { ADOPTED_RUN_DIR: adopted } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "from-artifacts\n");
  assert.equal(head(root), before);
  assert.equal(sh(root, "git", "status", "--porcelain"), "");
});

test("intake takes the first of several adopted briefs in sorted order", () => {
  const { root, art } = slugRepo();
  const adopted = adoptedDir({ "brief/zeta/brief.md": "# z\n", "brief/alpha/brief.md": "# a\n" });
  const r = intake(root, art, { env: { ADOPTED_RUN_DIR: adopted } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "alpha\n");
});

test("intake prefers the adopted run's artifacts over its brief commit", () => {
  const root = withBriefCommit("run-adopted-1");
  const art = mkdtemp("artifacts-");
  const adopted = adoptedDir({ "brief/from-artifacts/brief.md": "# b\n" });
  const r = intake(root, art, { env: { ADOPTED_RUN_DIR: adopted } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "from-artifacts\n");
});

test("intake falls back to the brief commit when the adopted artifacts hold no brief", () => {
  const root = withBriefCommit("run-adopted-1");
  const art = mkdtemp("artifacts-");
  const r = intake(root, art, { env: { ADOPTED_RUN_DIR: adoptedDir() } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "my-slug\n");
});

test("intake names the adopted run when neither its artifacts nor its branch hold a brief", () => {
  const root = withBriefCommit("run-other-3");
  const art = mkdtemp("artifacts-");
  const r = intake(root, art, { env: { ADOPTED_RUN_DIR: adoptedDir() } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /adopted run run-adopted-1 left no brief/);
});

// The shots node runs the repository's shots_cmd under GNU timeout, or gtimeout where Homebrew's coreutils installed it.
test("shots runs the repository's shots_cmd under gtimeout where timeout is not installed", () => {
  const root = mkRepo();
  write(root, ".archon/build.json", { shots_cmd: "bash shot.sh" });
  write(root, "shot.sh", 'while [ $# -gt 0 ]; do [ "$1" = --out ] && out=$2; shift; done\necho png > "$out/a.png"\n');
  commitAll(root, "base");
  const bin = mkdtemp("shots-bin-");
  const log = path.join(bin, "log");
  write(bin, "gtimeout", `#!/usr/bin/env bash\necho "gtimeout $*" >> ${log}\nshift 3\nexec "$@"\n`);
  fs.chmodSync(path.join(bin, "gtimeout"), 0o755);
  const art = mkdtemp("artifacts-");
  const r = runNode(BUILD, "shots", {
    cwd: root,
    vars: { "$intake.output": "s1" },
    env: { ARTIFACTS_DIR: art, PATH: `${bin}${path.delimiter}${pathWithout("timeout", made)}` },
  });
  assert.equal(r.status, 0, r.stderr);
  const dir = spawnSync("bash", [path.join(SCRIPTS, "build-settings.sh"), "--design-dir", "s1"], { cwd: root, encoding: "utf8", env: { ...process.env, ARCHON_HOME: KIT.dir } }).stdout.trim();
  assert.equal(fs.readFileSync(path.join(dir, "built", "a.png"), "utf8"), "png\n");
  assert.match(fs.readFileSync(log, "utf8"), /^gtimeout -k 5 120 bash -c /m);
});

// The node that prints the directory holding the design or brief.
function locRepo({ committed = null, artifacts = false } = {}) {
  const root = mkRepo();
  write(root, "README.md");
  if (committed === "design") {
    write(root, "docs/designs/s1/design.html");
    write(root, "docs/designs/s1/mockups.mjs");
  }
  if (committed === "brief") write(root, "docs/designs/s1/brief.md", "# s1\n");
  commitAll(root, "base");
  const art = mkdtemp("artifacts-");
  if (artifacts) write(art, "brief/s1/brief.md", "# s1\n");
  return { root, art };
}
const location = ({ root, art }) =>
  runNode(BUILD, "brief_location", { cwd: root, vars: { "$settings.output": "docs/designs", "$intake.output": "s1" }, env: { ARTIFACTS_DIR: art } });

test("brief_location prints the committed design's directory, relative", () => {
  const r = location(locRepo({ committed: "design" }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "docs/designs/s1\n");
});

test("brief_location prints the committed brief's directory, relative", () => {
  const r = location(locRepo({ committed: "brief" }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "docs/designs/s1\n");
});

test("brief_location prints the artifacts directory when only the artifacts hold the brief", () => {
  const l = locRepo({ artifacts: true });
  const r = location(l);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${path.join(l.art, "brief/s1")}\n`);
});

test("brief_location prefers the committed directory when the artifacts hold a copy too", () => {
  const r = location(locRepo({ committed: "brief", artifacts: true }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "docs/designs/s1\n");
});

test("brief_location fails, naming the slug, when neither place holds the brief", () => {
  const r = location(locRepo());
  assert.equal(r.status, 1);
  assert.match(r.stderr, /s1/);
});

// reuse copies the adopted run's brief into the adopting run's artifacts.
function reuseRun({ brief = true } = {}) {
  const root = mkRepo();
  write(root, "README.md");
  commitAll(root, "base");
  const adopted = adoptedDir({ "plan.md": "# Plan: x\n" });
  if (brief) write(adopted, "brief/s1/brief.md", "# s1\n\nthe message\n");
  return { root, adopted };
}
const reuse = (l, art) => runNode(BUILD, "reuse", { cwd: l.root, env: { ARTIFACTS_DIR: art, ADOPTED_RUN_DIR: l.adopted } });
const stateIn = (dir, root, sha) => sh(root, "env", `ARTIFACTS_DIR=${dir}`, "bash", path.join(SCRIPTS, "state.sh"), "set", "tests-sha", sha);

test("reuse copies the adopted run's brief directory into this run's artifacts", () => {
  const l = reuseRun();
  stateIn(l.adopted, l.root, head(l.root));
  const art = mkdtemp("artifacts-");
  const r = reuse(l, art);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(art, "brief/s1/brief.md"), "utf8"), "# s1\n\nthe message\n");
});

test("reuse copies the brief into artifacts that already hold a brief directory, without nesting", () => {
  const l = reuseRun();
  stateIn(l.adopted, l.root, head(l.root));
  const art = mkdtemp("artifacts-");
  write(art, "brief/other/brief.md", "# other\n");
  const r = reuse(l, art);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(art, "brief/s1/brief.md")));
  assert.ok(fs.existsSync(path.join(art, "brief/other/brief.md")));
  assert.ok(!fs.existsSync(path.join(art, "brief/brief")));
});

test("reuse still succeeds when the adopted run holds no brief directory", () => {
  const l = reuseRun({ brief: false });
  stateIn(l.adopted, l.root, head(l.root));
  const art = mkdtemp("artifacts-");
  const r = reuse(l, art);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "reused\n");
});

const slugSource = (msg, env = {}) =>
  runNode(BUILD, "slug_source", { cwd: mkdtemp("slug-source-"), vars: { $ARGUMENTS: msg }, env: { INPUTS_DESIGN: "", ADOPTED_RUN_DIR: undefined, ...env } });

test("slug_source asks for a name when there is a message and no design or adopted run", () => {
  const r = slugSource("Fix the landing loop");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "ask\n");
  assert.equal(slugSource("Fix the landing loop", { ADOPTED_RUN_DIR: "" }).stdout, "ask\n");
});

test("slug_source says given when a design slug, an adopted run or no message is present", () => {
  assert.equal(slugSource("Fix the landing loop", { INPUTS_DESIGN: "given-slug" }).stdout, "given\n");
  assert.equal(slugSource("Fix the landing loop", { ADOPTED_RUN_DIR: "/somewhere/run-adopted-1" }).stdout, "given\n");
  assert.equal(slugSource("").stdout, "given\n");
});

// A repository whose branch `feat` conflicts with `main` on kit/x.mjs. With `resolution` null the
// rebase stays stopped at the conflict; otherwise it is resolved and finished. Returns the tip of
// `feat` before the rebase, which is also recorded as the run's `sync-pre`.
function conflicted({ resolution = null } = {}) {
  const root = mkRepo();
  write(root, ".archon/lanes.json", { protected: ["kit/**"] });
  write(root, ".archon/gates.json", { feature: { ordered: ["true"] } });
  write(root, "kit/x.mjs", "a\nb\nc\n");
  commitAll(root, "base");
  sh(root, "git", "checkout", "-q", "-b", "feat");
  write(root, "kit/x.mjs", "a\nbranch-b\nc\n");
  commitAll(root, "branch");
  const pre = head(root);
  sh(root, "git", "checkout", "-q", "main");
  write(root, "kit/x.mjs", "a\nmain-b\nc\n");
  commitAll(root, "main");
  sh(root, "git", "checkout", "-q", "feat");
  const stopped = spawnSync("git", ["rebase", "main"], { cwd: root, encoding: "utf8" });
  assert.notEqual(stopped.status, 0, "the rebase should stop at a conflict");
  if (resolution !== null) {
    write(root, "kit/x.mjs", resolution);
    sh(root, "git", "add", "kit/x.mjs");
    execFileSync("git", ["rebase", "--continue"], { cwd: root, encoding: "utf8", stdio: "pipe", env: { ...process.env, GIT_EDITOR: "true" } });
  }
  const art = mkdtemp("artifacts-");
  sh(root, "bash", path.join(SCRIPTS, "state.sh"), "set", "sync-pre", pre);
  return { root, pre, art };
}
// state.sh reads ARTIFACTS_DIR from the environment, which `sh` inherits.
const withState = (art, fn) => {
  const old = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = art;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = old;
  }
};
const mkConflict = (opts) => {
  const art = mkdtemp("artifacts-");
  return withState(art, () => ({ ...conflicted(opts), art }));
};
const gates = (c, start) =>
  runNode(BUILD, "sync_gates", {
    cwd: c.root,
    vars: { "$sync_start.output": start, "$sync_base.output": "main" },
    env: { ARTIFACTS_DIR: c.art },
  });

test("sync_gates fails the run, naming the file, when the resolver left the rebase unfinished", () => {
  const c = mkConflict();
  const r = gates(c, "conflict");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the landing loop stopped: the conflict resolver left the rebase unfinished, conflicts in: kit\/x\.mjs/);
  assert.equal(head(c.root), c.pre);
  assert.equal(sh(c.root, "git", "status", "--porcelain").trim(), "");
});

test("sync_gates fails the run when a conflict resolution wrote a line neither side had into a protected file", () => {
  const c = mkConflict({ resolution: "a\nbranch-b\ninvented line\nc\n" });
  const r = gates(c, "conflict");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the conflict resolution wrote lines that neither side had into kit\/x\.mjs/);
  assert.equal(head(c.root), c.pre);
});

test("sync_gates runs the gates after a resolution made of the branch's own lines", () => {
  const c = mkConflict({ resolution: "a\nbranch-b\nmain-b\nc\n" });
  const r = gates(c, "conflict");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "green\n");
});

test("sync_gates does not check provenance after a clean rebase", () => {
  const root = mkRepo();
  write(root, ".archon/lanes.json", { protected: ["kit/**"] });
  write(root, ".archon/gates.json", { feature: { ordered: ["true"] } });
  write(root, "kit/x.mjs", "a\n");
  write(root, "other.txt", "o\n");
  commitAll(root, "base");
  sh(root, "git", "checkout", "-q", "-b", "feat");
  write(root, "kit/x.mjs", "a\nnew line\n");
  commitAll(root, "branch");
  const pre = head(root);
  sh(root, "git", "checkout", "-q", "main");
  write(root, "other.txt", "o2\n");
  commitAll(root, "main");
  sh(root, "git", "checkout", "-q", "feat");
  sh(root, "git", "rebase", "main");
  const art = mkdtemp("artifacts-");
  withState(art, () => sh(root, "bash", path.join(SCRIPTS, "state.sh"), "set", "sync-pre", pre));
  const r = gates({ root, art }, "clean");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "green\n");
});

// A workspace of git repositories: `site` holding the publish-docs workflow (a global hand-off in the
// kit.json that mkResearchEnv writes), one repository for
// each name in `ready`, which passes build's start-up checks, and `bare`, which declares nothing.
function mkWorkspace(ready = ["ready"]) {
  const ws = mkdtemp("workflow-nodes-ws-");
  const init = (name) => {
    const d = path.join(ws, name);
    fs.mkdirSync(d);
    sh(d, "git", "init", "-q", "-b", "main");
    return d;
  };
  const site = init("site");
  write(site, ".archon/workflows/publish-docs/publish-docs.yaml", "");
  const dirs = {};
  for (const name of ready) {
    const d = init(name);
    write(d, ".archon/gates.json", { feature: { ordered: ["true"] }, tests: { ordered: ["true"] } });
    write(d, ".archon/lanes.json", { tests: ["test/**"] });
    write(d, ".claude/settings.json", { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "node /x/lane-hook.mjs" }] }] } });
    dirs[name] = d;
  }
  init("bare");
  return { ws, site, dirs };
}

// The repository the research run is in, declaring no hand-offs, with one commit so `base` resolves,
// and a fake `archon` that logs each call as { cwd, args }.
function mkResearchEnv(ready) {
  const root = mkdtemp("workflow-nodes-research-");
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  sh(repo, "git", "init", "-q", "-b", "main");
  sh(repo, "git", "config", "user.email", "t@example.com");
  sh(repo, "git", "config", "user.name", "t");
  write(repo, "README.md");
  commitAll(repo, "base");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const log = path.join(root, "calls.jsonl");
  fs.writeFileSync(
    path.join(bin, "archon"),
    `#!/usr/bin/env bash
jq -cn --arg cwd "$PWD" '{cwd: $cwd, args: $ARGS.positional}' --args -- "$@" >> "${log}"
printf 'Run id: run-%s\\n' "$3"
`,
    { mode: 0o755 },
  );
  const art = path.join(root, "artifacts");
  fs.mkdirSync(art);
  const w = mkWorkspace(ready);
  const kit = kitHome({ handoffs: [{ workflow: "publish-docs", repo: "site", use_when: "the work changes files that the site repository publishes", ask: [] }] });
  made.push(kit.dir);
  const env = { ARTIFACTS_DIR: art, START_RUN_WORKSPACE: w.ws, ARCHON_HOME: kit.dir, PATH: `${bin}:${process.env.PATH}` };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { root, repo, art, w, env, calls };
}

// A repository whose local `main` is two commits ahead of origin/main, and a detached worktree cut
// from origin/main, as Archon cuts a run's worktree. `buildJson` goes to .archon/build.json.
function mkLagging({ buildJson } = {}) {
  const root = mkRepo();
  write(root, "README.md");
  commitAll(root, "one");
  sh(root, "git", "update-ref", "refs/remotes/origin/main", "HEAD");
  if (buildJson) write(root, ".archon/build.json", buildJson);
  write(root, "two.txt");
  commitAll(root, "two");
  write(root, "three.txt");
  commitAll(root, "three");
  const wt = path.join(mkdtemp("workflow-nodes-wt-"), "wt");
  sh(root, "git", "worktree", "add", "-q", "--detach", wt, "origin/main");
  return { root, wt };
}

test("research's sync_base detaches the worktree at the local base branch when origin lags", () => {
  const { root, wt } = mkLagging();
  assert.notEqual(head(wt), head(root));
  const r = runNode(RESEARCH, "sync_base", { cwd: wt });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(head(wt), head(root));
  assert.equal(r.stdout, "main\n");
  assert.throws(() => sh(wt, "git", "symbolic-ref", "-q", "HEAD"));
});

test("research's sync_base leaves the worktree alone when the local base branch does not exist", () => {
  const { root, wt: _ } = mkLagging({ buildJson: { base: "release" } });
  const first = sh(root, "git", "rev-parse", "main~2").trim();
  sh(root, "git", "update-ref", "refs/remotes/origin/release", first);
  const wt = path.join(mkdtemp("workflow-nodes-wt-"), "wt");
  sh(root, "git", "worktree", "add", "-q", "--detach", wt, "origin/release");
  const before = head(wt);
  const r = runNode(RESEARCH, "sync_base", { cwd: wt });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(head(wt), before);
  assert.equal(r.stdout, "release\n");
});

test("research's sync_base prints only the base name", () => {
  const { wt } = mkLagging();
  const r = runNode(RESEARCH, "sync_base", { cwd: wt });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "main\n");
});

const entry = (workflow, extra = {}) => ({ workflow, repo: "", inputs: [], note: "", ...extra });
const researcher = (...followUps) => JSON.stringify({ confidence: "likely", title: "Do the work", follow_ups: followUps });
const plan = (r) => runNode(RESEARCH, "follow_plan", { cwd: r.repo, vars: {}, env: r.env });
const planWith = (r, out) => runNode(RESEARCH, "follow_plan", { cwd: r.repo, vars: { "$research.output": out }, env: r.env });
const planFile = (r) => JSON.parse(fs.readFileSync(path.join(r.art, "follow-up-plan.json"), "utf8"));

test("follow_plan proposes nothing when the researcher returned an empty array", () => {
  const r = mkResearchEnv(["ready"]);
  const out = planWith(r, researcher());
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^nothing/);
  assert.deepEqual(planFile(r), []);
});

test("follow_plan proposes nothing when the only entry has an empty workflow", () => {
  const r = mkResearchEnv(["ready"]);
  const out = planWith(r, researcher(entry("")));
  assert.match(out.stdout, /^nothing/);
  assert.deepEqual(planFile(r), []);
});

test("follow_plan proposes nothing for a workflow the repository does not declare, and says so on stderr", () => {
  const r = mkResearchEnv(["ready"]);
  const out = planWith(r, researcher(entry("rm-rf")));
  assert.match(out.stdout, /^nothing/);
  assert.match(out.stderr, /start-run: dropped rm-rf/);
  assert.deepEqual(planFile(r), []);
});

test("follow_plan proposes nothing when the research output is not JSON", () => {
  const r = mkResearchEnv(["ready"]);
  const out = planWith(r, "not json");
  assert.match(out.stdout, /^nothing/);
  assert.deepEqual(planFile(r), []);
});

test("follow_plan keeps build with no repo", () => {
  const r = mkResearchEnv(["ready"]);
  const out = planWith(r, researcher(entry("build", { note: "here" })));
  assert.equal(out.stdout, "build\n");
  assert.equal(planFile(r).length, 1);
});

test("follow_plan keeps a build entry with interactive=yes, names its input and drops any other value", () => {
  const r = mkResearchEnv(["ready"]);
  const yes = [{ name: "interactive", value: "yes" }];
  const ok = planWith(r, researcher(entry("build", { inputs: yes, note: "deploy it and tell me what the page shows" })));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "build interactive=yes\n");
  assert.deepEqual(planFile(r), [{ workflow: "build", repo: "", inputs: yes, note: "deploy it and tell me what the page shows" }]);
  const there = planWith(r, researcher(entry("build", { repo: "ready", inputs: yes })));
  assert.equal(there.stdout, "build in ready interactive=yes\n");
  const bad = planWith(r, researcher(entry("build", { inputs: [{ name: "interactive", value: "no" }] })));
  assert.match(bad.stdout, /^nothing/);
  assert.match(bad.stderr, /dropped build: interactive must be yes/);
  assert.deepEqual(planFile(r), []);
});

test("follow_plan names the repository for build in a ready repository and drops one that is not ready", () => {
  const r = mkResearchEnv(["ready"]);
  const ok = planWith(r, researcher(entry("build", { repo: "ready" })));
  assert.equal(ok.stdout, "build in ready\n");
  const bad = planWith(r, researcher(entry("build", { repo: "bare" })));
  assert.match(bad.stdout, /^nothing/);
  assert.match(bad.stderr, /dropped build in bare/);
  assert.deepEqual(planFile(r), []);
});

test("follow_plan joins a fan-out in order and drops a repeat and every entry past the fifth", () => {
  const r = mkResearchEnv(["r1", "r2", "r3", "r4"]);
  const three = planWith(r, researcher(entry("build", { repo: "r1" }), entry("publish-docs"), entry("build")));
  assert.equal(three.stdout, "build in r1, publish-docs, build\n");
  assert.equal(planFile(r).length, 3);
  const many = planWith(
    r,
    researcher(entry("build", { repo: "r1" }), entry("build", { repo: "r1", note: "again" }), entry("build", { repo: "r2" }), entry("build", { repo: "r3" }), entry("build", { repo: "r4" }), entry("build"), entry("publish-docs")),
  );
  assert.equal(many.stdout, "build in r1, build in r2, build in r3, build in r4, build\n");
  assert.match(many.stderr, /dropped build: already proposed/);
  assert.match(many.stderr, /dropped publish-docs: at most five follow-ups/);
});

test("follow_up with an empty plan starts nothing and ends cleanly", () => {
  const r = mkResearchEnv(["ready"]);
  fs.writeFileSync(path.join(r.art, "follow-up-plan.json"), "[]\n");
  const out = runNode(RESEARCH, "follow_up", { cwd: r.repo, vars: {}, env: r.env });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, "no follow-up was proposed, so none started\n");
  assert.deepEqual(r.calls(), []);
});

test("follow_up starts a build with interactive=yes and passes the input to the run", () => {
  const r = mkResearchEnv(["ready"]);
  fs.writeFileSync(
    path.join(r.art, "follow-up-plan.json"),
    JSON.stringify([entry("build", { inputs: [{ name: "interactive", value: "yes" }], note: "deploy it and report" })]),
  );
  fs.writeFileSync(path.join(r.art, "note.txt"), "go ahead");
  fs.writeFileSync(path.join(r.art, "research.json"), JSON.stringify({ title: "Do the work" }));
  fs.writeFileSync(path.join(r.art, "report.md"), "# Report\n\nfindings\n");
  const out = runNode(RESEARCH, "follow_up", { cwd: r.repo, vars: {}, env: r.env });
  assert.equal(out.status, 0, out.stderr);
  const [call] = r.calls();
  assert.deepEqual(call.args.slice(0, 6), ["workflow", "run", "build", "--detach", "--input", "interactive=yes"]);
  assert.ok(call.args.at(-1).endsWith("## Scope of this run\n\ndeploy it and report"));
});

test("follow_up starts each entry in its own repository with the brief and its own scope", () => {
  const r = mkResearchEnv(["ready"]);
  fs.writeFileSync(
    path.join(r.art, "follow-up-plan.json"),
    JSON.stringify([entry("build", { repo: "ready", note: "the ready part" }), entry("publish-docs", { note: "the mirror" }), entry("build")]),
  );
  fs.writeFileSync(path.join(r.art, "note.txt"), "go ahead");
  fs.writeFileSync(path.join(r.art, "research.json"), JSON.stringify({ title: "Do the work" }));
  fs.writeFileSync(path.join(r.art, "report.md"), "# Report\n\nfindings\n");
  const out = runNode(RESEARCH, "follow_up", { cwd: r.repo, vars: {}, env: r.env });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^started build, run run-build\nstarted publish-docs, run run-publish-docs\nstarted build, run run-build\n/);
  const calls = r.calls();
  assert.deepEqual(calls.map((c) => c.cwd), [r.w.dirs.ready, r.w.site, r.repo]);
  const brief = "# Do the work\n\n## Note\n\ngo ahead\n\n## Research\n\n# Report\n\nfindings";
  assert.deepEqual(calls.map((c) => c.args.at(-1)), [
    `${brief}\n\n## Scope of this run\n\nthe ready part`,
    `${brief}\n\n## Scope of this run\n\nthe mirror`,
    brief,
  ]);
  assert.ok(calls.every((c) => !c.args.some((a) => a.startsWith("ref="))));
});

// The build loop's interactive route: `round`, `ask_check`, `ready` and `report`. Each test runs the
// node's own bash. state.sh keeps the loop's facts in $ARTIFACTS_DIR/state, so the tests read it back.
const stateGet = (art, key) =>
  execFileSync("bash", [path.join(SCRIPTS, "state.sh"), "get", key], { env: { ...process.env, ARTIFACTS_DIR: art }, encoding: "utf8" }).trim();
const stateSet = (art, key, value) =>
  execFileSync("bash", [path.join(SCRIPTS, "state.sh"), "set", key, value], { env: { ...process.env, ARTIFACTS_DIR: art }, encoding: "utf8" });
const ownerNotes = (art) => {
  const f = path.join(art, "owner-notes.md");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
};

function mkLoop({ buildJson = null } = {}) {
  const root = mkRepo();
  write(root, "README.md");
  if (buildJson) write(root, ".archon/build.json", buildJson);
  commitAll(root, "base");
  return { root, art: mkdtemp("artifacts-") };
}

const roundNode = (l, { d = "", text = "" } = {}) =>
  runNode(BUILD, "round", {
    cwd: l.root,
    vars: { "$LOOP_PREV.final_gate.output.decision": d, "$LOOP_PREV.final_gate.output.text": text },
    env: { ARTIFACTS_DIR: l.art },
  });

test("round: reply at an ask pause appends the answer to owner-notes.md, resets not-ready-rounds and builds again", () => {
  const l = mkLoop();
  stateSet(l.art, "pause-kind", "ask");
  stateSet(l.art, "not-ready-rounds", "2");
  stateSet(l.art, "ask-pending", "yes");
  const r = roundNode(l, { d: "reply", text: "the page shows the new banner" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "build\n");
  assert.equal(ownerNotes(l.art), "## Answer\n\nthe page shows the new banner\n\n");
  assert.equal(stateGet(l.art, "not-ready-rounds"), "0");
  assert.equal(stateGet(l.art, "build-loop"), "open");
  assert.equal(stateGet(l.art, "ask-pending"), "");
  assert.equal(stateGet(l.art, "ask-stop"), "");
});

test("round: an answer with quotes and several lines reaches owner-notes.md as written", () => {
  const l = mkLoop();
  stateSet(l.art, "pause-kind", "ask");
  const text = `it's "half" lit\nsecond line with $HOME and 100%`;
  const r = roundNode(l, { d: "reply", text });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ownerNotes(l.art), `## Answer\n\n${text}\n\n`);
});

test("round: any answer at an ask pause continues the build, and the notes keep every answer in order", () => {
  const l = mkLoop();
  stateSet(l.art, "pause-kind", "ask");
  assert.equal(roundNode(l, { d: "reply", text: "one" }).stdout, "build\n");
  const second = roundNode(l, { d: "rework", text: "two" });
  assert.equal(second.stdout, "build\n");
  assert.equal(ownerNotes(l.art), "## Answer\n\none\n\n## Answer\n\ntwo\n\n");
  assert.equal(stateGet(l.art, "ask-stop"), "");
});

test("round: approve at an ask pause sets ask-stop, tells the implementer to finish without asking, and builds again", () => {
  const l = mkLoop();
  stateSet(l.art, "pause-kind", "ask");
  const r = roundNode(l, { d: "approve" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "build\n");
  assert.equal(stateGet(l.art, "ask-stop"), "yes");
  assert.equal(stateGet(l.art, "build-loop"), "open");
  assert.match(ownerNotes(l.art), /^## Answer\n\nThe owner chose to finish without answering\. Do not ask again: finish the work/);
});

test("round: approve at a clean pause settles the loop and writes no notes", () => {
  const l = mkLoop();
  stateSet(l.art, "pause-kind", "clean");
  const r = roundNode(l, { d: "approve" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "idle\n");
  assert.equal(stateGet(l.art, "build-loop"), "settled");
  assert.equal(stateGet(l.art, "ask-stop"), "");
  assert.equal(ownerNotes(l.art), null);
});

test("round: approve with no pause kind recorded settles the loop", () => {
  const l = mkLoop();
  const r = roundNode(l, { d: "approve" });
  assert.equal(r.stdout, "idle\n");
  assert.equal(stateGet(l.art, "build-loop"), "settled");
});

test("round: reply at a clean pause counts as rework", () => {
  const l = mkLoop();
  stateSet(l.art, "pause-kind", "clean");
  stateSet(l.art, "not-ready-rounds", "1");
  const r = roundNode(l, { d: "reply", text: "also fix the label" });
  assert.equal(r.stdout, "build\n");
  assert.equal(stateGet(l.art, "not-ready-rounds"), "0");
  assert.equal(stateGet(l.art, "build-loop"), "open");
  assert.equal(ownerNotes(l.art), null);
});

test("round: rework at a clean pause builds again", () => {
  const l = mkLoop();
  const r = roundNode(l, { d: "rework", text: "again" });
  assert.equal(r.stdout, "build\n");
  assert.equal(ownerNotes(l.art), null);
});

test("round: no previous answer builds, and a pause kind left by an earlier round writes no notes", () => {
  const l = mkLoop();
  stateSet(l.art, "pause-kind", "ask");
  stateSet(l.art, "ask-pending", "yes");
  const r = roundNode(l);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "build\n");
  assert.equal(ownerNotes(l.art), null);
  assert.equal(stateGet(l.art, "ask-pending"), "");
  assert.equal(stateGet(l.art, "ask-stop"), "");
});

const askJson = (extra = {}) =>
  JSON.stringify({ ask: true, question: "Does the page show the new banner?", steps: "1. Deploy the build.\n2. Open the page.", handoffs: [], ...extra });
const askCheck = (l, out, env = {}) => runNode(BUILD, "ask_check", { cwd: l.root, vars: { "$implement.output": out }, env: { ARTIFACTS_DIR: l.art, ...env } });

test("ask_check prints go for a question when the run is not interactive", () => {
  const l = mkLoop();
  write(l.root, "work.txt", "unsaved\n");
  const before = head(l.root);
  const r = askCheck(l, askJson());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "go\n");
  assert.equal(ownerNotes(l.art), null);
  assert.equal(stateGet(l.art, "ask-pending"), "");
  assert.equal(head(l.root), before);
});

test("ask_check prints go when an interactive implementer returned no question", () => {
  const cases = {
    "an empty output": "",
    "text that is not JSON": "implemented the change",
    "ask false": askJson({ ask: false }),
    "ask true with an empty question": askJson({ question: "" }),
    "ask true with no question": JSON.stringify({ ask: true }),
    "ask as a string": askJson({ ask: "true" }),
  };
  for (const [what, out] of Object.entries(cases)) {
    const l = mkLoop();
    stateSet(l.art, "interactive", "yes");
    const r = askCheck(l, out);
    assert.equal(r.status, 0, `${what}: ${r.stderr}`);
    assert.equal(r.stdout, "go\n", what);
    assert.equal(ownerNotes(l.art), null, what);
    assert.equal(stateGet(l.art, "ask-pending"), "", what);
  }
});

test("ask_check prints go and writes nothing when the owner chose to finish without answering", () => {
  const l = mkLoop();
  stateSet(l.art, "interactive", "yes");
  stateSet(l.art, "ask-stop", "yes");
  write(l.root, "work.txt", "unsaved\n");
  const before = head(l.root);
  const r = askCheck(l, askJson());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "go\n");
  assert.match(r.stderr, /the owner chose to finish/);
  assert.equal(ownerNotes(l.art), null);
  assert.equal(stateGet(l.art, "ask-pending"), "");
  assert.equal(head(l.root), before);
});

test("ask_check on a question commits what the implementer left, records the question and sets ask-pending", () => {
  const l = mkLoop();
  stateSet(l.art, "interactive", "yes");
  stateSet(l.art, "ask-started", "left over from an earlier round");
  write(l.root, "work.txt", "unsaved\n");
  const before = head(l.root);
  const r = askCheck(l, askJson());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "ask\n");
  assert.notEqual(head(l.root), before);
  assert.equal(sh(l.root, "git", "log", "-1", "--format=%s").trim(), "build: save the work before asking the owner");
  assert.equal(sh(l.root, "git", "status", "--porcelain").trim(), "");
  assert.equal(ownerNotes(l.art), "## Question\n\nDoes the page show the new banner?\n\n");
  assert.equal(stateGet(l.art, "ask-pending"), "yes");
  assert.equal(stateGet(l.art, "ask-started"), "");
});

test("ask_check makes no commit when the implementer left nothing uncommitted", () => {
  const l = mkLoop();
  stateSet(l.art, "interactive", "yes");
  const before = head(l.root);
  const r = askCheck(l, askJson());
  assert.equal(r.stdout, "ask\n");
  assert.equal(head(l.root), before);
});

test("ask_check ends the lane marker before it commits", () => {
  const l = mkLoop();
  stateSet(l.art, "interactive", "yes");
  const marker = path.join(l.root, ".git", "archon-stage");
  fs.writeFileSync(marker, "implement\n");
  const r = askCheck(l, askJson());
  assert.equal(r.stdout, "ask\n");
  assert.ok(!fs.existsSync(marker));
});

// A fake `archon` that logs each call as { cwd, args } and prints a run id named for the workflow.
function fakeArchon() {
  const root = mkdtemp("fake-archon-");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const log = path.join(root, "calls.jsonl");
  fs.writeFileSync(
    path.join(bin, "archon"),
    `#!/usr/bin/env bash
jq -cn --arg cwd "$PWD" '{cwd: $cwd, args: $ARGS.positional}' --args -- "$@" >> "${log}"
printf 'Run id: run-%s\\n' "$3"
`,
    { mode: 0o755 },
  );
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((x) => JSON.parse(x)) : []);
  return { env: { PATH: `${bin}:${process.env.PATH}`, START_RUN_WORKSPACE: root }, calls };
}
const deployDeclared = { handoffs: [{ workflow: "deploy-staging", use_when: "the build has to be deployed", ask: [], pass_ref: true }] };

test("ask_check starts a declared hand-off on the commit it made, records it and drops one the repository does not declare", () => {
  const l = mkLoop({ buildJson: deployDeclared });
  const fa = fakeArchon();
  stateSet(l.art, "interactive", "yes");
  write(l.root, "work.txt", "unsaved\n");
  const handoffs = [
    { workflow: "deploy-staging", inputs: [], note: "deploy the experiment build" },
    { workflow: "rm-rf", inputs: [], note: "" },
  ];
  const r = askCheck(l, askJson({ handoffs }), fa.env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "ask\n");
  assert.match(r.stderr, /start-run: dropped rm-rf/);
  assert.equal(stateGet(l.art, "ask-started"), "started deploy-staging, run run-deploy-staging");
  const calls = fa.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, l.root);
  assert.deepEqual(calls[0].args, ["workflow", "run", "deploy-staging", "--detach", "--input", `ref=${head(l.root)}`, "deploy the experiment build"]);
});

test("ask_check records two hand-offs on one line, in order", () => {
  const two = { handoffs: [...deployDeclared.handoffs, { workflow: "plain", use_when: "something else" }] };
  const l = mkLoop({ buildJson: two });
  const fa = fakeArchon();
  stateSet(l.art, "interactive", "yes");
  const handoffs = [
    { workflow: "deploy-staging", inputs: [], note: "" },
    { workflow: "plain", inputs: [], note: "" },
  ];
  const r = askCheck(l, askJson({ handoffs }), fa.env);
  assert.equal(r.stdout, "ask\n");
  assert.equal(stateGet(l.art, "ask-started"), "started deploy-staging, run run-deploy-staging; started plain, run run-plain");
  assert.deepEqual(fa.calls().map((c) => c.args[2]), ["deploy-staging", "plain"]);
});

test("ask_check starts nothing for a question that proposes no hand-off", () => {
  const l = mkLoop({ buildJson: deployDeclared });
  const fa = fakeArchon();
  stateSet(l.art, "interactive", "yes");
  const r = askCheck(l, askJson(), fa.env);
  assert.equal(r.stdout, "ask\n");
  assert.deepEqual(fa.calls(), []);
  assert.equal(stateGet(l.art, "ask-started"), "");
});

test("ask_check starts no hand-off when the owner chose to finish", () => {
  const l = mkLoop({ buildJson: deployDeclared });
  const fa = fakeArchon();
  stateSet(l.art, "interactive", "yes");
  stateSet(l.art, "ask-stop", "yes");
  const r = askCheck(l, askJson({ handoffs: [{ workflow: "deploy-staging", inputs: [], note: "" }] }), fa.env);
  assert.equal(r.stdout, "go\n");
  assert.deepEqual(fa.calls(), []);
});

const readyNode = (l, round) => runNode(BUILD, "ready", { cwd: l.root, vars: { "$round.output": round }, env: { ARTIFACTS_DIR: l.art } });

test("ready prints ask and records the pause kind before it reads a gate or counts a not-ready round", () => {
  const l = mkLoop();
  stateSet(l.art, "ask-pending", "yes");
  const r = readyNode(l, "build");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "ask\n");
  assert.equal(stateGet(l.art, "pause-kind"), "ask");
  assert.equal(stateGet(l.art, "not-ready-rounds"), "");
});

test("ready prints idle for an idle round even when a question is pending", () => {
  const l = mkLoop();
  stateSet(l.art, "ask-pending", "yes");
  const r = readyNode(l, "idle");
  assert.equal(r.stdout, "idle\n");
  assert.equal(stateGet(l.art, "pause-kind"), "");
});

test("ready prints pause for a green gate and a clean review", () => {
  const l = mkLoop();
  stateSet(l.art, "gates-status", "green");
  stateSet(l.art, "review-verdict", "clean");
  stateSet(l.art, "not-ready-rounds", "2");
  const r = readyNode(l, "build");
  assert.equal(r.stdout, "pause\n");
  assert.equal(stateGet(l.art, "pause-kind"), "clean");
  assert.equal(stateGet(l.art, "not-ready-rounds"), "0");
});

test("ready prints not-ready for the first four red rounds, then fails the fifth and sets no pause kind", () => {
  const l = gatesRepo(["npm ci", "npm test"]);
  for (let i = 1; i <= 4; i++) {
    const r = readyNode(l, "build");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "not-ready\n");
    assert.equal(stateGet(l.art, "not-ready-rounds"), String(i));
  }
  const fifth = readyNode(l, "build");
  assert.equal(fifth.status, 1);
  assert.equal(fifth.stdout, "");
  assert.equal(stateGet(l.art, "pause-kind"), "");
});

// A scratch home whose scripts directory holds the real state.sh and logging stubs for the two scripts that
// build a report, so a test can see whether `report` called them.
function fakeHome({ reportUrl = "", realMatch = false } = {}) {
  const home = mkdtemp("fake-home-");
  const dir = path.join(home, ".archon", "scripts");
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(path.join(SCRIPTS, "state.sh"), path.join(dir, "state.sh"));
  const log = path.join(home, "calls.log");
  const stub = (name, body) =>
    fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\nprintf '${name} %s\\n' "$*" >> '${log}'\n${body}\n`, { mode: 0o755 });
  stub("report.sh", reportUrl ? `printf '%s\\n' '${reportUrl}'` : "");
  stub("build-settings.sh", `case "$1" in --design-dir) printf '%s\\n' '${home}/design/'"$2" ;; esac`);
  // `report` asks publish-match.sh which publish targets the change touches. The stub finds none
  // unless a test asks for the real script, which then reads the real build-settings.sh.
  if (realMatch) {
    fs.symlinkSync(path.join(SCRIPTS, "publish-match.sh"), path.join(dir, "publish-match.sh"));
    fs.writeFileSync(
      path.join(dir, "build-settings.sh"),
      `#!/usr/bin/env bash\ncase "$1" in --design-dir) printf '%s\\n' '${home}/design/'"$2" ;; *) exec bash '${path.join(SCRIPTS, "build-settings.sh")}' "$@" ;; esac\n`,
      { mode: 0o755 },
    );
  } else {
    fs.writeFileSync(path.join(dir, "publish-match.sh"), "#!/usr/bin/env bash\nprintf '[]\\n'\n", { mode: 0o755 });
  }
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  return { home, calls };
}
const reportNode = (l, home, vars) =>
  runNode(BUILD, "report", {
    cwd: l.root,
    vars: { "$intake.output": "timer", "$report_pick.output": "", "$sync_base.output": "main", ...vars },
    env: { ARTIFACTS_DIR: l.art, HOME: home, ARCHON_HOME: undefined },
  });

test("report at an ask round prints the question, the steps, the hand-offs started and the two answers, and builds no report", () => {
  const l = mkLoop();
  const h = fakeHome();
  stateSet(l.art, "ask-started", "started deploy-staging, run run-deploy-staging");
  const r = reportNode(l, h.home, { "$ready.output": "ask", "$implement.output": askJson() });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      "Does the page show the new banner?",
      "1. Deploy the build.",
      "2. Open the page.",
      "Started: started deploy-staging, run run-deploy-staging",
      "reply keeps building with your answer. approve skips the question and finishes the work with what exists.",
      "",
    ].join("\n"),
  );
  assert.deepEqual(h.calls(), []);
  assert.ok(!fs.existsSync(path.join(l.art, "report-picks.json")));
});

test("report at an ask round leaves out the Started line when no hand-off started", () => {
  const l = mkLoop();
  const h = fakeHome();
  const r = reportNode(l, h.home, { "$ready.output": "ask", "$implement.output": askJson({ steps: "" }) });
  assert.equal(
    r.stdout,
    "Does the page show the new banner?\nreply keeps building with your answer. approve skips the question and finishes the work with what exists.\n",
  );
});

test("report at a clean pause still builds the review report and says the change waits to land", () => {
  const l = mkLoop();
  const h = fakeHome();
  stateSet(l.art, "pause-kind", "clean");
  stateSet(l.art, "deliver", "land");
  const picks = JSON.stringify({ summary: "s", picks: [], extra_json: "" });
  const r = reportNode(l, h.home, { "$ready.output": "pause", "$implement.output": "", "$report_pick.output": picks });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "timer is built, reviewed and green, and waits for you to land it.\n");
  assert.ok(h.calls().some((c) => c.startsWith("report.sh page review ")));
  assert.equal(fs.readFileSync(path.join(l.art, "report-picks.json"), "utf8"), picks);
});

test("report at a clean pause prints what the owner's answers showed on one line, and nothing when there is none", () => {
  const l = mkLoop();
  const h = fakeHome();
  stateSet(l.art, "pause-kind", "clean");
  stateSet(l.art, "deliver", "land");
  const picks = (findings) => JSON.stringify({ findings, summary: "s", picks: [], extra_json: "" });
  const vars = (findings) => ({ "$ready.output": "pause", "$implement.output": "", "$report_pick.output": picks(findings) });
  const found = reportNode(l, h.home, vars("The write took 1 ms.\nThe hold waited for a refresh.\n"));
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout, "timer is built, reviewed and green, and waits for you to land it.\nThe write took 1 ms. The hold waited for a refresh.\n");
  assert.equal(reportNode(l, h.home, vars("")).stdout, "timer is built, reviewed and green, and waits for you to land it.\n");
  const old = reportNode(l, h.home, { "$ready.output": "pause", "$implement.output": "", "$report_pick.output": JSON.stringify({ summary: "s", picks: [], extra_json: "" }) });
  assert.equal(old.stdout, "timer is built, reviewed and green, and waits for you to land it.\n");
});

test("report at a clean pause says how many open items the page lists, after the findings line", () => {
  const l = mkLoop();
  const h = fakeHome();
  stateSet(l.art, "pause-kind", "clean");
  stateSet(l.art, "deliver", "land");
  const base = "timer is built, reviewed and green, and waits for you to land it.\n";
  const at = (body) => reportNode(l, h.home, { "$ready.output": "pause", "$implement.output": "", "$report_pick.output": JSON.stringify({ summary: "s", picks: [], extra_json: "", ...body }) });
  assert.equal(at({ open_items: ["a", "b", "c"] }).stdout, `${base}3 open items are listed on the page.\n`);
  assert.equal(at({ open_items: ["a"] }).stdout, `${base}1 open item is listed on the page.\n`);
  assert.equal(at({ findings: "The write took 1 ms.", open_items: ["a", "b"] }).stdout, `${base}The write took 1 ms.\n2 open items are listed on the page.\n`);
  assert.equal(at({ open_items: ["a", "  ", 3] }).stdout, `${base}1 open item is listed on the page.\n`);
  for (const body of [{ open_items: [] }, {}, { open_items: "none" }, { open_items: ["", " "] }]) assert.equal(at(body).stdout, base, JSON.stringify(body));
});

test("report_pick reads the owner's answers and review-change checks the change against them", () => {
  const yaml = fs.readFileSync(BUILD, "utf8");
  const pick = yaml.slice(yaml.indexOf("- id: report_pick"), yaml.indexOf("- id: report\n"));
  assert.match(pick, /owner-notes\.md/);
  assert.match(pick, /required: \[findings, summary, picks, open_items, extra_json\]/);
  assert.match(pick, /open_items: \{ type: array, items: \{ type: string \} \}/);
  const flat = pick.replace(/\s+/g, " ");
  assert.match(flat, /Open it with whether the change does what was asked, and name any departure from the plan/);
  assert.match(flat, /Return `open_items`: every caveat, unverified item, step to take after landing and test that was declined/);
  const review = fs.readFileSync(path.join(path.dirname(BUILD), "..", "review-change", "review-change.yaml"), "utf8");
  assert.match(review, /owner-notes\.md/);
  assert.match(flat, /report\.md was written before the gates ran, and \$ARTIFACTS_DIR\/gate-report\.md has their result/);
  assert.match(flat, /Leave out an item that only says a gate, the full feature gate or a test run had not run when the review was written/);
  assert.match(flat, /keep an item for a gate that failed or was skipped in gate-report\.md and for anything that report does not cover/);
  const reviewFlat = review.replace(/\s+/g, " ");
  assert.match(reviewFlat, /gates run after it, so do not report a gate that has not run as a defect/);
  assert.match(reviewFlat, /under a final `## Not verified` heading in report\.md/);
});

test("sync_base records interactive=yes in state and refuses any other value", () => {
  const root = mkRepo();
  write(root, "README.md");
  commitAll(root, "base");
  const art = mkdtemp("artifacts-");
  const run = (interactive) =>
    runNode(BUILD, "sync_base", { cwd: root, vars: {}, env: { ARTIFACTS_DIR: art, INPUTS_DELIVER: "draft-pr", INPUTS_INTERACTIVE: interactive } });
  const ok = run("yes");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(stateGet(art, "interactive"), "yes");
  const empty = run("");
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(stateGet(art, "interactive"), "");
  const bad = run("no");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /interactive must be yes or empty, not no/);
});

test("ask_mode prints yes for an interactive run and no otherwise", () => {
  const l = mkLoop();
  const mode = () => runNode(BUILD, "ask_mode", { cwd: l.root, vars: {}, env: { ARTIFACTS_DIR: l.art } });
  assert.equal(mode().stdout, "no\n");
  stateSet(l.art, "interactive", "yes");
  assert.equal(mode().stdout, "yes\n");
});

test("deliver_pr adds the questions asked of the owner under their own heading, one level down", () => {
  const l = mkLoop();
  const bin = path.join(mkdtemp("fake-gh-"), "bin");
  fs.mkdirSync(bin);
  const sent = path.join(bin, "..", "body.md");
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
case "$1 $2" in
  "pr list") printf '\\n' ;;
  "pr create") cat > '${sent}'; printf 'https://example.test/pr/1\\n' ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, "git"), `#!/usr/bin/env bash\ncase "$1" in push) exit 0 ;; esac\nexec "${sh(l.root, "which", "git").trim()}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(l.art, "plan.md"), "# Plan\n");
  fs.writeFileSync(path.join(l.art, "owner-notes.md"), "## Question\n\nDoes it show?\n\n## Answer\n\nyes\n\n");
  const r = runNode(BUILD, "deliver_pr", { cwd: l.root, vars: { "$sync_base.output": "main" }, env: { ARTIFACTS_DIR: l.art, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  const body = fs.readFileSync(sent, "utf8");
  assert.match(body, /\n## Questions asked of the owner\n\n### Question\n\nDoes it show\?\n\n### Answer\n\nyes\n/);
  assert.ok(body.indexOf("## Questions asked of the owner") < body.indexOf("## Commits"));
});

test("deliver_pr leaves the questions section out when no question was asked", () => {
  const l = mkLoop();
  const bin = path.join(mkdtemp("fake-gh-"), "bin");
  fs.mkdirSync(bin);
  const sent = path.join(bin, "..", "body.md");
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
case "$1 $2" in
  "pr list") printf '\\n' ;;
  "pr create") cat > '${sent}'; printf 'https://example.test/pr/1\\n' ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, "git"), `#!/usr/bin/env bash\ncase "$1" in push) exit 0 ;; esac\nexec "${sh(l.root, "which", "git").trim()}" "$@"\n`, { mode: 0o755 });
  const r = runNode(BUILD, "deliver_pr", { cwd: l.root, vars: { "$sync_base.output": "main" }, env: { ARTIFACTS_DIR: l.art, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(fs.readFileSync(sent, "utf8"), /Questions asked of the owner/);
});

// ---- model tiers and output schemas -------------------------------------------------------------

const WORKFLOW_FILES = fs
  .readdirSync(WORKFLOWS)
  .map((d) => path.join(WORKFLOWS, d, `${d}.yaml`))
  .filter((f) => fs.existsSync(f));

test("every model: names a tier or an @alias, so one switch moves a workflow to another provider", () => {
  assert.ok(WORKFLOW_FILES.length >= 6);
  for (const file of WORKFLOW_FILES) {
    const bad = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((l, i) => [i + 1, l.match(/^\s*model:\s*(\S+)\s*$/)])
      .filter(([, m]) => m && !/^(small|medium|large|@[\w-]+)$/.test(m[1]));
    assert.deepEqual(bad.map(([n, m]) => `${path.basename(file)}:${n} ${m[1]}`), []);
  }
});

// Codex runs a structured answer in strict mode, which rejects an object whose `required` list
// omits one of its `properties`. PyYAML reads the files; the test is skipped without it.
const hasPyYaml = spawnSync("python3", ["-c", "import yaml"]).status === 0;
test("every output_format object lists all of its properties under required", { skip: hasPyYaml ? false : "PyYAML is not installed" }, () => {
  const script = `
import json, sys, yaml
problems = []
def walk_schema(s, where):
    if isinstance(s, dict):
        props = s.get("properties")
        if isinstance(props, dict):
            missing = [k for k in props if k not in (s.get("required") or [])]
            if missing:
                problems.append("%s: properties not in required: %s" % (where, ", ".join(missing)))
            for k, v in props.items():
                walk_schema(v, where + "." + k)
        if "items" in s:
            walk_schema(s["items"], where + "[]")
def walk(node, where):
    if isinstance(node, dict):
        if "output_format" in node:
            walk_schema(node["output_format"], where + " " + str(node.get("id", "?")))
        for k, v in node.items():
            walk(v, where)
    elif isinstance(node, list):
        for v in node:
            walk(v, where)
for f in sys.argv[1:]:
    walk(yaml.safe_load(open(f)), f.split("/")[-1])
print(json.dumps(problems))
`;
  const r = spawnSync("python3", ["-c", script, ...WORKFLOW_FILES], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), []);
});

// ---- the lane check at the end of each confined stage ---------------------------------------------

const buildText = fs.readFileSync(BUILD, "utf8");
const nodeBashAround = (id) => nodeScript(BUILD, id);

test("the nodes that end a confined stage verify what it wrote and fail the run when it wrote out of lane", () => {
  for (const id of ["red_check", "repair_state", "ask_check", "gates", "sync_start"]) {
    assert.match(nodeBashAround(id), /lane\.sh" unstage --verify \|\| exit 1/, `${id} ends its stage with --verify`);
  }
});

test("round and lane_mut end a stage without the snapshot check, because round clears a stale marker and lane_mut lists what the branch changed itself", () => {
  const round = nodeBashAround("round");
  assert.match(round, /lane\.sh" unstage\n/);
  assert.doesNotMatch(round, /unstage --verify/);
  assert.doesNotMatch(nodeBashAround("lane_mut"), /unstage --verify/);
  assert.match(nodeBashAround("lane_mut"), /lane\.sh" check --allow-empty --since /);
});

test("every lane.sh unstage call in build.yaml is one of the two sites that clear without checking", () => {
  const plain = [...buildText.matchAll(/lane\.sh" unstage(?! --verify)/g)].length;
  assert.equal(plain, 2);
  assert.equal([...buildText.matchAll(/lane\.sh" unstage --verify \|\| exit 1/g)].length, 5);
});

// A repository with a tests lane, so the node's real lane.sh runs against a stage marker.
function laneRepo() {
  const root = mkRepo();
  write(root, ".archon/lanes.json", { tests: ["test/**"] });
  write(root, "src/a.js", "a\n");
  commitAll(root, "base");
  return root;
}

test("ask_check fails the run when the implementer wrote inside the tests lane, and passes when it wrote outside it", () => {
  for (const [file, ok] of [["src/impl.js", true], ["test/sneaky.js", false]]) {
    const root = laneRepo();
    const l = mkLoop();
    const art = l.art;
    sh(root, "bash", path.join(SCRIPTS, "lane.sh"), "stage", "implement", art);
    write(root, file);
    stateSet(art, "interactive", "yes");
    const r = runNode(BUILD, "ask_check", {
      cwd: root,
      vars: { "$impl_join.output": "go", "$implement.output": JSON.stringify({ ask: true, question: "q?", steps: "", handoffs: [] }) },
      env: { ARTIFACTS_DIR: art },
    });
    if (ok) assert.equal(r.status, 0, r.stderr);
    else {
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /the implement stage wrote inside the tests lane:\ntest\/sneaky\.js/);
    }
    assert.equal(fs.existsSync(path.join(root, ".git", "archon-stage")), false);
  }
});

const ANTI = path.join(WORKFLOWS, "anti-entropy", "anti-entropy.yaml");

test("research's report_page node builds through report.sh page and keeps no builder logic of its own", () => {
  const script = nodeScript(RESEARCH, "report_page");
  assert.match(script, /report\.sh/);
  assert.match(script, /page research/);
  assert.match(script, /--spec/);
  assert.doesNotMatch(script, /report-page\.py/);
  assert.doesNotMatch(script, /report_cmd/);
});

test("research's report_page waits for follow_plan, so the page can list the follow-ups, and passes no status", () => {
  const text = fs.readFileSync(RESEARCH, "utf8");
  const start = text.search(/^ *- id: report_page$/m);
  const block = text.slice(start, text.indexOf("- id: notice", start));
  assert.match(block, /depends_on: \[research, follow_plan\]/);
  assert.doesNotMatch(nodeScript(RESEARCH, "report_page"), /--status/);
});

// research's report_page in a repository with one commit, against a scratch home whose report-base-url
// makes report.sh print an address, for an artifacts directory named like a run id.
function researchPage() {
  const root = mkRepo();
  write(root, "README.md");
  commitAll(root, "base");
  const kit = kitHome();
  made.push(kit.dir);
  fs.writeFileSync(path.join(kit.dir, "report-base-url"), "https://reports.example\n");
  const art = path.join(mkdtemp("artifacts-"), "abcdef123456");
  fs.mkdirSync(art);
  write(art, "report.md", "# Findings\n\nBody.\n");
  const page = (spec, msg = "which node writes the plan report in build?") =>
    runNode(RESEARCH, "report_page", {
      cwd: root,
      vars: { $ARGUMENTS: msg, "$research.output": JSON.stringify(spec), "$research.output.confidence": spec.confidence },
      env: { ARCHON_HOME: kit.dir, ARTIFACTS_DIR: art },
    });
  return { page, kit, art, repo: path.basename(root) };
}
const SPEC = { confidence: "likely", title: "Act on research findings", follow_ups: [] };

test("research's report_page builds a page whose status names the round and the follow-ups of follow-up-plan.json", () => {
  const { page, kit, art, repo } = researchPage();
  fs.writeFileSync(path.join(art, "follow-up-plan.json"), JSON.stringify([entry("build", { note: "do it" })]));
  fs.writeFileSync(path.join(art, "steer.md"), "## Note\n\nwhy?\n\n");
  const r = page({ ...SPEC, slug: "retry-test-overlap" });
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(path.join(kit.dir, "designs", repo, "research-retry-test-overlap-abcdef", "index.html"), "utf8");
  assert.match(html, /Round 2: 1 follow-up run proposed/);
  assert.match(html, /<h2>Follow-up runs it proposes<\/h2>/);
});

test("research's report_page names the report's directory from the researcher's slug and the run id", () => {
  const { page, kit, repo } = researchPage();
  const r = page({ ...SPEC, slug: "retry-test-overlap" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `https://reports.example/${repo}/research-retry-test-overlap-abcdef/\n`);
  assert.ok(fs.existsSync(path.join(kit.dir, "designs", repo, "research-retry-test-overlap-abcdef", "index.html")));
});

test("research's report_page strips a repeated workflow name from the researcher's slug", () => {
  const { page, repo } = researchPage();
  const r = page({ ...SPEC, slug: "research-retry-test-overlap" });
  assert.equal(r.stdout, `https://reports.example/${repo}/research-retry-test-overlap-abcdef/\n`);
});

test("research's report_page falls back to the question's words when the spec has no slug", () => {
  for (const spec of [SPEC, { ...SPEC, slug: "" }]) {
    const { page, repo } = researchPage();
    const r = page(spec);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `https://reports.example/${repo}/research-which-node-writes-plan-report-abcdef/\n`);
  }
});

test("research's report_page builds a later round's page at the first round's address, whatever slug it names", () => {
  const { page, kit, art, repo } = researchPage();
  const first = page({ ...SPEC, slug: "first-name" });
  const second = page({ ...SPEC, slug: "second-name" });
  assert.equal(first.stdout, `https://reports.example/${repo}/research-first-name-abcdef/\n`);
  assert.equal(second.stdout, first.stdout);
  assert.equal(fs.readFileSync(path.join(art, "slug.txt"), "utf8"), "research-first-name-abcdef\n");
  assert.deepEqual(fs.readdirSync(path.join(kit.dir, "designs", repo)), ["research-first-name-abcdef"]);
});

test("anti-entropy's report_page node builds through report.sh markdown into a design directory", () => {
  const script = nodeScript(ANTI, "report_page");
  assert.match(script, /report\.sh/);
  assert.match(script, /markdown anti-entropy/);
  assert.match(script, /--design-dir/);
  assert.match(script, /--status "Anti-entropy: \$lens"/);
  assert.doesNotMatch(script, /report-page\.py/);
});

test("build.yaml no longer says a missing report_cmd leaves a sentence in the page's place", () => {
  assert.doesNotMatch(fs.readFileSync(BUILD, "utf8"), /leaves a sentence naming/);
});

// sync_land runs in a plain repository on main. worktree-land refuses to run there ("Not in a worktree"),
// which is a land that no later round can fix.
function mkLanding() {
  const root = mkRepo();
  write(root, "README.md");
  commitAll(root, "base");
  const art = mkdtemp("artifacts-");
  stateSet(art, "sync-base", head(root));
  return { root, art };
}
const syncLand = (l, gates = "green") =>
  runNode(BUILD, "sync_land", { cwd: l.root, vars: { "$sync_gates.output": gates, "$sync_base.output": "main" }, env: { ARTIFACTS_DIR: l.art } });
const runLog = (l) => (fs.existsSync(path.join(l.art, "run.log")) ? fs.readFileSync(path.join(l.art, "run.log"), "utf8") : "");

test("sync_land fails the run, naming the file, when green gates left an untracked file, and does not run worktree-land", () => {
  const l = mkLanding();
  write(l.root, "tests/golden/frame.txt");
  const r = syncLand(l);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the landing loop stopped: the gates passed but left uncommitted changes/);
  assert.match(r.stderr, /tests\/golden\/frame\.txt/);
  assert.equal(r.stdout, "");
  assert.doesNotMatch(runLog(l), /== \S+ land /);
  assert.equal(stateGet(l.art, "land-failures"), "");
});

test("sync_land is idle when the gates were not green, even with an untracked file", () => {
  const l = mkLanding();
  write(l.root, "stray.txt");
  const r = syncLand(l, "red");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "idle\n");
});

test("sync_land prints moved when the base moved since the rebase", () => {
  const l = mkLanding();
  write(l.root, "later.txt");
  commitAll(l.root, "later");
  const r = syncLand(l);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "moved\n");
});

test("sync_land prints failed after a first failed land and fails the run after the second", () => {
  const l = mkLanding();
  const first = syncLand(l);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, "failed\n");
  assert.equal(stateGet(l.art, "land-failures"), "1");
  assert.match(first.stderr, /Not in a worktree/);
  assert.equal(stateGet(l.art, "landed"), "");

  const second = syncLand(l);
  assert.equal(second.status, 1);
  assert.equal(second.stdout, "");
  assert.match(second.stderr, /the landing loop stopped: worktree-land failed 2 rounds in a row; see run\.log\. The worktree is kept\./);
  assert.equal(stateGet(l.art, "land-failures"), "2");
});

// plan_rules reads the file kit.json names. Each test gets its own scratch home and, for a `~/` path, its own HOME.
const rulesNode = (kit, { home } = {}) => {
  const kh = kitHome(kit);
  made.push(kh.dir);
  const env = { ARCHON_HOME: kh.dir, ARTIFACTS_DIR: mkdtemp("artifacts-") };
  if (home) env.HOME = home;
  return { kh, run: () => runNode(BUILD, "plan_rules", { cwd: mkdtemp("rules-cwd-"), vars: {}, env }) };
};

test("plan_rules prints none when kit.json has no plan_rules, or there is no kit.json", () => {
  for (const kit of [undefined, {}, { plan_rules: "" }]) {
    const r = rulesNode(kit).run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "none\n");
  }
});

test("plan_rules prints the file kit.json names", () => {
  const dir = mkdtemp("rules-file-");
  const file = path.join(dir, "rules.md");
  fs.writeFileSync(file, "# Rules\n\nRead before you plan.\n");
  const r = rulesNode({ plan_rules: file }).run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "# Rules\n\nRead before you plan.\n");
});

test("plan_rules expands a leading ~/ to the home directory", () => {
  const home = mkdtemp("rules-home-");
  write(home, "notes/rules.md", "home rules\n");
  const r = rulesNode({ plan_rules: "~/notes/rules.md" }, { home }).run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "home rules\n");
});

test("plan_rules fails the run, naming the path, when the file does not exist", () => {
  const home = mkdtemp("rules-home-");
  const r = rulesNode({ plan_rules: "~/missing.md" }, { home }).run();
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, new RegExp(`kit\\.json plan_rules names ${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/missing\\.md, which is not a file`));
});

test("plan_rules fails the run when kit.json is not a JSON object, instead of using none", () => {
  const t = rulesNode({});
  fs.writeFileSync(path.join(t.kh.dir, "kit.json"), "{ not json");
  const r = t.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read .*kit\.json as a JSON object/);
});

// plan_round decides what each round of the plan loop does. approach_check comes from kit.json, so a test
// that sets it gets its own scratch home.
const planRound = (art, { prev = "", decision = "", note = "", kit } = {}) => {
  const env = { ARTIFACTS_DIR: art };
  if (kit !== undefined) {
    const kh = kitHome(kit);
    made.push(kh.dir);
    env.ARCHON_HOME = kh.dir;
  }
  return runNode(BUILD, "plan_round", {
    cwd: mkdtemp("plan-round-"),
    vars: { "$LOOP_PREV.plan_round.output": prev, "$LOOP_PREV.plan_gate.output.decision": decision, "$LOOP_PREV.plan_gate.output.text": note },
    env,
  });
};
const planState = (art) => ({ phase: stateGet(art, "plan-phase"), loop: stateGet(art, "plan-loop"), decision: stateGet(art, "plan-decision") });

test("plan_round plans in the first round when approach_check is unset or false", () => {
  for (const kit of [undefined, {}, { approach_check: false }]) {
    const art = mkdtemp("artifacts-");
    const r = planRound(art, { kit });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "plan\n");
    assert.deepEqual(planState(art), { phase: "plan", loop: "open", decision: "" });
  }
});

test("plan_round asks for an approach in the first round when approach_check is true", () => {
  const art = mkdtemp("artifacts-");
  const r = planRound(art, { kit: { approach_check: true } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "approach\n");
  assert.deepEqual(planState(art), { phase: "approach", loop: "open", decision: "" });
});

test("plan_round starts the full plan after the owner approves the approach", () => {
  const art = mkdtemp("artifacts-");
  planRound(art, { kit: { approach_check: true } });
  const r = planRound(art, { prev: "approach", decision: "approve", note: "use the second option", kit: { approach_check: true } });
  assert.equal(r.stdout, "plan\n");
  assert.deepEqual(planState(art), { phase: "plan", loop: "open", decision: "" });
  assert.match(fs.readFileSync(path.join(art, "plan-notes.md"), "utf8"), /## Owner note\n\nuse the second option\n/);
});

test("plan_round asks for another approach when the owner reworks the approach, and keeps the note", () => {
  const art = mkdtemp("artifacts-");
  planRound(art, { kit: { approach_check: true } });
  const r = planRound(art, { prev: "approach", decision: "rework", note: "smaller", kit: { approach_check: true } });
  assert.equal(r.stdout, "approach\n");
  assert.deepEqual(planState(art), { phase: "approach", loop: "open", decision: "" });
  assert.match(fs.readFileSync(path.join(art, "plan-notes.md"), "utf8"), /smaller/);
});

test("plan_round settles when the owner approves the full plan, after an approach round or without one", () => {
  for (const withApproach of [false, true]) {
    const art = mkdtemp("artifacts-");
    const kit = { approach_check: withApproach };
    planRound(art, { kit });
    if (withApproach) planRound(art, { prev: "approach", decision: "approve", kit });
    const r = planRound(art, { prev: "plan", decision: "approve", kit });
    assert.equal(r.stdout, "idle\n");
    assert.deepEqual(planState(art), { phase: "plan", loop: "settled", decision: "approve" });
  }
});

test("plan_round plans again when the owner reworks the full plan, and settles on approve when no pause asked", () => {
  const art = mkdtemp("artifacts-");
  planRound(art, { kit: { approach_check: true } });
  planRound(art, { prev: "approach", decision: "approve", kit: { approach_check: true } });
  const again = planRound(art, { prev: "plan", decision: "rework", note: "split it", kit: { approach_check: true } });
  assert.equal(again.stdout, "plan\n");
  assert.equal(planState(art).loop, "open");
  const quiet = planRound(art, { prev: "plan", kit: { approach_check: true } });
  assert.equal(quiet.stdout, "idle\n");
  assert.deepEqual(planState(art), { phase: "plan", loop: "settled", decision: "approve" });
});

// plan_record and plan_report in an approach round, and plan_report's question line in a plan round.
const planRecord = (art, round, spec = "") =>
  runNode(BUILD, "plan_record", { cwd: mkdtemp("plan-record-"), vars: { "$plan_round.output": round, "$spec.output": spec }, env: { ARTIFACTS_DIR: art } });
const planReport = (art, home, round) =>
  runNode(BUILD, "plan_report", {
    cwd: mkdtemp("plan-report-"),
    vars: { "$plan_round.output": round, "$intake.output": "timer" },
    env: { ARTIFACTS_DIR: art, HOME: home, ARCHON_HOME: undefined },
  });

test("plan_record always asks in an approach round and records no plan", () => {
  const art = mkdtemp("artifacts-");
  const r = planRecord(art, "approach");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "ask\n");
  assert.ok(!fs.existsSync(path.join(art, "spec-approved.json")));
});

test("plan_record in a plan round asks only for a decision or a hand-off, and records the plan", () => {
  const art = mkdtemp("artifacts-");
  const quiet = planRecord(art, "plan", JSON.stringify({ summary: "s", files: [], needs_decision: false, question: "", excuses: [], handoffs: [] }));
  assert.equal(quiet.stdout, "no-ask\n");
  const ask = planRecord(art, "plan", JSON.stringify({ summary: "s", files: [], needs_decision: true, question: "Which?", excuses: [], handoffs: [] }));
  assert.equal(ask.stdout, "ask\n");
  assert.equal(JSON.parse(fs.readFileSync(path.join(art, "spec-approved.json"), "utf8")).question, "Which?");
  assert.equal(planRecord(art, "idle", "").stdout, "no-ask\n");
});

test("plan_report in an approach round builds the approach as a page and pauses on its link, a sentence and the two answers", () => {
  const art = mkdtemp("artifacts-");
  const h = fakeHome({ reportUrl: "http://localhost:8082/site/timer/approach-report" });
  fs.writeFileSync(path.join(art, "approach.md"), "# Approach: timer\n\nFiles: src/a.js\nTests: test/a.test.js\nOpen: none\n");
  const r = planReport(art, h.home, "approach");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      "http://localhost:8082/site/timer/approach-report",
      "The approach is ready: the choices still open, the files it touches and the tests that prove it.",
      "approve starts the full plan from this approach. rework asks for another approach with your note.",
      "",
    ].join("\n"),
  );
  const built = h.calls().filter((c) => c.startsWith("report.sh "));
  assert.deepEqual(built, [
    `report.sh markdown approach --report ${art}/approach.md --out ${h.home}/design/timer/approach-report.html --design timer` +
      ` --run ${path.basename(art)} --artifacts ${art} --status Approach, before the full plan`,
  ]);
});

test("plan_report in an approach round still pauses, without a page, when the approach node wrote no file", () => {
  const art = mkdtemp("artifacts-");
  const h = fakeHome();
  const r = planReport(art, h.home, "approach");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    "The approach node wrote no approach.md.\napprove starts the full plan from this approach. rework asks for another approach with your note.\n",
  );
  assert.deepEqual(h.calls().filter((c) => c.startsWith("report.sh ")), []);
});

const PLAN_ANSWERS = "approve starts the build of this plan. rework asks for a new plan with your note.";

test("plan_report in a plan round prints the summary's opening paragraph, the hand-offs line, the planner's question and what the answers do", () => {
  const art = mkdtemp("artifacts-");
  const h = fakeHome();
  fs.writeFileSync(
    path.join(art, "spec-approved.json"),
    JSON.stringify({ summary: "Adds a **wrap** option to `timer`, because the brief asks for it. Approve starts this build.\n\nA second paragraph stays off the message.", question: "Stop at zero or wrap?" }),
  );
  fs.writeFileSync(path.join(art, "handoffs-approved.json"), JSON.stringify([{ workflow: "deploy-staging", inputs: [], note: "n" }]));
  const r = planReport(art, h.home, "plan");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      "Adds a wrap option to timer, because the brief asks for it. Approve starts this build.",
      "After delivery this run starts: deploy-staging",
      "Stop at zero or wrap?",
      PLAN_ANSWERS,
      "",
    ].join("\n"),
  );
  assert.ok(h.calls().some((c) => c.startsWith("report.sh page plan ")));
});

test("plan_report in a plan round prints a first paragraph of the work and the reason whole, and leaves the second paragraph on the page", () => {
  const art = mkdtemp("artifacts-");
  const first = "The plan makes the client read only the readable-key spelling of its feeds. The brief gives the reason: the move from short keys is finished, so the old branch is dead code.";
  const second = "It deletes the old parser and converts the fixtures. Approve starts this build and then the deploy-staging hand-off.";
  fs.writeFileSync(path.join(art, "spec-approved.json"), JSON.stringify({ summary: `${first}\n\n${second}`, question: "" }));
  fs.writeFileSync(path.join(art, "handoffs-approved.json"), "[]");
  const r = planReport(art, fakeHome().home, "plan");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(first.length < 350);
  assert.equal(r.stdout, `${first}\n${PLAN_ANSWERS}\n`);
});

test("plan_report in a plan round prints no question or hand-off line when the planner proposed none", () => {
  const art = mkdtemp("artifacts-");
  fs.writeFileSync(path.join(art, "spec-approved.json"), JSON.stringify({ summary: "Adds a wrap option.", question: "" }));
  fs.writeFileSync(path.join(art, "handoffs-approved.json"), "[]");
  const r = planReport(art, fakeHome().home, "plan");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `Adds a wrap option.\n${PLAN_ANSWERS}\n`);
});

test("plan_report in a plan round still pauses with the answers when the plan has no summary", () => {
  const art = mkdtemp("artifacts-");
  fs.writeFileSync(path.join(art, "spec-approved.json"), JSON.stringify({ question: "" }));
  fs.writeFileSync(path.join(art, "handoffs-approved.json"), "[]");
  const r = planReport(art, fakeHome().home, "plan");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${PLAN_ANSWERS}\n`);
});

// ready prints `auto` only when kit.json sets auto_land and nothing in the run needs the owner. Each case below
// breaks one condition of an otherwise clean landing run.
function mkAutoLoop({ kit = { auto_land: true }, deliver = "land", interactive = "", reworked = false, repairs = false, spec = { needs_decision: false } } = {}) {
  const l = mkLoop();
  const kh = kitHome(kit);
  made.push(kh.dir);
  l.home = kh.dir;
  stateSet(l.art, "gates-status", "green");
  stateSet(l.art, "review-verdict", "clean");
  stateSet(l.art, "deliver", deliver);
  if (interactive) stateSet(l.art, "interactive", interactive);
  if (reworked) stateSet(l.art, "owner-reworked", "yes");
  if (repairs) write(l.art, "test-repairs.md", "## a test\n");
  if (spec !== null) write(l.art, "spec-approved.json", typeof spec === "string" ? spec : JSON.stringify(spec));
  return l;
}
const readyAuto = (l) => runNode(BUILD, "ready", { cwd: l.root, vars: { "$round.output": "build" }, env: { ARTIFACTS_DIR: l.art, ARCHON_HOME: l.home } });

test("ready prints auto, and records auto-land, for a clean landing run when auto_land is true", () => {
  const l = mkAutoLoop();
  const r = readyAuto(l);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "auto\n");
  assert.equal(stateGet(l.art, "auto-land"), "yes");
  assert.equal(stateGet(l.art, "pause-kind"), "clean");
  assert.equal(stateGet(l.art, "not-ready-rounds"), "0");
});

for (const [name, opts] of [
  ["auto_land is unset", { kit: {} }],
  ["auto_land is false", { kit: { auto_land: false } }],
  ["the run delivers a draft pull request", { deliver: "draft-pr" }],
  ["the run is interactive", { interactive: "yes" }],
  ["the owner sent the build back", { reworked: true }],
  ["the repair stage changed a test", { repairs: true }],
  ["the plan asked a question", { spec: { needs_decision: true } }],
  ["the plan record is missing", { spec: null }],
  ["the plan record is not JSON", { spec: "not json" }],
]) {
  test(`ready prints pause, and records no auto-land, when ${name}`, () => {
    const l = mkAutoLoop(opts);
    const r = readyAuto(l);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "pause\n");
    assert.equal(stateGet(l.art, "auto-land"), "");
    assert.equal(stateGet(l.art, "pause-kind"), "clean");
  });
}

test("ready never prints auto for a round that is not green and clean", () => {
  for (const [key, value] of [["gates-status", "red"], ["review-verdict", "blocked"]]) {
    const l = mkAutoLoop();
    stateSet(l.art, key, value);
    assert.equal(readyAuto(l).stdout, "not-ready\n");
    assert.equal(stateGet(l.art, "auto-land"), "");
  }
});

test("round settles the loop at once when the previous round was an auto-land round", () => {
  const l = mkLoop();
  stateSet(l.art, "auto-land", "yes");
  stateSet(l.art, "pause-kind", "clean");
  const r = roundNode(l);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "idle\n");
  assert.equal(stateGet(l.art, "build-loop"), "settled");
  assert.equal(ownerNotes(l.art), null);
});

test("round records that the owner sent the build back, and clears auto-land when it builds again", () => {
  const l = mkLoop();
  stateSet(l.art, "pause-kind", "clean");
  const r = roundNode(l, { d: "rework", text: "again" });
  assert.equal(r.stdout, "build\n");
  assert.equal(stateGet(l.art, "owner-reworked"), "yes");
  assert.equal(stateGet(l.art, "auto-land"), "");
  const first = roundNode(mkLoop());
  assert.equal(first.stdout, "build\n");
});

test("after the owner sends the build back, a later clean round pauses even when auto_land is true", () => {
  const l = mkAutoLoop();
  stateSet(l.art, "pause-kind", "clean");
  roundNode(l, { d: "rework" });
  stateSet(l.art, "gates-status", "green");
  stateSet(l.art, "review-verdict", "clean");
  assert.equal(readyAuto(l).stdout, "pause\n");
});

// ---- where the run's own changes start: fork-ref and brief-path ---------------------------------------

test("sync_base records the ref the branch left: the local base for a landing run, origin's for a draft pull request or when there is no local base", () => {
  const cases = [
    { deliver: "land", local: true, want: "main" },
    { deliver: "draft-pr", local: true, want: "origin/main" },
    { deliver: "land", local: false, want: "origin/main" },
  ];
  for (const c of cases) {
    const root = mkRepo();
    write(root, "README.md");
    commitAll(root, "base");
    if (!c.local) sh(root, "git", "branch", "-m", "main", "work");
    const art = mkdtemp("artifacts-");
    const r = runNode(BUILD, "sync_base", { cwd: root, vars: {}, env: { ARTIFACTS_DIR: art, INPUTS_DELIVER: c.deliver, INPUTS_INTERACTIVE: "" } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(stateGet(art, "fork-ref"), c.want, JSON.stringify(c));
  }
});

test("intake records the brief's path when it commits the brief, when the adopted branch holds it and when the design is approved", () => {
  const made = slugRepo();
  assert.equal(intake(made.root, made.art, { msg: "Fix the landing loop now please" }).status, 0);
  assert.equal(stateGet(made.art, "brief-path"), "docs/designs/fix-landing-loop-abcdef/brief.md");

  const root = withBriefCommit("run-adopted-1");
  const art = path.join(mkdtemp("artifacts-"), "run-new-2");
  fs.mkdirSync(art);
  assert.equal(intake(root, art, { env: { ADOPTED_RUN_DIR: "/somewhere/run-adopted-1" } }).status, 0);
  assert.equal(stateGet(art, "brief-path"), "docs/designs/my-slug/brief.md");

  const d = slugRepo();
  write(d.root, "docs/designs/s/design.html");
  write(d.root, "docs/designs/s/mockups.mjs", 'export default [{ id: "one" }];\n');
  commitAll(d.root, "design");
  const r = intake(d.root, d.art, { env: { INPUTS_DESIGN: "s" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stateGet(d.art, "brief-path"), "docs/designs/s/brief.md");
});

test("tests_go starts the tests stage and records no commit, and skips an adopted run's", () => {
  const root = laneRepo();
  const art = mkdtemp("artifacts-");
  const go = (decision) => runNode(BUILD, "tests_go", { cwd: root, vars: { "$plan_decision.output": decision }, env: { ARTIFACTS_DIR: art } });
  const run = go("approve");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "run\n");
  assert.equal(stateGet(art, "tests-sha"), "");
  assert.ok(fs.existsSync(path.join(root, sh(root, "git", "rev-parse", "--git-path", "archon-stage").trim())));
  const skip = go("reused");
  assert.equal(skip.stdout, "skip\n");
});

// The artifacts directory of an earlier build run, with the files that `reuse` copies.
function adoptedRunDir({ plan = true, state = "", legacy = "" } = {}) {
  const src = mkdtemp("adopted-");
  if (plan) write(src, "plan.md", "# plan\n");
  write(src, "plan-notes.md", "notes\n");
  if (state) write(src, "state", state);
  if (legacy) write(src, "tests.sha", legacy);
  return src;
}
const reuseAdopted = (src) => {
  const root = mkRepo();
  const art = mkdtemp("artifacts-");
  const r = runNode(BUILD, "reuse", { cwd: root, vars: {}, env: { ARTIFACTS_DIR: art, ADOPTED_RUN_DIR: src } });
  return { r, art };
};

test("reuse prints fresh when nothing is adopted", () => {
  const root = mkRepo();
  const r = runNode(BUILD, "reuse", { cwd: root, vars: {}, env: { ARTIFACTS_DIR: mkdtemp("artifacts-"), ADOPTED_RUN_DIR: undefined } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "fresh\n");
});

test("reuse takes an approved plan and its notes from the adopted run, whatever the adopted branch's history holds", () => {
  const src = adoptedRunDir({ state: "plan-decision=approve\ntests-sha=0123456789abcdef0123456789abcdef01234567\n" });
  const { r, art } = reuseAdopted(src);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "reused\n");
  assert.equal(fs.readFileSync(path.join(art, "plan.md"), "utf8"), "# plan\n");
  assert.equal(fs.readFileSync(path.join(art, "plan-notes.md"), "utf8"), "notes\n");
  assert.equal(stateGet(art, "plan-decision"), "reused");
  assert.equal(stateGet(art, "tests-sha"), "");
});

test("reuse takes a plan that an earlier adoption reused", () => {
  const { r } = reuseAdopted(adoptedRunDir({ state: "plan-decision=reused\n" }));
  assert.equal(r.status, 0, r.stderr);
});

test("reuse takes a run made before plan-decision was recorded, which kept tests-sha in state or in tests.sha", () => {
  for (const opts of [{ state: "tests-sha=abc123\n" }, { legacy: "abc123\n" }]) {
    const { r } = reuseAdopted(adoptedRunDir(opts));
    assert.equal(r.status, 0, `${JSON.stringify(opts)}: ${r.stderr}`);
    assert.equal(r.stdout, "reused\n");
  }
});

test("reuse refuses a run whose plan was not approved, and one with no plan", () => {
  const open = reuseAdopted(adoptedRunDir({ state: "plan-loop=open\n" }));
  assert.equal(open.r.status, 1);
  assert.match(open.r.stderr, /the adopted run has no approved plan to reuse/);
  const none = reuseAdopted(adoptedRunDir({ plan: false, state: "plan-decision=approve\n" }));
  assert.equal(none.r.status, 1);
  assert.match(none.r.stderr, /the adopted run has no approved plan to reuse/);
});

// A run's branch as the lane checks see it, after the base branch moved on and the branch was
// rebased onto it: the brief and one more file committed on the branch, and the facts that
// `sync_base` and `intake` recorded.
function branchRun(file = "test/a.test.js") {
  const root = mkRepo();
  write(root, ".archon/lanes.json", { tests: ["test/**"] });
  write(root, "src/a.js", "a\n");
  commitAll(root, "base");
  const art = mkdtemp("artifacts-");
  stateSet(art, "fork-ref", "main");
  stateSet(art, "brief-path", "docs/designs/s/brief.md");
  sh(root, "git", "checkout", "-q", "-b", "work");
  write(root, "docs/designs/s/brief.md", "# s\n");
  commitAll(root, "docs: add the s brief");
  write(root, file, "t\n");
  commitAll(root, "tests: add");
  sh(root, "git", "checkout", "-q", "main");
  write(root, "src/landed.js", "l\n");
  commitAll(root, "landed meanwhile");
  sh(root, "git", "checkout", "-q", "work");
  sh(root, "git", "rebase", "-q", "main");
  return { root, art };
}
const laneNode = (id, b) => runNode(BUILD, id, { cwd: b.root, vars: {}, env: { ARTIFACTS_DIR: b.art } });

test("impl_skipped and lane_mut pass for a branch that holds the brief and tests, also after a rebase, and name an implementation file", () => {
  for (const id of ["impl_skipped", "lane_mut"]) {
    const b = branchRun();
    const ok = laneNode(id, b);
    assert.equal(ok.status, 0, `${id}: ${ok.stderr}`);
    write(b.root, "src/impl.js");
    commitAll(b.root, "impl");
    const bad = laneNode(id, b);
    assert.equal(bad.status, 1, id);
    assert.match(bad.stderr, /wrote outside the tests lane:\nsrc\/impl\.js/);
  }
});

test("impl_join checks the docs set only when the plan excuses the mutation check", () => {
  const b = branchRun();
  assert.equal(laneNode("impl_join", b).stdout, "ok\n");
  write(b.art, "spec-approved.json", { excuses: [{ node: "mutation_cycle", reason: "prose only" }] });
  const bad = laneNode("impl_join", b);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /wrote outside the docs lane:\ntest\/a\.test\.js/);
  const prose = branchRun("docs/guide.md");
  write(prose.art, "spec-approved.json", { excuses: [{ node: "mutation_cycle", reason: "prose only" }] });
  const ok = laneNode("impl_join", prose);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "ok\n");
});

// ---- lanes_declared: the hook must be registered for the provider that runs the stages ---------------

test("lanes_declared needs the lane hook registered for the provider that the run's confined stages use", () => {
  const root = laneRepo();
  write(root, ".claude/settings.json", { hooks: { PreToolUse: [{ hooks: [{ command: "node lane-hook.mjs" }] }] } });
  const art = mkdtemp("artifacts-");
  const codexHome = mkdtemp("codex-home-");
  const dbFile = path.join(KIT.dir, "archon.db");
  const store = (provider) => {
    fs.rmSync(dbFile, { force: true });
    const db = new DatabaseSync(dbFile);
    db.exec("create table remote_agent_workflow_runs (id text primary key, metadata text)");
    const aliases = { medium: { provider, model: "m" } };
    db.prepare("insert into remote_agent_workflow_runs values (?, ?)").run(
      path.basename(art),
      JSON.stringify({ model_bindings: { effective: { aliases } } }),
    );
    db.close();
  };
  const declared = () => runNode(BUILD, "lanes_declared", { cwd: root, vars: {}, env: { ARTIFACTS_DIR: art, CODEX_HOME: codexHome } });
  try {
    store("claude");
    assert.equal(declared().status, 0, "a Claude run with the Claude registration");
    store("codex");
    const bad = declared();
    assert.equal(bad.status, 1, "a Codex run with only the Claude registration");
    assert.match(bad.stderr, /not registered for codex/);
    write(root, ".codex/config.toml", '[[hooks.PreToolUse]]\ncommand = "node ~/.archon/scripts/lane-hook.mjs"\n');
    assert.equal(declared().status, 0, "a Codex run with the Codex registration");
    fs.rmSync(dbFile, { force: true });
    assert.equal(declared().status, 0, "with no stored run, any registration is enough");
  } finally {
    fs.rmSync(dbFile, { force: true });
  }
});

// The gates of the round that can fail the run, the failure of the fifth not-ready round and the base check.
function gatesRepo(ordered) {
  const l = mkLoop();
  write(l.root, ".archon/gates.json", { feature: { parallel: [], ordered } });
  commitAll(l.root, "declare the gates");
  return l;
}
const gatesNode = (l) => runNode(BUILD, "gates", { cwd: l.root, vars: {}, env: { ARTIFACTS_DIR: l.art } });
const gateRows = (l) => fs.readFileSync(path.join(l.art, "gate-report.md"), "utf8").match(/^\| `(?!clean working tree`)/gm)?.length ?? 0;

test("gates stops at the first red gate in the first four red rounds", () => {
  for (const rounds of ["", "1", "2", "3"]) {
    const l = gatesRepo(["false", "touch second.ran", "touch third.ran"]);
    if (rounds) stateSet(l.art, "not-ready-rounds", rounds);
    const r = gatesNode(l);
    assert.match(r.stdout, /red\n$/, r.stderr);
    assert.equal(stateGet(l.art, "gates-status"), "red");
    assert.equal(gateRows(l), 1, `after ${rounds || 0} red rounds`);
    assert.ok(!fs.existsSync(path.join(l.root, "second.ran")));
  }
});

test("gates runs every gate in the round after four red rounds, so the failure can name every red gate", () => {
  const l = gatesRepo(["false", "touch second.ran", "test -f missing.txt"]);
  stateSet(l.art, "not-ready-rounds", "4");
  const r = gatesNode(l);
  assert.match(r.stdout, /red\n$/, r.stderr);
  assert.equal(gateRows(l), 3);
  assert.ok(fs.existsSync(path.join(l.root, "second.ran")));
});

test("gates prints green for a passing set after four red rounds", () => {
  const l = gatesRepo(["true", "true"]);
  stateSet(l.art, "not-ready-rounds", "4");
  assert.match(gatesNode(l).stdout, /green\n$/);
  assert.equal(stateGet(l.art, "gates-status"), "green");
});

// The fifth not-ready round in a row, in a repository that declares three gates, with a last-round report that lists two.
const TWO_ROWS = "| gate | result |\n| --- | --- |\n| `npm ci` | passed |\n| `npm test` | **FAILED** |\n\n### Output of failing gate `npm test`\n\n```\nboom\n```\n";
function fifthRound({ verdict = "clean", gatesStatus = "red", report = TWO_ROWS } = {}) {
  const l = gatesRepo(["npm ci", "npm test", "npm run lint"]);
  stateSet(l.art, "review-verdict", verdict);
  stateSet(l.art, "gates-status", gatesStatus);
  stateSet(l.art, "not-ready-rounds", "4");
  if (report !== null) fs.writeFileSync(path.join(l.art, "gate-report.md"), report);
  return { l, r: readyNode(l, "build") };
}
const FAILURE = "The build loop stopped: the last 5 rounds in a row did not pass. A round passes when every gate passes and the review says clean.";
const continueLine = (l) =>
  `The branch keeps its commits in ${l.root}. To continue from it, run \`archon workflow run build --adopt ${path.basename(l.art)} --detach\` from the repository.\n`;

test("ready fails the fifth not-ready round, naming the failing gate, the gates that did not run, the verdict and how to continue", () => {
  const { l, r } = fifthRound();
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, `${FAILURE} In the last round \`npm test\` failed and the review said clean. These gates did not run: \`npm run lint\`.\n${continueLine(l)}`);
  assert.equal(stateGet(l.art, "not-ready-rounds"), "5");
});

test("ready lists every failing gate and leaves out the did-not-run sentence when every gate ran", () => {
  const rows = "| gate | result |\n| --- | --- |\n| `npm ci` | passed |\n| `npm test` | **FAILED** |\n| `npm run lint` | **FAILED** |\n";
  const { l, r } = fifthRound({ report: rows, verdict: "blocked" });
  assert.equal(r.stderr, `${FAILURE} In the last round \`npm test\`, \`npm run lint\` failed and the review said blocked.\n${continueLine(l)}`);
});

test("ready fails a blocked review with green gates and says every gate passed", () => {
  const rows = "| gate | result |\n| --- | --- |\n| `npm ci` | passed |\n| `npm test` | passed |\n| `npm run lint` | passed |\n";
  const { r } = fifthRound({ report: rows, verdict: "blocked", gatesStatus: "green" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /In the last round every gate passed and the review said blocked\.\n/);
});

test("ready fails with a missing gate report as the gates not finishing, and a missing verdict as blocked", () => {
  const { r } = fifthRound({ report: null, verdict: "" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /In the last round the gates did not finish and the review said blocked\.\n/);
});

test("the gates node runs every gate one round before the round that fails the run", () => {
  const yaml = fs.readFileSync(BUILD, "utf8");
  const failAt = Number(/if \[ "\$c" -ge (\d+) \]; then\n\s+# gate-report\.md is the last round's/.exec(yaml)?.[1]);
  const keepAt = Number(/if \[ "\$\{n:-0\}" -ge (\d+) \]; then keep=--keep-going/.exec(yaml)?.[1]);
  assert.ok(failAt >= 2, "the threshold in ready");
  assert.equal(keepAt, failAt - 1);
  assert.match(yaml, new RegExp(`the last ${failAt} rounds in a row did not pass`));
  assert.match(yaml.slice(yaml.indexOf("  - id: build_cycle")), /max_iterations: 30\b/);
});

test("report at a clean pause prints the repair-stage line when a test was repaired", () => {
  const l = mkLoop();
  const h = fakeHome();
  stateSet(l.art, "pause-kind", "clean");
  stateSet(l.art, "deliver", "land");
  fs.writeFileSync(path.join(l.art, "test-repairs.md"), "## simulator/test/a.test.js\n- Old: x\n");
  const picks = JSON.stringify({ summary: "s", picks: [], extra_json: "" });
  const r = reportNode(l, h.home, { "$ready.output": "pause", "$implement.output": "", "$report_pick.output": picks });
  assert.match(r.stdout, /1 test\(s\) changed by the repair stage/);
});

const baseGatesNode = (l) => runNode(BUILD, "base_gates", { cwd: l.root, vars: {}, env: { ARTIFACTS_DIR: l.art } });

test("base_gates prints the script's word for a green base and ends the run with the failing gates for a red one", () => {
  const green = gatesRepo(["true"]);
  const ok = baseGatesNode(green);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "green\n");
  const red = gatesRepo(["true", "test -f missing.txt"]);
  const bad = baseGatesNode(red);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /The base commit is red, so this run cannot succeed/);
  assert.match(bad.stderr, /^ {2}test -f missing\.txt$/m);
  assert.equal(stateGet(red.art, "base-gates"), "red");
});

test("the gates and sync_gates nodes pass --clean-tree to run-gates.sh and red-check does not", () => {
  const text = fs.readFileSync(BUILD, "utf8");
  const node = (id) => {
    const lines = text.split("\n");
    const start = lines.findIndex((l) => l === `        - id: ${id}`);
    assert.ok(start >= 0, `node ${id} exists`);
    let end = lines.findIndex((l, i) => i > start && /^ {8}- id:/.test(l));
    if (end < 0) end = lines.length;
    return lines.slice(start, end).join("\n");
  };
  for (const id of ["gates", "sync_gates"]) {
    assert.match(node(id), /run-gates\.sh" feature .*--clean-tree|run-gates\.sh" feature --clean-tree/, id);
  }
  const red = text.split("\n").filter((l) => l.includes("run-log.sh") && l.includes("red-check"));
  assert.ok(red.length > 0);
  for (const l of red) assert.doesNotMatch(l, /--clean-tree/);
});

// ---- plan_record: a plan with a defect fails the run ------------------------------------------

// A repository whose build.json declares deploy-staging and a publish target, and (when ready) the
// files `build` needs before `check --also build` keeps a build hand-off.
function mkPlanRepo({ ready = false } = {}) {
  const l = mkLoop({ buildJson: { handoffs: [{ workflow: "deploy-staging", use_when: "the build has to be deployed", ask: [], pass_ref: true }] } });
  if (ready) {
    write(l.root, ".archon/gates.json", { feature: { ordered: ["true"] }, tests: { ordered: ["true"] } });
    write(l.root, ".archon/lanes.json", { tests: ["test/**"] });
    write(l.root, ".claude/settings.json", { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "node /x/lane-hook.mjs" }] }] } });
    commitAll(l.root, "ready");
  }
  return l;
}
const specOf = (extra = {}) => JSON.stringify({ summary: "s", files: [], needs_decision: false, question: "", excuses: [], handoffs: [], ...extra });
const planRecordIn = (l, spec, round = "plan") =>
  runNode(BUILD, "plan_record", {
    cwd: l.root,
    vars: { "$plan_round.output": round, "$spec.output": spec },
    env: { ARTIFACTS_DIR: l.art, START_RUN_WORKSPACE: mkdtemp("ws-") },
  });
const defects = (l) => {
  const f = path.join(l.art, "plan-defects.txt");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
};
const deployEntry = { workflow: "deploy-staging", repo: "", inputs: [], note: "deploy it" };
const buildEntry = { workflow: "build", repo: "", inputs: [], note: "publish the docs site" };

test("plan_record fails the run when the planner proposes a hand-off that is not declared, and names it", () => {
  const l = mkPlanRepo();
  const r = planRecordIn(l, specOf({ handoffs: [deployEntry, { workflow: "nonexistent", repo: "", inputs: [], note: "" }] }));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /nonexistent/);
  assert.match(defects(l), /nonexistent/);
  assert.match(fs.readFileSync(path.join(l.art, "handoffs-dropped.txt"), "utf8"), /nonexistent/);
  assert.doesNotMatch(r.stdout, /^(ask|no-ask)$/m);
});

test("plan_record fails the run when a gap has no build hand-off, and says how many of each", () => {
  const l = mkPlanRepo({ ready: true });
  const r = planRecordIn(l, specOf({ gaps: [{ thing: "docs site", why: "nothing publishes it" }], handoffs: [deployEntry] }));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(defects(l), /1 thing\(s\)/);
  assert.match(defects(l), /0 build/);
});

test("plan_record accepts a gap that a build hand-off answers", () => {
  const l = mkPlanRepo({ ready: true });
  const r = planRecordIn(l, specOf({ gaps: [{ thing: "docs site", why: "nothing publishes it" }], handoffs: [buildEntry] }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "ask\n");
  assert.equal(defects(l), "");
});

test("plan_record with no gaps key and a clean hand-off asks, and a spec with nothing says no-ask", () => {
  const l = mkPlanRepo();
  const ask = planRecordIn(l, specOf({ handoffs: [deployEntry] }));
  assert.equal(ask.status, 0, ask.stderr);
  assert.equal(ask.stdout, "ask\n");
  const none = planRecordIn(l, specOf());
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, "no-ask\n");
});

test("plan_record replaces an earlier round's defects, and a settling round writes nothing", () => {
  const l = mkPlanRepo();
  assert.equal(planRecordIn(l, specOf({ handoffs: [{ workflow: "nonexistent", repo: "", inputs: [], note: "" }] })).status, 1);
  assert.match(defects(l), /nonexistent/);
  assert.equal(planRecordIn(l, specOf({ handoffs: [deployEntry] })).status, 0);
  assert.equal(defects(l), "");
  const l2 = mkPlanRepo();
  const settled = planRecordIn(l2, "");
  assert.equal(settled.stdout, "no-ask\n");
  assert.equal(defects(l2), null);
});

test("spec asks for gaps and plan_record's candidates include build", () => {
  const yaml = fs.readFileSync(BUILD, "utf8");
  const spec = yaml.slice(yaml.indexOf("- id: spec\n"), yaml.indexOf("- id: spec\n") + 12000);
  assert.match(spec, /\bgaps\b/);
  assert.match(yaml, /candidates --also build/);
});

// ---- report: the publish targets the change triggers ------------------------------------------

// A repository on a branch that changes `changed` off main, declaring a docs-site publish target.
function mkPublishLoop(changed, { publish } = {}) {
  const l = mkLoop({ buildJson: { publish: publish ?? [{ name: "docs-site", command: "true", auto_paths: ["docs/**"], use_when: "docs change" }] } });
  sh(l.root, "git", "checkout", "-q", "-b", "work");
  write(l.root, changed, "changed\n");
  commitAll(l.root, "change");
  return l;
}
const reportWith = (l, ready, deliver, extra = {}) => {
  const h = fakeHome({ realMatch: true });
  stateSet(l.art, "pause-kind", "clean");
  stateSet(l.art, "deliver", deliver);
  const picks = JSON.stringify({ summary: "s", picks: [], extra_json: "" });
  return reportNode(l, h.home, { "$ready.output": ready, "$implement.output": "", "$report_pick.output": picks, ...extra });
};

test("report records the matched publish targets and says the run starts them after landing, at a pause and at auto", () => {
  for (const ready of ["pause", "auto"]) {
    const l = mkPublishLoop("docs/a.md");
    const r = reportWith(l, ready, "land");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^After landing this run also starts: publish docs-site$/m, ready);
    const matched = JSON.parse(fs.readFileSync(path.join(l.art, "publish-matched.json"), "utf8"));
    assert.deepEqual(matched.map((m) => m.inputs[0].value), ["docs-site"]);
  }
});

test("report says a draft-pull-request run does not start the publish targets", () => {
  const l = mkPublishLoop("docs/a.md");
  const r = reportWith(l, "pause", "draft-pr");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Not started by this run, because it delivers a draft pull request: publish docs-site$/m);
  assert.doesNotMatch(r.stdout, /After landing/);
});

test("report prints no publish line when the change touches no target's paths", () => {
  const l = mkPublishLoop("src/a.js");
  const r = reportWith(l, "pause", "land");
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /After landing|Not started by this run/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(l.art, "publish-matched.json"), "utf8")), []);
});

test("report fails when the publish match fails", () => {
  const l = mkPublishLoop("docs/a.md");
  const r = reportWith(l, "pause", "land", { "$sync_base.output": "no-such-branch" });
  assert.equal(r.status, 1);
});

// ---- handoff: every hand-off starts, or the run fails -----------------------------------------

// A fake `archon` that logs each call and prints a run id, failing for each workflow named in FAIL (comma-separated).
function strictArchon() {
  const root = mkdtemp("strict-archon-");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const log = path.join(root, "calls.jsonl");
  fs.writeFileSync(
    path.join(bin, "archon"),
    `#!/usr/bin/env bash
jq -cn --arg cwd "$PWD" '{cwd: $cwd, args: $ARGS.positional}' --args -- "$@" >> "${log}"
case ",\${FAIL:-}," in *",$3,"*) echo "Error: no such workflow $3" >&2; exit 1 ;; esac
printf 'Run id: run-%s\\n' "$3"
`,
    { mode: 0o755 },
  );
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((x) => JSON.parse(x)) : []);
  return { env: { PATH: `${bin}:${process.env.PATH}`, START_RUN_WORKSPACE: root, START_RUN_RETRY_SLEEP: "0" }, calls };
}
const HANDOFF_DECL = {
  handoffs: [
    { workflow: "deploy-staging", use_when: "deploy", ask: [], pass_ref: true },
    { workflow: "other", use_when: "other", ask: [] },
  ],
  publish: [{ name: "docs-site", command: "true", auto_paths: ["docs/**"], use_when: "docs" }],
};
const handoffNode = (l, a, { how = "land", env = {} } = {}) =>
  runNode(BUILD, "handoff", {
    cwd: l.root,
    vars: { "$sync_base.output": "main", "$ship_decision.output": how },
    env: { ARTIFACTS_DIR: l.art, ...a.env, ...env },
  });
const writeArt = (l, name, value) => fs.writeFileSync(path.join(l.art, name), JSON.stringify(value));
const startedFile = (l) => {
  const f = path.join(l.art, "handoffs-started.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
};
const pubEntry = { workflow: "publish", repo: "", inputs: [{ name: "target", value: "docs-site" }], note: "changed docs/a.md" };

test("handoff starts an approved hand-off once, records it, and starts nothing when it runs again", () => {
  const l = mkLoop({ buildJson: HANDOFF_DECL });
  const a = strictArchon();
  writeArt(l, "handoffs-approved.json", [deployEntry]);
  const first = handoffNode(l, a);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /^started deploy-staging, run run-deploy-staging$/m);
  assert.equal(a.calls().length, 1);
  const rec = startedFile(l);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].workflow, "deploy-staging");
  assert.equal(rec[0].run, "run-deploy-staging");
  const again = handoffNode(l, a);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(a.calls().length, 1);
});

test("handoff starts a hand-off that the plan and the publish match both name only once", () => {
  const l = mkLoop({ buildJson: HANDOFF_DECL });
  const a = strictArchon();
  writeArt(l, "handoffs-approved.json", [pubEntry]);
  writeArt(l, "publish-matched.json", [pubEntry]);
  const r = handoffNode(l, a);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(a.calls().length, 1);
  assert.ok(a.calls()[0].args.includes("target=docs-site"));
});

test("handoff starts a publish hand-off that only the publish match names", () => {
  const l = mkLoop({ buildJson: HANDOFF_DECL });
  const a = strictArchon();
  writeArt(l, "publish-matched.json", [pubEntry]);
  const r = handoffNode(l, a);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^started publish, run run-publish$/m);
});

test("handoff fails the run when a hand-off does not start, and records nothing", () => {
  const l = mkLoop({ buildJson: HANDOFF_DECL });
  const a = strictArchon();
  writeArt(l, "handoffs-approved.json", [deployEntry]);
  const r = handoffNode(l, a, { env: { FAIL: "deploy-staging" } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /did not start deploy-staging/);
  assert.equal(startedFile(l), null);
});

test("handoff keeps the record of the hand-offs that started when a later one fails", () => {
  const l = mkLoop({ buildJson: HANDOFF_DECL });
  const a = strictArchon();
  writeArt(l, "handoffs-approved.json", [deployEntry, { workflow: "other", repo: "", inputs: [], note: "" }]);
  const r = handoffNode(l, a, { env: { FAIL: "other" } });
  assert.equal(r.status, 1);
  assert.deepEqual(startedFile(l).map((x) => x.workflow), ["deploy-staging"]);
  const retry = handoffNode(l, a);
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.equal(a.calls().filter((c) => c.args.includes("deploy-staging")).length, 1);
});

test("handoff skips a publish hand-off for a draft pull request and still starts the others", () => {
  const l = mkLoop({ buildJson: HANDOFF_DECL });
  const a = strictArchon();
  writeArt(l, "handoffs-approved.json", [deployEntry]);
  writeArt(l, "publish-matched.json", [pubEntry]);
  const r = handoffNode(l, a, { how: "draft-pr" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /skipped publish/);
  assert.deepEqual(a.calls().map((c) => c.args[2]), ["deploy-staging"]);
});

test("handoff with no entries says no hand-offs and exits 0", () => {
  const l = mkLoop({ buildJson: HANDOFF_DECL });
  const a = strictArchon();
  const r = handoffNode(l, a);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no hand-offs/);
  assert.equal(a.calls().length, 0);
});
