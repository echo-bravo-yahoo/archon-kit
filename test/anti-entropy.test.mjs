import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { kitHome } from "./kit-home.mjs";
import { runNodeBash } from "./node-script.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ANTI = path.join(here, "..", "scripts", "anti-entropy.py");
const WORKFLOW = path.join(here, "..", "workflows", "anti-entropy", "anti-entropy.yaml");

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
const write = (root, rel, body = "x\n") => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};
const commitAll = (repo, msg) => {
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-q", "-m", msg);
};

// A throwaway repository named `proj`, a HOME of its own so the ledger lands in a scratch
// directory, and an artifacts directory for the files the workflow's nodes pass around.
function mkEnv({ lanes = { tests: ["test/**"] }, build = null, files = {} } = {}) {
  const root = mkdtemp("anti-entropy-test-");
  const repo = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  sh(repo, "git", "init", "-q", "-b", "main");
  sh(repo, "git", "config", "user.email", "t@example.com");
  sh(repo, "git", "config", "user.name", "t");
  write(repo, ".archon/lanes.json", JSON.stringify(lanes));
  if (build) write(repo, ".archon/build.json", JSON.stringify(build));
  for (const [rel, body] of Object.entries(files)) write(repo, rel, body);
  commitAll(repo, "base");
  return { root, repo, home, ledger: path.join(home, ".archon/state/anti-entropy/proj.jsonl") };
}

const env = (e) => ({ ...process.env, HOME: e.home });
const run = (e, ...args) => spawnSync("python3", ["-I", ANTI, ...args], { cwd: e.repo, encoding: "utf8", env: env(e) });
const runAsync = (e, ...args) =>
  new Promise((resolve) => {
    const c = spawn("python3", ["-I", ANTI, ...args], { cwd: e.repo, env: env(e) });
    let err = "";
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => resolve({ code, err }));
  });

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400e3).toISOString();
const entry = (o) => ({
  run: "r1",
  ts: iso(1),
  lens: "tests",
  paths: ["test/"],
  status: "declined",
  base: "",
  summary: "",
  findings: [],
  build: null,
  ...o,
});
const seed = (e, entries) => {
  fs.mkdirSync(path.dirname(e.ledger), { recursive: true });
  fs.writeFileSync(e.ledger, entries.map((x) => JSON.stringify(x)).join("\n") + "\n");
};
const ledgerLines = (e) =>
  fs
    .readFileSync(e.ledger, "utf8")
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l));

const inventory = (e) => {
  const out = path.join(e.root, "inventory.json");
  const r = run(e, "inventory", "--out", out);
  return { r, all: r.status === 0 ? JSON.parse(fs.readFileSync(out, "utf8")) : null };
};
const subject = (all, lens, p) => all.find((s) => s.lens === lens && s.paths.includes(p));
const files = (dir, n, prefix = "f") => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${dir}/${prefix}${String(i).padStart(2, "0")}.js`, `v${i}\n`]));

const subjectFile = (e, name, lens, paths, reason = "because") => {
  const f = path.join(e.root, name);
  fs.writeFileSync(f, JSON.stringify({ lens, paths, reason }));
  return f;
};
const evalFile = (e, name, o = {}) => {
  const f = path.join(e.root, name);
  fs.writeFileSync(
    f,
    JSON.stringify({
      title: "Merge the overlapping retry tests",
      summary: "Two tests pin the same retry rule.",
      findings: [
        { id: "F1", title: "Merge the two retry tests", files: ["test/retry.test.js"], change: "Fold both into one table-driven test", keeps: "the retry-once rule stays pinned", risk: "low" },
        { id: "F2", title: "Drop the skipped dial test", files: ["test/dial.test.js", "test/helpers.js"], change: "Delete it", keeps: "dial is pinned by connect.test.js", risk: "medium" },
      ],
      ...o,
    }),
  );
  return f;
};

test("inventory ranks a never-examined subject above one examined yesterday", () => {
  const e = mkEnv({ files: { "net/retry.js": "a\n", "store/db.js": "b\n" } });
  seed(e, [entry({ run: "a", ts: iso(1), lens: "structure", paths: ["store/"], status: "clean" })]);
  const { r, all } = inventory(e);
  assert.equal(r.status, 0, r.stderr);
  const net = subject(all, "structure", "net/");
  const store = subject(all, "structure", "store/");
  assert.equal(net.last, null);
  assert.equal(store.last.run, "a");
  assert.ok(net.score > store.score + 90, `${net.score} vs ${store.score}`);
  assert.equal(all[0].paths[0], "net/");
});

test("an earlier entry lowers the rank of a subject that lies under it or contains it", () => {
  const e = mkEnv({ files: { ...files("big", 31), "src/a.js": "a\n", "src/net/retry.js": "b\n", "lib/x.js": "c\n" } });
  seed(e, [
    entry({ run: "dir", lens: "structure", paths: ["big/"], status: "clean" }),
    entry({ run: "file", lens: "structure", paths: ["src/net/retry.js"], status: "clean" }),
  ]);
  const { all } = inventory(e);
  const chunks = all.filter((s) => s.lens === "structure" && s.paths.some((p) => p.startsWith("big/")));
  assert.equal(chunks.length, 2);
  for (const c of chunks) assert.equal(c.last.run, "dir", "an entry for big/ covers the files listed from it");
  assert.equal(subject(all, "structure", "src/").last.run, "file", "an entry for a file covers the directory that holds it");
  assert.equal(subject(all, "structure", "lib/").last, null);
});

test("a subject scores its days since examination up to 120, plus churn, size and the lens rotation", () => {
  const e = mkEnv({ files: { "src/a.js": "a\n" } });
  seed(e, [entry({ run: "a", ts: iso(30), lens: "structure", paths: ["src/"], status: "clean" })]);
  assert.equal(subject(inventory(e).all, "structure", "src/").score, 30 + 4 * 1 - 10);
  seed(e, [entry({ run: "a", ts: iso(150), lens: "structure", paths: ["src/"], status: "clean" })]);
  assert.equal(subject(inventory(e).all, "structure", "src/").score, 120 + 4 * 1 - 10);

  const f = mkEnv({ files: { "a/x.js": "1\n", "b/y.js": "1\n" } });
  for (const n of [2, 3]) {
    write(f.repo, "a/x.js", `${n}\n`);
    commitAll(f.repo, `touch a ${n}`);
  }
  const { all } = inventory(f);
  assert.equal(subject(all, "structure", "a/").commits, 3);
  assert.equal(subject(all, "structure", "b/").commits, 1);
  assert.equal(subject(all, "structure", "a/").score - subject(all, "structure", "b/").score, 8);

  const g = mkEnv({ files: { "a/big.js": "line\n".repeat(400), "b/small.js": "line\n" } });
  const sizes = inventory(g).all;
  assert.equal(subject(sizes, "structure", "a/").score - subject(sizes, "structure", "b/").score, 2);

  const h = mkEnv({ files: { "docs/x.md": "doc\n", "src/x.js": "src\n" } });
  seed(h, [entry({ run: "a", ts: iso(1), lens: "structure", paths: ["elsewhere/"], status: "clean" })]);
  const rot = inventory(h).all;
  assert.equal(subject(rot, "docs", "docs/").score - subject(rot, "structure", "src/").score, 10);
});

test("inventory puts test-lane files under tests, other Markdown under docs and the rest under structure", () => {
  const e = mkEnv({
    build: { anti_entropy_exclude: ["gen/**"] },
    files: {
      "test/a.test.js": "t\n",
      "README.md": "r\n",
      "docs/guide.md": "g\n",
      "docs/briefs/b1/brief.md": "generated\n",
      "src/x.js": "s\n",
      "package-lock.json": "{}\n",
      "web/yarn.lock": "x\n",
      "dist/out.js": "o\n",
      "vendor/v.js": "v\n",
      "public/app.min.js": "m\n",
      "gen/skip.js": "skip\n",
    },
  });
  const { r, all } = inventory(e);
  assert.equal(r.status, 0, r.stderr);
  const shape = (lens) => all.filter((s) => s.lens === lens).map((s) => s.paths.join(",")).sort();
  assert.deepEqual(shape("tests"), ["test/"]);
  assert.deepEqual(shape("docs"), ["README.md", "docs/"]);
  assert.deepEqual(shape("structure"), ["src/"]);
  assert.equal(subject(all, "docs", "docs/").files, 1);
  const every = JSON.stringify(all);
  for (const left of ["briefs", "package-lock", "yarn.lock", "dist/", "vendor/", ".min.", "gen/", ".archon"]) {
    assert.ok(!every.includes(left), `${left} is left out`);
  }
});

test("inventory prints the twelve best subjects and writes all of them to the file", () => {
  const e = mkEnv({ files: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`d${String(i).padStart(2, "0")}/x.js`, "x\n"])) });
  const { r, all } = inventory(e);
  assert.equal(all.length, 14);
  const rows = r.stdout.trimEnd().split("\n").filter((l) => l.includes("structure"));
  assert.equal(rows.length, 12);
  assert.match(r.stdout, /never/);
});

test("a directory of 31 files in two subdirectories becomes two subjects", () => {
  const e = mkEnv({ files: { ...files("src/a", 16), ...files("src/b", 15) } });
  const structure = inventory(e).all.filter((s) => s.lens === "structure");
  assert.deepEqual(structure.map((s) => s.paths.join(",")).sort(), ["src/a/", "src/b/"]);
  assert.deepEqual(structure.map((s) => s.files).sort(), [15, 16]);
});

test("a directory that splits keeps its loose files as subjects of at most 30 files", () => {
  const e = mkEnv({ files: { ...files("pkg", 31), "pkg/sub/inner.js": "i\n" } });
  const structure = inventory(e).all.filter((s) => s.lens === "structure");
  const loose = structure.filter((s) => s.paths[0].startsWith("pkg/f"));
  assert.equal(loose.reduce((n, s) => n + s.files, 0), 31);
  assert.ok(loose.every((s) => s.files <= 30));
  assert.ok(structure.some((s) => s.paths.join() === "pkg/sub/"));
});

test("an entry older than 180 days is ignored and the last line for a run wins", () => {
  const e = mkEnv({ files: { "src/a.js": "a\n", "lib/b.js": "b\n" } });
  seed(e, [
    entry({ run: "old", ts: iso(200), lens: "structure", paths: ["src/"], status: "clean" }),
    entry({ run: "x", ts: iso(2), lens: "structure", paths: ["lib/"], status: "picked" }),
    entry({ run: "x", ts: iso(2), lens: "structure", paths: ["lib/"], status: "declined" }),
  ]);
  const { all } = inventory(e);
  assert.equal(subject(all, "structure", "src/").last, null);
  assert.equal(subject(all, "structure", "lib/").last.status, "declined");
});

test("inventory exits 1 with nothing to examine for a repository with no eligible files", () => {
  const e = mkEnv({ files: { "package-lock.json": "{}\n" } });
  const r = run(e, "inventory", "--out", path.join(e.root, "inventory.json"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nothing to examine/);
});

test("claim rejects an unknown lens, an untracked path, a path with .., and a subject of over 60 files", () => {
  const e = mkEnv({ files: { ...files("big", 61), "src/a.js": "a\n" } });
  write(e.repo, "src/untracked.js");
  const claim = (lens, paths) => run(e, "claim", "--run", "r2", "--subject", subjectFile(e, "s.json", lens, paths));

  const lens = claim("vibes", ["src/"]);
  assert.equal(lens.status, 1);
  assert.match(lens.stderr, /unknown lens/);
  const untracked = claim("structure", ["src/untracked.js"]);
  assert.equal(untracked.status, 1);
  assert.match(untracked.stderr, /not tracked/);
  const dots = claim("structure", ["src/../src/a.js"]);
  assert.equal(dots.status, 1);
  assert.match(dots.stderr, /\.\./);
  const big = claim("structure", ["big/"]);
  assert.equal(big.status, 1);
  assert.match(big.stderr, /at most 60 files/);
  const wrongLens = claim("docs", ["src/"]);
  assert.equal(wrongLens.status, 1);
  assert.match(wrongLens.stderr, /no docs files/);
  assert.equal(fs.existsSync(e.ledger), false, "a rejected subject is not recorded");
});

test("claim appends a picked entry and prints the earlier entries that overlap, newest first", () => {
  const e = mkEnv({ files: { "test/a.test.js": "t\n", "test/b.test.js": "t\n", "src/x.js": "s\n" } });
  seed(e, [
    entry({ run: "aaaaaa11", ts: iso(20), paths: ["test/a.test.js"], status: "handed-off", summary: "older run", findings: ["Merge a"], build: "bbbb" }),
    entry({ run: "cccccc22", ts: iso(3), paths: ["test/"], status: "declined", summary: "Two tests pin one rule.", findings: ["Merge the retry tests", "Drop the skipped test"] }),
    entry({ run: "dddddd33", ts: iso(1), lens: "structure", paths: ["src/"], status: "clean", summary: "unrelated" }),
  ]);
  const sf = subjectFile(e, "s.json", "tests", ["test/"]);
  const r = run(e, "claim", "--run", "eeeeee44", "--subject", sf);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines[0], "Subject: tests of test/ (2 files)");
  assert.match(r.stdout, /Earlier runs on overlapping subjects:/);
  assert.match(r.stdout, /declined/);
  assert.match(r.stdout, /Merge the retry tests; Drop the skipped test/);
  assert.match(r.stdout, /handed-off/);
  assert.ok(r.stdout.indexOf("cccccc") < r.stdout.indexOf("aaaaaa"), "newest first");
  assert.ok(!r.stdout.includes("dddddd"), "an entry for other paths is not listed");

  const last = ledgerLines(e).at(-1);
  assert.equal(last.run, "eeeeee44");
  assert.equal(last.status, "picked");
  assert.equal(last.lens, "tests");
  assert.deepEqual(last.paths, ["test/"]);
  assert.equal(last.base, sh(e.repo, "git", "rev-parse", "HEAD").trim());
  assert.equal(last.build, null);
  assert.match(last.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
});

test("claim prints none when nothing overlaps and writes a directory path with a trailing slash", () => {
  const e = mkEnv({ files: { "test/a.test.js": "t\n" } });
  const sf = subjectFile(e, "s.json", "tests", ["./test"]);
  const r = run(e, "claim", "--run", "r2", "--subject", sf);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "Subject: tests of test/ (1 file)\nEarlier runs on overlapping subjects: none\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(sf, "utf8")), { lens: "tests", paths: ["test/"], reason: "because" });
  assert.deepEqual(ledgerLines(e)[0].paths, ["test/"]);
});

test("claim replaces a list of every file in a directory with the directory", () => {
  const e = mkEnv({
    files: { "test/a.test.js": "t\n", "test/unit/b.test.js": "t\n", "test/unit/c.test.js": "t\n", "test/e2e/d.test.js": "t\n", "test/e2e/e.test.js": "t\n", "README.md": "r\n" },
  });
  const claim = (paths) => {
    const sf = subjectFile(e, "s.json", "tests", paths);
    const r = run(e, "claim", "--run", `r${Math.random()}`, "--subject", sf);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(fs.readFileSync(sf, "utf8")).paths;
  };
  assert.deepEqual(claim(["test/a.test.js", "test/unit/b.test.js", "test/unit/c.test.js", "test/e2e/d.test.js", "test/e2e/e.test.js"]), ["test/"]);
  assert.deepEqual(claim(["test/unit/b.test.js", "test/unit/c.test.js", "test/e2e/d.test.js"]), ["test/unit/", "test/e2e/d.test.js"]);
  assert.deepEqual(claim(["test/unit/b.test.js"]), ["test/unit/b.test.js"]);
  assert.deepEqual(claim(["test/unit/", "test/a.test.js"]), ["test/unit/", "test/a.test.js"]);
});

test("claim never collapses files into the repository root", () => {
  const e = mkEnv({ files: { "README.md": "r\n", "CLAUDE.md": "c\n" } });
  const sf = subjectFile(e, "s.json", "docs", ["README.md", "CLAUDE.md"]);
  assert.equal(run(e, "claim", "--run", "r1", "--subject", sf).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(sf, "utf8")).paths, ["README.md", "CLAUDE.md"]);
});

test("claim shows each earlier entry in a few short lines", () => {
  const e = mkEnv({ files: { "test/a.test.js": "t\n" } });
  const long = "First paragraph.\n\nThe debt is:\n- one\n- two\n" + "More words. ".repeat(60);
  seed(e, [entry({ run: "aaaaaa", paths: ["test/a.test.js", "test/b.test.js", "test/c.test.js", "test/d.test.js", "test/e.test.js"], status: "declined", summary: long, findings: ["F one"] })]);
  const r = run(e, "claim", "--run", "new", "--subject", subjectFile(e, "s.json", "tests", ["test/"]));
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 5, r.stdout);
  assert.ok(lines.every((l) => l.length <= 330), "no line is longer than the summary cap");
  assert.match(lines[2], /test\/a\.test\.js, test\/b\.test\.js, test\/c\.test\.js, \+2 more/);
  assert.match(lines[3], /^ {2}Summary: First paragraph\. The debt is: - one - two More words\./);
  assert.ok(lines[3].endsWith("..."));
});

test("claim lists at most six earlier entries", () => {
  const e = mkEnv({ files: { "test/a.test.js": "t\n" } });
  seed(e, Array.from({ length: 8 }, (_, i) => entry({ run: `run${i}xxxx`, ts: iso(i + 1), status: "clean", summary: `s${i}` })));
  const r = run(e, "claim", "--run", "new", "--subject", subjectFile(e, "s.json", "tests", ["test/"]));
  assert.equal((r.stdout.match(/^- /gm) ?? []).length, 6);
  assert.ok(r.stdout.includes("run0xx") && !r.stdout.includes("run7xx"));
});

test("claims started together leave one complete JSON line each", async () => {
  const e = mkEnv({ files: { "test/a.test.js": "t\n" } });
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => runAsync(e, "claim", "--run", `run-${i}`, "--subject", subjectFile(e, `s${i}.json`, "tests", ["test/"]))),
  );
  for (const r of results) assert.equal(r.code, 0, r.err);
  const lines = ledgerLines(e);
  assert.equal(lines.length, 6);
  assert.deepEqual(lines.map((l) => l.run).sort(), ["run-0", "run-1", "run-2", "run-3", "run-4", "run-5"]);
});

test("record appends clean for none, declined for close and handed-off for build", () => {
  const e = mkEnv({ files: { "test/a.test.js": "t\n" } });
  const sf = subjectFile(e, "s.json", "tests", ["test/"]);
  assert.equal(run(e, "claim", "--run", "r-none", "--subject", sf).status, 0);
  const picked = ledgerLines(e)[0];
  const ev = evalFile(e, "e.json");
  const clean = evalFile(e, "clean.json", { title: "Nothing to remove", summary: "All sound.", findings: [] });

  const none = run(e, "record", "--run", "r-none", "--decision", "none", "--subject", sf, "--evaluation", clean, "--build-started", path.join(e.root, "missing.txt"));
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, "recorded clean\n");

  const close = run(e, "record", "--run", "r-close", "--decision", "close", "--subject", sf, "--evaluation", ev);
  assert.equal(close.status, 0, close.stderr);
  assert.equal(close.stdout, "recorded declined\n");

  const started = path.join(e.root, "build-started.txt");
  fs.writeFileSync(started, "started build, run 7f3a9c21\n");
  const build = run(e, "record", "--run", "r-build", "--decision", "build", "--subject", sf, "--evaluation", ev, "--build-started", started);
  assert.equal(build.status, 0, build.stderr);
  assert.equal(build.stdout, "recorded handed-off\n");

  const [, a, b, c] = ledgerLines(e);
  assert.deepEqual([a.run, a.status, a.findings, a.build], ["r-none", "clean", [], null]);
  assert.equal(a.summary, "All sound.");
  assert.equal(a.base, picked.base, "the commit examined is the one the claim recorded");
  assert.deepEqual([b.run, b.status, b.findings, b.build], ["r-close", "declined", ["Merge the two retry tests", "Drop the skipped dial test"], null]);
  assert.deepEqual([c.run, c.status, c.build, c.lens, c.paths], ["r-build", "handed-off", "7f3a9c21", "tests", ["test/"]]);
  assert.equal(c.summary, "Two tests pin the same retry rule.");
});

test("a run's outcome replaces its picked entry when the ledger is read", () => {
  const e = mkEnv({ files: { "test/a.test.js": "t\n", "src/x.js": "s\n" } });
  const sf = subjectFile(e, "s.json", "tests", ["test/"]);
  run(e, "claim", "--run", "r1", "--subject", sf);
  run(e, "record", "--run", "r1", "--decision", "close", "--subject", sf, "--evaluation", evalFile(e, "e.json"));
  const { all } = inventory(e);
  assert.equal(subject(all, "tests", "test/").last.status, "declined");
});

test("record refuses a build decision with no started run to name", () => {
  const e = mkEnv({ files: { "test/a.test.js": "t\n" } });
  const sf = subjectFile(e, "s.json", "tests", ["test/"]);
  const r = run(e, "record", "--run", "r1", "--decision", "build", "--subject", sf, "--evaluation", evalFile(e, "e.json"), "--build-started", path.join(e.root, "missing.txt"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /started build, run/);
  assert.equal(fs.existsSync(e.ledger), false);
});

const report = (e) => {
  const f = path.join(e.root, "report.md");
  fs.writeFileSync(f, "\n# What the run examined\n\nThe answer is here.\n\n## F1 evidence\n\n```bash\n# a comment, not a title\n```\n");
  return f;
};
const brief = (e, note) => {
  const n = path.join(e.root, "note.txt");
  fs.writeFileSync(n, note);
  return run(e, "brief", "--subject", subjectFile(e, "s.json", "tests", ["test/"]), "--evaluation", evalFile(e, "e.json"), "--report", report(e), "--note", n);
};

test("brief opens with the title, lists each finding and keeps the fixed constraints", () => {
  const e = mkEnv();
  const r = brief(e, "");
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.ok(out.startsWith("# Merge the overlapping retry tests\n"));
  assert.ok(!out.includes("## Note"));
  assert.match(out, /^### F1 — Merge the two retry tests$/m);
  assert.match(out, /^### F2 — Drop the skipped dial test$/m);
  assert.match(out, /Fold both into one table-driven test/);
  assert.match(out, /`test\/dial\.test\.js`, `test\/helpers\.js`/);
  assert.match(out, /dial is pinned by connect\.test\.js/);
  assert.match(out, /medium/);
  for (const line of [
    "Remove or simplify only: add no behaviour, dependency or abstraction that a finding does not call for.",
    "Keep behaviour the same unless a finding says it changes; a finding that changes an interface names its callers, and the change updates every one.",
    "Make one commit for each finding, so any one can be reverted alone.",
    "When tests are merged, generalized or removed, each behaviour they pinned stays pinned by a test that remains, and the plan maps every removed test to the test that keeps its behaviour.",
    "When docs change, each claim that stays has been checked against the code or the command it describes.",
    "The findings are the whole scope, and the note, when there is one, takes precedence over them: a finding it drops is out of scope.",
  ]) {
    assert.ok(out.includes(`- ${line}`), line);
  }
  assert.ok(out.indexOf("## Evidence") > out.indexOf("### F2"));
});

test("brief puts the owner's note first when there is one and the report under Evidence without its H1", () => {
  const e = mkEnv();
  const out = brief(e, "Skip F2, it is not worth the risk.\n").stdout;
  assert.match(out, /^## Note\n\nSkip F2, it is not worth the risk\.\n/m);
  assert.ok(out.indexOf("## Note") < out.indexOf("### F1"));
  const evidence = out.slice(out.indexOf("## Evidence"));
  assert.match(evidence, /The answer is here\./);
  assert.match(evidence, /# a comment, not a title/);
  assert.ok(!out.includes("# What the run examined"));
});

test("an unknown subcommand and a missing one are usage errors", () => {
  const e = mkEnv();
  assert.equal(run(e, "bogus").status, 2);
  assert.equal(run(e).status, 2);
});

// ---- the report page's address ------------------------------------------------------------------

// Runs the bash of the workflow's report_page node in the scratch repository, against a scratch
// ARCHON_HOME whose report-base-url makes report.sh print an address.
function pageNode() {
  const e = mkEnv();
  const kit = kitHome();
  made.push(kit.dir);
  fs.writeFileSync(path.join(kit.dir, "report-base-url"), "https://reports.example\n");
  const art = path.join(e.root, "abcdef123456");
  fs.mkdirSync(art);
  write(art, "report.md", "# Merge the overlapping retry tests\n\nBody.\n");
  write(art, "subject.json", JSON.stringify({ lens: "tests", paths: ["test/"], reason: "because" }));
  const page = (ev) => {
    write(art, "evaluation.json", JSON.stringify(ev));
    return runNodeBash(WORKFLOW, "report_page", { cwd: e.repo, env: { ARCHON_HOME: kit.dir, ARTIFACTS_DIR: art } });
  };
  return { page, kit };
}
const EVALUATION = { title: "Merge the overlapping retry tests", summary: "s", findings: [] };

test("report_page names the report's directory from the evaluator's slug, the lens and the run id", () => {
  const { page, kit } = pageNode();
  const r = page({ ...EVALUATION, slug: "retry-test-overlap" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "https://reports.example/proj/anti-entropy-tests-retry-test-overlap-abcdef/\n");
  assert.ok(fs.existsSync(path.join(kit.dir, "designs/proj/anti-entropy-tests-retry-test-overlap-abcdef/index.html")));
});

test("report_page falls back to the title's words when the evaluation has no slug", () => {
  for (const ev of [EVALUATION, { ...EVALUATION, slug: "" }]) {
    const r = pageNode().page(ev);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "https://reports.example/proj/anti-entropy-tests-merge-overlapping-retry-tests-abcdef/\n");
  }
});

test("report_page keeps the first address when a later call of the same run has another slug", () => {
  const { page } = pageNode();
  const first = page({ ...EVALUATION, slug: "first-name" });
  const second = page({ ...EVALUATION, slug: "second-name" });
  assert.equal(first.stdout, "https://reports.example/proj/anti-entropy-tests-first-name-abcdef/\n");
  assert.equal(second.stdout, first.stdout);
});
