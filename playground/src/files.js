// Files a workflow creates while it runs, and the nodes that write and read them. This is a reading of the
// shell and prompt text, not a shell parser: it finds redirects, tee, cp, mv, touch, mkdir and rm, the
// scripts the page knows write files (FILE_RULES.scripts), and the sentences of a prompt that tell an agent
// to write a path. A file is identified by where it lives and its name: "artifacts:deliver.txt".
//   where: artifacts (the run's $ARTIFACTS_DIR), designs (~/.archon/designs/<repo>/<slug>/), worktree (the
//   checkout), gitdir (the worktree's git directory), state (~/.archon/state), other (an unresolved path).
var FILE_WHERE = {
  artifacts: "run artifacts", designs: "reports", worktree: "worktree", gitdir: "git dir", state: "state", other: "other",
};
var FILE_WRITE_HOW = { redirect: "redirect", tee: "tee", cp: "cp", mv: "mv", touch: "touch", mkdir: "mkdir", deletes: "deletes", script: "script", flag: "output flag", agent: "agent", include: "included workflow" };

function filesBlankComments(text) {
  return text.replace(/^[ \t]*#.*$/gm, (m) => " ".repeat(m.length));
}

// A line that only names a path (`f="$ARTIFACTS_DIR/x"`) defines an alias and reads nothing.
function filesBlankAssignments(text) {
  return text.replace(/^[ \t]*(?:local[ \t]+)?[A-Za-z_]\w*=(?:"[^"\n$]*(?:\$[A-Za-z_{][^"\n$()]*)*"|[^\s$()`"';|&]+)[ \t]*$/gm, (m) => (/\$\(|`/.test(m) ? m : " ".repeat(m.length)));
}

// Same length as the input, so indexes line up: comments and the inside of single-quoted strings are blanked.
function filesMask(text) {
  return filesBlankComments(text).replace(/'[^'\n]*'/g, (m) => "'" + " ".repeat(m.length - 2) + "'");
}

function filesUnquote(tok) {
  const t = tok.trim();
  if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) return t.slice(1, -1);
  return t;
}

// Replace aliases and the well-known roots, giving "@A/name" for the artifacts directory and so on.
function filesExpand(expr, aliases) {
  let s = expr.replace(/\$\{([A-Za-z_]\w*)\}/g, "$$$1");
  s = s.replace(/\$ARTIFACTS_DIR\b/g, "@A");
  s = s.replace(/\$HOME\/\.archon\/designs\/[^/\s"']+\/[^/\s"']+/g, "@D").replace(/\$HOME\/\.archon\/state/g, "@S");
  for (let i = 0; i < 6; i++) {
    const next = s.replace(/\$([A-Za-z_]\w*)/g, (m, name) => (aliases.has(name) && !Array.isArray(aliases.get(name)) ? aliases.get(name) : m));
    if (next === s) break;
    s = next;
  }
  return s;
}

// -> [{id, where, name}]: more than one when the path names a for-loop variable.
function filesResolve(expr, aliases, allowRoot) {
  let s = filesExpand(filesUnquote(expr), aliases);
  const loopVar = /\$([A-Za-z_]\w*)/.exec(s);
  if (loopVar && Array.isArray(aliases.get(loopVar[1]))) {
    return aliases.get(loopVar[1]).flatMap((w) => filesResolve(s.split("$" + loopVar[1]).join(w), aliases, allowRoot));
  }
  s = s.replace(/\/\.$/, "/").replace(/\/{2,}/g, "/");
  let where;
  let name;
  const root = /^@([ADSGM]|N:[A-Za-z_]\w*)(\/.*)?$/.exec(s);
  if (root) {
    const r = root[1];
    name = (root[2] || "").replace(/^\//, "");
    if (r === "A") where = "artifacts";
    else if (r === "D") where = "designs";
    else if (r === "S") where = "state";
    else if (r === "G") where = "gitdir";
    else if (r === "N:settings") { where = "worktree"; name = "<brief_dir>/" + (name ? name.replace(/^[^/]+/, "<slug>") : ""); }
    else return [];
  } else if (s && !/^[/$~@]/.test(s) && !/^(?:--|-\w)/.test(s) && !/^\.\.?$/.test(s)) {
    where = "worktree";
    name = s;
  } else {
    return [];
  }
  name = name.replace(/@N:(?:inputs_ok|intake)\b/g, "<slug>").replace(/@N:(\w+)/g, "<$1>").replace(/\$([A-Za-z_]\w*)/g, "<$1>");
  const dir = /\/$/.test(name);
  name = name.replace(/\/+$/, "");
  if (name === "." || name === "/") name = "";
  if (!name && !(allowRoot && where === "designs")) return [];
  return [{ id: where + ":" + name, where, name, dir }];
}

// name=value lines, in order, so a later one can use an earlier one; for-loop variables hold their words.
function filesAliases(text) {
  const aliases = new Map();
  const src = filesBlankComments(text);
  for (const m of src.matchAll(/^[ \t]*for[ \t]+([A-Za-z_]\w*)[ \t]+in[ \t]+([^;\n]+?)[ \t]*;[ \t]*do\b/gm)) {
    const words = m[2].trim().split(/\s+/).map(filesUnquote);
    if (words.length && words.every((w) => /^[\w.\-/]+$/.test(w))) aliases.set(m[1], words);
  }
  for (const m of src.matchAll(/^[ \t]*(?:local[ \t]+)?([A-Za-z_]\w*)=(.*)$/gm)) {
    const name = m[1];
    const rhs = m[2].trim();
    if (/\$\(/.test(rhs) && /--design-dir\b/.test(rhs)) {
      const suffix = /\)\/([^"\s]+)/.exec(rhs);
      aliases.set(name, "@D" + (suffix ? "/" + suffix[1] : ""));
      continue;
    }
    if (rhs.startsWith("$(")) {
      if (/--main-worktree\b/.test(rhs)) aliases.set(name, "@M");
      continue;
    }
    const first = /^("[^"]*"|'[^']*'|\S+)/.exec(rhs);
    if (!first) continue;
    const ref = /^\$([A-Za-z_]\w*)\.output$/.exec(filesUnquote(first[1]));
    if (ref) { aliases.set(name, "@N:" + ref[1]); continue; }
    const value = filesUnquote(first[1]);
    if (/\$\(|`/.test(value)) continue;
    const expanded = filesExpand(value, aliases);
    if (/^@[ADSGMN]/.test(expanded)) aliases.set(name, expanded);
  }
  return aliases;
}

var FILE_TOKEN = '"[^"\\n]*"|\\S+?(?=[\\s;|&)]|$)';

// ---- shell ----

function filesOfBash(text, rules) {
  const aliases = filesAliases(text);
  const masked = filesMask(text);
  const blanked = filesBlankAssignments(filesBlankComments(text));
  let writes = [];
  const taken = [];
  const addWrite = (expr, how, index) => {
    for (const f of filesResolve(expr, aliases, true)) writes.push({ id: f.id, where: f.where, name: f.name, dir: f.dir || f.name === "", how });
    if (index !== undefined) taken.push([index, index + expr.length]);
  };
  for (const m of masked.matchAll(/(?<![\d&<>])>>?\|?[ \t]*("[^"\n]*"|[^\s;|&()<>]+)/g)) {
    if (/^\/dev\/(?:null|stdout|stderr|tty)$/.test(filesUnquote(m[1]))) continue;
    addWrite(m[1], "redirect", m.index + m[0].length - m[1].length);
  }
  for (const m of masked.matchAll(/\b[3-9]>>?[ \t]*("[^"\n]*"|[^\s;|&()<>]+)/g)) addWrite(m[1], "redirect", m.index + m[0].length - m[1].length);
  for (const m of masked.matchAll(/\btee[ \t]+(?:-a[ \t]+)?("[^"\n]*"|[^\s;|&()<>]+)/g)) addWrite(m[1], "tee", m.index + m[0].length - m[1].length);
  for (const m of masked.matchAll(/\btouch[ \t]+("[^"\n]*"|[^\s;|&()<>]+)/g)) addWrite(m[1], "touch", m.index + m[0].length - m[1].length);
  for (const m of masked.matchAll(/\bmkdir[ \t]+(?:-\w+[ \t]+)*("[^"\n]*"|[^\s;|&()<>]+)/g)) {
    const at = m.index + m[0].length - m[1].length;
    const fs = filesResolve(m[1], aliases, true);
    for (const f of fs) writes.push({ id: f.id, where: f.where, name: f.name, dir: true, how: "mkdir" });
    taken.push([at, at + m[1].length]);
  }
  for (const m of masked.matchAll(/\b(cp|mv)[ \t]+((?:-[A-Za-z]+[ \t]+)*)((?:"[^"\n]*"|[^\s;|&()<>]+)(?:[ \t]+(?:"[^"\n]*"|[^\s;|&()<>]+))+)/g)) {
    const args = m[3].match(/"[^"\n]*"|[^\s;|&()<>]+/g);
    const dest = args[args.length - 1];
    const at = m.index + m[0].length - dest.length;
    for (const f of filesResolve(dest, aliases, true)) writes.push({ id: f.id, where: f.where, name: f.name, dir: f.dir || f.name === "" || /\s-\w*[rR]/.test(" " + m[2]), how: m[1] });
    taken.push([at, at + dest.length]);
  }
  for (const m of masked.matchAll(/\brm[ \t]+((?:-\w+[ \t]+)*)((?:"[^"\n]*"|[^\s;|&()<>]+)(?:[ \t]+(?:"[^"\n]*"|[^\s;|&()<>]+))*)/g)) {
    let at = m.index + m[0].length - m[2].length;
    for (const tok of m[2].match(/"[^"\n]*"|[^\s;|&()<>]+/g)) {
      const pos = masked.indexOf(tok, at);
      addWrite(tok, "deletes", pos);
      at = pos + tok.length;
    }
  }
  const flags = (rules && rules.flags) || {};
  const flagRe = new RegExp("(" + Object.keys(flags).map((f) => f.replace(/[-]/g, "\\-")).join("|") + ")[ =](" + FILE_TOKEN + ")", "g");
  let reads = [];
  if (Object.keys(flags).length) {
    for (const m of masked.matchAll(flagRe)) {
      const at = m.index + m[0].length - m[2].length;
      if (flags[m[1]] === "write") addWrite(m[2], "flag", at);
      else taken.push([at, at + m[2].length]), filesResolve(m[2], aliases).forEach((f) => reads.push({ id: f.id, where: f.where, name: f.name, dir: f.dir }));
    }
  }
  for (const rule of (rules && rules.scripts) || []) {
    const re = new RegExp(rule.match, "g");
    for (const m of masked.matchAll(re)) {
      const lineEnd = masked.indexOf("\n", m.index);
      const line = masked.slice(m.index, lineEnd < 0 ? masked.length : lineEnd);
      if (rule.unless && new RegExp(rule.unless).test(line)) continue;
      const sub = (entry) => entry.replace(/^\$(\d)$/, (_, n) => m[Number(n)] || "");
      for (const w of rule.writes || []) {
        const spec = sub(w);
        if (!spec) continue;
        if (/^\$|^@/.test(spec) || spec.startsWith('"')) addWrite(spec, "script");
        else {
          const colon = /^(artifacts|gitdir|designs|state|worktree):(.*)$/.exec(spec);
          const full = colon ? colon[2] : spec;
          const name = full.replace(/\/+$/, "");
          writes.push({ id: (colon ? colon[1] : "artifacts") + ":" + name, where: colon ? colon[1] : "artifacts", name, dir: name !== full, how: rule.how || "script" });
        }
      }
      for (const r of rule.reads || []) {
        const spec = sub(r);
        if (!spec) continue;
        const colon = /^(artifacts|gitdir|designs|state|worktree):(.*)$/.exec(spec);
        if (colon) reads.push({ id: spec, where: colon[1], name: colon[2] });
        else if (/^\$|^@|^"/.test(spec)) filesResolve(spec, aliases).forEach((f) => reads.push({ id: f.id, where: f.where, name: f.name }));
        else reads.push({ id: "artifacts:" + spec.replace(/\/+$/, ""), where: "artifacts", name: spec.replace(/\/+$/, "") });
      }
      for (const w of rule.writes || []) {
        const cap = /^\$(\d)$/.exec(w);
        if (cap && m[Number(cap[1])]) {
          const at = m.index + m[0].indexOf(m[Number(cap[1])]);
          taken.push([at, at + m[Number(cap[1])].length]);
        }
      }
    }
  }
  const inTaken = (i) => taken.some(([a, b]) => i >= a && i < b);
  for (const m of blanked.matchAll(/\$\{?[A-Za-z_]\w*\}?(?:\/[^\s"'`;|&()<>]*)?/g)) {
    if (inTaken(m.index)) continue;
    const tok = m[0];
    if (/^\$\{?(?:ARTIFACTS_DIR)\}?$/.test(tok)) continue;
    const bare = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(tok);
    if (bare && !aliases.has(bare[1])) continue;
    if (!/ARTIFACTS_DIR/.test(tok) && !bare && !/^\$\{?[A-Za-z_]\w*\}?\//.test(tok)) continue;
    for (const f of filesResolve(tok, aliases)) {
      if (f.where === "other") continue;
      reads.push({ id: f.id, where: f.where, name: f.name });
    }
  }
  const once = (list) => {
    const seen = new Set();
    return list.filter((f) => (seen.has(f.id + "|" + (f.how || "")) ? false : (seen.add(f.id + "|" + (f.how || "")), true)));
  };
  return { writes: once(writes), reads: once(reads) };
}

// ---- prompts ----

var FILE_PROMPT_TOKEN = /\$\{?ARTIFACTS_DIR\}?\/(?:[\w.*-]|\/|<[^<>\n]{1,24}>)*(?:[\w>/])/g;

function filesOfPrompt(text) {
  const flat = text.replace(/\s+/g, " ");
  const writes = [];
  const reads = [];
  for (const m of flat.matchAll(FILE_PROMPT_TOKEN)) {
    const rel = m[0].replace(/^\$\{?ARTIFACTS_DIR\}?\//, "");
    const name = rel.replace(/\/+$/, "");
    if (!name) continue;
    const isDir = rel !== name;
    const before = flat.slice(0, m.index);
    const cut = Math.max(before.lastIndexOf(". "), before.lastIndexOf("? "), before.lastIndexOf("! "));
    const ctx = before.slice(cut < 0 ? Math.max(0, before.length - 160) : cut + 2).slice(-160);
    const f = { id: "artifacts:" + name, where: "artifacts", name, dir: isDir };
    const direct = /\b(?:write|writes|append|appends|save|saves)\s+(?:only\s+)?(?:to\s+|into\s+|under\s+)?$/i.test(ctx);
    const into = /\b(?:write|writes|append|appends|save|saves|record|records|put|puts|create|creates)\b(?:[^.;]|\.(?=\S)){0,70}?\b(?:to|into|in|under)\s+$/i.test(ctx);
    const built = /\bbuild(?:s)?\b(?:[^.;]|\.(?=\S)){0,70}?\bat\s+$/i.test(ctx);
    const moved = /\bMove\s+\S+\s+to\s+$/.test(ctx);
    if (direct || into || built || moved) writes.push(Object.assign(f, { how: "agent" }));
    else reads.push(f);
  }
  return { writes, reads };
}

// ---- nodes and workflows ----

function filesFieldKinds(node) {
  const out = [];
  for (const f of nodeTextFields(node)) {
    if (/^(?:bash|script|loop_group\.until_bash|loop\.until_bash)$/.test(f.path)) out.push(["bash", f.text]);
    else if (/prompt$/i.test(f.path)) out.push(["prompt", f.text]);
  }
  return out;
}

function filesDedupe(list) {
  const seen = new Set();
  return list.filter((f) => {
    const k = f.id + "|" + (f.how || "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// -> {writes: [{id, where, name, how}], reads: [{id, where, name}]}
function filesOfNode(node, ctx) {
  const rules = (ctx && ctx.rules) || { scripts: [], flags: {} };
  const depth = (ctx && ctx.depth) || 0;
  let writes = [];
  let reads = [];
  for (const [kind, text] of filesFieldKinds(node)) {
    const r = kind === "bash" ? filesOfBash(text, rules) : filesOfPrompt(text);
    writes = writes.concat(r.writes);
    reads = reads.concat(r.reads);
  }
  if (typeof node.include === "string" && ctx && ctx.getWorkflow && depth < 4) {
    const inc = ctx.getWorkflow(node.include);
    if (inc) {
      for (const e of flattenNodes(inc)) {
        const r = filesOfNode(e.node, { rules, getWorkflow: ctx.getWorkflow, depth: depth + 1 });
        writes = writes.concat(r.writes.map((w) => Object.assign({}, w, { how: "include" })));
        reads = reads.concat(r.reads);
      }
    }
  }
  const fix = ctx && ctx.overrides && ctx.overrides[ctx.nodeKey];
  if (fix) {
    const ignore = new Set(fix.ignore || []);
    writes = writes.filter((w) => !ignore.has(w.id));
    reads = reads.filter((r) => !ignore.has(r.id));
    for (const spec of fix.writes || []) writes.push(filesFromSpec(spec, "agent"));
    for (const spec of fix.reads || []) reads.push(filesFromSpec(spec));
  }
  return { writes: filesDedupe(writes), reads: filesDedupe(reads) };
}

function filesFromSpec(spec, how) {
  const m = /^(artifacts|gitdir|designs|state|worktree|other):(.*)$/.exec(spec);
  const f = { id: m ? spec : "artifacts:" + spec, where: m ? m[1] : "artifacts", name: m ? m[2] : spec };
  if (how) f.how = how;
  return f;
}

// -> {files: [{id, where, name, writers: [{key, how}], readers: [key], external}], byNode: {key: {writes, reads}}}
// A file with a reader and no writer is made outside this workflow, such as an input a caller left.
function workflowFiles(wf, options) {
  const rules = (options && options.rules) || (typeof FILE_RULES !== "undefined" ? FILE_RULES : { scripts: [], flags: {} });
  const getWorkflow = (options && options.getWorkflow) || null;
  const overrides = (options && options.overrides) || (rules && rules.nodes ? rules.nodes[wf.name] : null) || null;
  const files = new Map();
  const byNode = {};
  const touch = (f) => {
    if (!files.has(f.id)) files.set(f.id, { id: f.id, where: f.where, name: f.name, dir: false, writers: [], readers: [], external: false });
    const entry = files.get(f.id);
    if (f.dir) entry.dir = true;
    return entry;
  };
  for (const e of flattenNodes(wf)) {
    const r = filesOfNode(e.node, { rules, getWorkflow, overrides, nodeKey: e.key });
    byNode[e.key] = r;
    for (const w of r.writes) {
      const f = touch(w);
      if (!f.writers.some((x) => x.key === e.key && x.how === w.how)) f.writers.push({ key: e.key, how: w.how });
    }
    for (const rd of r.reads) {
      const f = touch(rd);
      if (!f.readers.includes(e.key)) f.readers.push(e.key);
    }
  }
  const order = ["artifacts", "designs", "worktree", "gitdir", "state", "other"];
  const list = [...files.values()].sort((a, b) => order.indexOf(a.where) - order.indexOf(b.where) || a.name.localeCompare(b.name));
  const made = (f) => f.writers.some((w) => w.how !== "deletes");
  const dirs = list.filter((f) => f.dir && made(f));
  for (const f of list) {
    f.external = !made(f) && !dirs.some((d) => d.where === f.where && (d.name === "" || f.name.startsWith(d.name + "/")));
  }
  return { files: list, byNode };
}

// A function reach(a, b) telling whether node b runs after node a by declared order alone: depends_on inside a
// scope, a loop's body after what the loop depends on, and what depends on a loop after the loop's body nodes.
function declaredOrder(wf) {
  const entries = flattenNodes(wf);
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const resolve = (parent, id) => (parent ? parent + "." + id : id);
  const succ = new Map(entries.map((e) => [e.key, new Set()]));
  const addEdge = (from, to) => { if (succ.has(from)) succ.get(from).add(to); };
  for (const e of entries) for (const dep of e.node.depends_on || []) addEdge(resolve(e.parentKey, dep), e.key);
  for (const e of entries) {
    if (!e.parentKey) continue;
    const loop = byKey.get(e.parentKey);
    for (const dep of loop.node.depends_on || []) addEdge(resolve(loop.parentKey, dep), e.key);
    for (const x of entries) if ((x.node.depends_on || []).some((dep) => resolve(x.parentKey, dep) === e.parentKey)) addEdge(e.key, x.key);
  }
  return (from, to) => {
    const seen = new Set();
    const stack = [from];
    while (stack.length) {
      const k = stack.pop();
      if (k === to) return true;
      if (seen.has(k)) continue;
      seen.add(k);
      for (const n of succ.get(k) || []) stack.push(n);
    }
    return false;
  };
}

// The files drawn as nodes. Mode "all" draws every file. "linked" draws the files that one node makes and a different
// node reads, leaving out a file only its writer reads and one only a loop's exit test reads. "undeclared" keeps the
// linked files that have a reader no writer reaches through declared order (depends_on and loop placement), which is
// where a file is the only thing joining two nodes. Writers, deleters and readers are node keys, which is what
// layout.js lays the file out between. "linked" and "undeclared" need wf, the workflow's model.
function fileNodes(wfFiles, mode, wf) {
  const once = (list) => list.filter((k, i) => list.indexOf(k) === i);
  const narrowed = mode === "linked" || mode === "undeclared";
  const loops = new Set(narrowed && wf ? flattenNodes(wf).filter((e) => bodyOf(e.node)).map((e) => e.key) : []);
  const reach = mode === "undeclared" && wf ? declaredOrder(wf) : null;
  const keep = (f) => {
    if (!narrowed) return true;
    const writers = f.writers.filter((w) => w.how !== "deletes").map((w) => w.key);
    if (!writers.length) return false;
    const others = f.readers.filter((k) => !writers.includes(k) && !loops.has(k));
    if (!others.length) return false;
    return !reach || others.some((k) => !writers.some((w) => reach(w, k)));
  };
  return wfFiles.files
    .filter(keep)
    .map((f) => ({
      key: "file:" + f.id, id: f.id, name: f.name, where: f.where, dir: f.dir, external: f.external,
      writers: once(f.writers.filter((w) => w.how !== "deletes").map((w) => w.key)),
      deleters: once(f.writers.filter((w) => w.how === "deletes").map((w) => w.key)),
      readers: f.readers.slice(),
    }));
}

// Files the second workflow has and the first does not, and the reverse.
function filesDiff(before, after) {
  const a = new Map(before.files.map((f) => [f.id, f]));
  const b = new Map(after.files.map((f) => [f.id, f]));
  return {
    added: after.files.filter((f) => !a.has(f.id)),
    removed: before.files.filter((f) => !b.has(f.id)),
    rewired: after.files
      .filter((f) => a.has(f.id) && JSON.stringify([a.get(f.id).writers.map((w) => w.key).sort(), a.get(f.id).readers.slice().sort()]) !== JSON.stringify([f.writers.map((w) => w.key).sort(), f.readers.slice().sort()]))
      .map((f) => Object.assign({}, f, { was: { writers: a.get(f.id).writers.map((w) => w.key), readers: a.get(f.id).readers.slice() } })),
  };
}

if (typeof require !== "undefined") var { flattenNodes, nodeTextFields, bodyOf } = require("./model.js");
if (typeof module !== "undefined") module.exports = { FILE_WHERE, filesOfBash, filesOfPrompt, filesOfNode, workflowFiles, fileNodes, declaredOrder, filesDiff, filesResolve, filesAliases };
