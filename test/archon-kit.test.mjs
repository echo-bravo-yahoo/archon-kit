import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pathWithout } from "./path-without.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.join(here, "..");
const ARCHON_KIT = path.join(KIT, "scripts", "archon-kit");
const INSTALL = path.join(KIT, "install.sh");
const UNINSTALL = path.join(KIT, "uninstall.sh");

const made = [];
const mkdtemp = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const write = (root, rel, body = "x\n") => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
};
const read = (p) => fs.readFileSync(p, "utf8");
const sh = (cwd, cmd, ...args) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// A scratch world: HOME, ARCHON_HOME and CODEX_HOME of their own, and a bin directory of stubs ahead
// of PATH. `stubs` maps a command name to the bash that stands in for it.
function mkWorld(stubs = {}) {
  const root = mkdtemp("archon-kit-test-");
  const home = path.join(root, "home");
  const ah = path.join(home, ".archon");
  const bin = path.join(root, "bin");
  fs.mkdirSync(ah, { recursive: true });
  fs.mkdirSync(bin);
  for (const [name, body] of Object.entries(stubs)) fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: home,
    ARCHON_HOME: ah,
    CODEX_HOME: path.join(home, ".codex"),
    PATH: `${bin}:${process.env.PATH}`,
    XDG_CONFIG_HOME: path.join(home, ".config"),
  };
  const log = path.join(root, "calls.log");
  const kit = (...args) => spawnSync("bash", [ARCHON_KIT, ...args], { encoding: "utf8", env, cwd: root });
  const install = (...args) => spawnSync("bash", [INSTALL, "--prefix", path.join(root, "prefix"), ...args], { encoding: "utf8", env, cwd: root });
  return { root, home, ah, bin, env, log, kit, install };
}

// A systemctl that fails `show-environment`, so reports up falls back to nohup.
const NO_SYSTEMD = `[ "$2" = show-environment ] && exit 1; exit 1`;

// A systemctl that behaves like a user manager: enable --now runs the unit's ExecStart in the
// background and remembers its pid, show prints it, disable --now stops it.
const FAKE_SYSTEMD = (root) => `
state=${root}/systemd
mkdir -p "$state"
echo "$@" >> "$state/calls"
shift   # --user
case "$1" in
  show-environment) exit 0 ;;
  daemon-reload) exit 0 ;;
  enable)
    unit=$3
    f=\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$unit
    cmd=$(sed -n 's/^ExecStart=//p' "$f")
    eval "nohup $cmd > /dev/null 2>&1 < /dev/null &"
    echo $! > "$state/pid"
    ;;
  show) cat "$state/pid" 2> /dev/null || echo 0 ;;
  disable) [ -f "$state/pid" ] && kill "$(cat "$state/pid")" 2> /dev/null; rm -f "$state/pid" ;;
esac
exit 0
`;

// ---- install and uninstall -----------------------------------------------------------------------

test("install copies the kit into ARCHON_HOME, records every file, and keeps config.yaml and kit.json it finds", () => {
  const w = mkWorld();
  write(w.ah, "config.yaml", "defaultAssistant: codex\n");
  const r = w.install();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /installed \d+ files \(copy\)/);
  for (const f of ["scripts/start-run.sh", "scripts/archon-kit", "scripts/git-retry", "workflows/kit/build/build.yaml", "workflows/kit/research/fixtures/follow-up.stubs.yaml", "profiles/codex.yaml", "kit/templates/agents/AGENTS.md"]) {
    assert.ok(fs.existsSync(path.join(w.ah, f)), f);
    assert.ok(!fs.lstatSync(path.join(w.ah, f)).isSymbolicLink(), `${f} is a copy`);
  }
  assert.equal(read(path.join(w.ah, "config.yaml")), "defaultAssistant: codex\n");
  assert.equal(read(path.join(w.ah, "kit.json")), "{}\n");
  assert.equal(fs.readlinkSync(path.join(w.root, "prefix", "archon-kit")), path.join(w.ah, "scripts", "archon-kit"));
  const rec = JSON.parse(read(path.join(w.ah, "kit-installed.json")));
  assert.equal(rec.source, KIT);
  assert.equal(rec.mode, "copy");
  assert.ok(rec.files.includes(path.join(w.ah, "scripts", "lane.sh")));
  assert.ok(rec.files.includes(path.join(w.root, "prefix", "archon-kit")));
  assert.deepEqual(fs.readdirSync(path.join(w.ah, "scripts")).filter((n) => n.includes(".kit-new")), []);
  assert.deepEqual(fs.readdirSync(path.join(w.ah, "scripts")).filter((n) => n === "__pycache__"), []);
});

test("install writes config.yaml from the template when none exists, with no tier pinned", () => {
  const w = mkWorld();
  assert.equal(w.install().status, 0);
  const cfg = read(path.join(w.ah, "config.yaml"));
  assert.match(cfg, /^defaultAssistant: claude$/m);
  assert.match(cfg, /webSearchMode: live/);
  assert.doesNotMatch(cfg, /^tiers:/m);
});

test("install is repeatable, and an upgrade replaces a recorded file and removes one the kit no longer ships", () => {
  const w = mkWorld();
  assert.equal(w.install().status, 0);
  const lane = path.join(w.ah, "scripts", "lane.sh");
  fs.writeFileSync(lane, "# edited after install\n");
  const gone = write(w.ah, "scripts/old-script.sh", "old\n");
  const rec = JSON.parse(read(path.join(w.ah, "kit-installed.json")));
  rec.files.push(gone);
  fs.writeFileSync(path.join(w.ah, "kit-installed.json"), JSON.stringify(rec));
  const again = w.install();
  assert.equal(again.status, 0, again.stderr);
  assert.equal(read(lane), read(path.join(KIT, "scripts", "lane.sh")));
  assert.ok(!fs.existsSync(gone));
});

test("install refuses, and changes nothing, when a destination holds a different file it did not install", () => {
  const w = mkWorld();
  const mine = write(w.ah, "scripts/lane.sh", "my own lane script\n");
  write(w.ah, "scripts/also-mine.sh");
  const r = w.install();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /scripts\/lane\.sh exists and the kit did not install it/);
  assert.match(r.stderr, /1 conflict\(s\); nothing was changed/);
  assert.equal(read(mine), "my own lane script\n");
  assert.ok(!fs.existsSync(path.join(w.ah, "workflows")));
  assert.ok(!fs.existsSync(path.join(w.ah, "kit-installed.json")));
});

test("install adopts a file that already holds the kit's bytes, and a link that already points at the kit", () => {
  const w = mkWorld();
  const same = write(w.ah, "scripts/state.sh", read(path.join(KIT, "scripts", "state.sh")));
  fs.symlinkSync(path.join(KIT, "scripts", "run-log.sh"), path.join(w.ah, "scripts", "run-log.sh"));
  const r = w.install();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(same), read(path.join(KIT, "scripts", "state.sh")));
  assert.ok(JSON.parse(read(path.join(w.ah, "kit-installed.json"))).files.includes(path.join(w.ah, "scripts", "run-log.sh")));
});

test("install --link links each file to the clone and keeps a workflow's directories real, so Archon finds its fixtures", () => {
  const w = mkWorld();
  const r = w.install("--link");
  assert.equal(r.status, 0, r.stderr);
  const wf = path.join(w.ah, "workflows", "kit", "check-later");
  assert.ok(fs.lstatSync(wf).isDirectory() && !fs.lstatSync(wf).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(wf, "fixtures")).isDirectory() && !fs.lstatSync(path.join(wf, "fixtures")).isSymbolicLink());
  assert.equal(fs.readlinkSync(path.join(wf, "check-later.yaml")), path.join(KIT, "workflows", "check-later", "check-later.yaml"));
  assert.equal(fs.readlinkSync(path.join(w.ah, "scripts", "lane.sh")), path.join(KIT, "scripts", "lane.sh"));
  assert.equal(JSON.parse(read(path.join(w.ah, "kit-installed.json"))).mode, "link");
  const copy = w.install();
  assert.equal(copy.status, 0, copy.stderr);
  assert.ok(!fs.lstatSync(path.join(w.ah, "scripts", "lane.sh")).isSymbolicLink(), "a copy install replaces the links");
});

test("uninstall removes the recorded files, the link and the empty directories, and keeps everything else", () => {
  const w = mkWorld();
  assert.equal(w.install().status, 0);
  const keep = write(w.ah, "scripts/my-own.sh");
  write(w.ah, "state/ledger.jsonl", "{}\n");
  const r = spawnSync("bash", [UNINSTALL], { encoding: "utf8", env: w.env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /removed \d+ file\(s\); config\.yaml and kit\.json are kept/);
  assert.ok(!fs.existsSync(path.join(w.ah, "scripts", "lane.sh")));
  assert.ok(!fs.existsSync(path.join(w.ah, "workflows")));
  assert.ok(!fs.existsSync(path.join(w.root, "prefix", "archon-kit")));
  assert.ok(!fs.existsSync(path.join(w.ah, "kit-installed.json")));
  assert.ok(fs.existsSync(keep));
  assert.ok(fs.existsSync(path.join(w.ah, "config.yaml")));
  assert.ok(fs.existsSync(path.join(w.ah, "kit.json")));
  assert.ok(fs.existsSync(path.join(w.ah, "state", "ledger.jsonl")));
  assert.equal(spawnSync("bash", [UNINSTALL], { encoding: "utf8", env: w.env }).status, 1);
});

// ---- the command line ----------------------------------------------------------------------------

test("an unknown command and a missing subcommand are usage errors, and help lists the commands", () => {
  const w = mkWorld();
  assert.equal(w.kit("bogus").status, 2);
  assert.equal(w.kit("reports").status, 2);
  assert.equal(w.kit("provider").status, 2);
  const help = w.kit("help");
  assert.equal(help.status, 0);
  for (const c of ["doctor", "init-repo", "reports", "agent-docs", "hooks", "provider", "run", "playground"]) assert.match(help.stdout, new RegExp(c));
});

test("playground takes no arguments", () => {
  const w = mkWorld();
  const r = w.kit("playground", "extra");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /playground takes no arguments/);
});

// ---- reports -------------------------------------------------------------------------------------

test("reports up starts a localhost server without systemd, records it, and down stops it and removes the base URL", async () => {
  const w = mkWorld({ systemctl: NO_SYSTEMD });
  const port = await freePort();
  write(w.ah, "designs/repo/slug/index.html", "<h1>hi</h1>");
  const up = w.kit("reports", "up", "--port", String(port));
  assert.equal(up.status, 0, up.stderr);
  assert.equal(up.stdout.trim(), `http://localhost:${port}`);
  assert.equal(read(path.join(w.ah, "report-base-url")).trim(), `http://localhost:${port}`);
  const rec = JSON.parse(read(path.join(w.ah, "reports.json")));
  assert.equal(rec.method, "nohup");
  assert.equal(rec.bind, "127.0.0.1");
  try {
    const status = w.kit("reports", "status");
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.match(status.stdout, /server: running \(nohup, pid \d+\)/);
    assert.match(status.stdout, /answers: yes/);
    const body = await (await fetch(`http://127.0.0.1:${port}/repo/slug/index.html`)).text();
    assert.equal(body, "<h1>hi</h1>");
    const link = w.kit("reports", "url", path.join(w.ah, "designs/repo/slug/index.html"));
    assert.equal(link.stdout.trim(), `http://localhost:${port}/repo/slug/`);
    const pid1 = rec.pid;
    const again = w.kit("reports", "up", "--port", String(port));
    assert.equal(again.status, 0, again.stderr);
    assert.notEqual(JSON.parse(read(path.join(w.ah, "reports.json"))).pid, pid1, "a recorded server is restarted");
  } finally {
    const down = w.kit("reports", "down");
    assert.equal(down.status, 0, down.stderr);
  }
  assert.ok(!fs.existsSync(path.join(w.ah, "report-base-url")));
  assert.ok(!fs.existsSync(path.join(w.ah, "reports.json")));
  const status = w.kit("reports", "status");
  assert.equal(status.status, 1);
  assert.match(status.stdout, /server: none/);
  assert.equal(w.kit("reports", "down").status, 1);
});

test("reports up refuses a port that is already in use, and a report-base-url it did not write unless --force, and down restores it", async () => {
  const w = mkWorld({ systemctl: NO_SYSTEMD });
  const taken = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  made.push(path.join(w.root, "never"));
  try {
    const busy = w.kit("reports", "up", "--port", String(taken.address().port));
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /already in use/);
    assert.ok(!fs.existsSync(path.join(w.ah, "report-base-url")), "a refused up writes nothing");
  } finally {
    taken.close();
  }
  write(w.ah, "report-base-url", "https://reports.example.net\n");
  const port = await freePort();
  const refused = w.kit("reports", "up", "--port", String(port));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already exists \(https:\/\/reports\.example\.net\)/);
  assert.equal(read(path.join(w.ah, "report-base-url")), "https://reports.example.net\n");
  const forced = w.kit("reports", "up", "--port", String(port), "--force", "--url", "https://mine.example.net");
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(forced.stdout.trim(), "https://mine.example.net");
  assert.equal(w.kit("reports", "down").status, 0);
  assert.equal(read(path.join(w.ah, "report-base-url")).trim(), "https://reports.example.net");
});

test("reports up uses a systemd user unit when the user manager answers, filling the template", async () => {
  const w = mkWorld();
  fs.writeFileSync(path.join(w.bin, "systemctl"), `#!/usr/bin/env bash\n${FAKE_SYSTEMD(w.root)}`, { mode: 0o755 });
  const port = await freePort();
  const up = w.kit("reports", "up", "--port", String(port));
  try {
    assert.equal(up.status, 0, up.stderr);
    const rec = JSON.parse(read(path.join(w.ah, "reports.json")));
    assert.equal(rec.method, "systemd");
    const unit = read(rec.unit_file);
    assert.match(unit, new RegExp(`--port ${port}\\n`));
    assert.match(unit, /--bind 127\.0\.0\.1 /);
    assert.ok(unit.includes(`--root "${path.join(w.ah, "designs")}"`));
    assert.doesNotMatch(unit, /@[A-Z]+@/);
    assert.match(unit, /^WantedBy=default\.target$/m);
    assert.equal(w.kit("reports", "status").status, 0);
  } finally {
    w.kit("reports", "down");
  }
  assert.ok(!fs.existsSync(path.join(w.home, ".config/systemd/user/archon-kit-reports.service")));
  assert.match(read(path.join(w.root, "systemd/calls")), /disable --now archon-kit-reports\.service/);
});

test("reports status reports a server it did not start, by the base URL", async () => {
  const w = mkWorld({ systemctl: NO_SYSTEMD });
  assert.equal(w.kit("reports", "status").status, 1);
  write(w.ah, "report-base-url", "http://127.0.0.1:1\n");
  const r = w.kit("reports", "status");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not started by archon-kit/);
  assert.match(r.stdout, /answers: no/);
});

// ---- agent-docs ----------------------------------------------------------------------------------

const BLOCK_START = "<!-- archon-kit:reports:start -->";
const BLOCK_END = "<!-- archon-kit:reports:end -->";
const blockOf = (text) => text.slice(text.indexOf(BLOCK_START), text.indexOf(BLOCK_END) + BLOCK_END.length);

test("the CLAUDE.md and AGENTS.md templates hold the same block, in five bullets", () => {
  const claude = read(path.join(KIT, "templates/agents/CLAUDE.md"));
  const agents = read(path.join(KIT, "templates/agents/AGENTS.md"));
  assert.equal(claude, agents);
  assert.equal(blockOf(claude).split("\n").filter((l) => l.startsWith("- ")).length, 5);
});

test("agent-docs shows a diff and writes nothing without --yes, and writes both files with it", () => {
  const w = mkWorld();
  const repo = path.join(w.root, "repo");
  fs.mkdirSync(repo);
  sh(repo, "git", "init", "-q");
  write(repo, "CLAUDE.md", "# Project\n\nExisting text.\n");
  const dry = w.kit("agent-docs", "--repo", repo);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /\+## Archon reports/);
  assert.match(dry.stdout, /not written; pass --yes/);
  assert.equal(read(path.join(repo, "CLAUDE.md")), "# Project\n\nExisting text.\n");
  assert.ok(!fs.existsSync(path.join(repo, "AGENTS.md")));
  const yes = w.kit("agent-docs", "--repo", repo, "--yes");
  assert.equal(yes.status, 0, yes.stderr);
  const claude = read(path.join(repo, "CLAUDE.md"));
  assert.ok(claude.startsWith("# Project\n\nExisting text.\n\n<!-- archon-kit:reports:start -->"));
  assert.equal(blockOf(claude), blockOf(read(path.join(repo, "AGENTS.md"))));
  assert.match(w.kit("agent-docs", "--repo", repo, "--yes").stdout, /already up to date/);
});

test("agent-docs replaces an edited block and keeps the text around it", () => {
  const w = mkWorld();
  const repo = path.join(w.root, "repo");
  fs.mkdirSync(repo);
  write(repo, "AGENTS.md", `before\n\n${BLOCK_START}\nstale text\n${BLOCK_END}\n\nafter\n`);
  assert.equal(w.kit("agent-docs", "--repo", repo, "--yes").status, 0);
  const text = read(path.join(repo, "AGENTS.md"));
  assert.ok(text.startsWith("before\n\n"));
  assert.ok(text.endsWith(`${BLOCK_END}\n\nafter\n`));
  assert.doesNotMatch(text, /stale text/);
  assert.equal(text.split(BLOCK_START).length, 2);
});

test("agent-docs --global writes the user's own instruction files, and only with --yes", () => {
  const w = mkWorld();
  const dry = w.kit("agent-docs", "--global");
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(!fs.existsSync(path.join(w.home, ".claude/CLAUDE.md")));
  assert.equal(w.kit("agent-docs", "--global", "--yes").status, 0);
  assert.match(read(path.join(w.home, ".claude/CLAUDE.md")), /Archon reports/);
  assert.match(read(path.join(w.home, ".codex/AGENTS.md")), /Archon reports/);
  assert.equal(w.kit("agent-docs", "--global", "--repo", "x").status, 2);
});

// ---- hooks ---------------------------------------------------------------------------------------

test("hooks install codex shows a diff, writes the block only with --yes, and keeps the rest of config.toml", () => {
  const w = mkWorld();
  write(w.home, ".codex/config.toml", 'model = "gpt-5.6-terra"\n');
  const dry = w.kit("hooks", "install", "codex");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /\+\[\[hooks\.PreToolUse\]\]/);
  assert.equal(read(path.join(w.home, ".codex/config.toml")), 'model = "gpt-5.6-terra"\n');
  assert.match(w.kit("hooks", "status").stdout, /block is not in/);
  const yes = w.kit("hooks", "install", "codex", "--yes");
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /trust it in \/hooks/);
  const cfg = read(path.join(w.home, ".codex/config.toml"));
  assert.ok(cfg.startsWith('model = "gpt-5.6-terra"\n'));
  assert.match(cfg, /# archon-kit:lane-hook:start\n\[\[hooks\.PreToolUse\]\]\nmatcher = "Bash\|apply_patch\|Edit\|Write"/);
  assert.match(cfg, /\[\[hooks\.PreToolUse\.hooks\]\]\ntype = "command"\ncommand = ".*lane-hook\.mjs.*"\ntimeout = 30\n# archon-kit:lane-hook:end/);
  assert.match(w.kit("hooks", "status").stdout, /block is present/);
  assert.match(w.kit("hooks", "install", "codex", "--yes").stdout, /already up to date/);
  assert.equal(cfg.split("archon-kit:lane-hook:start").length, 2);
  assert.equal(w.kit("hooks", "install", "claude").status, 2);
});

test("a repository with the Codex hook block in CODEX_HOME passes lane.sh verify", () => {
  const w = mkWorld();
  const repo = path.join(w.root, "repo");
  fs.mkdirSync(repo);
  sh(repo, "git", "init", "-q");
  const verify = () => spawnSync("bash", [path.join(KIT, "scripts/lane.sh"), "verify"], { cwd: repo, encoding: "utf8", env: w.env });
  assert.equal(verify().status, 1);
  assert.equal(w.kit("hooks", "install", "codex", "--yes").status, 0);
  assert.equal(verify().status, 0);
});

// ---- init-repo and doctor ------------------------------------------------------------------------

const mkGitRepo = (w, name = "repo") => {
  const repo = path.join(w.root, name);
  fs.mkdirSync(repo);
  sh(repo, "git", "init", "-q", "-b", "main");
  sh(repo, "git", "config", "user.email", "t@example.com");
  sh(repo, "git", "config", "user.name", "t");
  return repo;
};

test("init-repo writes the declarations, a failing placeholder gate set, the hook registration and the report block", () => {
  const w = mkWorld();
  const repo = mkGitRepo(w);
  const r = w.kit("init-repo", repo);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /placeholder that fails on purpose/);
  assert.match(r.stdout, /commit \.archon\/ and push it/);
  for (const f of ["config.yaml", "build.json", "lanes.json", "gates.json"]) assert.ok(fs.existsSync(path.join(repo, ".archon", f)), f);
  const gates = JSON.parse(read(path.join(repo, ".archon/gates.json")));
  assert.match(gates.feature.ordered[0], /exit 1/);
  const settings = JSON.parse(read(path.join(repo, ".claude/settings.json")));
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /lane-hook\.mjs/);
  assert.match(read(path.join(repo, "CLAUDE.md")), /Archon reports/);
  assert.match(read(path.join(repo, "AGENTS.md")), /Archon reports/);
  const gate = spawnSync("bash", [path.join(KIT, "scripts/run-gates.sh"), "feature"], { cwd: repo, encoding: "utf8", env: { ...process.env, ARTIFACTS_DIR: w.root } });
  assert.equal(gate.status, 1, "the placeholder fails, so build refuses until it is edited");
});

test("init-repo fills gates.json from package.json scripts, never overwrites a file, and registers the hook once", () => {
  const w = mkWorld();
  const repo = mkGitRepo(w);
  write(repo, "package.json", { scripts: { lint: "eslint .", test: "node --test", build: "tsc", dev: "x" } });
  write(repo, ".claude/settings.json", { permissions: { allow: ["Bash(ls)"] } });
  write(repo, ".archon/lanes.json", { tests: ["spec/**"] });
  assert.equal(w.kit("init-repo", repo).status, 0);
  const gates = JSON.parse(read(path.join(repo, ".archon/gates.json")));
  assert.deepEqual(gates.feature.ordered, ["npm run lint", "npm run build", "npm run test"]);
  assert.deepEqual(gates.tests.ordered, ["npm run test"]);
  assert.deepEqual(JSON.parse(read(path.join(repo, ".archon/lanes.json"))), { tests: ["spec/**"] });
  const settings = JSON.parse(read(path.join(repo, ".claude/settings.json")));
  assert.deepEqual(settings.permissions, { allow: ["Bash(ls)"] });
  assert.equal(settings.hooks.PreToolUse.length, 1);
  const again = w.kit("init-repo", repo);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /the lane hook is already registered/);
  assert.equal(JSON.parse(read(path.join(repo, ".claude/settings.json"))).hooks.PreToolUse.length, 1);
  write(repo, "pnpm-lock.yaml", "");
  fs.rmSync(path.join(repo, ".archon/gates.json"));
  w.kit("init-repo", repo);
  assert.deepEqual(JSON.parse(read(path.join(repo, ".archon/gates.json"))).tests.ordered, ["pnpm run test"]);
});

test("init-repo --provider codex writes no .claude file and says to install the user-level hook", () => {
  const w = mkWorld();
  const repo = mkGitRepo(w);
  const r = w.kit("init-repo", repo, "--provider", "codex");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(repo, ".claude")));
  assert.match(r.stdout, /archon-kit hooks install codex/);
  assert.equal(w.kit("init-repo", repo, "--provider", "both").status, 0);
  assert.ok(fs.existsSync(path.join(repo, ".claude/settings.json")));
});

test("init-repo refuses a directory that is not a git repository", () => {
  const w = mkWorld();
  const dir = path.join(w.root, "plain");
  fs.mkdirSync(dir);
  const r = w.kit("init-repo", dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not inside a git repository/);
  assert.equal(w.kit("init-repo", dir, "--provider", "nope").status, 2);
});

const ARCHON_STUB = `case "$1" in --version) echo 'Archon CLI v0.13.2' ;; esac; exit 0`;

test("doctor DIR reports each of build's start-up checks for a repository, and passes once they hold", () => {
  const w = mkWorld({ archon: ARCHON_STUB, claude: "exit 0" });
  assert.equal(w.install().status, 0);
  const repo = mkGitRepo(w);
  w.kit("init-repo", repo);
  const before = w.kit("doctor", repo);
  assert.equal(before.status, 1, before.stdout);
  assert.match(before.stdout, /ok    archon 0\.13\.2/);
  assert.match(before.stdout, /ok    the kit's files are in /);
  assert.match(before.stdout, /ok    .*: the tests lane/);
  assert.match(before.stdout, /ok    .*: lanes are enforced/);
  assert.match(before.stdout, /fix   .*: the feature gate set still holds the placeholder — edit \.archon\/gates\.json/);
  assert.match(before.stdout, /fix   .*: the tests gate set still holds the placeholder/);
  write(repo, ".archon/gates.json", { feature: { ordered: ["true"] }, tests: { ordered: ["true"] } });
  const after = w.kit("doctor", repo);
  assert.equal(after.status, 0, after.stdout);
  assert.match(after.stdout, /all checks passed/);
});

test("doctor says what is missing from an install, and warns about an Archon version it was not tested with", () => {
  const w = mkWorld({ archon: `echo 'Archon CLI v0.13.5'`, claude: "exit 0" });
  const r = w.kit("doctor");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /warn  archon 0\.13\.5: the kit is tested against 0\.13\.2 only/);
  assert.match(r.stdout, /fix   missing from .*scripts\/start-run\.sh.*run the kit's install\.sh/);
  const old = mkWorld({ archon: `echo 'Archon CLI v0.12.0'`, claude: "exit 0" });
  assert.match(old.kit("doctor").stdout, /fix   archon 0\.12\.0 is older than 0\.13\.2/);
});

test("doctor checks the Archon database schema when a database exists", () => {
  const w = mkWorld({ archon: ARCHON_STUB, claude: "exit 0" });
  assert.equal(w.install().status, 0);
  const py = `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.executescript("create table remote_agent_workflow_runs (id text); create table remote_agent_workflow_events (id text); create table remote_agent_codebases (id text);")
c.commit()`;
  execFileSync("python3", ["-c", py, path.join(w.ah, "archon.db")]);
  const r = w.kit("doctor");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /fix   the Archon database lacks remote_agent_workflow_runs\./);
});

const realTool = (name) => execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();

test("doctor fails on a git or jq older than the kit needs, and reads the version out of the vendors' wording", () => {
  const git = realTool("git");
  const jq = realTool("jq");
  const old = mkWorld({
    archon: ARCHON_STUB,
    claude: "exit 0",
    git: `[ "$1" = --version ] && { echo 'git version 2.20.0'; exit 0; }\nexec ${git} "$@"`,
    jq: `[ "$1" = --version ] && { echo jq-1.5; exit 0; }\nexec ${jq} "$@"`,
  });
  const r = old.kit("doctor");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /fix   git 2\.20\.0 is older than 2\.31/);
  assert.match(r.stdout, /fix   jq 1\.5 is older than 1\.6/);
  const vendor = mkWorld({
    archon: ARCHON_STUB,
    claude: "exit 0",
    git: `[ "$1" = --version ] && { echo 'git version 2.39.3 (Apple Git-146)'; exit 0; }\nexec ${git} "$@"`,
    jq: `[ "$1" = --version ] && { echo jq-1.7.1-dirty; exit 0; }\nexec ${jq} "$@"`,
  });
  const ok = vendor.kit("doctor").stdout;
  assert.match(ok, /ok    git 2\.39\.3/);
  assert.match(ok, /ok    jq 1\.7\.1/);
});

test("doctor accepts gtimeout where timeout is missing, and fails when neither is installed", () => {
  const w = mkWorld({ archon: ARCHON_STUB, claude: "exit 0", gtimeout: "exit 0" });
  w.env.PATH = `${w.bin}${path.delimiter}${pathWithout("timeout", made)}`;
  assert.match(w.kit("doctor").stdout, /ok    gtimeout, which the kit uses where timeout is missing/);
  fs.rmSync(path.join(w.bin, "gtimeout"));
  assert.match(w.kit("doctor").stdout, /fix   neither timeout nor gtimeout is installed/);
});

test("doctor warns, and still passes, when curl, fuser, gh, ps and lsof are missing and there is no /proc", () => {
  const w = mkWorld({ archon: ARCHON_STUB, claude: "exit 0" });
  assert.equal(w.install().status, 0);
  w.env.PATH = `${w.bin}${path.delimiter}${pathWithout(["curl", "fuser", "gh", "ps", "lsof"], made)}`;
  w.env.KIT_PROC_ROOT = path.join(w.root, "no-proc");
  const r = w.kit("doctor");
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /warn  curl is not installed/);
  assert.match(r.stdout, /warn  fuser is not installed/);
  assert.match(r.stdout, /warn  gh is not installed — build needs it when deliver is draft-pr/);
  assert.match(r.stdout, /warn  no \/proc, and ps or lsof is missing/);
  assert.match(r.stdout, /all checks passed/);
});

test("doctor reads the process checks from ps and lsof where there is no /proc", () => {
  const w = mkWorld({ archon: ARCHON_STUB, claude: "exit 0" });
  w.env.KIT_PROC_ROOT = path.join(w.root, "no-proc");
  const has = (n) => spawnSync("sh", ["-c", `command -v ${n}`]).status === 0;
  const expected = has("ps") && has("lsof") ? /ok    process checks use ps and lsof/ : /warn  no \/proc, and ps or lsof is missing/;
  assert.match(w.kit("doctor").stdout, expected);
});

// ---- provider and run ----------------------------------------------------------------------------

const archonLogger = (log, doctorLine) => `
printf '%s\\n' "$*" >> ${log}
case "$1 $2" in
  "ai tier") printf 'Model tiers (default assistant: claude):\\n  small   claude/haiku\\n' ;;
esac
if [ "$1" = doctor ]; then printf '%s\\n' '${doctorLine}'; fi
exit 0`;

test("provider use refuses a provider that is not installed and sets the default for one that is", () => {
  const w = mkWorld();
  fs.writeFileSync(path.join(w.bin, "archon"), `#!/usr/bin/env bash\n${archonLogger(w.log, "✓ Installed providers: claude (0.13.2)")}\n`, { mode: 0o755 });
  const no = w.kit("provider", "use", "codex");
  assert.equal(no.status, 1);
  assert.match(no.stderr, /codex is not an installed provider; run: archon provider add codex/);
  assert.ok(!read(w.log).includes("ai default"));
  const yes = w.kit("provider", "use", "claude");
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(read(w.log), /^ai default claude$/m);
  assert.equal(w.kit("provider", "use", "gemini").status, 2);
  fs.writeFileSync(path.join(w.bin, "archon"), `#!/usr/bin/env bash\n${archonLogger(w.log, "✓ Installed providers: claude (0.13.2), codex (0.13.2)")}\n`, { mode: 0o755 });
  assert.equal(w.kit("provider", "use", "codex").status, 0);
  assert.match(read(w.log), /^ai default codex$/m);
});

test("provider status prints the tiers and the installed providers", () => {
  const w = mkWorld();
  fs.writeFileSync(path.join(w.bin, "archon"), `#!/usr/bin/env bash\n${archonLogger(w.log, "✓ Installed providers: claude (0.13.2), codex (0.13.2)")}\n`, { mode: 0o755 });
  const r = w.kit("provider", "status");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Model tiers/);
  assert.match(r.stdout, /installed providers: claude codex/);
});

test("run starts one workflow with the provider's profile, whatever the default is", () => {
  const w = mkWorld();
  fs.writeFileSync(path.join(w.bin, "archon"), `#!/usr/bin/env bash\n${archonLogger(w.log, "")}\n`, { mode: 0o755 });
  assert.equal(w.install().status, 0);
  const r = w.kit("run", "codex", "research", "--detach", "why is it slow");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(read(w.log).includes(`workflow run research --config ${path.join(w.ah, "profiles", "codex.yaml")} --detach why is it slow`));
  assert.equal(w.kit("run", "gemini", "research").status, 2);
  assert.equal(w.kit("run", "codex").status, 2);
});

test("the profiles set the provider and all three tiers, and the config template pins none", () => {
  for (const [name, provider] of [["claude", "claude"], ["codex", "codex"]]) {
    const text = read(path.join(KIT, "profiles", `${name}.yaml`));
    assert.match(text, new RegExp(`^assistant: ${provider}$`, "m"));
    for (const tier of ["small", "medium", "large"]) assert.match(text, new RegExp(`^  ${tier}: \\{ provider: ${provider}, model: \\S+ \\}$`, "m"));
  }
  assert.match(read(path.join(KIT, "profiles/codex.yaml")), /webSearchMode: live/);
  assert.doesNotMatch(read(path.join(KIT, "config/config.yaml.template")), /^tiers:/m);
});
