// YAML emitter and structural diff. The emitter keeps each node's key order (a node created in the page
// gets the canonical order), writes a string by the first rule that applies, and does not carry comments.
const YAML_RESERVED = /^(?:true|false|yes|no|on|off|null|~)$/i;
const YAML_PLAIN = /^[A-Za-z0-9_./$][^:#]*$/;
const YAML_UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\ufeff]/;
const YAML_NEW_NODE_ORDER = ["id", "depends_on", "when", "trigger_rule", "model"];

function yamlNumberLike(s) {
  return /^[-+]?(\d|\.\d|\.inf|\.nan)/i.test(s) && /^[0-9a-fA-FxXoObBeEnNiI_.+\-]+$/.test(s);
}

function yamlPlainOk(s) {
  return YAML_PLAIN.test(s) && !/\s$/.test(s) && !YAML_RESERVED.test(s) && !yamlNumberLike(s) && !/[\r\n\t]/.test(s);
}

function yamlFirstContentLine(s) {
  return s.split("\n").find((l) => l.trim() !== "") || "";
}

// Returns {kind: "plain"|"quoted"|"block", text} for a string value.
function yamlString(s) {
  const forceQuote = s.trim() === "" || /[\t\r]/.test(s) || YAML_UNSAFE.test(s) || yamlFirstContentLine(s).startsWith(" ") || s.split("\n")[0].startsWith(" ");
  if (forceQuote) return { kind: "quoted", text: JSON.stringify(s) };
  if (s.includes("\n")) return { kind: "block" };
  if (yamlPlainOk(s)) return { kind: "plain", text: s };
  return { kind: "quoted", text: JSON.stringify(s) };
}

function yamlKey(k) {
  const s = String(k);
  return !s.includes("\n") && yamlPlainOk(s) ? s : JSON.stringify(s);
}

function yamlBlockLines(s, pad) {
  const trailing = s.length - s.replace(/\n+$/, "").length;
  const header = trailing === 0 ? "|-" : trailing === 1 ? "|" : "|+";
  const lines = s.replace(/\n+$/, "").split("\n").map((l) => (l === "" ? "" : pad + l));
  for (let i = 1; i < trailing; i++) lines.push("");
  return { header, lines };
}

function yamlScalarText(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  const r = yamlString(String(v));
  return r.text;
}

function yamlFlowItem(v) {
  if (v === null || typeof v === "boolean" || typeof v === "number") return yamlScalarText(v);
  if (typeof v !== "string") return null;
  const r = yamlString(v);
  if (r.kind === "block") return null;
  if (r.kind === "plain" && /[,\[\]{}]/.test(r.text)) return JSON.stringify(v);
  return r.text;
}

function yamlFlowList(arr) {
  const items = arr.map(yamlFlowItem);
  if (items.some((i) => i === null)) return null;
  const text = "[" + items.join(", ") + "]";
  return text.length <= 80 ? text : null;
}

function yamlIsObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Lines for `key: value`, or `- value` when key is null, at the given indent.
function yamlEntry(key, value, indent) {
  const pad = " ".repeat(indent);
  const lead = key === null ? pad + "-" : pad + yamlKey(key) + ":";
  if (Array.isArray(value)) {
    if (!value.length) return [lead + " []"];
    const flow = yamlFlowList(value);
    if (flow) return [lead + " " + flow];
    return [lead, ...yamlSeq(value, indent + 2)];
  }
  if (yamlIsObject(value)) {
    if (!Object.keys(value).length) return [lead + " {}"];
    if (key === null) {
      const lines = yamlMap(value, indent + 2);
      lines[0] = pad + "- " + lines[0].slice(indent + 2);
      return lines;
    }
    return [lead, ...yamlMap(value, indent + 2)];
  }
  if (typeof value === "string") {
    const r = yamlString(value);
    if (r.kind === "block") {
      const b = yamlBlockLines(value, " ".repeat(indent + 2));
      return [lead + " " + b.header, ...b.lines];
    }
    return [lead + " " + r.text];
  }
  return [lead + " " + yamlScalarText(value)];
}

function yamlMap(obj, indent, opts) {
  const lines = [];
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) continue;
    if (opts && opts.nodesKey === k && Array.isArray(obj[k]) && obj[k].length) {
      lines.push(" ".repeat(indent) + yamlKey(k) + ":");
      obj[k].forEach((item, i) => {
        if (i > 0) lines.push("");
        lines.push(...yamlEntry(null, opts.prepare ? opts.prepare(item) : item, indent + 2));
      });
    } else lines.push(...yamlEntry(k, obj[k], indent));
  }
  return lines;
}

function yamlSeq(arr, indent) {
  const lines = [];
  for (const item of arr) lines.push(...yamlEntry(null, item, indent));
  return lines;
}

function yamlCanonicalOrder(node) {
  const typeKey = NODE_TYPE_KEYS.find((k) => node[k] !== undefined);
  const head = [...YAML_NEW_NODE_ORDER, typeKey].filter((k) => k && node[k] !== undefined);
  const out = {};
  for (const k of head) out[k] = node[k];
  for (const k of Object.keys(node)) if (!(k in out)) out[k] = node[k];
  return out;
}

// toYaml(workflow, snapshot): the workflow as YAML text. A node that is not in the snapshot is written
// in the canonical key order.
function toYaml(wf, snapshot) {
  const known = snapshot ? new Set(flattenNodes(snapshot).map((e) => e.key)) : null;
  const prepareList = (list, parentKey) =>
    list.map((node) => {
      const key = nodeKey(parentKey, node.id);
      let out = known && !known.has(key) ? yamlCanonicalOrder(node) : node;
      const body = bodyOf(out);
      if (body) out = { ...out, loop_group: { ...out.loop_group, nodes: prepareList(body, key) } };
      return out;
    });
  const top = { ...wf, nodes: Array.isArray(wf.nodes) ? prepareList(wf.nodes, null) : wf.nodes };
  return yamlMap(top, 0, { nodesKey: "nodes" }).join("\n") + "\n";
}

// ---- diff ----

function diffLines(a, b) {
  const x = a.split("\n");
  const y = b.split("\n");
  if (x.length * y.length > 4000000) return [...x.map((t) => ({ op: "-", text: t })), ...y.map((t) => ({ op: "+", text: t }))];
  const n = x.length;
  const m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: " ", text: x[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "-", text: x[i++] });
    else out.push({ op: "+", text: y[j++] });
  }
  while (i < n) out.push({ op: "-", text: x[i++] });
  while (j < m) out.push({ op: "+", text: y[j++] });
  return out;
}

function diffShow(v) {
  if (v === undefined) return undefined;
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

function diffEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffFieldSets(a, b) {
  const keys = [];
  for (const k of [...Object.keys(a), ...Object.keys(b)]) if (!keys.includes(k)) keys.push(k);
  return keys;
}

// diffWorkflows(before, after) compares two models by node key.
function diffWorkflows(before, after) {
  const bMap = new Map(flattenNodes(before).map((e) => [e.key, e]));
  const aMap = new Map(flattenNodes(after).map((e) => [e.key, e]));
  const out = { nodesAdded: [], nodesRemoved: [], edgesAdded: [], edgesRemoved: [], conditions: [], fields: [], workflow: [] };
  for (const key of aMap.keys()) if (!bMap.has(key)) out.nodesAdded.push(key);
  for (const key of bMap.keys()) if (!aMap.has(key)) out.nodesRemoved.push(key);
  const edgesOf = (e) => (Array.isArray(e.node.depends_on) ? e.node.depends_on : []).map((d) => nodeKey(e.parentKey, d));
  for (const [key, a] of aMap) {
    const b = bMap.get(key);
    const aEdges = edgesOf(a);
    const bEdges = b ? edgesOf(b) : [];
    for (const from of aEdges) if (!bEdges.includes(from)) out.edgesAdded.push({ from, to: key });
    if (!b) continue;
    for (const from of bEdges) if (!aEdges.includes(from)) out.edgesRemoved.push({ from, to: key });
    if (!diffEqual(a.node.when, b.node.when)) out.conditions.push({ key, before: b.node.when, after: a.node.when });
    const bn = b.node;
    const an = a.node;
    for (const field of diffFieldSets(bn, an)) {
      if (field === "id" || field === "depends_on" || field === "when") continue;
      let bv = bn[field];
      let av = an[field];
      if (field === "loop_group") {
        bv = bv && typeof bv === "object" ? { ...bv, nodes: undefined } : bv;
        av = av && typeof av === "object" ? { ...av, nodes: undefined } : av;
      }
      if (diffEqual(bv, av)) continue;
      const entry = { key, field, before: bv, after: av };
      const bs = diffShow(bv);
      const as = diffShow(av);
      if (bs !== undefined && as !== undefined && (bs.includes("\n") || as.includes("\n") || bs.length > 80 || as.length > 80)) entry.lines = diffLines(bs, as);
      out.fields.push(entry);
    }
  }
  for (const key of diffFieldSets(before, after)) {
    if (key === "nodes") continue;
    if (!diffEqual(before[key], after[key])) out.workflow.push({ field: key, before: before[key], after: after[key] });
  }
  out.empty = !Object.entries(out).some(([k, v]) => Array.isArray(v) && v.length);
  return out;
}

// ---- baseline comparison ----

function workflowScope(record) {
  return record.source === "repo" ? "repo/" + record.repo : record.group || "personal";
}

// How a workflow stands against the baseline. `base` and `cur` are page records ({source, repo, model, ...})
// or null when the workflow is not in that set. A workflow keeps its identity when it changes scope.
function baselineStatus(base, cur) {
  if (!base) return "added";
  if (!cur) return "removed";
  if (workflowScope(base) !== workflowScope(cur)) return "moved";
  return diffWorkflows(base.model, cur.model).empty ? "unchanged" : "changed";
}

// One row per workflow in the current set, then one per removed workflow. Each of scope, lines, nodes and
// inputs is [before, after], with null for the side that does not have the workflow. `changed` says that a
// workflow in both sets differs in its nodes, node bodies, inputs or other keys, whatever its scope.
function baselineRows(workflows, baseline, removed, fileCount) {
  const counts = (r) => ({ lines: r.lines, nodes: countNodes(r.model), inputs: Object.keys(r.inputs || {}).length, files: fileCount ? fileCount(r) : null });
  const rows = workflows.map((w) => {
    const base = baseline && baseline[w.name] ? baseline[w.name] : null;
    const b = base ? counts(base) : null;
    const a = counts(w);
    return {
      name: w.name, status: baselineStatus(base, w), changed: !!base && !diffWorkflows(base.model, w.model).empty,
      scope: [base ? workflowScope(base) : null, workflowScope(w)],
      lines: [b && b.lines, a.lines], nodes: [b && b.nodes, a.nodes], inputs: [b && b.inputs, a.inputs], files: [b && b.files, a.files],
    };
  });
  for (const r of removed || []) {
    const rec = baseline && baseline[r.name];
    rows.push({ name: r.name, status: "removed", changed: false, scope: [r.scope, null], lines: [r.lines, null], nodes: [r.nodes, null], inputs: [r.inputs, null], files: [rec && fileCount ? fileCount(rec) : null, null] });
  }
  return rows;
}

if (typeof require !== "undefined") var { NODE_TYPE_KEYS, flattenNodes, nodeKey, bodyOf, countNodes } = require("./model.js");
if (typeof module !== "undefined") module.exports = { toYaml, diffWorkflows, diffLines, yamlString, baselineStatus, baselineRows };
