import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pathWithout } from "./path-without.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(here, "..", "scripts", "report.sh");

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

// A repository with an optional build.json, an artifacts directory, and a HOME whose
// .archon/designs holds the reports, so `link` has a tree to resolve against.
function mkEnv(buildJson) {
  const root = mkdtemp("report-test-");
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  const art = path.join(root, "artifacts");
  fs.mkdirSync(path.join(repo, ".archon"), { recursive: true });
  fs.mkdirSync(path.join(home, ".archon/designs/repo/slug"), { recursive: true });
  fs.mkdirSync(art);
  sh(repo, "git", "init", "-q", "-b", "main");
  if (buildJson) fs.writeFileSync(path.join(repo, ".archon/build.json"), JSON.stringify(buildJson));
  return { repo, home, art, out: path.join(home, ".archon/designs/repo/slug/plan-report.html") };
}

const page = (e, kind, ...more) => {
  const extraEnv = more.length && typeof more[more.length - 1] === "object" ? more.pop() : {};
  return spawnSync("bash", [REPORT, "page", kind, "--out", e.out, "--design", "slug", "--run", "run1", "--artifacts", e.art, ...more], {
    cwd: e.repo,
    encoding: "utf8",
    env: { ...process.env, HOME: e.home, ...extraEnv },
  });
};

const URL_LINE = "https://reports.example/repo/slug/plan-report";
const PLAN = "# Plan heading\n\nThe plan text lives here.\n";
const withUrl = (e) => fs.writeFileSync(path.join(e.home, ".archon/report-base-url"), "https://reports.example");
const withPlan = (e) => fs.writeFileSync(path.join(e.art, "plan.md"), PLAN);
const withBuilder = (e, body) => {
  const builder = path.join(e.repo, "build.sh");
  fs.writeFileSync(builder, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(e.repo, ".archon/build.json"), JSON.stringify({ report_cmd: `bash ${builder}` }));
};
const FAILED = "the repository's report builder failed, so this is the default page";

test("a repository with no report_cmd gets the default page and its URL", () => {
  const e = mkEnv(null);
  withUrl(e);
  withPlan(e);
  const r = page(e, "plan");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${URL_LINE}\n`);
  const html = fs.readFileSync(e.out, "utf8");
  assert.match(html, /The plan text lives here/);
  assert.match(html, /<title>Plan: slug<\/title>/);
});

test("a review with no report_cmd gets the default page from report.md", () => {
  const e = mkEnv({});
  withUrl(e);
  fs.writeFileSync(path.join(e.art, "report.md"), "# Review\n\nReview body text.\n");
  const r = page(e, "review");
  assert.equal(r.stdout, `${URL_LINE}\n`);
  const html = fs.readFileSync(e.out, "utf8");
  assert.match(html, /Review body text/);
  assert.match(html, /<title>Review: slug<\/title>/);
});

test("when nothing can build, stdout is one sentence with no path", () => {
  const e = mkEnv(null);
  withUrl(e);
  const r = page(e, "plan");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "The plan report could not be built; run.log has the reason.\n");
  assert.equal(r.stdout.includes(e.art), false);
  assert.equal(r.stdout.includes(e.home), false);
  assert.equal(r.stdout.includes("/"), false);
  assert.equal(fs.existsSync(e.out), false);
});

test("a builder that exits 0 and writes nothing falls back, and a stale page is replaced", () => {
  const e = mkEnv({});
  withUrl(e);
  withPlan(e);
  withBuilder(e, ":");
  fs.writeFileSync(e.out, "STALE");
  const r = page(e, "plan");
  assert.equal(r.stdout, `${URL_LINE}\n`);
  const html = fs.readFileSync(e.out, "utf8");
  assert.equal(html.includes("STALE"), false);
  assert.match(html, /The plan text lives here/);
});

test("a stale page is removed when nothing builds", () => {
  const e = mkEnv({});
  fs.writeFileSync(e.out, "STALE");
  const r = page(e, "plan");
  assert.equal(r.stdout, "The plan report could not be built; run.log has the reason.\n");
  assert.equal(fs.existsSync(e.out), false);
});

test("a builder that writes a partial page and fails falls back to the default page", () => {
  const e = mkEnv({});
  withUrl(e);
  withPlan(e);
  withBuilder(e, 'echo partial > "$3"; exit 1');
  const r = page(e, "plan");
  assert.equal(r.stdout, `${URL_LINE}\n`);
  const html = fs.readFileSync(e.out, "utf8");
  assert.equal(html.includes("partial"), false);
  assert.match(html, /The plan text lives here/);
  assert.ok(html.includes(FAILED));
});

test("the builder runs under gtimeout where timeout is not installed", () => {
  const e = mkEnv({});
  withUrl(e);
  withPlan(e);
  withBuilder(e, 'echo built > "$3"');
  const bin = mkdtemp("report-gtimeout-");
  const log = path.join(bin, "log");
  fs.writeFileSync(path.join(bin, "gtimeout"), `#!/usr/bin/env bash\necho "gtimeout $*" >> ${log}\nshift 3\nexec "$@"\n`, { mode: 0o755 });
  const r = page(e, "plan", { PATH: `${bin}${path.delimiter}${pathWithout("timeout", made)}` });
  assert.equal(r.stdout, `${URL_LINE}\n`);
  assert.equal(fs.readFileSync(e.out, "utf8").trim(), "built");
  assert.match(fs.readFileSync(log, "utf8"), /^gtimeout -k 5 120 bash -c /m);
});

test("a builder that outruns the limit (timeout exits 124) falls back to the default page", () => {
  const e = mkEnv({});
  withUrl(e);
  withPlan(e);
  withBuilder(e, 'echo built > "$3"');
  const bin = mkdtemp("report-timeout-");
  fs.writeFileSync(path.join(bin, "timeout"), "#!/usr/bin/env bash\nexit 124\n", { mode: 0o755 });
  const r = page(e, "plan", { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.stdout, `${URL_LINE}\n`);
  const html = fs.readFileSync(e.out, "utf8");
  assert.match(html, /The plan text lives here/);
  assert.ok(html.includes(FAILED));
});

test("page --status is consumed, not forwarded, and shows on the default page", () => {
  const e = mkEnv({});
  withUrl(e);
  withPlan(e);
  e.cmdLog = path.join(e.art, "args.txt");
  withBuilder(e, `printf '%s\\n' "$@" > "${e.cmdLog}"\necho built > "$3"`);
  const r = page(e, "plan", "--status", "Plan ready", "--spec", "s.json");
  assert.equal(r.stdout, `${URL_LINE}\n`);
  assert.deepEqual(fs.readFileSync(e.cmdLog, "utf8").trim().split("\n"), ["plan", "--out", e.out, "--design", "slug", "--run", "run1", "--artifacts", e.art, "--spec", "s.json"]);
  const e2 = mkEnv(null);
  withUrl(e2);
  withPlan(e2);
  page(e2, "plan", "--status", "Plan ready");
  assert.match(fs.readFileSync(e2.out, "utf8"), /class="status">Plan ready</);
});

test("page accepts --status among the leading flags in any order", () => {
  const e = mkEnv(null);
  withUrl(e);
  withPlan(e);
  const r = spawnSync("bash", [REPORT, "page", "plan", "--status", "First", "--out", e.out, "--design", "slug", "--run", "run1", "--artifacts", e.art], {
    cwd: e.repo, encoding: "utf8", env: { ...process.env, HOME: e.home },
  });
  assert.equal(r.stdout, `${URL_LINE}\n`);
  assert.match(fs.readFileSync(e.out, "utf8"), /class="status">First</);
});

test("a builder that writes the page gets its path printed, with the arguments it was called with", () => {
  const e = mkEnv({});
  e.cmdLog = path.join(e.art, "args.txt");
  const builder = path.join(e.repo, "build.sh");
  fs.writeFileSync(builder, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${e.cmdLog}"\necho built > "$3"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(e.repo, ".archon/build.json"), JSON.stringify({ report_cmd: `bash ${builder}` }));
  fs.writeFileSync(path.join(e.home, ".archon/report-base-url"), "https://reports.example");
  const r = page(e, "plan", "--spec", "s.json");
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "https://reports.example/repo/slug/plan-report");
  assert.deepEqual(fs.readFileSync(e.cmdLog, "utf8").trim().split("\n"), ["plan", "--out", e.out, "--design", "slug", "--run", "run1", "--artifacts", e.art, "--spec", "s.json"]);
});

test("a builder that fails still ends in the default page URL", () => {
  const e = mkEnv({ report_cmd: "false" });
  withUrl(e);
  fs.writeFileSync(path.join(e.art, "report.md"), "# Review\n\nReview body text.\n");
  const r = page(e, "review");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${URL_LINE}\n`);
  assert.ok(fs.readFileSync(e.out, "utf8").includes(FAILED));
});

test("a plan builder's stderr goes to run.log under the plan-report label", () => {
  const e = mkEnv({ report_cmd: "echo boom >&2; false; :" });
  withUrl(e);
  withPlan(e);
  fs.writeFileSync(path.join(e.repo, ".archon/build.json"), JSON.stringify({ report_cmd: "bash -c 'echo boom >&2; exit 1' x" }));
  page(e, "plan");
  const log = fs.readFileSync(path.join(e.art, "run.log"), "utf8");
  assert.match(log, /^== \d\d:\d\d:\d\d plan-report \(exit 1\)$/m);
  assert.match(log, /^== \d\d:\d\d:\d\d plan-report-page \(exit 0\)$/m);
  assert.match(log, /^boom$/m);
  assert.equal(fs.existsSync(path.join(e.art, "plan-report.log")), false);
});

test("a review builder logs under the review-report label in the same run.log", () => {
  const e = mkEnv({ report_cmd: "bash -c 'echo bust >&2; exit 1' x" });
  page(e, "plan");
  page(e, "review");
  const log = fs.readFileSync(path.join(e.art, "run.log"), "utf8");
  assert.match(log, /plan-report \(exit 1\)/);
  assert.match(log, /review-report \(exit 1\)/);
  assert.equal(fs.existsSync(path.join(e.art, "report-build.log")), false);
});

const markdown = (e, cwd, ...more) =>
  spawnSync("bash", [REPORT, "markdown", "cleanup", "--report", e.md, "--out", e.out, "--design", "slug", "--run", "run1", "--artifacts", e.art, ...more], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: e.home },
  });

function mkMarkdownEnv(buildJson) {
  const e = mkEnv(buildJson);
  e.md = path.join(e.art, "report.md");
  fs.writeFileSync(e.md, "# Cleanup of build run abc123\n\nSaved.\n\n## What happened\n\nIt failed.\n");
  fs.writeFileSync(path.join(e.home, ".archon/report-base-url"), "https://reports.example");
  return e;
}

test("markdown calls the repository's builder with the kind, the report and the status", () => {
  const e = mkMarkdownEnv({});
  e.cmdLog = path.join(e.art, "args.txt");
  const builder = path.join(e.repo, "build.sh");
  fs.writeFileSync(builder, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${e.cmdLog}"\necho built > "$3"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(e.repo, ".archon/build.json"), JSON.stringify({ report_cmd: `bash ${builder}` }));
  const r = markdown(e, e.repo, "--status", "Worktree cleanup");
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "https://reports.example/repo/slug/plan-report");
  assert.deepEqual(fs.readFileSync(e.cmdLog, "utf8").trim().split("\n"), [
    "cleanup", "--out", e.out, "--design", "slug", "--run", "run1", "--artifacts", e.art, "--report", e.md, "--status", "Worktree cleanup",
  ]);
});

test("markdown reads report_cmd from the main worktree and runs the builder there", () => {
  const e = mkMarkdownEnv({});
  e.cmdLog = path.join(e.art, "cwd.txt");
  const builder = path.join(e.repo, "build.sh");
  fs.writeFileSync(builder, `#!/usr/bin/env bash\npwd > "${e.cmdLog}"\necho built > "$3"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(e.repo, ".archon/build.json"), JSON.stringify({ report_cmd: `bash ${builder}` }));
  sh(e.repo, "git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x");
  const linked = path.join(path.dirname(e.repo), "linked");
  sh(e.repo, "git", "worktree", "add", "-q", "-b", "other", linked);
  const r = markdown(e, linked);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "https://reports.example/repo/slug/plan-report");
  assert.equal(fs.readFileSync(e.cmdLog, "utf8").trim(), e.repo);
});

test("markdown builds the plain page when the repository has no report_cmd", () => {
  const e = mkMarkdownEnv(null);
  const r = markdown(e, e.repo, "--status", "Worktree cleanup");
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "https://reports.example/repo/slug/plan-report");
  const html = fs.readFileSync(e.out, "utf8");
  assert.match(html, /<title>Cleanup of build run abc123<\/title>/);
  assert.match(html, /class="status">Worktree cleanup</);
});

test("markdown builds the plain page when the builder fails, and logs the failure", () => {
  const e = mkMarkdownEnv({ report_cmd: "bash -c 'echo nope >&2; exit 1' x" });
  const r = markdown(e, e.repo, "--status", "Workflow cleanup");
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "https://reports.example/repo/slug/plan-report");
  assert.match(fs.readFileSync(e.out, "utf8"), /class="status">Workflow cleanup; the repository's report builder failed, so this is the default page</);
  const log = fs.readFileSync(path.join(e.art, "run.log"), "utf8");
  assert.match(log, /^== \d\d:\d\d:\d\d cleanup-report \(exit 1\)$/m);
  assert.match(log, /^nope$/m);
});

test("markdown leaves a sentence naming the report when no page builds", () => {
  const e = mkMarkdownEnv(null);
  fs.rmSync(e.md);
  const r = markdown(e, e.repo);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "The cleanup report could not be built; run.log has the reason.\n");
});

test("markdown needs --report, --out, --design, --run and --artifacts", () => {
  const e = mkEnv(null);
  const r = spawnSync("bash", [REPORT, "markdown", "cleanup", "--out", e.out], { cwd: e.repo, encoding: "utf8", env: { ...process.env, HOME: e.home } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: report\.sh/);
});

test("page needs --out, --design, --run and --artifacts", () => {
  const e = mkEnv(null);
  const r = spawnSync("bash", [REPORT, "page", "plan", "--out", e.out], { cwd: e.repo, encoding: "utf8", env: { ...process.env, HOME: e.home } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: report\.sh/);
});

test("link prints the report's URL when a base URL is set", () => {
  const e = mkEnv(null);
  fs.writeFileSync(e.out, "x");
  fs.writeFileSync(path.join(e.home, ".archon/report-base-url"), "https://reports.example/\n");
  const r = spawnSync("bash", [REPORT, "link", e.out], { encoding: "utf8", env: { ...process.env, HOME: e.home } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "https://reports.example/repo/slug/plan-report\n");
});

const link = (e, file) => spawnSync("bash", [REPORT, "link", file], { encoding: "utf8", env: { ...process.env, HOME: e.home } });

test("link prints the directory's address for an index.html and no file name", () => {
  const e = mkEnv(null);
  withUrl(e);
  const index = path.join(e.home, ".archon/designs/repo/slug/index.html");
  fs.writeFileSync(index, "x");
  assert.equal(link(e, index).stdout, "https://reports.example/repo/slug/\n");
  const top = path.join(e.home, ".archon/designs/index.html");
  fs.writeFileSync(top, "x");
  assert.equal(link(e, top).stdout, "https://reports.example/\n");
});

test("link drops .html from another page, and keeps it when a directory of the same name sits beside it", () => {
  const e = mkEnv(null);
  withUrl(e);
  const dir = path.join(e.home, ".archon/designs/repo/slug");
  fs.writeFileSync(path.join(dir, "review-report.html"), "x");
  assert.equal(link(e, path.join(dir, "review-report.html")).stdout, "https://reports.example/repo/slug/review-report\n");
  fs.writeFileSync(path.join(dir, "plan.html"), "x");
  fs.mkdirSync(path.join(dir, "plan"));
  assert.equal(link(e, path.join(dir, "plan.html")).stdout, "https://reports.example/repo/slug/plan.html\n");
});

test("link prints a path when no base URL is set", () => {
  const e = mkEnv(null);
  fs.writeFileSync(e.out, "x");
  const r = spawnSync("bash", [REPORT, "link", e.out], { encoding: "utf8", env: { ...process.env, HOME: e.home } });
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /plan-report\.html$/);
});

const PAGE_PY = path.join(here, "..", "scripts", "report-page.py");
const pagePy = (src, out) => spawnSync("python3", [PAGE_PY, src, out], { encoding: "utf8" });

test("report-page.py leaves only the page next to its output", () => {
  const dir = mkdtemp("report-page-");
  fs.writeFileSync(path.join(dir, "report.md"), "# T\n\nbody\n");
  const r = pagePy(path.join(dir, "report.md"), path.join(dir, "out", "out.html"));
  assert.equal(r.status, 0);
  assert.deepEqual(fs.readdirSync(path.join(dir, "out")), ["out.html"]);
});

test("report-page.py exits non-zero and leaves no temporary file when the page cannot replace its output", () => {
  const dir = mkdtemp("report-page-");
  fs.writeFileSync(path.join(dir, "report.md"), "# T\n\nbody\n");
  const out = path.join(dir, "out.html");
  fs.mkdirSync(out);
  const r = pagePy(path.join(dir, "report.md"), out);
  assert.notEqual(r.status, 0);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".tmp")), []);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["out.html", "report.md"]);
});

test("report-page.py writes through a per-process temporary name", () => {
  const dir = mkdtemp("report-page-");
  fs.writeFileSync(path.join(dir, "report.md"), "# T\n\nbody\n");
  const out = path.join(dir, "out.html");
  fs.mkdirSync(`${out}.tmp`);
  const r = pagePy(path.join(dir, "report.md"), out);
  assert.equal(r.status, 0);
  assert.match(fs.readFileSync(out, "utf8"), /<title>T<\/title>/);
});

// ---- the kit builder in the publish chain -----------------------------------------------------------

const SCRIPTS_DIR = path.join(here, "..", "scripts");
const RESEARCH_MD = "# Research title\n\nResearch summary text.\n\n## Part A\n\nbody a\n";
const withResearch = (e) => {
  fs.writeFileSync(path.join(e.art, "report.md"), RESEARCH_MD);
  e.spec = path.join(e.art, "research.json");
  fs.writeFileSync(e.spec, JSON.stringify({ confidence: "high" }));
};
const runLog = (e) => fs.readFileSync(path.join(e.art, "run.log"), "utf8");
const PLUGIN = "export default { css: '.zz-plugin-marker{color:red}' };\n";
const withPluginFile = (e, buildJson = {}) => {
  fs.writeFileSync(path.join(e.repo, ".archon/plugin.mjs"), PLUGIN);
  fs.writeFileSync(path.join(e.repo, ".archon/build.json"), JSON.stringify({ report_plugin: ".archon/plugin.mjs", ...buildJson }));
};

// A copy of scripts/ without the report/ directory, for a install that has no kit builder.
function scriptsWithoutBuilder() {
  const dst = path.join(mkdtemp("report-scripts-"), "scripts");
  fs.cpSync(SCRIPTS_DIR, dst, { recursive: true, filter: (src) => path.basename(src) !== "report" });
  return dst;
}

test("with no report_cmd the kit builder makes the page, and report-page.py is not needed", () => {
  const e = mkEnv(null);
  withUrl(e);
  withResearch(e);
  const r = page(e, "research", "--spec", e.spec, "--status", "Research finished (high)");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${URL_LINE}\n`);
  const html = fs.readFileSync(e.out, "utf8");
  assert.match(html, /<details/);
  assert.match(html, /Research finished \(high\)/);
  assert.match(runLog(e), /^== \d\d:\d\d:\d\d research-report-kit \(exit 0\)$/m);
  assert.doesNotMatch(runLog(e), /research-report-page/);
});

test("the kit builder's research page, built with no --status, shows the round and the follow-ups of the run's artifacts", () => {
  const e = mkEnv(null);
  withUrl(e);
  withResearch(e);
  fs.writeFileSync(path.join(e.art, "follow-up-plan.json"), "[]");
  const r = page(e, "research", "--spec", e.spec);
  assert.equal(r.status, 0);
  const html = fs.readFileSync(e.out, "utf8");
  assert.match(html, /Round 1: no follow-up proposed/);
  assert.doesNotMatch(html, /Research finished/);
});

test("a report_cmd that builds the page means the kit builder does not run", () => {
  const e = mkEnv({});
  withUrl(e);
  withResearch(e);
  withBuilder(e, 'echo built > "$3"');
  const r = page(e, "research", "--spec", e.spec);
  assert.equal(r.stdout, `${URL_LINE}\n`);
  assert.equal(fs.readFileSync(e.out, "utf8"), "built\n");
  assert.doesNotMatch(fs.existsSync(path.join(e.art, "run.log")) ? runLog(e) : "", /report-kit/);
});

test("a failing report_cmd falls to the kit builder, whose page says the repository's builder failed", () => {
  const e = mkEnv({ report_cmd: "false" });
  withUrl(e);
  withResearch(e);
  const r = page(e, "research", "--spec", e.spec);
  assert.equal(r.stdout, `${URL_LINE}\n`);
  const html = fs.readFileSync(e.out, "utf8");
  assert.match(html, /<details/);
  assert.ok(html.includes(FAILED));
  assert.match(runLog(e), /research-report \(exit 1\)/);
  assert.match(runLog(e), /research-report-kit \(exit 0\)/);
});

test("when the kit builder fails, report-page.py builds the page, and when that fails the sentence is printed", () => {
  const e = mkEnv(null);
  withUrl(e);
  withResearch(e);
  fs.writeFileSync(e.spec, "not json");
  const r = page(e, "research", "--spec", e.spec);
  assert.equal(r.stdout, `${URL_LINE}\n`);
  assert.doesNotMatch(fs.readFileSync(e.out, "utf8"), /<details/);
  assert.match(fs.readFileSync(e.out, "utf8"), /Research summary text/);
  assert.match(runLog(e), /research-report-kit \(exit [1-9]\d*\)/);
  assert.match(runLog(e), /research-report-page \(exit 0\)/);
  fs.rmSync(path.join(e.art, "report.md"));
  const none = page(e, "research", "--spec", e.spec);
  assert.equal(none.stdout, "The research report could not be built; run.log has the reason.\n");
  assert.equal(fs.existsSync(e.out), false);
});

test("an install without the kit builder still builds the page with report-page.py", () => {
  const e = mkEnv(null);
  withUrl(e);
  withResearch(e);
  const scripts = scriptsWithoutBuilder();
  const r = spawnSync("bash", [path.join(scripts, "report.sh"), "page", "research", "--out", e.out, "--design", "slug", "--run", "run1", "--artifacts", e.art, "--spec", e.spec], {
    cwd: e.repo, encoding: "utf8", env: { ...process.env, HOME: e.home },
  });
  assert.equal(r.stdout, `${URL_LINE}\n`);
  assert.doesNotMatch(fs.readFileSync(e.out, "utf8"), /<details/);
  assert.match(fs.readFileSync(e.out, "utf8"), /Research summary text/);
});

test("report_plugin is passed to the kit builder when no report_cmd is set", () => {
  const e = mkEnv(null);
  withUrl(e);
  withResearch(e);
  withPluginFile(e);
  const r = page(e, "research", "--spec", e.spec);
  assert.equal(r.stdout, `${URL_LINE}\n`);
  assert.match(fs.readFileSync(e.out, "utf8"), /\.zz-plugin-marker\{color:red\}/);
});

test("report_plugin is ignored when report_cmd is set, even if the builder fails and the kit builder runs", () => {
  const e = mkEnv(null);
  withUrl(e);
  withResearch(e);
  withPluginFile(e, { report_cmd: "false" });
  const r = page(e, "research", "--spec", e.spec);
  assert.equal(r.stdout, `${URL_LINE}\n`);
  const html = fs.readFileSync(e.out, "utf8");
  assert.match(html, /<details/);
  assert.doesNotMatch(html, /zz-plugin-marker/);
});

test("markdown reads report_plugin from the main worktree, so a file that is not committed loads", () => {
  const e = mkMarkdownEnv(null);
  withPluginFile(e);
  sh(e.repo, "git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x");
  const linked = path.join(path.dirname(e.repo), "linked");
  sh(e.repo, "git", "worktree", "add", "-q", "-b", "other", linked);
  const r = markdown(e, linked);
  assert.equal(r.stdout.trim(), "https://reports.example/repo/slug/plan-report");
  assert.match(fs.readFileSync(e.out, "utf8"), /\.zz-plugin-marker\{color:red\}/);
});

test("build-settings.sh prints report_plugin from build.json, and nothing when it is absent", () => {
  const settings = path.join(SCRIPTS_DIR, "build-settings.sh");
  const e = mkEnv({ report_plugin: ".archon/plugin.mjs" });
  assert.equal(sh(e.repo, "bash", settings, "report_plugin").trim(), ".archon/plugin.mjs");
  const bare = mkEnv({});
  assert.equal(sh(bare.repo, "bash", settings, "report_plugin").trim(), "");
});
