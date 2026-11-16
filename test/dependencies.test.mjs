import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The scripts and the bash of the workflows may call a tool that every Unix has without saying so. A
// tool that is not on every Unix has to be listed in docs/reference/dependencies.md, with the version
// it needs and what happens without it, and `archon-kit doctor` has to know about it. This test fails
// when a script calls one of the tools below, or probes for any tool, and the page does not list it.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const NON_STANDARD = [
  "jq", "curl", "gh", "flock", "timeout", "gtimeout", "fuser", "realpath", "readlink", "lsof", "systemctl", "launchctl",
  "wslpath", "shellcheck", "gdate", "python3", "node", "git", "archon", "claude", "codex",
];

// The tools that the first column of a table on the page names, such as `timeout` and `gtimeout`
// from "`timeout` or `gtimeout`", and `readlink` from "`readlink` with `-f`".
function listedTools() {
  const names = new Set();
  for (const line of read("docs/reference/dependencies.md").split("\n")) {
    if (!line.startsWith("|")) continue;
    for (const m of (line.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)) {
      const word = m[1].trim().split(/\s+/)[0];
      if (/^[A-Za-z][\w.-]*$/.test(word)) names.add(word);
    }
  }
  return names;
}

const SKIP_DIRS = new Set(["vendor", "__pycache__", "node_modules"]);
function* walk(dir) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(rel);
    } else if (e.isFile()) yield rel;
  }
}

// The text of every file that holds code the kit runs: what the shell runs, with its heredocs, the
// Python and Node scripts, and the bash blocks of the workflows. Comments are left out.
function sources() {
  const out = [];
  const files = [...walk("scripts"), ...walk("templates"), "install.sh", "uninstall.sh"];
  for (const rel of files) {
    const text = read(rel);
    const first = text.split("\n", 1)[0];
    const shell = rel.endsWith(".sh") || /^#!.*\b(?:ba)?sh\b/.test(first) || !path.extname(rel);
    const code = rel.endsWith(".py") || rel.endsWith(".mjs") || shell;
    if (code && !text.includes("\0")) out.push({ rel, text, shell });
  }
  for (const rel of fs.readdirSync(path.join(root, "workflows")).flatMap((d) => fs.readdirSync(path.join(root, "workflows", d)).filter((f) => f === `${d}.yaml`).map((f) => path.join("workflows", d, f)))) {
    out.push({ rel, text: bashBlocks(read(rel)), shell: true });
  }
  return out;
}

// The lines of the `bash:` blocks of a workflow, and the command of a one-line `bash:`.
function bashBlocks(yaml) {
  const lines = yaml.split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const block = lines[i].match(/^(\s*)bash:\s*[|>][-+]?\s*$/);
    if (block) {
      const indent = block[1].length;
      for (i += 1; i < lines.length && (lines[i].trim() === "" || lines[i].match(/^\s*/)[0].length > indent); i++) kept.push(lines[i]);
      i -= 1;
      continue;
    }
    const one = lines[i].match(/^\s*bash:\s+(\S.*)$/);
    if (one) kept.push(one[1]);
  }
  return kept.join("\n");
}

const codeLines = (text) => text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));

// The word at the start of a command: after a line start, a pipe, a semicolon, &&, ||, ( or $(, or a
// shell keyword, skipping VAR=value assignments.
const COMMAND_WORD = /(?:^|[|;&(`{]|\$\(|\b(?:then|do|else|elif|if|while|until)\s|!\s)\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:env\s+|exec\s+|sudo\s+)?([A-Za-z][\w.+-]*)/g;
const PROBE = /(?:^|[|;&(!{]|\b(?:if|then|elif|while)\s)\s*(?:have|command\s+-v)\s+([A-Za-z][\w.-]*)/g;
// A program started from Python or Node with an argument vector: ["lsof", "-a"], execFileSync("git", ...).
const ARGV = /(?:\[\s*|(?:execFileSync|execFile|spawnSync|spawn)\(\s*)"([A-Za-z][\w.+-]*)"\s*[,\]]/g;

function used() {
  const commands = new Map();
  const probes = new Map();
  const note = (map, name, rel) => map.set(name, [...(map.get(name) ?? []), rel]);
  for (const { rel, text, shell } of sources()) {
    for (const line of codeLines(text)) {
      if (shell) for (const m of line.matchAll(COMMAND_WORD)) note(commands, m[1], rel);
      for (const m of line.matchAll(PROBE)) note(probes, m[1], rel);
      for (const m of line.matchAll(ARGV)) note(commands, m[1], rel);
    }
  }
  return { commands, probes };
}

test("every tool that is not on every Unix and that a script or a workflow calls is listed in the dependencies page", () => {
  const listed = listedTools();
  const { commands } = used();
  const missing = NON_STANDARD.filter((n) => commands.has(n) && !listed.has(n)).map((n) => `${n} (${[...new Set(commands.get(n))].join(", ")})`);
  assert.deepEqual(missing, [], "add each of these to a table in docs/reference/dependencies.md");
});

test("every tool a script probes for is listed in the dependencies page", () => {
  const listed = listedTools();
  const { probes } = used();
  const missing = [...probes.keys()].filter((n) => !listed.has(n)).map((n) => `${n} (${[...new Set(probes.get(n))].join(", ")})`);
  assert.deepEqual(missing, [], "add each of these to a table in docs/reference/dependencies.md");
});

test("every tool that archon-kit doctor checks is listed in the dependencies page", () => {
  const listed = listedTools();
  const doctor = read("scripts/archon-kit").split("\n");
  const start = doctor.findIndex((l) => l.startsWith("cmd_doctor()"));
  assert.ok(start > 0, "cmd_doctor is in scripts/archon-kit");
  const body = doctor.slice(start).join("\n");
  const checked = new Set([...body.matchAll(/\bhave\s+([A-Za-z][\w.-]*)/g)].map((m) => m[1]).filter((n) => NON_STANDARD.includes(n) || n === "ps"));
  for (const n of ["jq", "node", "python3", "timeout", "gtimeout", "flock", "gh", "curl", "fuser", "gdate", "realpath", "ps", "lsof"]) assert.ok(checked.has(n), `doctor checks ${n}`);
  const missing = [...checked].filter((n) => !listed.has(n));
  assert.deepEqual(missing, []);
});

test("the first columns of the dependencies page name the tools that the kit's checks rely on", () => {
  const listed = listedTools();
  for (const n of ["archon", "claude", "codex", "bash", "git", "jq", "python3", "node", "flock", "timeout", "gtimeout", "realpath", "readlink", "curl", "gh", "fuser", "gdate", "ps", "lsof"]) {
    assert.ok(listed.has(n), `${n} is in a first column`);
  }
});

test("the dependencies page names the wake template, and the template exists", () => {
  const page = read("docs/reference/dependencies.md");
  assert.match(page, /templates\/wake\/archon-wake\.sh/);
  assert.ok(fs.existsSync(path.join(root, "templates/wake/archon-wake.sh")));
  assert.match(page, /archon workflow wake/);
});

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

test("the wake template runs archon workflow wake --json with the directories of the usual installs on its PATH", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wake-template-")));
  made.push(dir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const record = path.join(dir, "record");
  fs.writeFileSync(path.join(bin, "archon"), `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(record)}\nprintf '%s\\n' "$PATH" >> ${JSON.stringify(record)}\n`, { mode: 0o755 });
  const r = spawnSync("bash", [path.join(root, "templates/wake/archon-wake.sh")], { encoding: "utf8", env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  const [args, searchPath] = fs.readFileSync(record, "utf8").split("\n");
  assert.equal(args, "workflow wake --json");
  assert.ok(searchPath.split(":").includes(`${dir}/.local/bin`), searchPath);
});
