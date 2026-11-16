import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { STAGES } from "../scripts/lane-hook.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const LANE = path.join(here, "..", "scripts", "lane.sh");

const made = [];
const mkdtemp = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.homedir(), prefix));
  made.push(d);
  return fs.realpathSync(d);
};
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const sh = (cwd, cmd, ...args) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const lane = (cwd, ...args) => spawnSync("bash", [LANE, ...args], { cwd, encoding: "utf8" });
const write = (root, rel, body = "x\n") => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

function mkRepo(lanes = { tests: ["test/**"], protected: ["kit/**"] }) {
  const root = mkdtemp("lane-test-");
  sh(root, "git", "init", "-q", "-b", "main");
  sh(root, "git", "config", "user.email", "t@example.com");
  sh(root, "git", "config", "user.name", "t");
  write(root, ".archon/lanes.json", JSON.stringify(lanes));
  write(root, "src/a.js");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "base");
  return root;
}

const head = (root) => sh(root, "git", "rev-parse", "HEAD").trim();
const commit = (root, rel) => {
  write(root, rel, "changed\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", `change ${rel}`);
};

test("list prints the default set and a named set as pathspecs", () => {
  const root = mkRepo();
  assert.equal(lane(root, "list").stdout, ":(glob)test/**\n");
  assert.equal(lane(root, "list", "--set", "protected").stdout, ":(glob)kit/**\n");
});

test("the docs set defaults to every Markdown file and a declared set replaces the default", () => {
  const root = mkRepo();
  assert.equal(lane(root, "list", "--set", "docs").stdout, ":(glob)**/*.md\n");
  const declared = mkRepo({ tests: ["test/**"], docs: ["guide/**", "*.rst"] });
  assert.equal(lane(declared, "list", "--set", "docs").stdout, ":(glob)guide/**\n:(glob)*.rst\n");
});

test("check --set docs passes for Markdown changes and fails when a source file also changed", () => {
  const root = mkRepo();
  const base = head(root);
  commit(root, "README.md");
  commit(root, "docs/a.md");
  assert.equal(lane(root, "check", "--set", "docs", base, "in").status, 0);
  commit(root, "src/b.js");
  const r = lane(root, "check", "--set", "docs", base, "in");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /wrote outside the docs lane:\nsrc\/b\.js/);
});

test("a set other than docs still fails when lanes.json does not declare it", () => {
  const root = mkRepo({ tests: ["test/**"] });
  const r = lane(root, "list", "--set", "protected");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /declares no "protected" globs/);
});

test("list fails when the set or the file is missing", () => {
  const root = mkRepo();
  const missing = lane(root, "list", "--set", "untested");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /declares no "untested" globs/);
  fs.rmSync(path.join(root, ".archon/lanes.json"));
  const none = lane(root, "list");
  assert.equal(none.status, 1);
  assert.match(none.stderr, /declares no lanes/);
});

test("check in passes for a change inside the lane and fails for one outside it", () => {
  const root = mkRepo();
  const base = head(root);
  commit(root, "test/a.js");
  assert.equal(lane(root, "check", base, "in").status, 0);
  commit(root, "src/b.js");
  const r = lane(root, "check", base, "in");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /wrote outside the tests lane:\nsrc\/b\.js/);
});

test("check out fails for a change inside the lane", () => {
  const root = mkRepo();
  const base = head(root);
  commit(root, "src/b.js");
  assert.equal(lane(root, "check", base, "out").status, 0);
  commit(root, "test/a.js");
  const r = lane(root, "check", base, "out");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /wrote inside the tests lane:\ntest\/a\.js/);
});

test("check counts an uncommitted file and a named set", () => {
  const root = mkRepo();
  const base = head(root);
  write(root, "kit/x.js");
  assert.equal(lane(root, "check", "--set", "protected", base, "in").status, 0);
  assert.equal(lane(root, "check", base, "in").status, 1);
});

test("a stage that changed nothing fails unless --allow-empty is given", () => {
  const root = mkRepo();
  const base = head(root);
  const r = lane(root, "check", base, "in");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /this stage changed nothing/);
  assert.equal(lane(root, "check", "--allow-empty", base, "in").status, 0);
});

test("check refuses an unknown mode", () => {
  const root = mkRepo();
  const base = head(root);
  commit(root, "test/a.js");
  const r = lane(root, "check", base, "sideways");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown mode "sideways"/);
});

const BRIEF = "docs/designs/s/brief.md";

// A branch that holds what a build run's branch holds before its stages write anything: a brief
// commit outside the lane, and then a commit of tests.
function mkBranch() {
  const root = mkRepo();
  sh(root, "git", "checkout", "-q", "-b", "work");
  commit(root, BRIEF);
  commit(root, "test/a.js");
  return root;
}

test("check --since lists what the branch changed since it left the base branch, and --exclude leaves the brief out", () => {
  const root = mkBranch();
  const r = lane(root, "check", "--since", "main", "in");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /wrote outside the tests lane:\ndocs\/designs\/s\/brief\.md/);
  assert.equal(lane(root, "check", "--since", "main", "--exclude", BRIEF, "in").status, 0);
});

test("check --since gives the same answer after the base branch moved on and the branch was rebased onto it", () => {
  const root = mkBranch();
  assert.equal(lane(root, "check", "--since", "main", "--exclude", BRIEF, "in").status, 0);
  sh(root, "git", "checkout", "-q", "main");
  commit(root, "src/landed-meanwhile.js");
  sh(root, "git", "checkout", "-q", "work");
  sh(root, "git", "rebase", "-q", "main");
  assert.equal(lane(root, "check", "--since", "main", "--exclude", BRIEF, "in").status, 0);
  commit(root, "src/impl.js");
  const r = lane(root, "check", "--since", "main", "--exclude", BRIEF, "in");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /wrote outside the tests lane:\nsrc\/impl\.js/);
});

test("check --since counts an uncommitted file, and --exclude leaves out an uncommitted brief", () => {
  const root = mkBranch();
  write(root, BRIEF, "edited\n");
  assert.equal(lane(root, "check", "--since", "main", "--exclude", BRIEF, "in").status, 0);
  write(root, "src/x.js");
  assert.equal(lane(root, "check", "--since", "main", "--exclude", BRIEF, "in").status, 1);
});

test("check --exclude takes a directory with a trailing slash, can be repeated, and ignores an empty value", () => {
  const root = mkBranch();
  commit(root, "docs/designs/s/extra.md");
  assert.equal(lane(root, "check", "--since", "main", "--exclude", "docs/designs/s/", "in").status, 0);
  assert.equal(lane(root, "check", "--since", "main", "--exclude", BRIEF, "--exclude", "docs/designs/s/extra.md", "in").status, 0);
  assert.equal(lane(root, "check", "--since", "main", "--exclude", BRIEF, "in").status, 1);
  assert.equal(lane(root, "check", "--since", "main", "--exclude", "", "in").status, 1);
});

test("check --exclude works with a base commit as well", () => {
  const root = mkRepo();
  const base = head(root);
  commit(root, BRIEF);
  assert.equal(lane(root, "check", "--exclude", BRIEF, "--allow-empty", base, "in").status, 0);
  assert.equal(lane(root, "check", base, "in").status, 1);
});

test("a branch whose only change is the excluded brief changed nothing", () => {
  const root = mkRepo();
  sh(root, "git", "checkout", "-q", "-b", "work");
  commit(root, BRIEF);
  const r = lane(root, "check", "--since", "main", "--exclude", BRIEF, "in");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /this stage changed nothing/);
  assert.equal(lane(root, "check", "--since", "main", "--exclude", BRIEF, "--allow-empty", "in").status, 0);
});

test("check --since names the ref it cannot find, and an empty ref is a usage error", () => {
  const root = mkBranch();
  const missing = lane(root, "check", "--since", "origin/main", "in");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot find where HEAD left origin\/main/);
  const empty = lane(root, "check", "--since", "", "in");
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /--since needs a ref/);
});

test("check --since still applies the mode and the named set", () => {
  const root = mkBranch();
  const out = lane(root, "check", "--since", "main", "--exclude", BRIEF, "out");
  assert.equal(out.status, 1);
  assert.match(out.stderr, /wrote inside the tests lane:\ntest\/a\.js/);
  const docs = lane(root, "check", "--set", "docs", "--since", "main", "in");
  assert.equal(docs.status, 1);
  assert.match(docs.stderr, /wrote outside the docs lane:\ntest\/a\.js/);
  const bad = lane(root, "check", "--set", "docs", "--since", "main", "sideways");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown mode "sideways"/);
});

test("stage and unstage write and delete the marker", () => {
  const root = mkRepo();
  const marker = path.join(root, ".git", "archon-stage");
  assert.equal(lane(root, "stage", "implement", "/a/b", "/c d").status, 0);
  const written = JSON.parse(fs.readFileSync(marker, "utf8"));
  assert.match(written.snapshot, /^[0-9a-f]{40}$/);
  assert.deepEqual({ ...written, snapshot: undefined }, { stage: "implement", allow: ["/a/b", "/c d"], snapshot: undefined });
  assert.equal(written.snapshot, sh(root, "git", "rev-parse", "HEAD^{tree}").trim());
  assert.equal(lane(root, "unstage").status, 0);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(lane(root, "unstage").status, 0);
});

test("verify needs the hook registered in .claude/settings.json", () => {
  const root = mkRepo();
  assert.match(lane(root, "verify").stderr, /does not enforce the lanes/);
  write(root, ".claude/settings.json", JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "sh -c 'exec node ${ARCHON_HOME:-$HOME/.archon}/scripts/lane-hook.mjs'" }] }] } }));
  assert.equal(lane(root, "verify").status, 0);
});

test("verify also accepts a Codex registration of the hook and a build.json that asks for the stage-end check alone", () => {
  const codexHome = mkdtemp("lane-codex-");
  const verify = (root) => spawnSync("bash", [LANE, "verify"], { cwd: root, encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome } });
  const root = mkRepo();
  assert.equal(verify(root).status, 1);
  write(root, ".codex/config.toml", "model = 'x'\n");
  assert.equal(verify(root).status, 1, "a Codex config that does not mention the hook");
  write(root, ".codex/config.toml", '[[hooks.PreToolUse]]\ncommand = "node ~/.archon/scripts/lane-hook.mjs"\n');
  assert.equal(verify(root).status, 0, "the repository's .codex/config.toml");
  fs.rmSync(path.join(root, ".codex"), { recursive: true });
  assert.equal(verify(root).status, 1);
  write(root, ".codex/hooks.json", JSON.stringify({ hooks: { PreToolUse: [{ command: "node lane-hook.mjs" }] } }));
  assert.equal(verify(root).status, 0, "the repository's .codex/hooks.json");
  fs.rmSync(path.join(root, ".codex"), { recursive: true });
  write(codexHome, "config.toml", "# archon-kit:lane-hook:start\ncommand = 'lane-hook.mjs'\n");
  assert.equal(verify(root).status, 0, "config.toml under CODEX_HOME");
  fs.rmSync(path.join(codexHome, "config.toml"));
  assert.equal(verify(root).status, 1);
  write(codexHome, "hooks.json", JSON.stringify({ x: "lane-hook.mjs" }));
  assert.equal(verify(root).status, 0, "hooks.json under CODEX_HOME");
  fs.rmSync(path.join(codexHome, "hooks.json"));
  write(root, ".archon/build.json", JSON.stringify({ lane_enforcement: "check" }));
  assert.equal(verify(root).status, 0, "lane_enforcement check");
  write(root, ".archon/build.json", JSON.stringify({ lane_enforcement: "hook" }));
  assert.equal(verify(root).status, 1);
});

// ---- verify and providers, by provider -----------------------------------------------------------

const CLAUDE_HOOK = { hooks: { PreToolUse: [{ hooks: [{ command: "sh -c 'exec node ${ARCHON_HOME:-$HOME/.archon}/scripts/lane-hook.mjs'" }] }] } };
const CODEX_HOOK = '[[hooks.PreToolUse]]\ncommand = "node ~/.archon/scripts/lane-hook.mjs"\n';
const verifyFor = (root, providers, codexHome) =>
  spawnSync("bash", [LANE, "verify", ...providers.flatMap((p) => ["--provider", p])], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: codexHome },
  });
const repoWith = ({ claude = false, codex = false } = {}) => {
  const root = mkRepo();
  if (claude) write(root, ".claude/settings.json", JSON.stringify(CLAUDE_HOOK));
  if (codex) write(root, ".codex/config.toml", CODEX_HOOK);
  return root;
};

test("verify --provider needs the registration for that provider, and no other provider's registration stands in for it", () => {
  const codexHome = mkdtemp("lane-codex-");
  const claudeOnly = repoWith({ claude: true });
  assert.equal(verifyFor(claudeOnly, ["claude"], codexHome).status, 0);
  const noCodex = verifyFor(claudeOnly, ["codex"], codexHome);
  assert.equal(noCodex.status, 1);
  assert.match(noCodex.stderr, /not registered for codex/);
  const codexOnly = repoWith({ codex: true });
  assert.equal(verifyFor(codexOnly, ["codex"], codexHome).status, 0);
  const noClaude = verifyFor(codexOnly, ["claude"], codexHome);
  assert.equal(noClaude.status, 1);
  assert.match(noClaude.stderr, /not registered for claude/);
});

test("verify --provider can be repeated and needs every named provider, and naming none keeps the any-of rule", () => {
  const codexHome = mkdtemp("lane-codex-");
  const both = repoWith({ claude: true, codex: true });
  assert.equal(verifyFor(both, ["claude", "codex"], codexHome).status, 0);
  const claudeOnly = repoWith({ claude: true });
  const missing = verifyFor(claudeOnly, ["claude", "codex"], codexHome);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not registered for codex/);
  assert.doesNotMatch(missing.stderr, /not registered for claude/);
  assert.equal(verifyFor(claudeOnly, [], codexHome).status, 0);
  assert.equal(verifyFor(repoWith({ codex: true }), [], codexHome).status, 0);
});

test("verify --provider accepts lane_enforcement check for every provider, and refuses a provider that has no lane hook", () => {
  const codexHome = mkdtemp("lane-codex-");
  const root = repoWith({ claude: true });
  const unknown = verifyFor(root, ["opencode"], codexHome);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /the kit has no lane hook for opencode/);
  write(root, ".archon/build.json", JSON.stringify({ lane_enforcement: "check" }));
  for (const providers of [["codex"], ["claude", "codex"], ["opencode"]]) {
    assert.equal(verifyFor(root, providers, codexHome).status, 0, providers.join());
  }
});

// A scratch Archon home whose database holds one run with this metadata.
const archonHome = (metadata, runId = "0a1b2c3d4e5f60718293a4b5c6d7e8f9") => {
  const home = mkdtemp("lane-home-");
  const db = new DatabaseSync(path.join(home, "archon.db"));
  db.exec("create table remote_agent_workflow_runs (id text primary key, metadata text)");
  db.prepare("insert into remote_agent_workflow_runs values (?, ?)").run(runId, JSON.stringify(metadata));
  db.close();
  return home;
};
const tiers = (small, medium, large) => ({
  small: { provider: small, model: "s" },
  medium: { provider: medium, model: "m" },
  large: { provider: large, model: "l" },
});
const providersFor = (home, artifacts) =>
  spawnSync("bash", [LANE, "providers"], {
    encoding: "utf8",
    env: { ...process.env, ARCHON_HOME: home, ARTIFACTS_DIR: artifacts ?? "" },
  });
const RUN = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";

test("providers prints the provider of the tier that the confined stages run on, from the run's effective bindings", () => {
  const home = archonHome({
    model_bindings: { effective: { defaultProvider: "claude", aliases: tiers("claude", "codex", "opencode") } },
    ai_configuration: { baseAiProfile: { aliases: tiers("claude", "claude", "claude") } },
  });
  const r = providersFor(home, `/somewhere/artifacts/runs/${RUN}`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "codex\n");
});

test("providers opens a database whose path holds ?, # and %", () => {
  const src = archonHome({ model_bindings: { effective: { defaultProvider: "claude", aliases: tiers("claude", "codex", "opencode") } } });
  const odd = path.join(mkdtemp("lane-odd-"), "a?b#c%25d e");
  fs.mkdirSync(odd);
  fs.copyFileSync(path.join(src, "archon.db"), path.join(odd, "archon.db"));
  assert.equal(providersFor(odd, `/somewhere/artifacts/runs/${RUN}`).stdout, "codex\n");
});

test("providers falls back to the run's AI configuration when no bindings were stored", () => {
  const home = archonHome({ ai_configuration: { baseAiProfile: { aliases: tiers("claude", "claude", "claude") } } });
  assert.equal(providersFor(home, `/x/${RUN}`).stdout, "claude\n");
});

test("providers prints nothing and succeeds when the run, the database or ARTIFACTS_DIR is not there, so verify keeps its any-of rule", () => {
  const home = archonHome({ model_bindings: { effective: { aliases: tiers("a", "codex", "c") } } });
  for (const [label, r] of [
    ["another run", providersFor(home, "/x/ffffffffffffffffffffffffffffffff")],
    ["no ARTIFACTS_DIR", providersFor(home, "")],
    ["no database", providersFor(mkdtemp("lane-empty-"), `/x/${RUN}`)],
  ]) {
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    assert.equal(r.stdout, "", label);
  }
});

test("every stage that lane.sh confines runs on the tier that `providers` reads", () => {
  const yaml = fs.readFileSync(path.join(here, "..", "workflows", "build", "build.yaml"), "utf8").split("\n");
  for (const id of ["tests", "repair_tests", "mut_fix", "implement", "sync_fix"]) {
    const at = yaml.findIndex((l) => new RegExp(`^ *- id: ${id}$`).test(l));
    assert.ok(at >= 0, `no node ${id}`);
    const model = yaml.slice(at, at + 12).find((l) => /^ *model:/.test(l));
    assert.match(model ?? "", /model: medium$/, `${id} runs on the medium tier`);
  }
  const home = archonHome({ model_bindings: { effective: { aliases: tiers("claude", "codex", "opencode") } } });
  assert.equal(providersFor(home, `/x/${RUN}`).stdout, "codex\n");
});

// ---- unstage --verify ---------------------------------------------------------------------------

const marker = (root) => path.join(root, ".git", "archon-stage");

test("unstage --verify with no marker passes, and a marker without a snapshot is removed with one line on stderr", () => {
  const root = mkRepo();
  const none = lane(root, "unstage", "--verify");
  assert.equal(none.status, 0);
  assert.equal(none.stderr, "");
  for (const body of ["implement", JSON.stringify({ stage: "implement", allow: [] }), "{nope"]) {
    fs.writeFileSync(marker(root), body);
    write(root, "test/a.js");
    const r = lane(root, "unstage", "--verify");
    assert.equal(r.status, 0, body);
    assert.match(r.stderr, /no snapshot/);
    assert.equal(fs.existsSync(marker(root)), false);
  }
});

test("a tests stage may write inside the tests lane and not outside it, and the marker is gone either way", () => {
  const root = mkRepo();
  lane(root, "stage", "tests");
  write(root, "test/new.test.js");
  assert.equal(lane(root, "unstage", "--verify").status, 0);
  assert.equal(fs.existsSync(marker(root)), false);

  lane(root, "stage", "tests");
  write(root, "test/more.test.js");
  write(root, "src/changed.js");
  const r = lane(root, "unstage", "--verify");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the tests stage wrote outside the tests lane:\nsrc\/changed\.js\n$/);
  assert.equal(fs.existsSync(marker(root)), false);
});

test("a repair stage is held to the tests lane like a tests stage", () => {
  const root = mkRepo();
  lane(root, "stage", "repair");
  write(root, "src/a.js", "edited\n");
  assert.match(lane(root, "unstage", "--verify").stderr, /the repair stage wrote outside the tests lane:\nsrc\/a\.js/);
});

test("an implement stage may write outside the tests lane and not inside it", () => {
  const root = mkRepo();
  lane(root, "stage", "implement");
  write(root, "src/impl.js");
  assert.equal(lane(root, "unstage", "--verify").status, 0);

  lane(root, "stage", "implement");
  write(root, "src/impl2.js");
  write(root, "test/sneaky.js");
  const r = lane(root, "unstage", "--verify");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the implement stage wrote inside the tests lane:\ntest\/sneaky\.js\n$/);
});

test("the check sees a write that no hook sees: a modified, deleted or untracked file, staged or not, and one committed", () => {
  const root = mkRepo();
  write(root, "test/old.js");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "old test");
  lane(root, "stage", "implement");
  write(root, "test/old.js", "edited\n");
  assert.match(lane(root, "unstage", "--verify").stderr, /test\/old\.js/, "modified");

  lane(root, "stage", "implement");
  fs.rmSync(path.join(root, "test/old.js"));
  assert.match(lane(root, "unstage", "--verify").stderr, /test\/old\.js/, "deleted");

  lane(root, "stage", "implement");
  write(root, "test/untracked.js");
  assert.match(lane(root, "unstage", "--verify").stderr, /test\/untracked\.js/, "untracked");

  lane(root, "stage", "implement");
  write(root, "test/staged.js");
  sh(root, "git", "add", "test/staged.js");
  assert.match(lane(root, "unstage", "--verify").stderr, /test\/staged\.js/, "staged");

  lane(root, "stage", "implement");
  write(root, "test/committed.js");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "commit the test");
  assert.match(lane(root, "unstage", "--verify").stderr, /test\/committed\.js/, "committed");
});

test("work that was uncommitted when the stage began is not blamed on it, and the real index is untouched", () => {
  const root = mkRepo();
  write(root, "test/author.test.js", "the test author's work\n");
  write(root, "test/staged.test.js", "staged\n");
  sh(root, "git", "add", "test/staged.test.js");
  const indexBefore = sh(root, "git", "ls-files", "--stage");
  lane(root, "stage", "implement");
  write(root, "src/impl.js");
  assert.equal(lane(root, "unstage", "--verify").status, 0);
  assert.equal(sh(root, "git", "ls-files", "--stage"), indexBefore);
  assert.match(sh(root, "git", "status", "--porcelain"), /\?\? test\/author\.test\.js/);
});

test("a dependency install's lockfile change is not blamed, and an ignored file is not counted", () => {
  const root = mkRepo({ tests: ["**"] });
  write(root, ".gitignore", "build/\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "ignore build");
  lane(root, "stage", "tests");
  for (const f of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "Cargo.lock", "poetry.lock", "uv.lock", "go.sum", "sub/package-lock.json"]) write(root, f);
  write(root, "build/out.js");
  assert.equal(lane(root, "unstage", "--verify").status, 0);
  const only = mkRepo();
  lane(only, "stage", "tests");
  write(only, "package-lock.json");
  assert.equal(lane(only, "unstage", "--verify").status, 0);
});

test("a stage that changed nothing passes", () => {
  const root = mkRepo();
  for (const stage of ["tests", "repair", "implement", "sync_fix"]) {
    lane(root, "stage", stage);
    assert.equal(lane(root, "unstage", "--verify").status, 0, stage);
  }
});

test("a sync_fix stage is held to the protected lane when lanes.json declares one, and to nothing when it does not", () => {
  const root = mkRepo();
  lane(root, "stage", "sync_fix");
  write(root, "src/fix.js");
  assert.equal(lane(root, "unstage", "--verify").status, 0);
  lane(root, "stage", "sync_fix");
  write(root, "kit/locked.js");
  assert.match(lane(root, "unstage", "--verify").stderr, /the sync_fix stage wrote inside the protected lane:\nkit\/locked\.js/);

  const none = mkRepo({ tests: ["test/**"] });
  lane(none, "stage", "sync_fix");
  write(none, "kit/anything.js");
  assert.equal(lane(none, "unstage", "--verify").status, 0);
  const noFile = mkRepo();
  fs.rmSync(path.join(noFile, ".archon/lanes.json"));
  lane(noFile, "stage", "sync_fix");
  write(noFile, "kit/anything.js");
  assert.equal(lane(noFile, "unstage", "--verify").status, 0);
});

test("a path the stage was told it may write, inside the worktree, is not blamed", () => {
  const root = mkRepo();
  lane(root, "stage", "implement", path.join(root, "test", "allowed"));
  write(root, "test/allowed/notes.md");
  assert.equal(lane(root, "unstage", "--verify").status, 0);
  lane(root, "stage", "implement", path.join(root, "test", "allowed"));
  write(root, "test/allowed/notes.md", "again\n");
  write(root, "test/other/notes.md");
  assert.match(lane(root, "unstage", "--verify").stderr, /test\/other\/notes\.md/);
});

test("a stage the table does not know is passed with a note", () => {
  const root = mkRepo();
  lane(root, "stage", "review");
  write(root, "test/x.js");
  const r = lane(root, "unstage", "--verify");
  assert.equal(r.status, 0);
  assert.match(r.stderr, /stage review has no lane to check/);
});

test("lane.sh's stage table agrees with the hook's", () => {
  const rows = lane(mkRepo(), "stages").stdout.trim().split("\n").map((l) => l.split("\t"));
  const fromHook = Object.entries(STAGES).map(([stage, { lane: set, mode }]) => [stage, set, mode]);
  assert.deepEqual(rows, fromHook);
});

test("unstage takes no argument but --verify", () => {
  const root = mkRepo();
  assert.equal(lane(root, "unstage", "--force").status, 2);
});

test("an unknown subcommand and a missing one are usage errors", () => {
  const root = mkRepo();
  const unknown = lane(root, "bogus");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command bogus/);
  assert.equal(lane(root).status, 2);
});
