import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The kit is shared, so nothing about the person or the machine that wrote it may appear in it.
// Two kinds of check run here. The generic checks need no knowledge of the author and always run.
// The personal checks read a word list that lives outside the repository, so the list is never
// published with the kit; they are skipped when no list exists on the host that runs the tests.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const OWN_URL = "github.com/echo-bravo-yahoo/archon-kit";
const WORDS_FILE =
  process.env.ARCHON_KIT_SCRUB_WORDS ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "archon-kit", "scrub-words.txt");

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__"]);

// What matters is what git would commit: tracked files and untracked files that are not ignored. A host keeps its own
// data in ignored files (playground/data/findings.json), and the test must not read them. Outside a git checkout the
// test walks the directory instead.
const committable = (() => {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\0").filter(Boolean).map((p) => path.join(root, p)).filter((p) => fs.existsSync(p) && !p.split(path.sep).some((s) => SKIP_DIRS.has(s)));
  } catch (e) {
    return null;
  }
})();

function* files(dir) {
  if (committable) {
    for (const f of committable) if (f.startsWith(dir + path.sep)) yield f;
    return;
  }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (e.isFile()) yield p;
  }
}

function* lines(dir = root) {
  for (const file of files(dir)) {
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) continue;
    const rel = path.relative(root, file);
    const text = buf.toString("utf8").split("\n");
    for (let i = 0; i < text.length; i++) yield { rel, n: i + 1, text: text[i] };
  }
}

const show = (l, why) => `${l.rel}:${l.n}: ${why}: ${l.text.trim().slice(0, 100)}`;

const HOME_PATH = /(?:\/(?:home|Users)\/(?!kit-test\b)|\/mnt\/)[A-Za-z0-9_.-]+/;
const EMAIL = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;
const EMAIL_OK = [/@example\.(?:com|net)$/i, /@users\.noreply\.github\.com$/i, /^noreply@anthropic\.com$/i];
const PRIVATE_IP = /\b(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b/;
const URL_RE = /https?:\/\/([^\s/"'`)\]>,;:\\]+)(?::\d+)?([^\s"'`)\]>,;\\]*)/g;
const URL_PREFIXES = ["github.com/coleam00/Archon", OWN_URL, "github.com/example/", "www.apple.com", "www.shellcheck.net", "clig.dev", "www.w3.org/2000/svg", "github.com/markedjs/", "github.com/chjj/", "daringfireball.net/"];

function urlAllowed(host, rest) {
  if (/(?:^|\.)example(?:\.[a-z]+)?$/i.test(host) || host === "localhost" || host === "127.0.0.1") return true;
  const full = host + rest;
  return URL_PREFIXES.some((p) => full.startsWith(p));
}

test("no absolute home path or mount path appears in the kit", () => {
  const hits = [];
  for (const l of lines()) if (HOME_PATH.test(l.text)) hits.push(show(l, "path"));
  assert.deepEqual(hits, []);
});

test("no email address other than a placeholder appears in the kit", () => {
  const hits = [];
  for (const l of lines()) {
    for (const m of l.text.matchAll(EMAIL)) if (!EMAIL_OK.some((ok) => ok.test(m[0]))) hits.push(show(l, "email"));
  }
  assert.deepEqual(hits, []);
});

test("no private network address appears in the kit", () => {
  const hits = [];
  for (const l of lines()) if (PRIVATE_IP.test(l.text)) hits.push(show(l, "address"));
  assert.deepEqual(hits, []);
});

test("every URL in the kit points at a placeholder host, localhost or a known public page", () => {
  const hits = [];
  for (const l of lines()) {
    for (const m of l.text.matchAll(URL_RE)) if (!urlAllowed(m[1], m[2])) hits.push(show(l, "url"));
  }
  assert.deepEqual(hits, []);
});

// A tool, script or document that one person keeps in their own home directory cannot be assumed on
// another machine. The kit may name the Archon home, the providers' own configuration (the
// ~/.claude directory itself and its CLAUDE.md and settings files, and ~/.codex) and the XDG and
// SSH locations that every machine has; any other dot-directory under the home belongs to one
// person's setup. The words of a person's own tools stay in the word list outside the repository.
const HOME_DOT_PATH = /(?:~|\$HOME|\$\{HOME\})\/\.([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_.-]+))?/g;
const SHARED_DOT_DIRS = new Set(["archon", "codex", "config", "local", "cache", "ssh"]);
const CLAUDE_OWN_FILES = new Set(["CLAUDE.md", "settings.json", "settings.local.json"]);

test("no tool, script or document that only one person has appears in the kit", () => {
  const hits = [];
  for (const l of lines()) {
    if (l.rel.endsWith("scrub.test.mjs")) continue;
    for (const m of l.text.matchAll(HOME_DOT_PATH)) {
      const [, dir, entry] = m;
      const shared = dir === "claude" ? !entry || CLAUDE_OWN_FILES.has(entry) : SHARED_DOT_DIRS.has(dir);
      if (!shared) hits.push(show(l, "a directory that one person's home has"));
    }
  }
  assert.deepEqual(hits, []);
});

function readWords() {
  return fs
    .readFileSync(WORDS_FILE, "utf8")
    .split("\n")
    .map((s, i) => ({ n: i + 1, s: s.trim() }))
    .filter((w) => w.s && !w.s.startsWith("#"))
    .map((w) => {
      try {
        return new RegExp(w.s, "i");
      } catch (e) {
        throw new Error(`${WORDS_FILE}:${w.n}: not a regular expression: ${e.message}`);
      }
    });
}

test("no word from the personal word list appears in the kit", { skip: fs.existsSync(WORDS_FILE) ? false : `no word list at ${WORDS_FILE}` }, () => {
  const words = readWords();
  const hits = [];
  for (const l of lines()) {
    // LICENSE and the lines that carry the repository's own URL name the public handle on purpose.
    if (l.rel === "LICENSE" || l.text.includes(OWN_URL)) continue;
    for (const w of words) if (w.test(l.text)) hits.push(show(l, `/${w.source}/`));
  }
  assert.deepEqual(hits, []);
});

test("no script builds a path under the Archon home from HOME alone", () => {
  const hits = [];
  for (const dir of ["scripts", "workflows", "test"]) {
    for (const file of files(path.join(root, dir))) {
      if (file.endsWith("scrub.test.mjs")) continue;
      fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (/(HOME|homedir).{0,40}\.archon/.test(line) && !line.includes("ARCHON_HOME")) hits.push(`${path.relative(root, file)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
  }
  assert.deepEqual(hits, []);
});
