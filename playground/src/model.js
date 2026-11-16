// Workflow model: a workflow is the plain object that yaml.safe_load returns, and a node is one entry of
// its `nodes` list. A node key is `<id>`, or `<loop id>.<node id>` for a node inside a loop.
var NODE_TYPE_KEYS = ["prompt", "command", "bash", "script", "loop", "loop_group", "approval", "wait", "cancel", "include", "workflow"];
var NODE_AI_TYPES = ["prompt", "command", "loop"];
var NODE_PAUSE_TYPES = ["wait", "approval"];
var NODE_TEMPLATES = {
  prompt: { prompt: "Describe the task for the agent." },
  command: { command: "command-name" },
  bash: { bash: "echo ok" },
  script: { script: "print('ok')", runtime: "uv" },
  loop: { loop: { prompt: "Do one more pass.", max_iterations: 5, until_bash: 'test -f "$ARTIFACTS_DIR/done"' } },
  loop_group: { loop_group: { nodes: [], max_iterations: 5, until_bash: 'test -f "$ARTIFACTS_DIR/settled"' } },
  approval: { approval: { message: "Proceed?" } },
  wait: { wait: { attention: "Question for the owner", form: "approval" } },
  cancel: { cancel: "Reason the run ends." },
  include: { include: "workflow-name" },
  workflow: { workflow: "workflow-name" },
};
var NODE_REF_ID = "[A-Za-z_][A-Za-z0-9_-]*";
var NODE_REF_PATH = "((?:\\.[A-Za-z_][A-Za-z0-9_]*)*)";

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function typeKeysOf(node) {
  return NODE_TYPE_KEYS.filter((k) => {
    const v = node[k];
    if (v === undefined) return false;
    return typeof v === "string" ? v.trim().length > 0 : true;
  });
}

// The node's type: its one type key, or the first present key when a blank one is all it has.
function nodeType(node) {
  const keys = typeKeysOf(node);
  if (keys.length) return keys[0];
  return NODE_TYPE_KEYS.find((k) => node[k] !== undefined) || null;
}

function isPauseNode(node) {
  return NODE_PAUSE_TYPES.includes(nodeType(node));
}

function nodeKey(parentKey, id) {
  return parentKey ? parentKey + "." + id : String(id);
}

function bodyOf(node) {
  return isPlainObject(node.loop_group) && Array.isArray(node.loop_group.nodes) ? node.loop_group.nodes : null;
}

// Every node in document order with its key and parent key; a loop comes before its body.
function flattenNodes(wf) {
  const out = [];
  const visit = (list, parentKey, depth) => {
    for (const node of list) {
      if (!isPlainObject(node)) continue;
      const key = nodeKey(parentKey, node.id);
      out.push({ node, key, id: node.id, parentKey: parentKey || null, depth, list });
      const body = bodyOf(node);
      if (body) visit(body, key, depth + 1);
    }
  };
  visit(Array.isArray(wf.nodes) ? wf.nodes : [], null, 0);
  return out;
}

function countNodes(wf) {
  return flattenNodes(wf).length;
}

function findNode(wf, key) {
  return flattenNodes(wf).find((e) => e.key === key) || null;
}

function scopeList(wf, parentKey) {
  if (!parentKey) return wf.nodes;
  const entry = findNode(wf, parentKey);
  return entry ? bodyOf(entry.node) : null;
}

function allIds(wf) {
  return new Set(flattenNodes(wf).map((e) => e.id));
}

function uniqueNodeId(wf, base) {
  const used = allIds(wf);
  const stem = String(base).replace(/[^A-Za-z0-9_]/g, "_");
  if (!used.has(stem)) return stem;
  let n = 2;
  while (used.has(stem + "_" + n)) n++;
  return stem + "_" + n;
}

// A new node's keys are in the order id, type key, then the rest; depends_on, when, trigger_rule and
// model are inserted before the type key when the exporter reorders new nodes (see toYaml).
function addNode(wf, type, parentKey, overrides) {
  const list = scopeList(wf, parentKey || null);
  if (!list) return null;
  const node = { id: uniqueNodeId(wf, (overrides && overrides.id) || type) };
  const template = cloneJson(NODE_TEMPLATES[type]);
  Object.assign(node, template, overrides && overrides.fields ? overrides.fields : {});
  if (type === "loop_group" && !node.loop_group.nodes.length) {
    node.loop_group.nodes.push({ id: uniqueNodeId(wf, "round"), bash: "echo idle" });
  }
  list.push(node);
  return { node, key: nodeKey(parentKey || null, node.id) };
}

function descendantIds(node) {
  const ids = [];
  const body = bodyOf(node);
  if (body) for (const child of body) ids.push(child.id, ...descendantIds(child));
  return ids;
}

// Removes the node (and its body) and its id from the depends_on of nodes in the same list. Returns the
// removed node and the nodes elsewhere whose text or condition still refer to a removed id.
function deleteNode(wf, key) {
  const entry = findNode(wf, key);
  if (!entry) return null;
  const idx = entry.list.indexOf(entry.node);
  entry.list.splice(idx, 1);
  for (const sib of entry.list) {
    if (Array.isArray(sib.depends_on)) {
      sib.depends_on = sib.depends_on.filter((d) => d !== entry.id);
      if (!sib.depends_on.length) delete sib.depends_on;
    }
  }
  const gone = new Set([entry.id, ...descendantIds(entry.node)]);
  const dangling = [];
  for (const other of flattenNodes(wf)) {
    const refs = collectRefs(other.node).nodes.filter((r) => gone.has(r.id));
    if (refs.length) dangling.push({ key: other.key, ids: [...new Set(refs.map((r) => r.id))] });
  }
  return { removed: entry.node, dangling };
}

function addEdge(wf, fromKey, toKey) {
  const from = findNode(wf, fromKey);
  const to = findNode(wf, toKey);
  if (!from || !to) return { ok: false, error: "unknown node" };
  if (from.list !== to.list) return { ok: false, error: "a dependency joins nodes in the same graph or loop body" };
  if (from.node === to.node) return { ok: false, error: "a node cannot depend on itself" };
  const deps = Array.isArray(to.node.depends_on) ? to.node.depends_on : [];
  if (deps.includes(from.id)) return { ok: false, error: "that dependency already exists" };
  to.node.depends_on = [...deps, from.id];
  return { ok: true };
}

function removeEdge(wf, fromKey, toKey) {
  const from = findNode(wf, fromKey);
  const to = findNode(wf, toKey);
  if (!from || !to || !Array.isArray(to.node.depends_on)) return false;
  const next = to.node.depends_on.filter((d) => d !== from.id);
  if (next.length === to.node.depends_on.length) return false;
  if (next.length) to.node.depends_on = next;
  else delete to.node.depends_on;
  return true;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mapNodeText(node, fn) {
  const visit = (obj, key) => {
    const v = obj[key];
    if (typeof v === "string") obj[key] = fn(v, key);
    else if (Array.isArray(v)) v.forEach((_, i) => visit(v, i));
    else if (isPlainObject(v)) for (const k of Object.keys(v)) if (k !== "nodes") visit(v, k);
  };
  for (const k of Object.keys(node)) {
    if (k === "id" || k === "depends_on") continue;
    visit(node, k);
  }
}

// Renames a node and rewrites the depends_on entries, $id references and conditions that name it.
function renameNode(wf, key, newId) {
  const entry = findNode(wf, key);
  if (!entry) return { ok: false, error: "unknown node" };
  const id = String(newId).trim();
  if (!id) return { ok: false, error: "the id is empty" };
  if (id === entry.id) return { ok: true, key };
  if (allIds(wf).has(id)) return { ok: false, error: "the id '" + id + "' is already used" };
  const old = entry.id;
  const node = entry.node;
  const refRe = new RegExp("\\$" + escapeRegExp(old) + "(?=\\.)", "g");
  const prevRe = new RegExp("\\$LOOP_PREV\\." + escapeRegExp(old) + "(?=\\.)", "g");
  for (const e of flattenNodes(wf)) {
    mapNodeText(e.node, (text) => text.replace(prevRe, "$LOOP_PREV." + id).replace(refRe, "$" + id));
    if (e.list === entry.list && Array.isArray(e.node.depends_on)) {
      e.node.depends_on = e.node.depends_on.map((d) => (d === old ? id : d));
    }
  }
  node.id = id;
  return { ok: true, key: nodeKey(entry.parentKey, id) };
}

// Text fields of a node that Archon substitutes variables and $node.output references into.
function nodeTextFields(node) {
  const out = [];
  const add = (path, value) => {
    if (typeof value === "string") out.push({ path, text: value });
  };
  for (const k of ["prompt", "bash", "script", "systemPrompt", "cancel", "input"]) add(k, node[k]);
  if (isPlainObject(node.loop)) {
    add("loop.prompt", node.loop.prompt);
    add("loop.until_bash", node.loop.until_bash);
    add("loop.until", node.loop.until);
  }
  if (isPlainObject(node.loop_group)) {
    add("loop_group.until_bash", node.loop_group.until_bash);
    add("loop_group.until", node.loop_group.until);
  }
  if (isPlainObject(node.approval)) add("approval.message", node.approval.message);
  if (isPlainObject(node.wait)) {
    add("wait.attention", node.wait.attention);
    add("wait.until", node.wait.until);
    add("wait.event", node.wait.event);
    add("wait.options", node.wait.options);
  }
  if (isPlainObject(node.with)) {
    for (const [name, v] of Object.entries(node.with)) {
      if (typeof v === "string") add("with." + name, v);
      else if (isPlainObject(v)) add("with." + name + ".from", v.from);
    }
  }
  if (isPlainObject(node.agents)) {
    for (const [name, a] of Object.entries(node.agents)) if (isPlainObject(a)) add("agents." + name + ".prompt", a.prompt);
  }
  return out;
}

// References a node makes: node outputs ($id.output), $LOOP_PREV outputs and $INPUTS names, each with
// where it was found. Conditions are read through the `when` parser, with a text scan as the fallback.
function collectRefs(node) {
  const nodes = [];
  const inputs = [];
  const scan = (text, via, path) => {
    const refRe = new RegExp("\\$(" + NODE_REF_ID + ")\\.output" + NODE_REF_PATH, "g");
    const prevRe = new RegExp("\\$LOOP_PREV\\.(" + NODE_REF_ID + ")\\.output" + NODE_REF_PATH, "g");
    const inRe = new RegExp("\\$INPUTS\\.(" + NODE_REF_ID + ")", "g");
    let m;
    while ((m = refRe.exec(text))) nodes.push({ id: m[1], via, path, loopPrev: false, field: m[2] ? m[2].slice(1) : null });
    while ((m = prevRe.exec(text))) nodes.push({ id: m[1], via, path, loopPrev: true, field: m[2] ? m[2].slice(1) : null });
    while ((m = inRe.exec(text))) inputs.push({ name: m[1], via, path });
  };
  for (const { path, text } of nodeTextFields(node)) scan(text, "text", path);
  if (typeof node.when === "string") {
    const parsed = parseWhen(node.when, { loopBody: true });
    if (parsed.ok) {
      for (const atom of whenAtoms(parsed)) {
        const r = atom.ref;
        if (r.kind === "input") inputs.push({ name: r.name, via: "when", path: "when" });
        else nodes.push({ id: r.id, via: "when", path: "when", loopPrev: r.kind === "loop_prev", field: r.field, atom });
      }
    } else scan(node.when, "when", "when");
  }
  return { nodes, inputs };
}

// Ids a node reaches through depends_on, transitively, within one list.
function ancestorIds(list, id) {
  const deps = new Map(list.map((n) => [n.id, Array.isArray(n.depends_on) ? n.depends_on : []]));
  const seen = new Set();
  const stack = [...(deps.get(id) || [])];
  while (stack.length) {
    const d = stack.pop();
    if (seen.has(d)) continue;
    seen.add(d);
    stack.push(...(deps.get(d) || []));
  }
  return seen;
}

// {order, cycle}: ids in dependency order, or the ids left over when a cycle blocks the sort.
function topoOrder(list) {
  const ids = list.map((n) => n.id);
  const known = new Set(ids);
  const indeg = new Map();
  const out = new Map();
  for (const n of list) {
    const deps = (Array.isArray(n.depends_on) ? n.depends_on : []).filter((d) => known.has(d) && d !== n.id);
    indeg.set(n.id, new Set(deps).size);
    for (const d of new Set(deps)) {
      if (!out.has(d)) out.set(d, []);
      out.get(d).push(n.id);
    }
  }
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of out.get(id) || []) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  const done = new Set(order);
  const cycle = ids.filter((id) => !done.has(id));
  return { order, cycle: cycle.length ? cycle : null };
}

// Sets (or, when value is undefined, removes) the value at a path of keys inside a node.
function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (!isPlainObject(cur[path[i]]) && !Array.isArray(cur[path[i]])) cur[path[i]] = {};
    cur = cur[path[i]];
  }
  const last = path[path.length - 1];
  if (value === undefined) {
    if (Array.isArray(cur)) cur.splice(Number(last), 1);
    else delete cur[last];
  } else cur[last] = value;
}

function getPath(obj, path) {
  let cur = obj;
  for (const p of path) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[p];
  }
  return cur;
}

if (typeof require !== "undefined") var { parseWhen, whenAtoms } = require("./when.js");
if (typeof module !== "undefined") {
  module.exports = {
    NODE_TYPE_KEYS, NODE_AI_TYPES, NODE_PAUSE_TYPES, NODE_TEMPLATES, cloneJson, isPlainObject, typeKeysOf, nodeType, isPauseNode,
    nodeKey, bodyOf, flattenNodes, countNodes, findNode, scopeList, allIds, uniqueNodeId, addNode, deleteNode, addEdge, removeEdge,
    renameNode, nodeTextFields, collectRefs, ancestorIds, topoOrder, setPath, getPath, escapeRegExp,
  };
}
