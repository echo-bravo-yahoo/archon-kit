import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { kitHome } from "./kit-home.mjs";

// Runs scripts/report/build.mjs, the kit's default report page builder, in throwaway git repositories.
const here = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(here, "..", "scripts", "report", "build.mjs");

const KIT = kitHome();
const made = [];
const mkdtemp = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(d);
  return d;
};
after(() => {
  KIT.remove();
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const sh = (cwd, ...args) => execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const commit = (repo, msg) => {
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", msg);
  return sh(repo, "git", "rev-parse", "HEAD").trim();
};
const write = (root, rel, body) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};

// A repository with a base commit and a head commit that changes a source file, a test file, a text
// file and a bitmap, plus an artifacts directory and the output path of the page.
function mkEnv({ subject = "change things", extra } = {}) {
  const root = mkdtemp("report-build-");
  const repo = path.join(root, "repo");
  const art = path.join(root, "artifacts");
  const home = path.join(root, "home");
  fs.mkdirSync(art);
  fs.mkdirSync(home);
  fs.mkdirSync(repo);
  sh(repo, "git", "init", "-q", "-b", "main");
  write(repo, ".archon/lanes.json", JSON.stringify({ tests: ["test/**"] }));
  write(repo, "src/a.js", "const one = 1;\nconsole.log(one);\n");
  write(repo, "README.md", "readme\n");
  const base = commit(repo, "base");
  write(repo, "src/a.js", "const one = 1;\nconst two = 2;\nconsole.log(one + two);\n");
  write(repo, "test/a.test.mjs", "// a test\nexport const t = 1;\n");
  write(repo, "notes/secret.txt", "line one\nline two\nline three\n");
  write(repo, "img/a.png", Buffer.from(Array.from({ length: 64 }, (_, i) => i)));
  if (extra) extra(repo);
  const head = commit(repo, subject);
  return { root, repo, art, home, base, head, out: path.join(root, "out", "page.html") };
}

const run = (kind, e, flags = [], opts = {}) =>
  spawnSync("node", [BUILD, kind, "--out", e.out, "--design", "site", "--run", "run1", "--artifacts", e.art, ...flags], {
    cwd: e.repo,
    encoding: "utf8",
    env: { ...process.env, HOME: e.home, ARCHON_HOME: KIT.dir, ...opts.env },
  });
const html = (e) => fs.readFileSync(e.out, "utf8");
const picks = (e, body = {}) => write(e.root, "picks.json", JSON.stringify({ summary: "The picked summary text.", picks: [], ...body }));
const review = (e, flags = [], opts = {}) => run("review", e, ["--base", e.base, "--head", e.head, "--picks", picks(e), ...flags], opts);
const ok = (r) => assert.equal(r.status, 0, r.stderr);

// The indices of `id="<id>"` for the ids that appear, in page order.
const order = (page, ids) =>
  ids
    .map((id) => [id, page.indexOf(`id="${id}"`)])
    .filter(([, i]) => i >= 0)
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id);
const between = (page, from, to) => {
  const a = page.indexOf(`id="${from}"`);
  const b = page.indexOf(`id="${to}"`);
  assert.ok(a >= 0 && b > a, `${from} then ${to}`);
  return page.slice(a, b);
};
const SECTIONS = ["findings", "summary", "open-items", "test-repairs", "key-changes", "gates", "mutation", "review", "owner-answers", "all-changes", "how-to-answer"];
const GATES = "# Gates\n\n| Command | Result |\n| --- | --- |\n| `npm test` | **passed** |\n| `lint` | **failed** |\n";

// ---- every kind ------------------------------------------------------------------------------------

test("review builds a page, prints one built line, creates the output directory and leaves no temporary file", () => {
  const e = mkEnv();
  const r = review(e);
  ok(r);
  assert.match(r.stdout.trim(), /^built .+ \(\d+ KB\)$/);
  assert.ok(r.stdout.includes(e.out));
  assert.deepEqual(fs.readdirSync(path.dirname(e.out)), ["page.html"]);
  assert.match(html(e), /<h1[^>]*>[^<]*site review/);
});

test("plan builds a page titled for the design", () => {
  const e = mkEnv();
  write(e.root, "spec.json", JSON.stringify({ summary: "s", files: [], question: "" }));
  const r = run("plan", e, ["--spec", path.join(e.root, "spec.json")]);
  ok(r);
  assert.match(html(e), /site plan/);
  assert.deepEqual(fs.readdirSync(path.dirname(e.out)), ["page.html"]);
});

test("research builds a page from report.md and cleanup builds one from --report", () => {
  const e = mkEnv();
  write(e.art, "report.md", "# Findings title\n\nSummary text.\n\n## Part A\n\nbody a\n");
  write(e.root, "spec.json", JSON.stringify({ confidence: "high" }));
  ok(run("research", e, ["--spec", path.join(e.root, "spec.json")]));
  assert.match(html(e), /Findings title/);
  const md = write(e.root, "clean.md", "# Cleanup of run abc\n\nSaved.\n\n## What happened\n\nIt failed.\n");
  ok(run("cleanup", e, ["--report", md]));
  assert.match(html(e), /Cleanup of run abc/);
  assert.match(html(e), /It failed/);
  ok(run("markdown", e, ["--report", md]));
  assert.match(html(e), /Cleanup of run abc/);
});

test("the page has a contents list, collapsible sections, print styles, dark mode and no external URL or script source", () => {
  const e = mkEnv();
  ok(review(e));
  const p = html(e);
  assert.match(p, /<details/);
  assert.match(p, /href="#summary"/);
  assert.match(p, /@media print/);
  assert.match(p, /prefers-color-scheme/);
  assert.doesNotMatch(p, /<script[^>]*\ssrc=/);
  assert.doesNotMatch(p, /(?:src|href)="https?:\/\//);
});

function researchEnv({ spec = { confidence: "likely" }, report = "# T\n\nzz-summary.\n\n## A\n\nzz-a\n\n## Rounds\n\nRound 2: asked why; rewrote A\n" } = {}) {
  const e = mkEnv();
  write(e.art, "report.md", report);
  e.spec = write(e.root, "c.json", JSON.stringify(spec));
  return e;
}
const FOLLOW_UPS = [
  { workflow: "build", repo: "site", inputs: [{ name: "interactive", value: "yes" }], note: "Fix the <retry> loop" },
  { workflow: "check-later", repo: "", inputs: [{ name: "when", value: "in 2 weeks" }], note: "Check it held" },
];

test("research takes its status from the round and the follow-ups it proposes, and --status replaces it", () => {
  const e = researchEnv();
  ok(run("research", e, ["--spec", e.spec]));
  assert.match(html(e), /Round 1/);
  assert.doesNotMatch(html(e), /Research finished|follow-up run/);
  write(e.art, "steer.md", "## Note\n\nfirst\n\n## Note\n\nsecond\n\n");
  write(e.art, "follow-up-plan.json", JSON.stringify(FOLLOW_UPS));
  ok(run("research", e, ["--spec", e.spec]));
  assert.match(html(e), /Round 3: 2 follow-up runs proposed/);
  write(e.art, "follow-up-plan.json", JSON.stringify(FOLLOW_UPS.slice(0, 1)));
  ok(run("research", e, ["--spec", e.spec]));
  assert.match(html(e), /Round 3: 1 follow-up run proposed/);
  write(e.art, "follow-up-plan.json", "[]");
  ok(run("research", e, ["--spec", e.spec]));
  assert.match(html(e), /Round 3: no follow-up proposed/);
  ok(run("research", e, ["--spec", e.spec, "--status", "Research finished (likely)"]));
  assert.match(html(e), /Research finished \(likely\)/);
  assert.doesNotMatch(html(e), /Round 3: no follow-up/);
});

test("research counts a round once for each ## Note heading in steer.md and not for a Note mentioned in text", () => {
  const e = researchEnv();
  write(e.art, "steer.md", "## Note\n\nsee the ## Note heading above\n\n");
  ok(run("research", e, ["--spec", e.spec]));
  assert.match(html(e), /<b>2<\/b><span>round<\/span>/);
});

test("research banner shows confidence, round and follow-ups, then the decision with the follow-ups named", () => {
  const e = researchEnv();
  write(e.art, "follow-up-plan.json", JSON.stringify(FOLLOW_UPS));
  ok(run("research", e, ["--spec", e.spec]));
  const p = html(e);
  assert.match(p, /<b>likely<\/b><span>confidence<\/span>/);
  assert.match(p, /<b>1<\/b><span>round<\/span>/);
  assert.match(p, /<b>2<\/b><span>follow-up runs proposed<\/span>/);
  assert.match(
    p,
    /<strong>Your decision:<\/strong> close, dig deeper with a note, or start the follow-ups: <code>build in site interactive=yes<\/code>, <code>check-later when=in 2 weeks<\/code>\./,
  );
  const none = researchEnv();
  write(none.art, "follow-up-plan.json", "[]");
  ok(run("research", none, ["--spec", none.spec]));
  assert.match(html(none), /<strong>Your decision:<\/strong> close, or dig deeper with a note\./);
  assert.doesNotMatch(html(none), /start the follow-ups/);
});

test("research lists the follow-up runs in a section after the summary and before the report's own sections", () => {
  const e = researchEnv();
  write(e.art, "follow-up-plan.json", JSON.stringify(FOLLOW_UPS));
  ok(run("research", e, ["--spec", e.spec]));
  const p = html(e);
  assert.match(p, /<h2>Follow-up runs it proposes<\/h2>/);
  assert.match(p, /<td><code>build<\/code><\/td><td><code>site<\/code><\/td><td><code>interactive=yes<\/code><\/td><td>Fix the &lt;retry&gt; loop<\/td>/);
  assert.match(p, /<td><code>check-later<\/code><\/td><td>this repository<\/td>/);
  const at = (t) => p.indexOf(t);
  assert.ok(at("zz-summary") < at("<h2>Follow-up runs it proposes") && at("<h2>Follow-up runs it proposes") < at("zz-a"));
  assert.match(p, /href="#follow-ups"/);
  const empty = researchEnv();
  write(empty.art, "follow-up-plan.json", "[]");
  ok(run("research", empty, ["--spec", empty.spec]));
  assert.doesNotMatch(html(empty), /Follow-up runs it proposes/);
});

test("research puts the follow-up section first when the report has no text before its first ##, and keeps its id unique", () => {
  const e = researchEnv({ report: "# T\n\n## Follow-ups\n\nzz-own\n\n## A\n\nzz-a\n" });
  write(e.art, "follow-up-plan.json", JSON.stringify(FOLLOW_UPS));
  ok(run("research", e, ["--spec", e.spec]));
  const p = html(e);
  assert.ok(p.indexOf("<h2>Follow-up runs it proposes") >= 0 && p.indexOf("<h2>Follow-up runs it proposes") < p.indexOf("zz-own"));
  const ids = [...p.matchAll(/<details class="sec[^"]*" id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, ids.join(","));
});

test("research builds with the older inputs: no steer.md, no follow-up-plan.json, invalid follow-up-plan.json, no confidence", () => {
  const e = researchEnv({ spec: {} });
  ok(run("research", e, ["--spec", e.spec]));
  assert.match(html(e), /zz-summary/);
  assert.doesNotMatch(html(e), /Your decision|<span>confidence<\/span>|follow-up run/);
  write(e.art, "follow-up-plan.json", "{not json");
  ok(run("research", e, ["--spec", e.spec]));
  assert.doesNotMatch(html(e), /Your decision|follow-up run/);
  write(e.art, "follow-up-plan.json", '{"workflow":"build"}');
  ok(run("research", e, ["--spec", e.spec]));
  assert.doesNotMatch(html(e), /Your decision|follow-up run/);
});

test("research makes the first # the title, the text before the first ## the summary, and each ## and ### a section", () => {
  const e = mkEnv();
  write(e.art, "report.md", "# Findings title\n\nzz-lead text.\n\n## Part A\n\nbody a\n\n### Sub B\n\nbody b\n\n# Stray\n");
  write(e.root, "s.json", "{}");
  ok(run("research", e, ["--spec", path.join(e.root, "s.json")]));
  const p = html(e);
  const at = (s) => p.indexOf(s);
  assert.ok(at("Summary") >= 0 && at("Summary") < at("Part A") && at("Part A") < at("Sub B"));
  assert.ok(at("zz-lead") < at("Part A"));
  assert.equal((p.match(/<h1[\s>]/g) ?? []).length, 1);
});

test("cleanup takes its status from --status and defaults to Workflow cleanup", () => {
  const e = mkEnv();
  const md = write(e.root, "clean.md", "# C\n\nbody\n");
  ok(run("cleanup", e, ["--report", md]));
  assert.match(html(e), /Workflow cleanup/);
  ok(run("cleanup", e, ["--report", md, "--status", "Worktree sweep"]));
  assert.match(html(e), /Worktree sweep/);
});

test("a missing required input exits non-zero and writes no page", () => {
  const e = mkEnv();
  for (const [kind, flags] of [
    ["plan", ["--spec", path.join(e.root, "none.json")]],
    ["research", ["--spec", path.join(e.root, "none.json")]],
    ["cleanup", ["--report", path.join(e.root, "none.md")]],
  ]) {
    const r = run(kind, e, flags);
    assert.notEqual(r.status, 0, kind);
    assert.equal(fs.existsSync(e.out), false, kind);
    assert.deepEqual(fs.existsSync(path.dirname(e.out)) ? fs.readdirSync(path.dirname(e.out)) : [], [], kind);
  }
  write(e.art, "report.md", "");
  write(e.root, "s.json", "{}");
  assert.notEqual(run("research", e, ["--spec", path.join(e.root, "s.json")]).status, 0);
  assert.equal(fs.existsSync(e.out), false);
});

test("an unknown flag is ignored with a note on stderr", () => {
  const e = mkEnv();
  const r = review(e, ["--frobnicate", "x"]);
  ok(r);
  assert.match(r.stderr, /frobnicate/);
  assert.ok(fs.existsSync(e.out));
});

test("raw HTML in Markdown is escaped, and a Markdown # heading never becomes a second h1", () => {
  const e = mkEnv();
  write(e.art, "report.md", "# Top\n\nSummary <script>alert(1)</script> here.\n\n## A\n\n<script>alert(2)</script>\n\n# Another\n");
  write(e.root, "s.json", "{}");
  ok(run("research", e, ["--spec", path.join(e.root, "s.json")]));
  const p = html(e);
  assert.match(p, /&lt;script&gt;alert\(1\)/);
  assert.doesNotMatch(p, /<script>alert/);
  assert.equal((p.match(/<h1[\s>]/g) ?? []).length, 1);
});

// ---- plan ------------------------------------------------------------------------------------------

function planEnv(spec = {}) {
  const e = mkEnv();
  write(e.art, "plan.md", "# Plan heading\n\nzz-overview text.\n\n## Step one\n\nzz-step-one\n\n## Step two\n\nzz-step-two\n");
  write(e.art, "plan-notes.md", "zz-earlier note\n");
  e.spec = write(e.root, "spec.json", JSON.stringify({ summary: "zz-summary", files: ["src/a.js"], question: "Pick A or B?", ...spec }));
  return e;
}

test("plan orders Summary, files, the plan's sections and the earlier notes", () => {
  const e = planEnv();
  ok(run("plan", e, ["--spec", e.spec]));
  const p = html(e);
  const idx = ["zz-summary", "Files it will touch", "zz-overview", "zz-step-one", "zz-step-two", "Your earlier notes", "zz-earlier"].map((s) => p.indexOf(s));
  assert.ok(idx.every((i) => i >= 0), String(idx));
  assert.deepEqual([...idx].sort((a, b) => a - b), idx);
  assert.match(p, /<code>src\/a\.js<\/code>/);
  assert.match(p, /Plan awaiting your decision/);
});

test("plan shows the decision only when there is a question, and --status replaces the default status", () => {
  const e = planEnv();
  ok(run("plan", e, ["--spec", e.spec, "--status", "Plan ready"]));
  assert.match(html(e), /Decision:<\/strong>\s*Pick A or B\?/);
  assert.match(html(e), /Plan ready/);
  assert.doesNotMatch(html(e), /Plan awaiting your decision/);
  const blank = planEnv({ question: "   " });
  ok(run("plan", blank, ["--spec", blank.spec]));
  assert.doesNotMatch(html(blank), /Decision:/);
});

test("plan builds without plan.md and plan-notes.md and omits their sections", () => {
  const e = planEnv();
  fs.rmSync(path.join(e.art, "plan.md"));
  fs.rmSync(path.join(e.art, "plan-notes.md"));
  ok(run("plan", e, ["--spec", e.spec]));
  assert.doesNotMatch(html(e), /Your earlier notes|zz-step-one/);
  assert.match(html(e), /zz-summary/);
});

test("plan names what approve starts: each hand-off with its inputs, after the decision", () => {
  const e = planEnv();
  write(e.art, "handoffs-approved.json", JSON.stringify([{ workflow: "deploy-staging", inputs: [{ name: "ref", value: "main" }, { name: "mode", value: "<fast>" }], note: "n" }, { workflow: "check-later", inputs: [], note: "n" }]));
  ok(run("plan", e, ["--spec", e.spec]));
  const p = html(e);
  assert.match(p, /Approve starts this build, then: <code>deploy-staging ref=main mode=&lt;fast&gt;<\/code>, <code>check-later<\/code>\./);
  assert.ok(p.indexOf("Decision:") >= 0 && p.indexOf("Decision:") < p.indexOf("Approve starts this build"));
  assert.ok(p.indexOf("Approve starts this build") < p.indexOf("zz-summary"));
});

test("plan says approve starts nothing after the build when the hand-off list is empty", () => {
  const e = planEnv();
  write(e.art, "handoffs-approved.json", "[]");
  ok(run("plan", e, ["--spec", e.spec]));
  assert.match(html(e), /Approve starts this build and nothing after it\./);
});

test("plan builds without a hand-off line when handoffs-approved.json is missing or not JSON", () => {
  const missing = planEnv();
  ok(run("plan", missing, ["--spec", missing.spec]));
  assert.doesNotMatch(html(missing), /Approve starts/);
  const bad = planEnv();
  write(bad.art, "handoffs-approved.json", "{not json");
  ok(run("plan", bad, ["--spec", bad.spec]));
  assert.doesNotMatch(html(bad), /Approve starts/);
  assert.match(html(bad), /zz-summary/);
  const object = planEnv();
  write(object.art, "handoffs-approved.json", '{"workflow":"x"}');
  ok(run("plan", object, ["--spec", object.spec]));
  assert.doesNotMatch(html(object), /Approve starts/);
});

test("plan lists each excused stage with its reason in the banner", () => {
  const e = planEnv({ excuses: [{ node: "red_check", reason: "the tests pin <existing> behaviour" }, { node: "mutation_cycle", reason: "prose only" }] });
  write(e.art, "handoffs-approved.json", "[]");
  ok(run("plan", e, ["--spec", e.spec]));
  const p = html(e);
  assert.match(p, /Skips <code>red_check<\/code>: the tests pin &lt;existing&gt; behaviour/);
  assert.match(p, /Skips <code>mutation_cycle<\/code>: prose only/);
  assert.ok(p.indexOf("Approve starts this build") < p.indexOf("Skips <code>red_check"));
  const none = planEnv({ excuses: [] });
  ok(run("plan", none, ["--spec", none.spec]));
  assert.doesNotMatch(html(none), /Skips/);
});

test("plan links an options page that is not a built page", () => {
  const e = planEnv();
  write(path.dirname(e.out), "options.html", "<html><body>not a kit page</body></html>");
  ok(run("plan", e, ["--spec", e.spec, "--options-page", "options.html"]));
  assert.match(html(e), /href="options\.html"/);
});

// ---- review ----------------------------------------------------------------------------------------

function fullReview() {
  const e = mkEnv();
  write(e.art, "gate-report.md", GATES);
  write(e.art, "report.md", "Verdict: approve\n\nzz-review-body\n");
  write(e.art, "test-repairs.md", "# Test repairs\n\nzz-repair-note\n");
  write(e.art, "repair-ranges.txt", `${e.base} ${e.head}\n`);
  write(e.art, "mutation-report.md", "# Mutation report\n\nzz-mutation-text\n");
  write(e.art, "owner-notes.md", "## Question\n\nzz-question\n\n## Answer\n\nzz-owner-answer\n");
  return e;
}
const withFindings = (e, text) => run("review", e, ["--base", e.base, "--head", e.head, "--picks", picks(e, { findings: text })]);
const withPicks = (e, body) => run("review", e, ["--base", e.base, "--head", e.head, "--picks", picks(e, body)]);

test("review lists its sections in order, each only when its input exists", () => {
  const e = fullReview();
  ok(withPicks(e, { findings: "zz-found-text", open_items: ["zz-open-one"] }));
  assert.deepEqual(order(html(e), SECTIONS), SECTIONS);
  const bare = mkEnv();
  ok(review(bare));
  assert.deepEqual(order(html(bare), SECTIONS), ["summary", "key-changes", "all-changes", "how-to-answer"]);
  assert.match(html(e), /zz-mutation-text/);
  assert.match(html(e), /zz-review-body/);
});

test("open items follow the summary as their own section, listed one to an item, with their count in the banner", () => {
  const e = mkEnv();
  ok(withPicks(e, { open_items: ["Run `npm test` after landing.", "The retry path is <untested>."] }));
  const p = html(e);
  assert.ok(p.indexOf('id="summary"') < p.indexOf('id="open-items"') && p.indexOf('id="open-items"') < p.indexOf('id="key-changes"'));
  const items = between(p, "open-items", "key-changes");
  assert.match(items, /<li>Run <code>npm test<\/code> after landing\.<\/li>/);
  assert.match(items, /<li>The retry path is &lt;untested&gt;\.<\/li>/);
  assert.match(p, /Open items/);
  assert.match(p, /href="#open-items"/);
  assert.match(p, /<b>2<\/b><span>open items<\/span>/);
  const one = mkEnv();
  ok(withPicks(one, { open_items: ["Only one."] }));
  assert.match(html(one), /<b>1<\/b><span>open item<\/span>/);
});

test("open items with no summary still show, and blank or non-string entries are dropped", () => {
  const e = mkEnv();
  ok(withPicks(e, { summary: "", open_items: ["real", "  ", 3, null, "also real"] }));
  const p = html(e);
  assert.doesNotMatch(p, /id="summary"/);
  assert.match(between(p, "open-items", "key-changes"), /<li>real<\/li>[\s\S]*<li>also real<\/li>/);
  assert.match(p, /<b>2<\/b><span>open items<\/span>/);
});

test("an empty, missing or malformed open_items adds no section and no banner count", () => {
  for (const body of [{ open_items: [] }, {}, { open_items: "none" }, { open_items: { a: 1 } }, { open_items: ["", "   "] }]) {
    const e = mkEnv();
    ok(withPicks(e, body));
    assert.doesNotMatch(html(e), /id="open-items"|open items?<\/span>/, JSON.stringify(body));
  }
});

test("a plugin section placed after the summary comes after the open items", () => {
  const e = mkEnv();
  const file = plugin(e, "export default { sections: { review: () => [{ title: 'Zz extra', id: 'zz-extra', html: '<p>zz</p>', after: 'summary' }] } };\n");
  ok(run("review", e, ["--base", e.base, "--head", e.head, "--picks", picks(e, { open_items: ["x"] }), "--plugin", file]));
  assert.deepEqual(order(html(e), ["summary", "open-items", "zz-extra", "key-changes"]), ["summary", "open-items", "zz-extra", "key-changes"]);
});

test("the findings open the page before the summary", () => {
  const e = mkEnv();
  ok(withFindings(e, "The LED write took 0.2 to 1.2 ms."));
  const p = html(e);
  assert.ok(p.indexOf('id="findings"') >= 0 && p.indexOf('id="findings"') < p.indexOf('id="summary"'));
  assert.match(between(p, "findings", "summary"), /The LED write took 0\.2 to 1\.2 ms\./);
  assert.match(p, /What the run found/);
});

test("empty findings, or picks from a run that predates them, add no findings section", () => {
  const empty = mkEnv();
  ok(withFindings(empty, "   "));
  assert.doesNotMatch(html(empty), /id="findings"/);
  const old = mkEnv();
  ok(review(old));
  assert.doesNotMatch(html(old), /id="findings"/);
});

test("the owner's answers show in a closed section after the review, and only when the run recorded some", () => {
  const e = fullReview();
  ok(review(e));
  const p = html(e);
  assert.match(between(p, "owner-answers", "all-changes"), /zz-owner-answer/);
  assert.match(p, /Your answers during the run/);
  const tag = p.match(/<details[^>]*id="owner-answers"[^>]*>/) ?? p.match(/<details[^>]*>[^]{0,80}?id="owner-answers"/);
  assert.ok(tag, "the section is a details element");
  assert.doesNotMatch(tag[0], /\sopen/);
  const none = mkEnv();
  ok(review(none));
  assert.doesNotMatch(html(none), /id="owner-answers"/);
});

test("the gates section shows a pass and a fail badge per command, and the banner counts the passes", () => {
  const e = fullReview();
  ok(review(e));
  const p = html(e);
  assert.match(p, /<code>npm test<\/code>[\s\S]{0,120}?class="[^"]*\bbadge\b[^"]*\bpass\b/);
  assert.match(p, /<code>lint<\/code>[\s\S]{0,120}?class="[^"]*\bbadge\b[^"]*\bfail\b/);
  assert.match(p, /1 of 2/);
});

test("the stats banner counts the files changed and the lines added and removed", () => {
  const e = mkEnv();
  ok(review(e));
  assert.match(html(e), /\+\d+/);
  assert.match(html(e), /−\d+/);
});

test("test repairs show a diff per range limited to the tests lane", () => {
  const e = fullReview();
  ok(review(e));
  const repairs = between(html(e), "test-repairs", "key-changes");
  assert.match(repairs, /zz-repair-note/);
  assert.match(repairs, /test\/a\.test\.mjs/);
  assert.doesNotMatch(repairs, /src\/a\.js/);
});

test("how to answer prints the respond commands, last", () => {
  const e = mkEnv();
  ok(review(e));
  const tail = html(e).slice(html(e).indexOf('id="how-to-answer"'));
  assert.match(tail, /archon workflow respond run1 approve/);
  assert.match(tail, /archon workflow respond run1 rework &quot;your note&quot;|archon workflow respond run1 rework "your note"/);
  assert.match(tail, /archon workflow respond run1 abandon/);
});

test("a stuck pause says approve counts as rework and that the run fails at round 30, and the last line of a state key wins", () => {
  const e = mkEnv();
  write(e.art, "state", "pause-kind=clean\npause-kind=stuck\nreview-verdict=ship-it\nreview-verdict=hold-it\n");
  ok(review(e));
  assert.match(html(e), /<code>approve<\/code> counts as <code>rework<\/code>/);
  assert.match(html(e), /Every answer starts another round, and the run fails when it reaches round 30/);
  assert.match(html(e), /hold-it/);
  assert.doesNotMatch(html(e), /ship-it/);
  write(e.art, "state", "pause-kind=stuck\npause-kind=clean\n");
  ok(review(e));
  assert.doesNotMatch(html(e), /counts as/);
});

test("all changes is closed by default and caps the stat at 60 files and the commits at 30", () => {
  const e = mkEnv({
    extra: (repo) => {
      for (let i = 0; i < 31; i++) write(repo, `files/f${i}.txt`, `${i}\n`);
    },
  });
  for (let i = 31; i < 61; i++) {
    write(e.repo, `files/f${i}.txt`, `${i}\n`);
    commit(e.repo, `bulk ${i}`);
  }
  commit(e.repo, "bulk last");
  const head = sh(e.repo, "git", "rev-parse", "HEAD").trim();
  ok(run("review", e, ["--base", e.base, "--head", head, "--picks", picks(e)]));
  const all = between(html(e), "all-changes", "how-to-answer");
  assert.equal((all.match(/<code>[^<]*<\/code><\/td>/g) ?? []).length, 60);
  assert.equal((all.match(/<li>[^<]*\b(?:bulk \d+|bulk last|change things)<\/li>/g) ?? []).length, 30);
  const open = html(e).match(/<details[^>]*id="all-changes"[^>]*>/) ?? html(e).match(/<details[^>]*>[^]{0,80}?id="all-changes"/);
  if (open) assert.doesNotMatch(open[0], /\sopen/);
});

test("the default diff viewer skips bitmaps and shows other changed files", () => {
  const e = mkEnv();
  ok(review(e));
  const changes = between(html(e), "key-changes", "all-changes");
  assert.match(changes, /src\/a\.js/);
  assert.match(changes, /notes\/secret\.txt/);
  assert.doesNotMatch(changes, /img\/a\.png/);
});

// ---- git safety and hostile text -------------------------------------------------------------------

test("a --base that starts with - or names no commit drops the Changes sections and still builds", () => {
  for (const bad of ["-x", "no-such-ref"]) {
    const e = mkEnv();
    const r = review(e, ["--base", bad]);
    ok(r);
    assert.notEqual(r.stderr.trim(), "", bad);
    const p = html(e);
    assert.doesNotMatch(p, /id="key-changes"|id="all-changes"/, bad);
    assert.match(p, /id="summary"/);
    assert.match(p, /id="how-to-answer"/);
  }
  const e = mkEnv();
  ok(review(e, ["--head", "-x"]));
  assert.doesNotMatch(html(e), /id="all-changes"/);
});

test("a commit subject of <script> or # h is escaped and adds no tag or heading", () => {
  const plain = mkEnv({ subject: "plain subject" });
  ok(review(plain));
  const scripts = (p) => (p.match(/<script/g) ?? []).length;
  const h1s = (p) => (p.match(/<h1[\s>]/g) ?? []).length;
  for (const subject of ["<script>", "# h"]) {
    const e = mkEnv({ subject });
    ok(review(e));
    const p = html(e);
    assert.equal(scripts(p), scripts(html(plain)), subject);
    assert.equal(h1s(p), h1s(html(plain)), subject);
    const all = between(p, "all-changes", "how-to-answer");
    assert.match(all, subject === "# h" ? /<li>[^<]*# h<\/li>/ : /<li>[^<]*&lt;script&gt;<\/li>/);
  }
});

test("an unbalanced fence in report.md leaves the sections after it intact", () => {
  const e = mkEnv();
  write(e.art, "report.md", "Intro\n\n```\nunclosed\n\n## Changes\n\ntext\n");
  ok(review(e));
  const p = html(e);
  assert.deepEqual(order(p, SECTIONS), ["summary", "key-changes", "review", "all-changes", "how-to-answer"]);
  assert.match(p, /<h2[^>]*>[\s\S]{0,200}?All changes/);
  assert.equal((p.match(/<details/g) ?? []).length, (p.match(/<\/details>/g) ?? []).length);
});

// ---- plugin ----------------------------------------------------------------------------------------

const plugin = (e, body, name = "plugin.mjs") => write(e.root, name, body);
const withPlugin = (e, file, flags = []) => review(e, ["--plugin", file, ...flags]);

test("a plugin's css is appended to the page styles", () => {
  const e = mkEnv();
  ok(withPlugin(e, plugin(e, "export default { css: '.zz-marker{color:red}' };")));
  assert.match(html(e), /<style[^>]*>[\s\S]*\.zz-marker\{color:red\}[\s\S]*<\/style>/);
});

test("a plugin fence renders a block by its name and every other fence stays a plain code block", () => {
  const e = mkEnv();
  write(e.art, "report.md", "```chart\nabc\n```\n\n```js\nvar plain = 1;\n```\n");
  const file = plugin(e, "export default { fences: { chart(code, ctx) { return '<div class=\"zz-chart\">' + code.trim().toUpperCase() + '</div>'; } } };");
  ok(withPlugin(e, file));
  assert.match(html(e), /<div class="zz-chart">ABC<\/div>/);
  assert.match(html(e), /<pre><code[^>]*>[^]*var plain = 1;/);
});

test("highlight gets the code and the language the diff's languages map names, and null means plain", () => {
  const e = mkEnv();
  const log = path.join(e.root, "highlight.log");
  const file = plugin(
    e,
    `import fs from "node:fs";
export default {
  diff: { languages: { ".js": "zzlang" } },
  highlight(code, lang) { fs.appendFileSync(${JSON.stringify(log)}, String(lang) + "\\n"); return lang === "zzlang" ? '<i class="zz-hl">' + code.replace(/</g, "&lt;") + "</i>" : null; },
};`,
  );
  ok(withPlugin(e, file));
  assert.match(fs.readFileSync(log, "utf8"), /^zzlang$/m);
  const changes = between(html(e), "key-changes", "all-changes");
  assert.match(changes, /class="zz-hl"/);
  assert.match(changes, /notes\/secret\.txt/);
});

test("diff.skip omits matching files from the diff viewer but not from the stat", () => {
  const e = mkEnv();
  const control = mkEnv();
  ok(review(control));
  assert.match(between(html(control), "key-changes", "all-changes"), /notes\/secret\.txt/);
  ok(withPlugin(e, plugin(e, "export default { diff: { skip: /\\.txt$/ } };")));
  assert.doesNotMatch(between(html(e), "key-changes", "all-changes"), /notes\/secret\.txt/);
  assert.match(between(html(e), "all-changes", "how-to-answer"), /notes\/secret\.txt/);
});

test("plugin sections land after the section they name, at the end when it is missing or unknown", () => {
  const e = fullReview();
  const file = plugin(
    e,
    `export default { sections: { review(ctx, kit) { return [
  { id: "zz-extra", title: "Extra", html: "<p>zz-ctx " + [ctx.kind, ctx.design, ctx.run, typeof kit.escapeHtml, typeof kit.section].join(" ") + "</p>", after: "gates" },
  { id: "zz-end", title: "End", html: "<p>end</p>" },
  { id: "zz-lost", title: "Lost", html: "<p>lost</p>", after: "nonexistent" },
]; }, plan() { return [{ id: "zz-plan-only", title: "P", html: "<p>p</p>" }]; } } };`,
  );
  ok(withPlugin(e, file));
  const p = html(e);
  const ids = ["zz-extra", "zz-end", "zz-lost", ...SECTIONS];
  const got = order(p, ids);
  assert.equal(got[got.indexOf("gates") + 1], "zz-extra");
  assert.equal(got.at(-1), "how-to-answer");
  assert.deepEqual(got.slice(-3, -1).sort(), ["zz-end", "zz-lost"]);
  assert.match(p, /zz-ctx review site run1 function function/);
  assert.doesNotMatch(p, /zz-plan-only/);
});

test("a plugin whose hooks throw costs those hooks and not the page", () => {
  const cases = [
    ["css", "export default { get css() { throw new Error('boom-css'); } };", "plugin css: boom-css"],
    ["fences", "export default { fences: { chart() { throw new Error('boom-fence'); } } };", "plugin fences: boom-fence"],
    ["sections", "export default { sections: { review() { throw new Error('boom-sections'); } } };", "plugin sections: boom-sections"],
    ["highlight", "export default { diff: { languages: { '.js': 'x' } }, highlight() { throw new Error('boom-hl'); } };", "plugin highlight: boom-hl"],
    ["diff", "export default { get diff() { throw new Error('boom-diff'); } };", "plugin diff: boom-diff"],
  ];
  for (const [name, body, message] of cases) {
    const e = mkEnv();
    write(e.art, "report.md", "```chart\nabc\n```\n");
    const r = withPlugin(e, plugin(e, body));
    ok(r);
    assert.ok(r.stderr.includes(message), `${name}: ${r.stderr}`);
    assert.match(html(e), /id="summary"/, name);
    assert.match(html(e), /id="how-to-answer"/, name);
  }
});

test("a plugin that cannot be imported, or does not exist, builds the page with no plugin", () => {
  const e = mkEnv();
  const bad = plugin(e, "export default {{{ nope");
  const r = withPlugin(e, bad);
  ok(r);
  assert.match(r.stderr, /plugin load: /);
  assert.match(html(e), /id="summary"/);
  fs.rmSync(e.out);
  const missing = withPlugin(e, path.join(e.root, "absent.mjs"));
  ok(missing);
  assert.match(missing.stderr, /plugin load: /);
  assert.match(html(e), /id="summary"/);
});

// ---- install ---------------------------------------------------------------------------------------

test("install puts scripts/report and scripts/report/vendor in place, copied or linked, and uninstall removes them", () => {
  const kit = path.join(here, "..");
  for (const mode of [[], ["--link"]]) {
    const root = mkdtemp("report-install-");
    const ah = path.join(root, "home", ".archon");
    fs.mkdirSync(ah, { recursive: true });
    const env = { ...process.env, HOME: path.join(root, "home"), ARCHON_HOME: ah, CODEX_HOME: path.join(root, "home", ".codex") };
    const r = spawnSync("bash", [path.join(kit, "install.sh"), "--prefix", path.join(root, "prefix"), ...mode], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    for (const f of ["report/build.mjs", "report/vendor/marked.esm.mjs"]) {
      const p = path.join(ah, "scripts", f);
      assert.ok(fs.existsSync(p), `${mode} ${f}`);
      assert.equal(fs.lstatSync(p).isSymbolicLink(), mode.length > 0, `${mode} ${f}`);
    }
    for (const d of ["report", "report/vendor"]) assert.ok(fs.lstatSync(path.join(ah, "scripts", d)).isDirectory(), d);
    const u = spawnSync("bash", [path.join(kit, "uninstall.sh")], { encoding: "utf8", env });
    assert.equal(u.status, 0, u.stderr);
    assert.equal(fs.existsSync(path.join(ah, "scripts", "report")), false);
  }
});
