#!/usr/bin/env node
// PreToolUse hook that confines the AI stages of the `build` workflow to paths.
//
// The hook reads the current stage from the marker `lane.sh stage` writes into the worktree's
// git directory (`archon-stage`) and the lanes from the repository's .archon/lanes.json. With no
// marker it allows everything, so interactive sessions are unaffected. With a marker it refuses a
// Write, Edit, MultiEdit, NotebookEdit or Bash call whose write targets break the stage's rule, and
// it refuses every call when the marker, lanes.json or the hook itself is broken, because nothing
// else checks the stage.
//
// Rules for one target path, in order:
//   1. inside the git directory: deny (it holds the marker)
//   2. inside a directory the marker declares: allow
//   3. outside the worktree: allow only /dev/null, /dev/stdout, /dev/stderr, /dev/tty and the
//      temp directory; deny the rest
//   4. ignored by git: allow
//   5. match the stage's lane globs (git `:(glob)` semantics) and apply the stage's mode
//
// The Bash analyzer finds write targets in the forms listed above `writeTargets`. A target it
// cannot resolve (`$R/x`) is allowed, and so is anything an interpreter or a build tool writes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// lane names a set in .archon/lanes.json. "in": only these paths may be written. "out": these
// paths may not be written. lane.sh holds the same table as stage_rule, which its stage-end check
// uses, and lane.test.mjs checks that the two agree.
export const STAGES = {
  tests: { lane: "tests", mode: "in" },
  repair: { lane: "tests", mode: "in" },
  implement: { lane: "tests", mode: "out" },
  sync_fix: { lane: "protected", mode: "out" },
};

// A lane that is absent from lanes.json confines nothing, for sets a repository may leave out.
const OPTIONAL_LANES = new Set(["protected"]);

const HINTS = {
  tests:
    "When the plan cannot be tested without a source change, write the test the way it should read and record what is missing in tests-notes.md in the run's artifacts directory.",
  repair:
    "When the implementer is wrong, change nothing and write repair-declined.md in the run's artifacts directory.",
  implement:
    "When a test is wrong and no implementation can satisfy it, write blocked.md in the run's artifacts directory naming the test and what it should assert, commit everything else, and stop.",
  sync_fix:
    "Fix the implementation instead, and put what you changed in the commit message body.",
};

const DEV_OK = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

// ---------------------------------------------------------------------------------------------
// Glob matching

const POSIX_CLASSES = {
  alpha: "a-zA-Z",
  digit: "0-9",
  alnum: "a-zA-Z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: " \\t\\n\\r\\f\\v",
  punct: "!-\\/:-@\\[-`{-~",
  xdigit: "0-9A-Fa-f",
  blank: " \\t",
  word: "a-zA-Z0-9_",
};

const reEscape = (s) => s.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");

// Compiles a pathspec `:(glob)` pattern to an anchored RegExp over a '/'-separated path
// relative to the repository root. `*` and `?` stay inside a directory; `**` crosses them when
// it is a whole path component. A pattern with no wildcard also matches everything under it.
export function pathspecGlob(glob) {
  if (!/[*?[\\]/.test(glob)) {
    return new RegExp(`^${reEscape(glob.replace(/\/+$/, ""))}(?:/.*)?$`, "s");
  }
  let re = "";
  let i = 0;
  const n = glob.length;
  while (i < n) {
    const c = glob[i];
    if (c === "*") {
      let j = i;
      while (glob[j] === "*") j++;
      const next = glob[j];
      const wholeComponent =
        j - i >= 2 &&
        (i === 0 || glob[i - 1] === "/") &&
        (next === undefined || next === "/" || (next === "\\" && glob[j + 1] === "/"));
      if (wholeComponent && next === "/") {
        re += "(?:.*/)?";
        i = j + 1;
      } else if (wholeComponent) {
        re += ".*";
        i = j;
      } else {
        re += "[^/]*";
        i = j;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "[") {
      let j = i + 1;
      let neg = false;
      if (glob[j] === "!" || glob[j] === "^") {
        neg = true;
        j++;
      }
      const start = j;
      if (glob[j] === "]") j++;
      while (j < n && glob[j] !== "]") {
        if (glob[j] === "[" && glob[j + 1] === ":") {
          const e = glob.indexOf(":]", j + 2);
          if (e > 0) {
            j = e + 2;
            continue;
          }
        }
        if (glob[j] === "\\") j++;
        j++;
      }
      if (j >= n) {
        re += "\\[";
        i++;
        continue;
      }
      let body = "";
      for (let k = start; k < j; k++) {
        if (glob[k] === "[" && glob[k + 1] === ":") {
          const e = glob.indexOf(":]", k + 2);
          const cls = e > 0 ? POSIX_CLASSES[glob.slice(k + 2, e)] : undefined;
          if (cls !== undefined) {
            body += cls;
            k = e + 1;
            continue;
          }
        }
        if (glob[k] === "\\") {
          body += reEscape(glob[k + 1] ?? "");
          k++;
        } else if (glob[k] === "]" || glob[k] === "[" || glob[k] === "^") body += `\\${glob[k]}`;
        else body += glob[k];
      }
      re += neg ? `[^${body}/]` : `(?!/)[${body}]`;
      i = j + 1;
    } else if (c === "\\") {
      re += reEscape(glob[i + 1] ?? "\\");
      i += 2;
    } else {
      re += reEscape(c);
      i++;
    }
  }
  return new RegExp(`^${re}$`, "s");
}

// ---------------------------------------------------------------------------------------------
// Shell lexer

function matchParen(src, i) {
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "'") {
      const e = src.indexOf("'", i + 1);
      if (e < 0) return -1;
      i = e;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") i++;
        i++;
      }
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
    i++;
  }
  return -1;
}

function matchBrace(src, i) {
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
    i++;
  }
  return -1;
}

function braceExpand(v) {
  const open = v.indexOf("{");
  if (open < 0) return [v];
  let depth = 0;
  let close = -1;
  const commas = [];
  for (let k = open; k < v.length; k++) {
    if (v[k] === "{") depth++;
    else if (v[k] === "}" && --depth === 0) {
      close = k;
      break;
    } else if (v[k] === "," && depth === 1) commas.push(k);
  }
  if (close < 0 || commas.length === 0) {
    const rest = braceExpand(v.slice(open + 1));
    return rest.map((r) => v.slice(0, open + 1) + r);
  }
  const pre = v.slice(0, open);
  const post = v.slice(close + 1);
  const bounds = [open, ...commas, close];
  const out = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    for (const alt of braceExpand(v.slice(bounds[k] + 1, bounds[k + 1]))) {
      for (const tail of braceExpand(post)) out.push(pre + alt + tail);
    }
  }
  return out;
}

const OPERATOR_STOP = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);

// Tokens: {t:"word", v, dyn, quoted, subs}, {t:"op", v}, {t:"redir", op, fd, heredoc?}.
// `dyn` marks a word whose value depends on something the lexer cannot know; `subs` holds the
// command substitutions inside the word, to be analyzed as commands of their own.
function lex(src) {
  const toks = [];
  const heredocs = [];
  const home = os.homedir();
  let cur = null;
  let i = 0;
  const n = src.length;
  const W = () => (cur ??= { t: "word", v: "", dyn: false, quoted: false, subs: [] });
  const endWord = () => {
    if (!cur) return;
    if (!cur.quoted && !cur.dyn && cur.v.includes("{") && cur.v.includes(",")) {
      for (const v of braceExpand(cur.v)) toks.push({ ...cur, v, subs: [] });
    } else toks.push(cur);
    cur = null;
  };
  const op = (v) => toks.push({ t: "op", v });

  const dollar = (inDq) => {
    const nx = src[i + 1];
    if (nx === "(") {
      if (src[i + 2] === "(") {
        const e = src.indexOf("))", i + 3);
        W().dyn = true;
        i = e < 0 ? n : e + 2;
        return;
      }
      const e = matchParen(src, i + 2);
      W().subs.push(src.slice(i + 2, e < 0 ? n : e));
      cur.dyn = true;
      i = e < 0 ? n : e + 1;
    } else if (nx === "{") {
      const e = matchBrace(src, i + 2);
      const name = src.slice(i + 2, e < 0 ? n : e);
      if (name === "HOME") W().v += home;
      else W().dyn = true;
      i = e < 0 ? n : e + 1;
    } else if (nx !== undefined && /[A-Za-z_]/.test(nx)) {
      let j = i + 1;
      while (j < n && /\w/.test(src[j])) j++;
      if (src.slice(i + 1, j) === "HOME") W().v += home;
      else W().dyn = true;
      i = j;
    } else if (nx !== undefined && /[0-9@*?$!#-]/.test(nx)) {
      W().dyn = true;
      i += 2;
    } else if (!inDq && nx === "'") {
      let j = i + 2;
      let s = "";
      while (j < n && src[j] !== "'") {
        if (src[j] === "\\") j++;
        s += src[j] ?? "";
        j++;
      }
      W().v += s;
      cur.quoted = true;
      i = j + 1;
    } else {
      W().v += "$";
      i++;
    }
  };

  const backtick = () => {
    let j = i + 1;
    let s = "";
    while (j < n && src[j] !== "`") {
      if (src[j] === "\\") j++;
      s += src[j] ?? "";
      j++;
    }
    W().subs.push(s);
    cur.dyn = true;
    i = j + 1;
  };

  const readHeredocDelim = (strip) => {
    while (src[i] === " " || src[i] === "\t") i++;
    let delim = "";
    let quoted = false;
    while (i < n && !OPERATOR_STOP.has(src[i])) {
      const c = src[i];
      if (c === "'" || c === '"') {
        const e = src.indexOf(c, i + 1);
        delim += src.slice(i + 1, e < 0 ? n : e);
        quoted = true;
        i = e < 0 ? n : e + 1;
      } else if (c === "\\") {
        delim += src[i + 1] ?? "";
        quoted = true;
        i += 2;
      } else {
        delim += c;
        i++;
      }
    }
    const h = { delim, strip, quoted, body: "" };
    heredocs.push(h);
    return h;
  };

  while (i < n) {
    const c = src[i];
    if (c === "\\") {
      if (src[i + 1] !== "\n") {
        W().v += src[i + 1] ?? "";
        cur.quoted = true;
      }
      i += 2;
    } else if (c === "'") {
      const e = src.indexOf("'", i + 1);
      W().v += src.slice(i + 1, e < 0 ? n : e);
      cur.quoted = true;
      i = e < 0 ? n : e + 1;
    } else if (c === '"') {
      W().quoted = true;
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\" && '"\\$`\n'.includes(src[i + 1] ?? "x")) {
          if (src[i + 1] !== "\n") cur.v += src[i + 1];
          i += 2;
        } else if (src[i] === "$") dollar(true);
        else if (src[i] === "`") backtick();
        else cur.v += src[i++];
      }
      i++;
    } else if (c === "$") dollar(false);
    else if (c === "`") backtick();
    else if (c === "#" && !cur) {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === "\n") {
      endWord();
      op("\n");
      i++;
      for (const h of heredocs.splice(0)) {
        const lines = [];
        while (i < n) {
          let e = src.indexOf("\n", i);
          if (e < 0) e = n;
          const line = src.slice(i, e);
          i = Math.min(e + 1, n);
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
          lines.push(line);
        }
        h.body = lines.join("\n");
      }
    } else if (c === ";") {
      endWord();
      if (src[i + 1] === ";") {
        op(";;");
        i += 2;
      } else {
        op(";");
        i++;
      }
    } else if (c === "&") {
      endWord();
      if (src[i + 1] === "&") {
        op("&&");
        i += 2;
      } else if (src[i + 1] === ">") {
        const o = src.startsWith("&>>", i) ? "&>>" : "&>";
        toks.push({ t: "redir", op: o, fd: null });
        i += o.length;
      } else {
        op("&");
        i++;
      }
    } else if (c === "|") {
      endWord();
      if (src[i + 1] === "|") {
        op("||");
        i += 2;
      } else if (src[i + 1] === "&") {
        op("|");
        i += 2;
      } else {
        op("|");
        i++;
      }
    } else if (c === "(" || c === ")") {
      endWord();
      op(c);
      i++;
    } else if ((c === "<" || c === ">") && src[i + 1] === "(") {
      const e = matchParen(src, i + 2);
      W().subs.push(src.slice(i + 2, e < 0 ? n : e));
      cur.dyn = true;
      i = e < 0 ? n : e + 1;
    } else if (c === "<" || c === ">") {
      let fd = null;
      if (cur && !cur.quoted && !cur.dyn && /^\d+$/.test(cur.v)) {
        fd = cur.v;
        cur = null;
      } else endWord();
      let o;
      if (c === ">") {
        o = [">>", ">|", ">&"].find((x) => src.startsWith(x, i)) ?? ">";
      } else {
        o = ["<<<", "<<-", "<<", "<&", "<>"].find((x) => src.startsWith(x, i)) ?? "<";
      }
      i += o.length;
      if (o === "<<" || o === "<<-") {
        toks.push({ t: "redir", op: "<<", fd, heredoc: readHeredocDelim(o === "<<-") });
      } else toks.push({ t: "redir", op: o, fd });
    } else if (c === "~" && !cur && (i + 1 >= n || src[i + 1] === "/" || OPERATOR_STOP.has(src[i + 1]))) {
      W().v += home;
      i++;
    } else {
      W().v += c;
      i++;
    }
  }
  endWord();
  return toks;
}

// ---------------------------------------------------------------------------------------------
// Bash analyzer

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "{", "}", "!", "esac"]);
const SKIPPED_COMPOUNDS = new Set(["for", "select", "case", "function"]);
const WRAPPERS = {
  env: ["-u", "-C", "-S"],
  command: [],
  exec: ["-a"],
  sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-r", "-t", "-U"],
  nice: ["-n"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  nohup: [],
  time: ["-f", "-o", "--format", "--output"],
  builtin: [],
  setsid: [],
  stdbuf: [],
  ionice: ["-c", "-n", "-p"],
  xargs: ["-I", "-n", "-P", "-d", "-L", "-s", "-E", "-a"],
};
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const MAX_DEPTH = 2;

function unwrap(words) {
  let k = 0;
  for (;;) {
    if (k >= words.length) return null;
    const a = words[k];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a.v)) {
      k++;
      continue;
    }
    if (a.dyn) return null;
    if (KEYWORDS.has(a.v)) {
      k++;
      continue;
    }
    const name = path.basename(a.v);
    if (SKIPPED_COMPOUNDS.has(name)) return null;
    if (name in WRAPPERS) {
      k++;
      while (k < words.length && !words[k].quoted && words[k].v.startsWith("-") && words[k].v !== "-") {
        if (words[k].v === "--") {
          k++;
          break;
        }
        k += WRAPPERS[name].includes(words[k].v) ? 2 : 1;
      }
      if (name === "timeout") k++;
      continue;
    }
    return { name, args: words.slice(k + 1) };
  }
}

// Non-flag words of an argument list, with `--` ending flag parsing and `valueFlags` taking the
// following word.
function operands(args, valueFlags = []) {
  const ops = [];
  let dd = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (dd) ops.push(a);
    else if (a.v === "--" && !a.quoted) dd = true;
    else if (!a.quoted && a.v.length > 1 && a.v.startsWith("-")) {
      if (valueFlags.includes(a.v)) k++;
    } else ops.push(a);
  }
  return ops;
}

const hasFlag = (args, re) => args.some((a) => !a.quoted && /^-[^-]/.test(a.v) && re.test(a.v));
const hasLong = (args, name) => args.some((a) => a.v === name || a.v.startsWith(`${name}=`));

const isDirSync = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// Splits the arguments of cp, mv, install and ln into sources and a destination, with `-t DIR`
// and `--target-directory=DIR` naming the destination directory.
function splitDest(args) {
  const valueFlags = ["-S", "--suffix", "-m", "--mode", "-o", "--owner", "-g", "--group"];
  let tdir = null;
  const ops = [];
  let dd = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (dd || a.quoted || !a.v.startsWith("-") || a.v === "-") {
      ops.push(a);
    } else if (a.v === "--") dd = true;
    else if (a.v === "--target-directory") tdir = args[++k] ?? null;
    else if (a.v.startsWith("--target-directory=")) tdir = { ...a, v: a.v.slice(19) };
    else if (/^-[a-zA-Z]*t$/.test(a.v)) tdir = args[++k] ?? null;
    else if (/^-t./.test(a.v)) tdir = { ...a, v: a.v.slice(2) };
    else if (valueFlags.includes(a.v)) k++;
  }
  return { ops, tdir };
}

// File operands of `sed -i` and `perl -i`: the words that are neither flags nor the script.
function scriptFiles(args, scriptFlags, clusterTakesScript) {
  const files = [];
  let script = false;
  let dd = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (dd || a.quoted || !a.v.startsWith("-") || a.v === "-") {
      if (script) files.push(a);
      else script = true;
    } else if (a.v === "--") dd = true;
    else if (scriptFlags.includes(a.v) || (clusterTakesScript && /^-[a-zA-Z0-9.]*[eE]$/.test(a.v))) {
      script = true;
      k++;
    } else if (a.v.startsWith("--expression=") || a.v.startsWith("--file=")) script = true;
  }
  return files;
}

function analyzeIn(src, cwd, depth, out) {
  if (depth > MAX_DEPTH) {
    out.unresolved++;
    return;
  }
  const st = { cwd, made: new Set() };
  const stack = [];
  let words = [];
  let redirs = [];
  let pend = null;
  const flush = () => {
    if (words.length || redirs.length) runCommand(st, words, redirs, depth, out);
    words = [];
    redirs = [];
    pend = null;
  };
  for (const t of lex(src)) {
    if (t.t === "word") {
      if (pend) {
        redirs.push({ op: pend.op, word: t });
        pend = null;
      } else words.push(t);
    } else if (t.t === "redir") {
      if (t.heredoc) redirs.push({ op: "<<", heredoc: t.heredoc });
      else pend = t;
    } else if (t.v === "(") {
      flush();
      stack.push(st.cwd);
    } else if (t.v === ")") {
      flush();
      if (stack.length) st.cwd = stack.pop();
    } else flush();
  }
  flush();
  if (depth === 0) out.endCwd = st.cwd;
}

function addTarget(st, w, opts, out) {
  if (w.dyn) {
    out.unresolved++;
    return null;
  }
  if (w.v === "") return null;
  let p;
  if (path.isAbsolute(w.v)) p = path.resolve(w.v);
  else if (st.cwd == null) {
    out.unresolved++;
    return null;
  } else p = path.resolve(st.cwd, w.v);
  out.targets.push({ path: p, recursive: !!opts.recursive });
  return p;
}

function runCommand(st, words, redirs, depth, out) {
  const add = (w, o = {}) => addTarget(st, w, o, out);
  for (const w of [...words, ...redirs.map((r) => r.word).filter(Boolean)]) {
    for (const s of w.subs) analyzeIn(s, st.cwd, depth + 1, out);
  }
  for (const r of redirs) {
    if (!r.word) continue;
    const writes =
      [">", ">>", ">|", "&>", "&>>", "<>"].includes(r.op) || (r.op === ">&" && !/^(\d+|-)$/.test(r.word.v) && !r.word.dyn);
    if (writes) add(r.word);
  }

  const cmd = unwrap(words);
  if (!cmd) return;
  const { name, args } = cmd;
  const ops = (flags) => operands(args, flags);

  switch (name) {
    // A cd to a directory that does not exist fails and leaves the directory unchanged, unless
    // an earlier mkdir in this command creates it.
    case "cd":
    case "pushd": {
      const a = ops()[0];
      if (!a) st.cwd = os.homedir();
      else if (a.dyn || a.v === "-") st.cwd = null;
      else {
        const np = path.isAbsolute(a.v) ? path.resolve(a.v) : st.cwd == null ? null : path.resolve(st.cwd, a.v);
        if (np == null) st.cwd = null;
        else if (isDirSync(np) || st.made.has(np)) st.cwd = np;
      }
      break;
    }
    case "popd":
      st.cwd = null;
      break;
    case "tee":
    case "touch":
    case "mkdir":
    case "rmdir":
      for (const w of ops(["-d", "-t", "-r", "--date", "--reference", "-m", "--mode"])) {
        const p = add(w);
        if (p && name === "mkdir") st.made.add(p);
      }
      break;
    case "truncate":
      for (const w of ops(["-s", "-r", "--size", "--reference"])) add(w);
      break;
    case "rm": {
      const recursive = hasFlag(args, /[rR]/) || hasLong(args, "--recursive");
      for (const w of ops()) add(w, { recursive });
      break;
    }
    case "chmod":
    case "chown":
    case "chgrp": {
      const recursive = hasFlag(args, /R/) || hasLong(args, "--recursive");
      const isFlag = (a) => !a.quoted && a.v.startsWith("-") && !/^-[-+=ugoarwxXst,0-7]+$/.test(a.v);
      const rest = args.filter((a) => !isFlag(a));
      for (const w of rest.slice(1)) add(w, { recursive });
      break;
    }
    case "cp":
    case "mv":
    case "install":
    case "ln": {
      if (name === "install" && hasFlag(args, /d/)) {
        for (const w of ops(["-m", "-o", "-g"])) add(w);
        break;
      }
      const { ops: all, tdir } = splitDest(args);
      let dest;
      let sources;
      if (tdir) {
        dest = tdir;
        sources = all;
      } else if (all.length >= 2) {
        dest = all[all.length - 1];
        sources = all.slice(0, -1);
      } else break;
      const intoDir =
        tdir || sources.length > 1 || dest.v.endsWith("/") || (!dest.dyn && isDirSync(path.resolve(st.cwd ?? "/", dest.v)));
      if (intoDir) {
        for (const s of sources) add({ ...dest, v: path.join(dest.v, s.dyn ? "_" : path.basename(s.v)) });
      } else add(dest);
      if (name === "mv") for (const s of sources) add(s, { recursive: true });
      break;
    }
    case "dd":
      for (const a of args) if (!a.quoted && a.v.startsWith("of=")) add({ ...a, v: a.v.slice(3) });
      break;
    case "sed":
      if (hasLong(args, "--in-place") || hasFlag(args, /^-[nEsruz]*i/)) {
        for (const w of scriptFiles(args, ["-e", "-f", "--expression", "--file"], false)) add(w);
      }
      break;
    case "perl":
      if (hasFlag(args, /^-[a-zA-Z0-9]*i/) && !args.some((a) => /^-[MmIdDxC]/.test(a.v))) {
        for (const w of scriptFiles(args, ["-e", "-E"], true)) add(w);
      }
      break;
    case "git":
      gitTargets(st, args, add);
      break;
    case "eval": {
      if (args.some((a) => a.dyn)) out.unresolved++;
      else analyzeIn(args.map((a) => a.v).join(" "), st.cwd, depth + 1, out);
      break;
    }
    default:
      if (SHELLS.has(name)) {
        const k = args.findIndex((a) => !a.quoted && /^-[a-zA-Z]*c$/.test(a.v));
        const script = k >= 0 ? args[k + 1] : undefined;
        if (script) {
          if (script.dyn) out.unresolved++;
          else analyzeIn(script.v, st.cwd, depth + 1, out);
        } else if (k < 0 && ops().length === 0) {
          const here = redirs.find((r) => r.heredoc);
          if (here) analyzeIn(here.heredoc.body, st.cwd, depth + 1, out);
        }
      }
  }
}

function gitTargets(st, args, add) {
  let k = 0;
  let cwd = st.cwd;
  while (k < args.length && args[k].v.startsWith("-") && !args[k].quoted) {
    if (args[k].v === "-C") {
      const d = args[k + 1];
      cwd = !d || d.dyn ? null : path.resolve(cwd ?? "/", d.v);
      k += 2;
    } else k += args[k].v === "-c" ? 2 : 1;
  }
  const sub = args[k]?.v;
  const rest = args.slice(k + 1);
  const addIn = (w, o) => {
    const prev = st.cwd;
    st.cwd = cwd;
    add(w, o);
    st.cwd = prev;
  };
  switch (sub) {
    case "checkout": {
      const dd = rest.findIndex((a) => a.v === "--");
      for (const w of dd >= 0 ? rest.slice(dd + 1) : rest.filter((a) => a.v === ".")) addIn(w, { recursive: true });
      break;
    }
    case "restore": {
      const staged = hasLong(rest, "--staged") || hasFlag(rest, /^-S$/);
      const worktree = hasLong(rest, "--worktree") || hasFlag(rest, /^-W$/);
      if (staged && !worktree) break;
      for (const w of operands(rest, ["-s", "--source"])) addIn(w, { recursive: true });
      break;
    }
    case "rm":
      if (hasLong(rest, "--cached")) break;
      for (const w of operands(rest)) addIn(w, { recursive: hasFlag(rest, /r/) });
      break;
    case "mv":
      for (const w of operands(rest)) addIn(w, { recursive: true });
      break;
  }
}

// Finds the files a Bash command writes, in these forms: redirects (>, >>, >|, &>, N>), tee,
// touch, mkdir, rmdir, rm, truncate, chmod, cp, install, ln, mv, sed -i, perl -i, dd of=, and
// git checkout/restore/rm/mv with explicit paths. It follows quoting, heredocs, ; && || |,
// $(...), `...`, bash -c, eval and cd. Returns {targets: [{path, recursive}], unresolved}, where
// `unresolved` counts targets whose path depends on something the analyzer cannot know, and
// `endCwd` is the directory the command leaves the shell in (null when it cannot be known).
export function writeTargets(command, cwd) {
  const out = { targets: [], unresolved: 0, endCwd: cwd ?? null };
  analyzeIn(String(command ?? ""), cwd ?? null, 0, out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Decisions

class Deny extends Error {}

function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.replace(/\n$/, "") : null;
}

function realpathDeep(p) {
  let head = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail.reverse());
    } catch {
      const up = path.dirname(head);
      if (up === head) return p;
      tail.push(path.basename(head));
      head = up;
    }
  }
}

function within(dir, p) {
  const r = path.relative(dir, p);
  return r === "" || (r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r));
}

const posix = (p) => p.split(path.sep).join("/");

// Builds the context for one stage: the worktree root, the git directory, the declared writable
// directories and the compiled lane. Throws Deny when the lanes cannot be read.
export function buildContext({ root, stage, allow = [], lanes }) {
  const spec = STAGES[stage];
  if (!spec) return null;
  const rootReal = fs.realpathSync(root);
  const globs = lanes?.[spec.lane];
  if (!Array.isArray(globs) || globs.length === 0 || !globs.every((g) => typeof g === "string")) {
    if (OPTIONAL_LANES.has(spec.lane) && (globs === undefined || (Array.isArray(globs) && globs.length === 0))) return null;
    throw new Deny(`.archon/lanes.json declares no "${spec.lane}" globs, so the ${stage} stage cannot be confined`);
  }
  const gitDirRaw = git(rootReal, ["rev-parse", "--git-dir"]);
  if (gitDirRaw == null) throw new Deny(`cannot find the git directory of ${rootReal}`);
  return {
    root: rootReal,
    stage,
    spec,
    gitDirs: [realpathDeep(path.resolve(rootReal, gitDirRaw)), path.join(rootReal, ".git")],
    allowRaw: allow,
    allow: allow.map(realpathDeep),
    globs,
    res: globs.map(pathspecGlob),
    tmp: [...new Set([realpathDeep(os.tmpdir()), realpathDeep("/tmp")])],
  };
}

// git reports a directory that does not exist yet as ignored only with a trailing slash.
function isIgnored(ctx, rel) {
  const ignored = (r) => spawnSync("git", ["-C", ctx.root, "check-ignore", "-q", "--", r]).status === 0;
  if (ignored(rel)) return true;
  const abs = path.join(ctx.root, rel);
  return (!fs.existsSync(abs) || isDirSync(abs)) && ignored(`${rel}/`);
}

function filesUnder(ctx, rel) {
  const r = spawnSync("git", ["-C", ctx.root, "ls-files", "-co", "--exclude-standard", "-z", "--", `:(literal)${rel === "" ? "." : rel}`], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout.split("\0").filter(Boolean) : [];
}

function artifactsNote(ctx) {
  return ctx.allowRaw.length ? ` The run's artifacts directory is ${ctx.allowRaw[0]}.` : "";
}

function denyOutside(ctx, p) {
  const extra = ctx.allowRaw.length ? `, and ${ctx.allowRaw.join(", ")}` : "";
  return `Lane hook (${ctx.stage} stage): ${p} is outside the worktree ${ctx.root}. This stage may write outside it only to the temp directory (${ctx.tmp[0]}), /dev/null, /dev/stdout, /dev/stderr and /dev/tty${extra}.`;
}

function laneCheck(ctx, t, p) {
  const rel = posix(path.relative(ctx.root, p));
  if (rel !== "" && isIgnored(ctx, rel)) return null;
  const inLane = (r) => ctx.res.some((re) => re.test(r));
  const { mode, lane } = ctx.spec;
  const inside = `Lane hook (${ctx.stage} stage): ${rel || "."} is inside the ${lane} lane (${ctx.globs.join(", ")}), and this stage may not change it. ${HINTS[ctx.stage]}${artifactsNote(ctx)}`;
  const outside = (r) =>
    `Lane hook (${ctx.stage} stage): ${r || "."} is outside the ${lane} lane, and this stage may change only ${ctx.globs.join(", ")}. ${HINTS[ctx.stage]}${artifactsNote(ctx)}`;

  if (t.recursive && isDirSync(p)) {
    const files = filesUnder(ctx, rel);
    if (mode === "out") {
      if (inLane(rel)) return inside;
      const hit = files.find(inLane);
      return hit ? `${inside.replace(rel || ".", `${rel || "."} (it holds ${hit})`)}` : null;
    }
    const bad = files.find((f) => !inLane(f));
    if (bad) return outside(bad);
    return inLane(rel) || inLane(`${rel}/_`) ? null : outside(rel);
  }
  if (mode === "out") return inLane(rel) ? inside : null;
  return inLane(rel) || inLane(`${rel}/_`) ? null : outside(rel);
}

// Returns a deny reason for one write target, or null.
export function checkTarget(ctx, t) {
  const given = path.resolve(t.path);
  if (DEV_OK.has(given)) return null;
  const p = realpathDeep(given);
  if (ctx.gitDirs.some((d) => within(d, p) || within(d, given))) {
    return `Lane hook (${ctx.stage} stage): ${given} is inside the git directory, which holds the stage marker and the repository's data. Use git commands instead of writing there.`;
  }
  if (ctx.allow.some((d) => within(d, p))) return null;
  if (within(ctx.root, p)) return laneCheck(ctx, t, p);
  if (ctx.tmp.some((d) => within(d, p))) return null;
  return denyOutside(ctx, given);
}

// Tools that run a shell command. Claude calls it Bash; Codex's shell tool carries the command in
// `tool_input.command`, as a string or as an argv array.
const SHELL_TOOLS = new Set(["Bash", "shell", "local_shell", "shell_command", "exec_command", "container.exec"]);

// The command of a shell call as one text. An argv array is joined with spaces, except that the
// script of a ["bash", "-lc", <script>] call is the script alone.
export function commandText(command) {
  if (Array.isArray(command)) {
    const parts = command.map(String);
    if (parts.length >= 3 && /^(?:.*\/)?(?:ba|z|da|k)?sh$/.test(parts[0]) && /^-[a-z]*c$/.test(parts[1])) return parts[parts.length - 1];
    return parts.join(" ");
  }
  return typeof command === "string" ? command : String(command ?? "");
}

// Every string anywhere in a tool input.
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

// The file paths that an apply_patch patch adds, updates, deletes or moves to. The payload shape
// of Codex's apply_patch is not documented, so the patch text is searched in every string of the
// input (a `command` string, an argv array, or a field of its own).
export function patchTargets(text) {
  const paths = [];
  for (const m of String(text).matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm)) paths.push(m[1]);
  return paths;
}

export function evaluate(ctx, input) {
  const ti = input.tool_input ?? {};
  const base = typeof input.cwd === "string" ? input.cwd : ctx.root;
  let targets = [];
  if (SHELL_TOOLS.has(input.tool_name)) {
    const command = commandText(ti.command);
    targets = writeTargets(command, base).targets;
    // A shell call that runs `apply_patch` carries the patch in its text.
    for (const f of patchTargets(command)) targets.push({ path: path.resolve(base, f), recursive: false });
  } else if (input.tool_name === "apply_patch") {
    const files = strings(ti).flatMap(patchTargets);
    if (files.length === 0) {
      return `Lane hook (${ctx.stage} stage): cannot tell which files this apply_patch call writes, so the hook refuses it while a stage is confined. Write the files with an editor tool or a shell command instead.`;
    }
    targets = files.map((f) => ({ path: path.resolve(base, f), recursive: false }));
  } else {
    const f = ti.file_path ?? ti.notebook_path;
    if (typeof f === "string" && f !== "") targets = [{ path: path.resolve(base, f), recursive: false }];
  }
  const seen = new Set();
  for (const t of targets) {
    const key = `${t.path}\0${t.recursive}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reason = checkTarget(ctx, t);
    if (reason) return reason;
  }
  return null;
}

// Finds the stage marker for the session's worktree. Returns null when there is none or when
// the worktree cannot be found, and {root, raw} when a marker exists.
function locate(input, env) {
  try {
    const dir = env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
    const top = git(dir, ["rev-parse", "--show-toplevel"]);
    if (top == null) return null;
    const root = fs.realpathSync(top);
    const rel = git(root, ["rev-parse", "--git-path", "archon-stage"]);
    if (rel == null) return null;
    const markerPath = path.resolve(root, rel);
    try {
      return { root, markerPath, raw: fs.readFileSync(markerPath, "utf8") };
    } catch (e) {
      return e.code === "ENOENT" || e.code === "ENOTDIR" ? null : { root, markerPath, error: e.message };
    }
  } catch {
    return null;
  }
}

const denyJson = (reason) =>
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });

function markerContext(loc) {
  if (loc.error) throw new Deny(`the stage marker ${loc.markerPath} cannot be read (${loc.error})`);
  let m;
  try {
    m = JSON.parse(loc.raw);
  } catch {
    throw new Deny(`the stage marker ${loc.markerPath} is not valid JSON; run lane.sh stage or unstage`);
  }
  if (m === null || typeof m !== "object" || typeof m.stage !== "string" || !Array.isArray(m.allow) || !m.allow.every((a) => typeof a === "string")) {
    throw new Deny(`the stage marker ${loc.markerPath} must be {"stage": string, "allow": [string]}; run lane.sh stage or unstage`);
  }
  if (!(m.stage in STAGES)) return null;
  let lanes;
  try {
    lanes = JSON.parse(fs.readFileSync(path.join(loc.root, ".archon", "lanes.json"), "utf8"));
  } catch (e) {
    throw new Deny(`.archon/lanes.json is missing or invalid (${e.message}), so the ${m.stage} stage cannot be confined`);
  }
  return buildContext({ root: loc.root, stage: m.stage, allow: m.allow, lanes });
}

// The whole hook: raw stdin text in, the text for stdout out. An empty string allows the call.
export function run(raw, env = process.env, evalFn = evaluate) {
  let input = null;
  try {
    input = JSON.parse(raw);
  } catch {
    // handled below, once we know whether a stage is running
  }
  const loc = locate(input, env);
  if (!loc) return "";
  try {
    if (input === null || typeof input !== "object") throw new Deny("the hook input is not valid JSON");
    const ctx = markerContext(loc);
    if (!ctx) return "";
    const reason = evalFn(ctx, input);
    return reason ? denyJson(reason) : "";
  } catch (e) {
    const why = e instanceof Deny ? e.message : `lane hook internal error: ${e?.stack ?? e}`;
    return denyJson(`Lane hook refused this call because it cannot tell whether it is allowed: ${why}`);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    // no stdin: nothing to judge
  }
  process.stdout.write(run(raw));
}
