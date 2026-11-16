import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVE = path.join(here, "..", "scripts", "report-serve.py");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "report-serve-")));
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "report-serve-outside-")));
let child;
let port;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });

// A raw request, so the path reaches the server as written (fetch would normalise `..`).
const get = (target) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: target, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });

// The listing's fixtures: a research report, a build's plan and review pages, a page with no title, a
// directory with no page, and a report whose index.html is a symlink to a file outside the root. Each
// page's modification time is fixed, so the listing's order and dates are known.
const when = (month, day, hour, minute) => new Date(2026, month - 1, day, hour, minute);
const stamp = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
function page(rel, body, date) {
  const file = path.join(root, "list", rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.utimesSync(file, date, date);
}
function mkListing() {
  page("older-report/index.html", "<!doctype html><title>An older report</title><p>x</p>", when(1, 2, 12, 30));
  page("newer-report/index.html", "<!doctype html><title>Newer &amp; better\n   report</title>", when(3, 4, 9, 5));
  page("build-report/plan-report.html", "<!doctype html><title>Plan: build-report</title>", when(2, 1, 8, 0));
  page("build-report/review-report.html", "<!doctype html><title>Review: build-report</title>", when(2, 3, 8, 0));
  page("no-title/index.html", "<!doctype html><p>no title here</p>", when(2, 10, 10, 10));
  page("hostile/index.html", "<!doctype html><title>&lt;script&gt;alert(1)&lt;/script&gt;</title>", when(2, 11, 10, 10));
  page("single.html", "<!doctype html><title>A single page</title>", when(2, 12, 10, 10));
  const plain = path.join(root, "list", "plain");
  fs.mkdirSync(plain);
  fs.utimesSync(plain, when(2, 20, 7, 7), when(2, 20, 7, 7));
  fs.mkdirSync(path.join(root, "list", "leaky"));
  fs.symlinkSync(path.join(outside, "titled.html"), path.join(root, "list", "leaky", "index.html"));
}

// Directories with a `.csp` file: a page of several files, a directory below it with its own policy,
// a file with a line break in it, one that is too long, one that links outside the root, and a
// `.csp` at the root, which is not read.
const APP_POLICY = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'";
const INNER_POLICY = "default-src 'none'; img-src 'self'";
function mkPolicies() {
  const put = (rel, body) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  put("app/index.html", "<h1>app</h1>");
  put("app/lib/x.js", "export {};");
  put("app/.csp", `${APP_POLICY}\n`);
  put("app/inner/index.html", "<h1>inner</h1>");
  put("app/inner/.csp", INNER_POLICY);
  put("split/index.html", "<h1>split</h1>");
  put("split/.csp", "default-src 'none'\r\nX-Injected: 1");
  put("long/index.html", "<h1>long</h1>");
  put("long/.csp", `default-src 'none'; img-src ${"a".repeat(1100)}`);
  put("empty/index.html", "<h1>empty</h1>");
  put("empty/.csp", "  \n");
  fs.writeFileSync(path.join(outside, "policy.txt"), "default-src *");
  fs.mkdirSync(path.join(root, "app", "linked-policy"), { recursive: true });
  put("app/linked-policy/index.html", "<h1>linked</h1>");
  fs.symlinkSync(path.join(outside, "policy.txt"), path.join(root, "app", "linked-policy", ".csp"));
  put(".csp", "default-src *");
}

before(async () => {
  fs.mkdirSync(path.join(root, "repo", "slug"), { recursive: true });
  fs.writeFileSync(path.join(root, "repo", "slug", "index.html"), "<h1>report</h1>");
  fs.writeFileSync(path.join(root, "repo", "slug", "plan-report.html"), "<h1>plan</h1>");
  fs.writeFileSync(path.join(root, ".secret.html"), "secret");
  fs.writeFileSync(path.join(outside, "leak.html"), "leak");
  fs.writeFileSync(path.join(outside, "titled.html"), "<title>LEAKED TITLE</title>");
  fs.symlinkSync(outside, path.join(root, "linked"));
  fs.symlinkSync(path.join(outside, "leak.html"), path.join(root, "x.html"));
  mkListing();
  mkPolicies();
  port = await freePort();
  child = spawn("python3", ["-I", SERVE, "--root", root, "--port", String(port)], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      await get("/");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("report-serve.py did not start");
});
after(() => {
  child?.kill();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("a report is served with 200, and a directory with an index.html serves it", async () => {
  const r = await get("/repo/slug/index.html");
  assert.equal(r.status, 200);
  assert.equal(r.body, "<h1>report</h1>");
  assert.match((await get("/repo/slug/")).body, /report/);
});

test("a page is served at its address without .html, and still at the old address with it", async () => {
  const bare = await get("/repo/slug/plan-report");
  assert.equal(bare.status, 200);
  assert.equal(bare.body, "<h1>plan</h1>");
  assert.match(bare.headers["content-type"], /^text\/html/);
  const full = await get("/repo/slug/plan-report.html");
  assert.equal(full.status, 200);
  assert.equal(full.body, "<h1>plan</h1>");
});

test("a directory address without its trailing slash redirects to the address with it", async () => {
  const r = await get("/repo/slug");
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, "/repo/slug/");
});

test("an address with no .html does not reach a symlinked page that leaves the root, and a missing page is 404", async () => {
  assert.equal((await get("/x")).status, 404);
  assert.equal((await get("/x.html")).status, 404);
  assert.equal((await get("/repo/slug/missing")).status, 404);
  assert.equal((await get("/.secret")).status, 404);
});

test("a directory without an index.html lists its subdirectories", async () => {
  const r = await get("/repo/");
  assert.equal(r.status, 200);
  assert.match(r.body, /slug\//);
});

test("a listing shows each report's title, its slug and its date", async () => {
  const r = await get("/list/");
  assert.equal(r.status, 200);
  assert.match(r.body, /<a href="older-report\/">An older report<\/a>/);
  assert.match(r.body, /older-report\/ · /);
  assert.ok(r.body.includes(stamp(when(1, 2, 12, 30))), "older-report's date");
  assert.ok(r.body.includes(stamp(when(3, 4, 9, 5))), "newer-report's date");
});

test("a listing collapses whitespace in a title and decodes its entities once", async () => {
  const r = await get("/list/");
  assert.match(r.body, /<a href="newer-report\/">Newer &amp; better report<\/a>/);
});

test("a listing escapes a title that holds markup", async () => {
  const r = await get("/list/");
  assert.ok(!r.body.includes("<script>alert(1)"));
  assert.match(r.body, /<a href="hostile\/">&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/a>/);
});

test("a directory of a build's pages is titled by its review page and dated by it", async () => {
  const r = await get("/list/");
  assert.match(r.body, /<a href="build-report\/">Review: build-report<\/a>/);
  assert.ok(r.body.includes(stamp(when(2, 3, 8, 0))));
  assert.ok(!r.body.includes(stamp(when(2, 1, 8, 0))), "the plan page's date is not shown");
  const inside = await get("/list/build-report/");
  assert.match(inside.body, /<a href="plan-report\.html">Plan: build-report<\/a>/);
  assert.match(inside.body, /<a href="review-report\.html">Review: build-report<\/a>/);
});

test("a page with no title, a lone .html file and a directory with no page are listed too", async () => {
  const r = await get("/list/");
  assert.match(r.body, /<a href="no-title\/">no-title\/<\/a>/);
  assert.match(r.body, /<a href="single\.html">A single page<\/a>/);
  assert.match(r.body, /<a href="plain\/">plain\/<\/a>/);
  assert.ok(r.body.includes(stamp(when(2, 20, 7, 7))), "the directory's own date");
});

test("a listing puts the newest first", async () => {
  const r = await get("/list/");
  const at = (name) => r.body.indexOf(`href="${name}"`);
  const order = ["newer-report/", "plain/", "single.html", "hostile/", "no-title/", "build-report/", "older-report/"].map(at);
  assert.ok(order.every((n) => n >= 0), String(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("a listing does not read the title of a page that is a symlink out of the root", async () => {
  const r = await get("/list/");
  assert.ok(!r.body.includes("LEAKED TITLE"));
  assert.match(r.body, /<a href="leaky\/">leaky\/<\/a>/);
});

test("a dotfile, an encoded parent path and a symlink that leaves the root are 404", async () => {
  assert.equal((await get("/.secret.html")).status, 404);
  assert.equal((await get("/repo/..%2f.secret.html")).status, 404);
  assert.equal((await get("/..%2f" + path.basename(outside) + "/leak.html")).status, 404);
  assert.equal((await get("/../../etc/passwd")).status, 404);
  assert.equal((await get("/linked/leak.html")).status, 404);
});

test("every response carries a content-security-policy and the other security headers", async () => {
  for (const target of ["/repo/slug/index.html", "/missing.html"]) {
    const r = await get(target);
    assert.match(r.headers["content-security-policy"], /default-src 'none'/);
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["referrer-policy"], "no-referrer");
  }
});

const policyOf = async (target) => (await get(target)).headers["content-security-policy"];
const DEFAULT_POLICY = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

test("a .csp file sets the policy of every file under its directory", async () => {
  for (const target of ["/app/", "/app/index.html", "/app/lib/x.js", "/app/missing.js", "/app/lib/"]) {
    assert.equal(await policyOf(target), APP_POLICY, target);
  }
  assert.equal((await get("/app/lib/x.js")).status, 200);
});

test("the nearest .csp file wins", async () => {
  assert.equal(await policyOf("/app/inner/index.html"), INNER_POLICY);
  assert.equal(await policyOf("/app/index.html"), APP_POLICY);
});

test("a directory with no .csp file keeps the default policy, and so does the root's own", async () => {
  for (const target of ["/repo/slug/index.html", "/missing.html", "/list/older-report/index.html"]) {
    assert.ok((await policyOf(target)).startsWith(DEFAULT_POLICY), target);
  }
});

test("a .csp file that is unusable falls back to the default policy, not to one further up", async () => {
  for (const target of ["/split/index.html", "/long/index.html", "/empty/index.html", "/app/linked-policy/index.html"]) {
    const policy = await policyOf(target);
    assert.ok(policy.startsWith(DEFAULT_POLICY), `${target}: ${policy}`);
  }
  const r = await get("/split/index.html");
  assert.equal(r.headers["x-injected"], undefined);
});

test("the .csp file itself is not served", async () => {
  assert.equal((await get("/app/.csp")).status, 404);
  assert.equal((await get("/.csp")).status, 404);
});

test("the default bind is 127.0.0.1 and the default root is under ARCHON_HOME", () => {
  const src = fs.readFileSync(SERVE, "utf8");
  assert.match(src, /"--bind", default="127\.0\.0\.1"/);
  assert.match(src, /os\.path\.join\(archon_home, "designs"\)/);
});
