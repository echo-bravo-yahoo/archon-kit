// The page: SVG graph, palette, inspector and panels. Workflow text reaches the DOM only through
// textContent or text nodes, never innerHTML, because prompts contain "<".
const UI_PREFIX = "archon-playground:v1:";
const UI_TABS = [["validation", "Validation"], ["changes", BASELINE ? "Changes vs baseline" : "Changes vs snapshot"], ["files", "Files"], ["yaml", "YAML"], ["sim", "Simulation"], ["findings", "Findings"]];
const UI_METRICS = [["none", "No overlay"], ["total", "Total time"], ["median", "Median time"], ["p90", "p90 time"], ["runs", "Runs"], ["failures", "Failures"], ["cost", "Cost"]];
const UI_SVG = "http://www.w3.org/2000/svg";
// The Files menu: which of the files a workflow creates the lane pane lists, or none.
const UI_FILE_MODES = [["off", "Hidden"], ["linked", "Files passed between nodes"], ["undeclared", "Only undeclared dependencies"], ["all", "All files"]];
const UI_LANE_GUTTER = 168;

const ui = {
  wf: null, snaps: {}, built: {}, models: {}, view: {}, selected: null, selEdge: null, tab: "validation", leftTab: "palette", metric: "none",
  showData: false, filesMode: "linked", hover: null, vb: { x: -20, y: -20, W: 300, H: 200, bx: -20, wf: null, zoom: 1 }, fileSel: null, fileFilter: "", filesMemo: null, zoom: 1, highlight: new Set(), sim: null, simFail: new Set(), simTimeout: new Set(), compare: "snapshot",
  marks: {}, issues: [], notice: "", experiments: {}, drag: null, addScope: "",
};

// ---- helpers ----

function uH(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  uApply(el, attrs, kids);
  return el;
}

function uS(tag, attrs, ...kids) {
  const el = document.createElementNS(UI_SVG, tag);
  uApply(el, attrs, kids);
  return el;
}

function uApply(el, attrs, kids) {
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.setAttribute("class", v);
      else if (k === "text") el.textContent = v;
      else if (k === "value") el.value = v;
      else if (k === "checked") el.checked = !!v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
}

function uClear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

function uStoreGet(key) {
  try {
    const raw = localStorage.getItem(UI_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function uStoreSet(key, value) {
  try {
    localStorage.setItem(UI_PREFIX + key, JSON.stringify(value));
  } catch (e) {
    /* storage can be missing or full; the page works without it */
  }
}

function uFmtMs(ms) {
  if (ms === null || ms === undefined) return "–";
  if (ms < 1000) return Math.round(ms) + " ms";
  if (ms < 90000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " s";
  if (ms < 5400000) return (ms / 60000).toFixed(1) + " min";
  return (ms / 3600000).toFixed(1) + " h";
}

function uFmtUsd(v) {
  if (v === null || v === undefined) return "–";
  return "$" + (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3));
}

function uCur() {
  return ui.models[ui.wf];
}

// What the Changes tab compares against: the baseline's version of the workflow when there is one, else the file as built.
function uSnap() {
  return ui.snaps[ui.wf];
}

function uBuilt() {
  return ui.built[ui.wf];
}

function uStats() {
  return (STATS.workflows && STATS.workflows[ui.wf]) || null;
}

function uNodeStat(key) {
  const s = uStats();
  return s && s.nodes ? s.nodes[key] || null : null;
}

function uEntry(key) {
  return key ? findNode(uCur(), key) : null;
}

// ---- files the workflow creates (src/files.js) ----

function uWorkflowModel(name) {
  if (ui.models[name]) return ui.models[name];
  const w = WORKFLOWS.find((x) => x.name === name);
  return w ? w.model : null;
}

function uFilesOfModel(model) {
  return workflowFiles(model, { getWorkflow: uWorkflowModel });
}

// The current workflow's files, recomputed only when the model changes.
function uFiles() {
  const key = ui.wf + "|" + JSON.stringify(uCur());
  if (!ui.filesMemo || ui.filesMemo.key !== key) ui.filesMemo = { key, value: uFilesOfModel(uCur()) };
  return ui.filesMemo.value;
}

function uRecordFileCount(rec) {
  const isBase = !!BASELINE && BASELINE[rec.name] === rec;
  const get = (n) => {
    const src = isBase ? BASELINE[n] : WORKFLOWS.find((w) => w.name === n);
    return src ? src.model : null;
  };
  return workflowFiles(rec.model, { getWorkflow: get }).files.length;
}

function uFileNodeList() {
  return ui.filesMode === "off" ? [] : fileNodes(uFiles(), ui.filesMode, uCur());
}

function uFileLabel(f) {
  return f.name ? f.name + (f.dir ? "/" : "") : "(report directory)";
}

// Selects a file: its writers and readers light up on the graph and its row opens in the Files tab.
function uShowFile(id) {
  const f = uFiles().files.find((x) => x.id === id);
  ui.fileSel = id;
  ui.selected = null;
  ui.selEdge = null;
  ui.highlight = new Set(f ? f.writers.map((w) => w.key).concat(f.readers) : []);
  ui.tab = "files";
  uRenderCanvas();
  uRenderBottom();
  uRenderInspector();
}

function uCopy(text, done) {
  const fallback = () => {
    const ta = uH("textarea", { style: "position:fixed;opacity:0" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (e) {
      /* no clipboard */
    }
    ta.remove();
    if (done) done();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => done && done(), fallback);
  else fallback();
}

function uDownload(name, text) {
  const blob = new Blob([text], { type: "text/yaml" });
  const url = URL.createObjectURL(blob);
  const a = uH("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---- persistence ----

function uLoadView(name) {
  const saved = uStoreGet(name) || {};
  ui.view[name] = { collapsed: saved.collapsed || [], offsets: saved.offsets || {} };
  ui.experiments[name] = saved.experiments || {};
}

function uSaveView() {
  const v = ui.view[ui.wf];
  uStoreSet(ui.wf, { collapsed: v.collapsed, offsets: v.offsets, experiments: ui.experiments[ui.wf] });
}

// ---- editing ----

function uRefresh(opts) {
  const o = opts || {};
  if (ui.selected && !uEntry(ui.selected)) ui.selected = null;
  ui.issues = validateWorkflow(uCur());
  if (!o.keepSim) {
    ui.sim = null;
    ui.simPrompt = null;
  }
  uRenderCanvas();
  uRenderBottom();
  if (o.inspector !== false) uRenderInspector();
  uRenderHeaderCounts();
}

function uEdit(fn, opts) {
  fn(uCur());
  uRefresh(opts);
}

function uSelect(key) {
  ui.selected = key;
  ui.selEdge = null;
  ui.fileSel = null;
  uRenderCanvas();
  uRenderInspector();
}

// ---- header ----

function uRenderHeader() {
  const head = uClear(document.getElementById("top"));
  const picker = uH("select", { id: "wf-select", "aria-label": "Workflow", onchange: (e) => uSwitch(e.target.value) },
    WORKFLOWS.map((w) => uH("option", { value: w.name, selected: w.name === ui.wf, text: w.name + " (" + (w.source === "repo" ? w.repo : w.group || "personal") + ")" })));
  const metric = uH("select", { id: "metric-select", "aria-label": "Statistics overlay", onchange: (e) => { ui.metric = e.target.value; uRenderCanvas(); uRenderInspector(); } },
    UI_METRICS.map(([v, l]) => uH("option", { value: v, selected: v === ui.metric, text: l })));
  head.append(
    uH("h1", { text: "Archon workflow playground" }),
    uH("label", {}, "Workflow ", picker),
    uH("span", { id: "run-pills", class: "pills" }),
    uH("label", {}, "Overlay ", metric),
    uH("label", {}, uH("input", { type: "checkbox", id: "show-data", checked: ui.showData, onchange: (e) => { ui.showData = e.target.checked; uRenderCanvas(); } }), "Data references"),
    uH("label", { title: "The files the workflow creates, as rows in the pane under the graph, with a dot under each node that touches them" }, "Files ",
      uH("select", { id: "files-mode", "aria-label": "Files in the lane pane", onchange: (e) => { ui.filesMode = e.target.value; uRenderCanvas(); } },
        UI_FILE_MODES.map(([v, l]) => uH("option", { value: v, selected: v === ui.filesMode, text: l })))),
    uH("button", { "data-action": "collapse-all", onclick: () => uSetCollapsed(true), text: "Collapse loops" }),
    uH("button", { "data-action": "expand-all", onclick: () => uSetCollapsed(false), text: "Expand loops" }),
    uH("span", { id: "exp-box" }),
    uH("div", { class: "banner", id: "snapshot-banner" }),
    ...(BASELINE ? [uH("details", { class: "baseline", id: "baseline-banner", open: uStoreGet("baselineOpen") !== false, ontoggle: (e) => uStoreSet("baselineOpen", e.target.open) })] : []),
  );
  uRenderExperiments();
  uRenderBanner();
  uRenderBaseline();
}

function uFmtChange(before, after) {
  if (before === null || before === undefined) return "– → " + after;
  if (after === null || after === undefined) return before + " → –";
  return before === after ? String(before) : before + " → " + after;
}

function uRenderBaseline() {
  const box = document.getElementById("baseline-banner");
  if (!box) return;
  const rows = baselineRows(WORKFLOWS, BASELINE, REMOVED, uRecordFileCount);
  const tally = ["added", "removed", "moved", "changed", "unchanged"].map((st) => [st, rows.filter((r) => r.status === st).length]).filter(([, n]) => n);
  const pillClass = { added: "ok", removed: "fail", moved: "moved", changed: "run", unchanged: "" };
  uClear(box).append(
    uH("summary", {}, uH("strong", { text: "Baseline: " + META.baselineLabel }), " — " + tally.map(([st, n]) => n + " " + st).join(", ")),
    uH("div", { class: "table-scroll" }, uH("table", { class: "ref baseline-table" },
      uH("thead", {}, uH("tr", {}, ["Workflow", "Scope", "Status", "Lines", "Nodes", "Inputs", "Files"].map((h) => uH("th", { text: h })))),
      uH("tbody", {}, rows.map((r) => uH("tr", { "data-workflow": r.name, "data-status": r.status },
        uH("td", {}, uH("code", { text: r.name })),
        uH("td", { text: uFmtChange(r.scope[0], r.scope[1]) }),
        uH("td", {}, uH("span", { class: "pill " + pillClass[r.status], text: r.status }), r.status === "moved" && r.changed ? uH("span", { class: "help", text: " and changed" }) : null),
        uH("td", { class: "num", text: uFmtChange(r.lines[0], r.lines[1]) }),
        uH("td", { class: "num", text: uFmtChange(r.nodes[0], r.nodes[1]) }),
        uH("td", { class: "num", text: uFmtChange(r.inputs[0], r.inputs[1]) }),
        uH("td", { class: "num", text: uFmtChange(r.files[0], r.files[1]) })))))),
  );
}

function uRenderBanner() {
  const b = document.getElementById("snapshot-banner");
  const built = new Date(META.builtAt);
  const stamp = isNaN(built) ? META.builtAt : built.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  uClear(b).append(
    "Snapshot taken " + stamp + ". Costs are provider-reported USD, not what you are billed. Refresh: ",
    uH("code", { text: "archon-kit playground" }),
    " or ",
    uH("code", { text: META.buildCommand }),
  );
}

function uRenderHeaderCounts() {
  const box = document.getElementById("run-pills");
  if (!box) return;
  uClear(box);
  const s = uStats();
  const m = uCur();
  const entries = flattenNodes(m);
  box.append(uH("span", { class: "pill", text: entries.length + " nodes, " + entries.filter((e) => bodyOf(e.node)).length + " loops" }));
  box.append(uH("span", { class: "pill", "data-count": "files", title: "Files the workflow creates while it runs", text: uFiles().files.length + " files" }));
  if (s) {
    box.append(uH("span", { class: "pill", text: s.runs + " runs" }));
    for (const [status, n] of Object.entries(s.byStatus)) {
      box.append(uH("span", { class: "pill " + (status === "completed" ? "ok" : status === "failed" ? "fail" : status === "running" || status === "paused" ? "run" : ""), text: n + " " + status }));
    }
  }
}

function uSetCollapsed(all) {
  const v = ui.view[ui.wf];
  v.collapsed = all ? flattenNodes(uCur()).filter((e) => bodyOf(e.node)).map((e) => e.key) : [];
  uSaveView();
  uRenderCanvas();
}

function uSwitch(name) {
  ui.wf = name;
  ui.selected = null;
  ui.selEdge = null;
  ui.highlight = new Set();
  ui.fileSel = null;
  ui.hover = null;
  ui.sim = null;
  ui.simPrompt = null;
  ui.simFail = new Set();
  ui.simTimeout = new Set();
  ui.compare = "snapshot";
  ui.addScope = "";
  ui.notice = "";
  uRenderExperiments();
  uRenderHeaderCounts();
  uRefresh();
  const sc = document.getElementById("canvas");
  if (sc) {
    sc.scrollLeft = 0;
    sc.scrollTop = 0;
  }
}

// ---- experiments ----

function uRenderExperiments() {
  const box = document.getElementById("exp-box");
  if (!box) return;
  uClear(box);
  const exps = ui.experiments[ui.wf] || {};
  const names = Object.keys(exps);
  const nameInput = uH("input", { type: "text", id: "exp-name", placeholder: "experiment name", size: 14, "aria-label": "Experiment name" });
  const loadSel = uH("select", { id: "exp-load", "aria-label": "Saved experiments" }, uH("option", { value: "", text: names.length ? "Saved experiments" : "No saved experiments" }), names.map((n) => uH("option", { value: n, text: n })));
  box.append(
    nameInput,
    uH("button", { "data-action": "exp-save", text: "Save", onclick: () => {
      const n = nameInput.value.trim();
      if (!n) return;
      exps[n] = cloneJson(uCur());
      ui.experiments[ui.wf] = exps;
      uSaveView();
      uRenderExperiments();
    } }),
    loadSel,
    uH("button", { "data-action": "exp-load", text: "Load", onclick: () => {
      const n = loadSel.value;
      if (!n || !exps[n]) return;
      ui.models[ui.wf] = cloneJson(exps[n]);
      uRefresh();
    } }),
    uH("button", { "data-action": "exp-compare", text: "Compare", onclick: () => {
      const n = loadSel.value;
      if (!n || !exps[n]) return;
      ui.compare = n;
      ui.tab = "changes";
      uRenderBottom();
    } }),
    uH("button", { "data-action": "exp-delete", text: "Delete", onclick: () => {
      const n = loadSel.value;
      if (!n) return;
      delete exps[n];
      if (ui.compare === n) ui.compare = "snapshot";
      uSaveView();
      uRenderExperiments();
      uRenderBottom();
    } }),
  );
}

// ---- left pane: palette and reference ----

function uRenderLeft() {
  const left = uClear(document.getElementById("left"));
  const tabs = uH("div", { class: "tabs", role: "tablist" },
    [["palette", "Palette"], ["reference", "Reference"]].map(([id, label]) => uH("button", { role: "tab", "aria-selected": ui.leftTab === id, "data-left": id, text: label, onclick: () => { ui.leftTab = id; uRenderLeft(); } })));
  left.append(tabs);
  if (ui.leftTab === "palette") left.append(uPalette());
  else left.append(uReference());
}

function uPalette() {
  const wrap = uH("div");
  const loops = flattenNodes(uCur()).filter((e) => bodyOf(e.node));
  if (ui.addScope && !loops.some((l) => l.key === ui.addScope)) ui.addScope = "";
  wrap.append(
    uH("p", { class: "help", text: "Add a node of a type with its defaults. It joins the graph below, or a loop body." }),
    uH("div", { class: "row" }, uH("label", {}, "Add to ", uH("select", { id: "add-scope", onchange: (e) => { ui.addScope = e.target.value; } },
      uH("option", { value: "", text: "workflow", selected: !ui.addScope }), loops.map((l) => uH("option", { value: l.key, text: "loop " + l.key, selected: ui.addScope === l.key }))))),
  );
  const grid = uH("div", { class: "palette" });
  for (const t of SCHEMA.typeKeys) {
    const spec = SCHEMA.types[t];
    grid.append(uH("button", { "data-add": t, title: spec.summary, onclick: () => uAddNode(t) }, uH("span", { class: "glyph", text: spec.glyph }), t));
  }
  wrap.append(grid);
  wrap.append(uH("p", { class: "help", text: "Select a node and use the inspector to wire dependencies, or drag from a node's right port to another node's left port." }));
  return wrap;
}

function uAddNode(type) {
  const scope = ui.addScope || null;
  let key = null;
  uEdit((m) => {
    const r = addNode(m, type, scope);
    key = r ? r.key : null;
  });
  if (key) uSelect(key);
}

function uReference() {
  const wrap = uH("div");
  wrap.append(uH("p", { class: "help", text: "Node types and fields for Archon " + SCHEMA.engineVersion + ". A node has exactly one type key." }));
  for (const t of SCHEMA.typeKeys) {
    const spec = SCHEMA.types[t];
    const rows = spec.fields.map((f) => uH("tr", {}, uH("td", {}, uH("code", { text: f.name })), uH("td", { text: (f.type || "") + (f.required ? ", required" : "") + (f.allowed ? " (" + f.allowed.join(" | ") + ")" : "") }), uH("td", { text: f.help })));
    wrap.append(uH("details", { "data-ref": t }, uH("summary", {}, uH("span", { class: "glyph", text: spec.glyph }), uH("code", { text: t }), " — " + spec.summary),
      uH("table", { class: "ref" }, uH("tr", {}, uH("th", { text: "Field" }), uH("th", { text: "Type" }), uH("th", { text: "Use" })), rows),
      spec.trap ? uH("p", { class: "help", text: "Trap: " + spec.trap }) : null));
  }
  const common = uH("details", { "data-ref": "common" }, uH("summary", { text: "Common fields (" + SCHEMA.commonFields.length + ")" }));
  const rows = SCHEMA.commonFields.map((f) => {
    const ignoredBy = SCHEMA.typeKeys.filter((t) => !SCHEMA.graphFields.includes(f.name) && SCHEMA.honors[t] !== "all" && !SCHEMA.honors[t].includes(f.name) && !(SCHEMA.fieldErrors[t] || []).includes(f.name));
    const errorOn = SCHEMA.typeKeys.filter((t) => (SCHEMA.fieldErrors[t] || []).includes(f.name));
    return uH("tr", {}, uH("td", {}, uH("code", { text: f.name })), uH("td", { text: (f.type || "") + (f.default !== undefined ? ", default " + f.default : "") + (f.allowed ? " (" + f.allowed.join(" | ") + ")" : "") }),
      uH("td", {}, f.help, ignoredBy.length ? uH("div", { class: "help", text: "Ignored by: " + ignoredBy.join(", ") + "." }) : null, errorOn.length ? uH("div", { class: "err-text", text: "Error on: " + errorOn.join(", ") + "." }) : null, f.trap ? uH("div", { class: "help", text: "Trap: " + f.trap }) : null));
  });
  common.append(uH("table", { class: "ref" }, uH("tr", {}, uH("th", { text: "Field" }), uH("th", { text: "Type" }), uH("th", { text: "Use" })), rows));
  wrap.append(common);
  const rules = uH("details", { "data-ref": "rules" }, uH("summary", { text: "Trigger rules, conditions and variables" }));
  rules.append(uH("h3", { text: "Trigger rules" }), uH("ul", {}, SCHEMA.triggerRules.map((r) => uH("li", {}, uH("code", { text: r.name }), " — " + r.help))));
  const g = SCHEMA.whenGrammar;
  rules.append(uH("h3", { text: "when grammar" }), uH("p", { class: "help" }, uH("code", { text: g.expression }), " where a clause is ", uH("code", { text: g.clause }), " and an atom is ", uH("code", { text: g.atom }), "."),
    uH("ul", {}, g.notes.map((n) => uH("li", { text: n }))), uH("p", { class: "help", text: "Operators: " + g.ops.join(" ") + ". Left side: " + g.lhs.join(", ") + ". Right side: " + g.rhs + "." }));
  rules.append(uH("h3", { text: "Variables" }), uH("p", { class: "help", text: "Run variables: " + SCHEMA.variables.run.join(", ") + ". References: " + SCHEMA.variables.refs.join(", ") + ". Shell text substitutes only " + SCHEMA.variables.shellText.join(", ") + " and node references as text; other variables arrive as environment variables, including INPUTS_<NAME>. Substituted output is capped at " + SCHEMA.variables.outputCapBytes + " bytes." }));
  rules.append(uH("h3", { text: "Workflow-level fields" }), uH("p", { class: "help", text: SCHEMA.workflowFields.map((f) => f.name).join(", ") + ". " + SCHEMA.unknownKeyNote }));
  wrap.append(rules);
  return wrap;
}

// ---- canvas ----

function uMetricValue(stat) {
  if (!stat) return null;
  switch (ui.metric) {
    case "total": return stat.durTotal;
    case "median": return stat.durMedian;
    case "p90": return stat.durP90;
    case "runs": return stat.runs;
    case "failures": return stat.failures;
    case "cost": return stat.costSum;
    default: return null;
  }
}

function uMetricText(v) {
  if (v === null || v === undefined) return "–";
  if (ui.metric === "cost") return uFmtUsd(v);
  if (ui.metric === "runs" || ui.metric === "failures") return String(v);
  return uFmtMs(v);
}

function uWorstIssue(key) {
  const order = { error: 3, warning: 2, risk: 1 };
  let worst = null;
  for (const i of ui.issues) if (i.key === key && (!worst || order[i.severity] > order[worst])) worst = i.severity;
  return worst;
}

function uNodeSub(entry) {
  const n = entry.node;
  const t = nodeType(n);
  let text;
  if (t === "loop_group") text = "loop · " + (bodyOf(n) ? bodyOf(n).length : 0) + " nodes · max " + (n.loop_group && n.loop_group.max_iterations);
  else if (NODE_AI_TYPES.includes(t)) text = Array.isArray(n.model) ? n.model.join(" / ") : n.model || t + " (default model)";
  else text = t;
  return text;
}

function uRenderCanvas() {
  const host = document.getElementById("graph-host");
  if (!host) return;
  const m = uCur();
  const v = ui.view[ui.wf];
  const lay = layoutWorkflow(m, { collapsed: v.collapsed, offsets: v.offsets, showData: ui.showData, lanes: uFileNodeList() });
  ui.layout = lay;
  const svg = uS("svg", { class: "graph", role: "img", "aria-label": "Workflow graph" });
  svg.append(uS("defs", {}, uS("marker", { id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" }, uS("path", { d: "M0 0 L10 5 L0 10 z", class: "arrow" }))));
  const entries = flattenNodes(m);
  const metricMax = ui.metric === "none" ? 0 : Math.max(0, ...entries.map((e) => {
    const st = uNodeStat(e.key);
    return st && !st.aggregate ? uMetricValue(st) || 0 : 0;
  }));
  // containers, outer ones first
  const boxes = Object.values(lay.containers).sort((a, b) => a.key.split(".").length - b.key.split(".").length);
  for (const c of boxes) svg.append(uContainer(c, entries));
  const edgeLayer = uS("g", { class: "edges" });
  svg.append(edgeLayer);
  for (const e of lay.edges) {
    const a = lay.nodes[e.from];
    const b = lay.nodes[e.to];
    if (!a || !b) continue;
    const target = findNode(m, e.realTo);
    const cond = e.kind === "dep" && target && typeof target.node.when === "string";
    const sel = ui.selEdge && ui.selEdge.from === e.realFrom && ui.selEdge.to === e.realTo;
    const d = layoutEdgePath(a, b);
    edgeLayer.append(uS("path", { d, class: "edge " + (e.kind === "dep" ? (cond ? "cond" : "") : e.kind) + (sel ? " sel" : ""), "marker-end": "url(#arrow)" }));
    if (e.kind === "dep") {
      edgeLayer.append(uS("path", { d, class: "edge-hit", "data-edge": e.realFrom + ">" + e.realTo, onclick: (ev) => { ev.stopPropagation(); ui.selEdge = { from: e.realFrom, to: e.realTo }; ui.selected = null; uRenderCanvas(); uRenderInspector(); } }, uS("title", { text: e.realFrom + " → " + e.realTo + (cond ? " (conditional)" : "") })));
    }
  }
  for (const e of entries) {
    const b = lay.nodes[e.key];
    if (b && !(lay.containers[e.key])) svg.append(uNodeCard(e, b, metricMax));
  }
  svg.addEventListener("pointerdown", uCanvasDown);
  svg.addEventListener("pointerover", (ev) => {
    const el = ev.target.closest && ev.target.closest("g.node");
    uSetHover(el ? { node: el.getAttribute("data-key") } : null);
  });
  svg.addEventListener("pointerleave", () => uSetHover(null));
  svg.addEventListener("click", (ev) => {
    if (ev.target === svg && !ui.panned) {
      ui.selected = null;
      ui.selEdge = null;
      ui.fileSel = null;
      ui.highlight = new Set();
      uRenderCanvas();
      uRenderInspector();
    }
  });
  const scroller = document.getElementById("canvas");
  const sx = scroller ? scroller.scrollLeft : 0;
  const sy = scroller ? scroller.scrollTop : 0;
  const prev = ui.vb;
  uClear(host).append(svg);
  uFitFileLabels(svg);
  ui.vb = uFitViewBox(svg, lay, lay.lanes.length ? UI_LANE_GUTTER : 0);
  if (scroller) {
    // When the drawing grows past the top or left edge, scroll by the same amount so what is on screen stays put.
    const same = prev.wf === ui.wf && prev.zoom === ui.zoom;
    scroller.scrollLeft = sx + (same ? (prev.bx - ui.vb.bx) * ui.zoom : 0);
    scroller.scrollTop = sy + (same ? (prev.y - ui.vb.y) * ui.zoom : 0);
  }
  ui.svg = svg;
  uRenderLanes();
  uRenderFocus();
}

// Sizes the svg to everything drawn in it, so a node dragged past the top or left edge can still be scrolled to.
// The lane pane's name gutter is added to the left of the drawing. Returns the view box.
function uFitViewBox(svg, lay, gutter) {
  let bb = { x: 0, y: 0, width: lay.width, height: lay.height };
  try {
    bb = svg.getBBox();
  } catch (e) {
    /* the svg is not rendered; the layout's size will do */
  }
  const bx = Math.min(-20, Math.floor(bb.x) - 20);
  const y = Math.min(-20, Math.floor(bb.y) - 20);
  const x = bx - gutter;
  const W = Math.max(Math.max(lay.width + 40, Math.ceil(bb.x + bb.width) + 20) - x, 300);
  const H = Math.max(Math.max(lay.height + 40, Math.ceil(bb.y + bb.height) + 20) - y, 200);
  svg.setAttribute("viewBox", x + " " + y + " " + W + " " + H);
  svg.setAttribute("width", Math.round(W * ui.zoom));
  svg.setAttribute("height", Math.round(H * ui.zoom));
  return { x, y, W, H, bx, wf: ui.wf, zoom: ui.zoom };
}

// The lane pane under the graph: a row per file, with a dot at the x of each node that writes (filled), reads (ring)
// or deletes (cross) it. It scrolls up and down on its own. Sideways it follows the graph's scroller (see uInit), so a
// dot stays under its node. The names sit over the left edge of the track, in the gutter the graph leaves there.
function uRenderLanes() {
  const pane = document.getElementById("lanes");
  if (!pane) return;
  const lay = ui.layout;
  const scroll = document.getElementById("lanes-scroll");
  const top = scroll.scrollTop;
  const head = uClear(document.getElementById("lanes-head"));
  const body = uClear(document.getElementById("lanes-body"));
  pane.hidden = !lay.lanes.length;
  if (!lay.lanes.length) return;
  const z = ui.zoom;
  const rows = lay.lanes.length;
  const H = rows * lay.laneH;
  const W = Math.round(ui.vb.W * z);
  const X = (x) => (x - ui.vb.x) * z;
  const files = new Map(uFiles().files.map((f) => [f.id, f]));
  const verb = { w: " is written by ", r: " is read by ", d: " is deleted by " };
  head.append(
    uH("strong", { text: "Files" }),
    uH("span", { class: "muted", text: rows + (rows === 1 ? " file" : " files") }),
    uH("span", { class: "lane-key", text: "● written   ○ read   ✕ deleted" }),
    uH("span", { class: "help", text: "A dot sits under each node that touches the file. Hover a row to light up its nodes, or a node to light up its files." }));
  const track = uS("svg", { class: "lane-svg", width: W, height: H, role: "img", "aria-label": "Files and the nodes that touch them" });
  const names = uS("svg", { class: "lane-names", width: UI_LANE_GUTTER, height: H });
  names.append(uS("rect", { class: "lane-back", x: 0, y: 0, width: UI_LANE_GUTTER, height: H }));
  lay.lanes.forEach((l, i) => {
    const f = files.get(l.id) || l;
    const label = uFileLabel(f);
    const y0 = i * lay.laneH;
    const g = uS("g", { class: "lane", "data-lane-file": l.id });
    g.append(uS("rect", { class: "lane-bg" + (i % 2 ? " alt" : ""), x: 0, y: y0, width: W, height: lay.laneH }));
    g.append(uS("line", { class: "lane-line", x1: X(l.x1), y1: l.y, x2: X(l.x2), y2: l.y }));
    for (const d of l.dots) {
      const cx = X(d.x);
      g.append(uS("circle", { class: "lane-dot " + d.kind, "data-lane-file": l.id, "data-lane-node": d.node, cx, cy: l.y, r: 4.5, onclick: () => uShowFile(l.id) }, uS("title", { text: label + verb[d.kind] + d.node })));
      if (d.kind === "d") g.append(uS("path", { class: "lane-x", d: "M" + (cx - 2.5) + " " + (l.y - 2.5) + " L" + (cx + 2.5) + " " + (l.y + 2.5) + " M" + (cx + 2.5) + " " + (l.y - 2.5) + " L" + (cx - 2.5) + " " + (l.y + 2.5) }));
    }
    track.append(g);
    const row = uS("g", { class: "lane-row", "data-lane-file": l.id, onclick: () => uShowFile(l.id) }, uS("title", { text: label + " (" + FILE_WHERE[l.where] + ")" }));
    row.append(uS("rect", { class: "lane-hit" + (i % 2 ? " alt" : ""), x: 0, y: y0, width: UI_LANE_GUTTER, height: lay.laneH }));
    row.append(uS("text", { class: "lane-label", x: 6, y: l.y + 4, "data-fit": JSON.stringify([label]), "data-avail": UI_LANE_GUTTER - 18, "data-path": "1" }, label));
    names.append(row);
  });
  const trackBox = uH("div", { class: "lane-track", id: "lane-track" }, track);
  body.append(trackBox, names);
  uFitFileLabels(names);
  scroll.scrollTop = top;
  trackBox.scrollLeft = document.getElementById("canvas").scrollLeft;
}

function uContainer(c, entries) {
  const e = entries.find((x) => x.key === c.key);
  const g = e.node.loop_group || {};
  const grp = uS("g", { class: "container" + (ui.selected === c.key ? " sel" : "") + (ui.highlight.has(c.key) ? " hl" : ""), "data-key": c.key, "data-container": c.key });
  grp.append(uS("rect", { class: "box", x: c.x, y: c.y, width: c.w, height: c.h }));
  const simNode = ui.sim ? ui.sim.state.nodes.get(c.key) : null;
  const rounds = simNode && simNode.rounds ? "  · round " + simNode.rounds : "";
  grp.append(uS("text", { class: "head", x: c.x + 12, y: c.y + 19, onclick: (ev) => { ev.stopPropagation(); uSelect(c.key); } }, "⟲ " + e.id + "  · max " + g.max_iterations + rounds));
  grp.append(uS("text", { class: "head", x: c.x + c.w - 22, y: c.y + 19, "data-toggle": c.key, style: "pointer-events:all", onclick: (ev) => { ev.stopPropagation(); uToggleCollapse(c.key); } }, "−", uS("title", { text: "Collapse " + e.id })));
  const lp = uStats() && uStats().loops ? uStats().loops[c.key] : null;
  if (lp) grp.append(uRoundsBars(lp, c.x + c.w - 30 - Math.min(lp.max, 12) * 8, c.y + 4, 8, 16));
  return grp;
}

// Tiny histogram of rounds used, one bar per round up to max_iterations (capped at 12 bars).
function uRoundsBars(lp, x, y, bw, bh) {
  const g = uS("g", { class: "rounds" }, uS("title", { text: "Rounds used per run (n=" + lp.runs + "), against max_iterations " + lp.max + ": " + Object.entries(lp.hist).sort((a, b) => a[0] - b[0]).map(([r, n]) => r + "×" + n).join(" ") }));
  const bars = Math.min(lp.max, 12);
  const top = Math.max(1, ...Object.values(lp.hist));
  for (let r = 1; r <= bars; r++) {
    const n = lp.hist[String(r)] || 0;
    const h = n ? Math.max(2, (n / top) * bh) : 1;
    g.append(uS("rect", { x: x + (r - 1) * bw, y: y + bh - h, width: bw - 2, height: h, style: "fill:" + (r === lp.max ? "var(--bad)" : "var(--good)"), opacity: n ? 0.9 : 0.25 }));
  }
  return g;
}

function uToggleCollapse(key) {
  const v = ui.view[ui.wf];
  const i = v.collapsed.indexOf(key);
  if (i >= 0) v.collapsed.splice(i, 1);
  else v.collapsed.push(key);
  uSaveView();
  uRenderCanvas();
}

// Fits each lane name to its width once it is in the page, where text can be measured. A name is cut from the
// beginning: leading folders go first, then the first characters of the file name.
function uFitFileLabels(svg) {
  for (const t of svg.querySelectorAll("text[data-fit]")) {
    const avail = Number(t.getAttribute("data-avail"));
    const options = JSON.parse(t.getAttribute("data-fit"));
    const fits = (text) => { t.textContent = text; return t.getComputedTextLength() <= avail; };
    if (options.some(fits)) continue;
    const full = options[options.length - 1];
    let best = null;
    if (t.getAttribute("data-path")) {
      const segs = full.split("/");
      for (let i = 1; i < segs.length && !best; i++) if (fits("…/" + segs.slice(i).join("/"))) best = "…/" + segs.slice(i).join("/");
      const base = segs[segs.length - 1];
      for (let n = base.length - 1; n >= 1 && !best; n--) if (fits("…" + base.slice(-n))) best = "…" + base.slice(-n);
    } else {
      for (let n = full.length - 1; n >= 1 && !best; n--) if (fits(full.slice(0, n) + "…")) best = full.slice(0, n) + "…";
    }
    t.textContent = best || "…";
  }
}

function uNodeCard(e, b, metricMax) {
  const n = e.node;
  const t = nodeType(n) || "none";
  const worst = uWorstIssue(e.key);
  const simNode = ui.sim ? ui.sim.state.nodes.get(e.key) : null;
  const cls = ["node", "t-" + t, ui.selected === e.key ? "sel" : "", ui.highlight.has(e.key) ? "hl" : "", worst === "error" ? "err" : "", simNode ? "sim-" + (simNode.state === "completed" && ui.simPrompt && ui.simPrompt.key === e.key ? "suspended" : simNode.state) : ""].filter(Boolean).join(" ");
  const g = uS("g", { class: cls, "data-key": e.key, transform: "translate(" + b.x + "," + b.y + ")" });
  const spec = SCHEMA.types[t];
  const stat = uNodeStat(e.key);
  const val = ui.metric === "none" || !stat || stat.aggregate ? null : uMetricValue(stat);
  g.append(uS("rect", { class: "card", width: b.w, height: b.h }));
  if (val && metricMax > 0) g.append(uS("rect", { class: "shade", width: b.w, height: b.h, rx: 8, opacity: (0.08 + 0.5 * Math.sqrt(val / metricMax)).toFixed(3) }));
  g.append(uS("rect", { class: "stripe", x: 0, y: 0, width: 5, height: b.h }));
  g.append(uS("text", { class: "glyph-t", x: 12, y: 19 }, spec ? spec.glyph : "?"));
  const id = String(n.id === undefined ? "(no id)" : n.id);
  g.append(uS("text", { class: "id", x: 40, y: 19 }, id.length > 18 ? id.slice(0, 17) + "…" : id));
  let sub = uNodeSub(e);
  if (val !== null) sub += " · " + uMetricText(val);
  else if (ui.metric !== "none" && stat && stat.aggregate) sub += " · see rounds";
  if (simNode && simNode.state === "skipped" && simNode.cause) sub = "skipped: " + simNode.cause.kind;
  if (simNode && simNode.state === "failed") sub = "failed";
  g.append(uS("text", { class: "sub", x: 12, y: 35 }, sub.length > 27 ? sub.slice(0, 26) + "…" : sub));
  let px = 12;
  const pill = (label, title) => {
    const w = label.length * 5.8 + 12;
    if (px + w > b.w - 6) return;
    g.append(uS("rect", { class: "pillbox", x: px, y: b.h - 20, width: w, height: 14 }, uS("title", { text: title })));
    g.append(uS("text", { class: "sub", x: px + 6, y: b.h - 9.5 }, label, uS("title", { text: title })));
    px += w + 4;
  };
  const pstat = uStats() && uStats().pauses ? uStats().pauses[e.key] : null;
  if (typeof n.when === "string") pill("when", "when: " + n.when);
  if (n.trigger_rule && n.trigger_rule !== "all_success") pill(n.trigger_rule === "none_failed_min_one_success" ? "nfm1s" : n.trigger_rule, "trigger_rule: " + n.trigger_rule);
  if (pstat && ui.metric !== "none") pill("wait ~" + uFmtMs(pstat.waitedMedian), "A pause. Median wait " + uFmtMs(pstat.waitedMedian) + ", p90 " + uFmtMs(pstat.waitedP90));
  else if (isPauseNode(n)) pill("pause", "A pause: the run stops until it is answered.");
  if (worst) g.append(uS("circle", { class: "dot-" + (worst === "error" ? "err" : worst === "warning" ? "warn" : "risk"), cx: b.w - 10, cy: 10, r: 4.5 }, uS("title", { text: worst })));
  const noteWhat = uNotesFor(e.key);
  g.append(uS("title", { text: id + " (" + t + ")" + (noteWhat && noteWhat.what ? "\n" + noteWhat.what : "") + (typeof n.when === "string" ? "\nwhen: " + n.when : "") + (simNode && simNode.cause ? "\nskipped: " + simNode.cause.kind + " — " + (simNode.cause.detail || "") : "") }));
  g.append(uS("circle", { class: "port port-in", cx: 0, cy: b.h / 2, r: 5, "data-port-in": e.key }));
  g.append(uS("circle", { class: "port port-out", cx: b.w, cy: b.h / 2, r: 5, "data-port-out": e.key }));
  if (bodyOf(n)) g.append(uS("text", { class: "head", x: b.w - 24, y: 20, "data-toggle": e.key, style: "pointer-events:all;cursor:pointer;fill:var(--good)", onclick: (ev) => { ev.stopPropagation(); uToggleCollapse(e.key); } }, "+", uS("title", { text: "Expand " + id })));
  return g;
}

// Sets what the pointer is over, a node or a file, and redraws the focus.
function uSetHover(next) {
  const was = ui.hover;
  if ((!was && !next) || (was && next && was.file === next.file && was.node === next.node)) return;
  ui.hover = next;
  uRenderFocus();
}

// Lights up what a file and a node have in common without drawing a line. The focus is what the pointer is over, else
// the selected file, else the selected node. A focused file lights the nodes that touch it; a focused node lights its
// dots, with a band down its column in the lane pane. In both, the lanes of other files fade.
function uRenderFocus() {
  const svg = ui.svg;
  const lay = ui.layout;
  const pane = document.getElementById("lanes");
  if (!svg || !lay || !pane) return;
  for (const el of svg.querySelectorAll(".fhl")) el.classList.remove("fhl");
  for (const el of pane.querySelectorAll(".fhl, .fdim")) el.classList.remove("fhl", "fdim");
  for (const el of pane.querySelectorAll(".lane-col")) el.remove();
  const collapsed = new Set(ui.view[ui.wf].collapsed);
  const rel = [];
  for (const l of lay.lanes) for (const d of l.dots) rel.push({ file: l.id, node: d.node });
  const focus = ui.hover || (ui.fileSel ? { file: ui.fileSel } : ui.selected ? { node: layoutVisibleKey(ui.selected, collapsed) } : null);
  const hit = focus ? rel.filter((r) => (focus.file ? r.file === focus.file : r.node === focus.node)) : [];
  const files = new Set(hit.map((r) => r.file));
  const nodes = new Set(hit.map((r) => r.node));
  for (const g of svg.querySelectorAll("g.node, g.container")) if (nodes.has(g.getAttribute("data-key"))) g.classList.add("fhl");
  if (!files.size) return;
  for (const el of pane.querySelectorAll("g.lane, g.lane-row")) if (!files.has(el.getAttribute("data-lane-file"))) el.classList.add("fdim");
  if (!focus.node) return;
  for (const d of pane.querySelectorAll("circle.lane-dot")) if (d.getAttribute("data-lane-node") === focus.node) d.classList.add("fhl");
  const b = lay.nodes[focus.node];
  const track = pane.querySelector("svg.lane-svg");
  if (b && track) track.insertBefore(uS("rect", { class: "lane-col", x: (b.x - ui.vb.x) * ui.zoom, y: 0, width: b.w * ui.zoom, height: lay.lanes.length * lay.laneH }), track.firstChild);
}

function uSvgPoint(ev) {
  const r = ui.svg.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / ui.zoom + ui.vb.x, y: (ev.clientY - r.top) / ui.zoom + ui.vb.y };
}

// A press on the background, or a middle-button press anywhere, pans the canvas by scrolling it.
function uStartPan(ev) {
  const sc = document.getElementById("canvas");
  if (!sc) return;
  ev.preventDefault();
  ui.drag = { kind: "pan", sx: ev.clientX, sy: ev.clientY, left: sc.scrollLeft, top: sc.scrollTop, moved: false };
  ui.svg.classList.add("panning");
  uDragListen();
}

function uCanvasDown(ev) {
  ui.panned = false;
  if (ev.button === 1) return uStartPan(ev);
  if (ev.button !== 0) return;
  // A press on a collapse or expand toggle is a click, not the start of a drag; selecting the node here
  // would redraw the graph before the click lands.
  if (ev.target.closest && ev.target.closest("[data-toggle]")) return;
  const out = ev.target.closest && ev.target.closest("[data-port-out]");
  if (out) {
    ev.preventDefault();
    ui.drag = { kind: "edge", from: out.getAttribute("data-port-out"), pt: uSvgPoint(ev) };
    uDragListen();
    return;
  }
  const node = ev.target.closest && ev.target.closest("g.node");
  if (node) {
    const key = node.getAttribute("data-key");
    const off = ui.view[ui.wf].offsets[key] || { dx: 0, dy: 0 };
    ui.drag = { kind: "move", key, sx: ev.clientX, sy: ev.clientY, base: { dx: off.dx || 0, dy: off.dy || 0 }, moved: false };
    uDragListen();
    return;
  }
  const t = ev.target;
  const background = t === ui.svg || (t.classList && t.classList.contains("box"));
  if (background) uStartPan(ev);
}

// A press on a lane's background pans: sideways with the graph's scroller, up and down in the lane pane.
function uLanesDown(ev) {
  if (ev.button !== 0 || !ev.target.classList || !ev.target.classList.contains("lane-bg")) return;
  ev.preventDefault();
  ui.drag = { kind: "lanepan", sx: ev.clientX, sy: ev.clientY, left: document.getElementById("canvas").scrollLeft, top: document.getElementById("lanes-scroll").scrollTop, moved: false };
  uDragListen();
}

// Gives the lane pane a height of its own, as far as the graph above it keeps room to be seen.
function uSizeLanes(px) {
  const pane = document.getElementById("lanes");
  const room = pane.parentElement.getBoundingClientRect().height - 120;
  const h = Math.round(Math.max(70, Math.min(px, room > 70 ? room : 70)));
  pane.classList.add("sized");
  pane.style.height = h + "px";
  return h;
}

// Dragging the pane's top edge resizes it; the height is remembered.
function uLanesSplitDown(ev) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  const handle = ev.currentTarget;
  const startY = ev.clientY;
  const startH = document.getElementById("lanes").getBoundingClientRect().height;
  let height = startH;
  handle.classList.add("on");
  const move = (e) => {
    height = uSizeLanes(startH + startY - e.clientY);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    handle.classList.remove("on");
    uStoreSet("lanes-height", height);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// Sideways wheel or shift+wheel over the lane pane scrolls the graph's scroller, which the lane track follows.
function uLanesWheel(ev) {
  const dx = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.shiftKey ? ev.deltaY : 0;
  if (!dx) return;
  ev.preventDefault();
  document.getElementById("canvas").scrollLeft += dx;
}

function uDragListen() {
  const move = (ev) => {
    const d = ui.drag;
    if (!d) return;
    const sc = document.getElementById("canvas");
    if (d.kind === "pan") {
      if (!d.moved && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 4) return;
      d.moved = true;
      sc.scrollLeft = d.left - (ev.clientX - d.sx);
      sc.scrollTop = d.top - (ev.clientY - d.sy);
      return;
    }
    if (d.kind === "lanepan") {
      if (!d.moved && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 4) return;
      d.moved = true;
      sc.scrollLeft = d.left - (ev.clientX - d.sx);
      document.getElementById("lanes-scroll").scrollTop = d.top - (ev.clientY - d.sy);
      return;
    }
    const r = sc.getBoundingClientRect();
    if (ev.clientX > r.right - 40) sc.scrollLeft += 20;
    else if (ev.clientX < r.left + 40) sc.scrollLeft -= 20;
    if (ev.clientY > r.bottom - 40) sc.scrollTop += 20;
    else if (ev.clientY < r.top + 80) sc.scrollTop -= 20;
    if (d.kind === "move") {
      const dx = (ev.clientX - d.sx) / ui.zoom;
      const dy = (ev.clientY - d.sy) / ui.zoom;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      ui.view[ui.wf].offsets[d.key] = { dx: d.base.dx + dx, dy: d.base.dy + dy };
      if (!d.raf) {
        d.raf = requestAnimationFrame(() => {
          d.raf = 0;
          uRenderCanvas();
        });
      }
    } else {
      d.pt = uSvgPoint(ev);
      uDrawDragLine();
    }
  };
  const up = (ev) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    const d = ui.drag;
    ui.drag = null;
    if (!d || d.kind === "lanepan") return;
    if (d.kind === "pan") {
      if (ui.svg) ui.svg.classList.remove("panning");
      if (d.moved) {
        // The click that follows a pan must not clear the selection; the next press clears the flag.
        ui.panned = true;
      }
      return;
    }
    if (d.kind === "move") {
      if (d.moved) uSaveView();
      else uSelect(d.key);
      return;
    }
    const line = ui.svg && ui.svg.querySelector(".drag-line");
    if (line) line.remove();
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const inPort = el && el.closest ? el.closest("[data-port-in]") : null;
    const nodeEl = el && el.closest ? el.closest("g.node") : null;
    const target = inPort ? inPort.getAttribute("data-port-in") : nodeEl ? nodeEl.getAttribute("data-key") : null;
    if (target) uConnect(d.from, target);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function uDrawDragLine() {
  const d = ui.drag;
  const a = ui.layout.nodes[d.from];
  if (!a || !ui.svg) return;
  let line = ui.svg.querySelector(".drag-line");
  if (!line) {
    line = uS("path", { class: "drag-line" });
    ui.svg.append(line);
  }
  line.setAttribute("d", "M" + (a.x + a.w) + " " + (a.y + a.h / 2) + " L" + d.pt.x + " " + d.pt.y);
}

function uConnect(from, to) {
  let res = null;
  uEdit((m) => {
    res = addEdge(m, from, to);
  });
  ui.notice = res && !res.ok ? "Edge not added: " + res.error + "." : "";
  uRenderBottom();
}

// ---- inspector ----

// What a file node is: where it lives, and which nodes write, delete and read it.
function uInspectFile(box, id) {
  const f = uFiles().files.find((x) => x.id === id);
  if (!f) return uInspectWorkflow(box);
  const where = { artifacts: "The run's artifacts directory, $ARTIFACTS_DIR, outside the worktree.", designs: "The reports directory, ~/.archon/designs/<repo>/<slug>/.", worktree: "The run's worktree, a file the run adds to the repository.", gitdir: "The worktree's git directory, which the lane hook reads.", state: "~/.archon/state, shared by every run of the repository.", other: "" }[f.where];
  const chips = (keys, cls, title) => uH("div", { class: "chips" }, keys.map((k) => uH("button", { class: "chip " + cls, "data-node": k, title, onclick: () => uSelect(k), text: k })));
  const made = f.writers.filter((w) => w.how !== "deletes");
  const gone = f.writers.filter((w) => w.how === "deletes");
  box.append(uH("div", { class: "row" }, uH("h2", { style: "margin:0", text: uFileLabel(f) }), uH("span", { class: "pill", text: "file" })));
  box.append(uH("p", { class: "help mono", text: f.id }), uH("p", { text: where }));
  box.append(uH("h3", { text: "Written by" }));
  box.append(made.length ? chips(made.map((w) => w.key), "file", "Writes it") : uH("p", { class: "muted", text: f.external ? "No node in this workflow: it is made outside it." : "No node." }));
  made.forEach((w) => box.append(uH("div", { class: "help", text: w.key + ": " + (FILE_WRITE_HOW[w.how] || w.how) })));
  if (gone.length) box.append(uH("h3", { text: "Deleted by" }), chips(gone.map((w) => w.key), "file gone", "Deletes it"));
  box.append(uH("h3", { text: "Read by" }), f.readers.length ? chips(f.readers, "", "Reads it") : uH("p", { class: "muted", text: "No node in this workflow reads it." }));
  box.append(uH("div", { class: "help", text: "Found by reading each node's shell and prompt text." }));
}

function uRenderInspector() {
  const box = uClear(document.getElementById("right"));
  if (ui.selEdge) return uInspectEdge(box);
  if (ui.fileSel && !ui.selected) return uInspectFile(box, ui.fileSel);
  if (ui.selected && uEntry(ui.selected)) return uInspectNode(box, uEntry(ui.selected));
  return uInspectWorkflow(box);
}

function uInspectEdge(box) {
  const e = ui.selEdge;
  box.append(uH("h2", { text: "Dependency" }), uH("p", {}, uH("code", { text: e.from }), " → ", uH("code", { text: e.to })),
    uH("p", { class: "help", text: "The target waits for the source. Dependencies are drawn dashed into a node that has a condition." }),
    uH("button", { class: "danger", "data-action": "remove-edge", text: "Remove dependency", onclick: () => {
      uEdit((m) => removeEdge(m, e.from, e.to));
      ui.selEdge = null;
      uRenderInspector();
    } }));
}

function uSetPath(path, value, opts) {
  const key = ui.selected;
  uEdit((m) => {
    const entry = findNode(m, key);
    if (entry) setPath(entry.node, path, value);
  }, opts);
}

function uField(label, control, help) {
  return uH("div", { class: "field" }, uH("label", { text: label }), uH("div", {}, control, help ? uH("div", { class: "help", text: help }) : null));
}

function uTextControl(node, path, o) {
  const cur = getPath(node, path);
  const attrs = { value: cur === undefined || cur === null ? "" : String(cur), "data-path": path.join("."), "aria-label": path.join(".") };
  const onInput = (e) => uSetPath(path, e.target.value === "" && !(o && o.keepEmpty) ? undefined : e.target.value, { inspector: false });
  if (o && o.multiline) return uH("textarea", Object.assign(attrs, { rows: o.rows || 6, oninput: onInput }));
  return uH("input", Object.assign(attrs, { type: "text", oninput: onInput, list: o && o.list }));
}

function uNumberControl(node, path) {
  const cur = getPath(node, path);
  return uH("input", { type: "number", value: cur === undefined ? "" : cur, "data-path": path.join("."), "aria-label": path.join("."), onchange: (e) => uSetPath(path, e.target.value === "" ? undefined : Number(e.target.value)) });
}

function uSelectControl(node, path, options, emptyLabel) {
  const cur = getPath(node, path);
  return uH("select", { "data-path": path.join("."), "aria-label": path.join("."), onchange: (e) => uSetPath(path, e.target.value === "" ? undefined : e.target.value) },
    uH("option", { value: "", text: emptyLabel || "(not set)", selected: cur === undefined }), options.map((o) => uH("option", { value: o, text: o, selected: cur === o })));
}

function uBoolControl(node, path) {
  const cur = getPath(node, path);
  return uH("select", { "data-path": path.join("."), "aria-label": path.join("."), onchange: (e) => uSetPath(path, e.target.value === "" ? undefined : e.target.value === "true") },
    uH("option", { value: "", text: "(not set)", selected: cur === undefined }), uH("option", { value: "true", text: "true", selected: cur === true }), uH("option", { value: "false", text: "false", selected: cur === false }));
}

function uListControl(node, path) {
  const cur = getPath(node, path);
  return uH("textarea", { rows: 3, "data-path": path.join("."), "aria-label": path.join("."), placeholder: "one per line", value: Array.isArray(cur) ? cur.join("\n") : "", oninput: (e) => {
    const items = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
    uSetPath(path, items.length ? items : undefined, { inspector: false });
  } });
}

function uJsonControl(node, path) {
  const cur = getPath(node, path);
  const err = uH("div", { class: "err-text" });
  const ta = uH("textarea", { rows: 4, "data-path": path.join("."), "aria-label": path.join("."), value: cur === undefined ? "" : JSON.stringify(cur, null, 2), oninput: (e) => {
    const text = e.target.value.trim();
    if (!text) {
      err.textContent = "";
      uSetPath(path, undefined, { inspector: false });
      return;
    }
    try {
      const v = JSON.parse(text);
      err.textContent = "";
      uSetPath(path, v, { inspector: false });
    } catch (ex) {
      err.textContent = "Not valid JSON yet: " + ex.message;
    }
  } });
  return uH("div", {}, ta, err);
}

function uNotesFor(key) {
  const n = NOTES[ui.wf];
  return n && n.nodes ? n.nodes[key] || null : null;
}

// What the node does and why: a sentence written for this page, its reason (the YAML's own comment when
// there is one), and the comment above the node in the workflow file, shown as written.
function uNotesBlock(key) {
  const note = uNotesFor(key);
  if (!note) return null;
  const block = uH("div", { class: "notes", "data-notes": key });
  if (note.what) block.append(uH("div", { class: "note-label", text: "What it does" }), uH("p", { class: "note-what", "data-note": "what", text: note.what }));
  if (note.why) block.append(uH("div", { class: "note-label", text: "Why" }), uH("p", { "data-note": "why", text: note.why }));
  if (note.comment) {
    block.append(uH("div", { class: "note-label", text: "Comment in the YAML" }));
    for (const para of note.comment.split("\n\n")) block.append(uH("blockquote", { "data-note": "comment", text: para }));
  }
  block.append(uH("div", { class: "help", text: note.comment ? "What it does" + (note.why ? " and Why" : "") + " are written for this page. The comment is from the workflow file." : "Written for this page, from reading the node. The workflow file has no comment on it." }));
  return block;
}

// The files this node writes and reads, found from its shell and prompt text. A chip opens the file in the Files tab.
function uFilesBlock(key) {
  const fr = uFiles().byNode[key];
  if (!fr || (!fr.writes.length && !fr.reads.length)) return null;
  const chip = (f, cls, title) => uH("button", { class: "chip " + cls, "data-file": f.id, title, onclick: () => uShowFile(f.id), text: uFileLabel(f) });
  const block = uH("div", { class: "files-block", "data-files": key }, uH("h3", { text: "Files" }));
  if (fr.writes.length) {
    block.append(uH("div", { class: "note-label", text: "Writes" }), uH("div", { class: "chips" }, fr.writes.map((w) => chip(w, w.how === "deletes" ? "file gone" : "file", (w.how === "deletes" ? "Deletes it" : "Writes it") + " (" + (FILE_WRITE_HOW[w.how] || w.how) + ")"))));
  }
  if (fr.reads.length) block.append(uH("div", { class: "note-label", text: "Reads" }), uH("div", { class: "chips" }, fr.reads.map((r) => chip(r, "", "Reads it"))));
  block.append(uH("div", { class: "help", text: "Found by reading the node's text, so a file made by a script the page does not know is missing." }));
  return block;
}

function uInspectNode(box, entry) {
  const node = entry.node;
  const type = nodeType(node);
  const key = entry.key;
  box.append(uH("div", { class: "row" }, uH("h2", { style: "margin:0", text: String(node.id) }), uH("span", { class: "pill", text: type || "no type" }),
    uH("button", { class: "danger small", "data-action": "delete", text: "Delete node", onclick: () => uDeleteNode(key) })));
  box.append(uH("p", { class: "help mono", text: key }));
  const notesBlock = uNotesBlock(key);
  if (notesBlock) box.append(notesBlock);
  const filesBlock = uFilesBlock(key);
  if (filesBlock) box.append(filesBlock);
  box.append(uField("id", uH("input", { type: "text", value: node.id === undefined ? "" : node.id, "data-path": "id", "aria-label": "id", onchange: (e) => uRename(key, e.target.value) }), "Renaming rewrites depends_on, $references and conditions that name this node."));
  box.append(uField("description", uTextControl(node, ["description"], { multiline: true, rows: 2 })));
  // flow
  box.append(uH("h3", { text: "Flow" }));
  const sibs = entry.list.filter((n) => isPlainObject(n) && n !== node);
  const deps = Array.isArray(node.depends_on) ? node.depends_on : [];
  box.append(uField("depends on", uH("div", { class: "chips" }, sibs.length ? sibs.map((s) => {
    const on = deps.includes(s.id);
    return uH("button", { class: "chip", "data-dep": s.id, "aria-pressed": on, text: s.id, onclick: () => uToggleDep(key, entry.parentKey, s.id, on) });
  }) : uH("span", { class: "muted", text: "no other nodes in this scope" })), "Click a node id to add or remove a dependency."));
  box.append(uField("trigger_rule", uH("select", { "data-path": "trigger_rule", "aria-label": "trigger_rule", onchange: (e) => uSetPath(["trigger_rule"], e.target.value === "" ? undefined : e.target.value) },
    uH("option", { value: "", text: "all_success (default)", selected: node.trigger_rule === undefined }), SCHEMA.triggerRules.filter((r) => !r.default).map((r) => uH("option", { value: r.name, text: r.name, selected: node.trigger_rule === r.name }))),
    node.trigger_rule ? SCHEMA.triggerRules.find((r) => r.name === node.trigger_rule).help : "Run only if every dependency completed."));
  box.append(uField("when", uWhenEditor(node, entry)));
  // type
  box.append(uH("h3", { text: "Node" }));
  uTypeForm(box, node, type);
  // other fields
  box.append(uCommonFields(node, type));
  // issues
  const mine = ui.issues.filter((i) => i.key === key);
  if (mine.length) {
    box.append(uH("h3", { text: "Issues" }));
    for (const i of mine) box.append(uH("div", { class: "issue", style: "grid-template-columns:70px 1fr" }, uH("span", { class: "sev " + i.severity, text: i.severity }), uH("span", { text: i.message })));
  }
  uInspectStats(box, entry);
  uInspectSim(box, entry);
}

function uToggleDep(key, parentKey, id, on) {
  const from = nodeKey(parentKey, id);
  uEdit((m) => {
    if (on) removeEdge(m, from, key);
    else addEdge(m, from, key);
  });
}

function uRename(key, value) {
  let res = null;
  uEdit((m) => {
    res = renameNode(m, key, value);
  });
  if (res && !res.ok) {
    ui.notice = "Rename refused: " + res.error + ".";
    uRenderBottom();
    uRenderInspector();
    return;
  }
  if (res && res.key !== key) {
    const v = ui.view[ui.wf];
    const move = (k) => (k === key ? res.key : k.startsWith(key + ".") ? res.key + k.slice(key.length) : k);
    v.collapsed = v.collapsed.map(move);
    const off = {};
    for (const [k, o] of Object.entries(v.offsets)) off[move(k)] = o;
    v.offsets = off;
    uSaveView();
    ui.selected = res.key;
    uRefresh();
  }
}

function uDeleteNode(key) {
  let res = null;
  uEdit((m) => {
    res = deleteNode(m, key);
  });
  ui.selected = null;
  ui.notice = res && res.dangling.length ? "Deleted " + key + ". Still referenced in: " + res.dangling.map((d) => d.key).join(", ") + "." : "Deleted " + key + ".";
  uRefresh();
}

function uTypeForm(box, node, type) {
  const f = (label, control, help) => box.append(uField(label, control, help));
  switch (type) {
    case "prompt":
      f("prompt", uTextControl(node, ["prompt"], { multiline: true, rows: 12, keepEmpty: true }));
      break;
    case "command":
      f("command", uTextControl(node, ["command"]), "A file in .archon/commands/<name>.md.");
      f("with", uJsonControl(node, ["with"]));
      break;
    case "bash":
      f("bash", uTextControl(node, ["bash"], { multiline: true, rows: 12, keepEmpty: true }));
      f("timeout (ms)", uNumberControl(node, ["timeout"]));
      f("on_timeout", uSelectControl(node, ["on_timeout"], ["skip"]));
      break;
    case "script":
      f("script", uTextControl(node, ["script"], { multiline: true, rows: 8, keepEmpty: true }));
      f("runtime", uSelectControl(node, ["runtime"], ["bun", "uv"]));
      f("deps", uListControl(node, ["deps"]));
      f("timeout (ms)", uNumberControl(node, ["timeout"]));
      f("on_timeout", uSelectControl(node, ["on_timeout"], ["skip"]));
      f("with", uJsonControl(node, ["with"]));
      break;
    case "loop":
      f("prompt", uTextControl(node, ["loop", "prompt"], { multiline: true, rows: 6 }));
      f("command", uTextControl(node, ["loop", "command"]));
      f("max_iterations", uNumberControl(node, ["loop", "max_iterations"]));
      f("until_bash", uTextControl(node, ["loop", "until_bash"], { multiline: true, rows: 2 }));
      f("until", uTextControl(node, ["loop", "until"]));
      f("until_field", uTextControl(node, ["loop", "until_field"]));
      f("fresh_context", uBoolControl(node, ["loop", "fresh_context"]));
      f("timeout (ms)", uNumberControl(node, ["timeout"]), "Bounds each until_bash run.");
      break;
    case "loop_group":
      f("max_iterations", uNumberControl(node, ["loop_group", "max_iterations"]), "Includes the settling round.");
      f("until_bash", uTextControl(node, ["loop_group", "until_bash"], { multiline: true, rows: 3 }));
      f("until", uTextControl(node, ["loop_group", "until"]));
      f("fresh_context", uBoolControl(node, ["loop_group", "fresh_context"]));
      f("timeout (ms)", uNumberControl(node, ["timeout"]));
      box.append(uField("body", uH("div", { class: "chips" }, (bodyOf(node) || []).map((c) => uH("button", { class: "chip", text: c.id, onclick: () => uSelect(ui.selected + "." + c.id) })))));
      break;
    case "approval":
      f("message", uTextControl(node, ["approval", "message"], { multiline: true, rows: 3 }));
      f("decisions", uJsonControl(node, ["approval", "decisions"]));
      break;
    case "wait":
      uWaitForm(box, node);
      break;
    case "cancel":
      f("reason", uTextControl(node, ["cancel"], { multiline: true, rows: 3, keepEmpty: true }));
      break;
    case "include": {
      const list = uH("datalist", { id: "wf-names" }, WORKFLOWS.map((w) => uH("option", { value: w.name })));
      box.append(list);
      f("include", uTextControl(node, ["include"], { list: "wf-names" }));
      f("with", uJsonControl(node, ["with"]));
      f("fan_out", uJsonControl(node, ["fan_out"]));
      break;
    }
    case "workflow": {
      const list = uH("datalist", { id: "wf-names" }, WORKFLOWS.map((w) => uH("option", { value: w.name })));
      box.append(list);
      f("workflow", uTextControl(node, ["workflow"], { list: "wf-names" }));
      f("input", uTextControl(node, ["input"]));
      f("with", uJsonControl(node, ["with"]));
      f("isolation", uSelectControl(node, ["isolation"], ["inherit", "worktree"]));
      f("fan_out", uJsonControl(node, ["fan_out"]));
      break;
    }
    default:
      box.append(uH("p", { class: "err-text", text: "This node has no type key. Add one of: " + SCHEMA.typeKeys.join(", ") + " (edit the YAML, or delete the node and add a typed one)." }));
  }
}

function uWaitForm(box, node) {
  const w = isPlainObject(node.wait) ? node.wait : {};
  const shapes = waitShapeOf(w);
  const shape = shapes[0] || "attention";
  const defaults = {
    duration: { duration_ms: 60000 },
    until: { until: "2030-01-01T00:00:00Z" },
    event: { event: "event-name", deadline_ms: 3600000 },
    attention: { attention: "Question for the owner", form: "approval" },
  };
  box.append(uField("shape", uH("select", { "data-path": "wait.shape", "aria-label": "wait shape", onchange: (e) => uSetPath(["wait"], cloneJson(defaults[e.target.value])) },
    SCHEMA.waitShapes.map((s) => uH("option", { value: s.name, text: s.name, selected: s.name === shape }))), SCHEMA.waitShapes.find((s) => s.name === shape).help));
  if (shape === "duration") box.append(uField("duration_ms", uNumberControl(node, ["wait", "duration_ms"])));
  if (shape === "until") box.append(uField("until", uTextControl(node, ["wait", "until"]), "An ISO-8601 time or a $node.output reference."));
  if (shape === "event") {
    box.append(uField("event", uTextControl(node, ["wait", "event"])));
    box.append(uField("deadline_ms", uNumberControl(node, ["wait", "deadline_ms"])));
  }
  if (shape === "attention") {
    box.append(uField("attention", uTextControl(node, ["wait", "attention"], { multiline: true, rows: 5, keepEmpty: true })));
    const form = w.form || "message";
    box.append(uField("form", uH("select", { "data-path": "wait.form", "aria-label": "wait form", onchange: (e) => {
      const f = e.target.value;
      uEdit((m) => {
        const entry = findNode(m, ui.selected);
        entry.node.wait.form = f;
        if (f === "select" || f === "multi_select") {
          if (!Array.isArray(entry.node.wait.options)) entry.node.wait.options = [{ id: "approve", label: "Approve" }, { id: "rework", label: "Rework" }];
        } else delete entry.node.wait.options;
      });
    } }, Object.keys(SCHEMA.waitForms).map((f) => uH("option", { value: f, text: f, selected: f === form }))), "Output: " + SCHEMA.waitForms[form].output));
    if (form === "select" || form === "multi_select") {
      const opts = Array.isArray(w.options) ? w.options : [];
      const rows = opts.map((o, i) => uH("div", { class: "row" },
        uH("input", { type: "text", size: 12, value: o.id || "", "aria-label": "option id", "data-option-id": i, oninput: (e) => uSetPath(["wait", "options", i, "id"], e.target.value, { inspector: false }) }),
        uH("input", { type: "text", size: 12, value: o.label || "", "aria-label": "option label", oninput: (e) => uSetPath(["wait", "options", i, "label"], e.target.value || undefined, { inspector: false }) }),
        uH("button", { class: "small", text: "×", "aria-label": "Remove option", onclick: () => uSetPath(["wait", "options", i], undefined) })));
      box.append(uField("options", uH("div", {}, rows, uH("button", { class: "small", "data-action": "add-option", text: "Add option", onclick: () => uSetPath(["wait", "options", opts.length], { id: "option-" + (opts.length + 1) }) })), "Option ids are kebab-case."));
      if (typeof w.options === "string") box.append(uField("options ref", uTextControl(node, ["wait", "options"])));
    }
    box.append(uField("labels", uJsonControl(node, ["wait", "labels"])));
  }
}

// Fields beyond the type's own: the common fields present on the node, and a selector to add another.
function uCommonFields(node, type) {
  const wrap = uH("div");
  const present = SCHEMA.commonFields.filter((f) => !SCHEMA.graphFields.includes(f.name) && node[f.name] !== undefined);
  wrap.append(uH("h3", { text: "Settings" }));
  const honors = SCHEMA.honors[type];
  for (const f of present) {
    const ignored = honors !== "all" && !honors.includes(f.name);
    const bad = (SCHEMA.fieldErrors[type] || []).includes(f.name);
    let control;
    if (f.type === "boolean") control = uBoolControl(node, [f.name]);
    else if (f.type === "number") control = uNumberControl(node, [f.name]);
    else if (f.type === "list") control = uListControl(node, [f.name]);
    else if (f.name === "model") control = uTextControl(node, [f.name], { list: "model-tiers" });
    else if (f.type === "enum") control = uSelectControl(node, [f.name], f.allowed);
    else if (f.type === "string") control = uTextControl(node, [f.name], { multiline: f.name === "systemPrompt", rows: 3 });
    else control = uJsonControl(node, [f.name]);
    wrap.append(uField(f.name, uH("div", {}, control, uH("button", { class: "small", "aria-label": "Remove " + f.name, text: "remove", onclick: () => uSetPath([f.name], undefined) })),
      bad ? "Error: not supported on " + type + " nodes." : ignored ? "Ignored on " + type + " nodes." : f.help));
  }
  wrap.append(uH("datalist", { id: "model-tiers" }, ["small", "medium", "large", "opus", "sonnet", "haiku"].map((v) => uH("option", { value: v }))));
  const addable = SCHEMA.commonFields.filter((f) => !SCHEMA.graphFields.includes(f.name) && node[f.name] === undefined);
  wrap.append(uH("div", { class: "row" }, uH("select", { id: "add-field", "aria-label": "Add a setting" }, uH("option", { value: "", text: "Add a setting…" }), addable.map((f) => uH("option", { value: f.name, text: f.name }))),
    uH("button", { class: "small", "data-action": "add-field", text: "Add", onclick: () => {
      const name = document.getElementById("add-field").value;
      if (!name) return;
      const spec = SCHEMA.commonFields.find((x) => x.name === name);
      const dflt = spec.type === "boolean" ? false : spec.type === "number" ? (name === "maxBudgetUsd" ? 1 : name === "idle_timeout" ? 1800000 : 1000) : spec.type === "list" ? [] : spec.type === "enum" ? spec.allowed[0] : spec.type === "object" ? {} : name === "model" ? "sonnet" : "";
      uSetPath([name], dflt);
    } })));
  return wrap;
}

// ---- the when editor ----

function uWhenProducers(entry) {
  const out = [];
  for (const e of flattenNodes(uCur())) if (e.node !== entry.node && e.id) out.push(["node:" + e.id, "$" + e.id + (e.parentKey ? "  (in " + e.parentKey + ")" : "")]);
  for (const name of Object.keys(uCur().inputs || {})) out.push(["input:" + name, "$INPUTS." + name]);
  if (entry.parentKey) for (const n of entry.list) if (isPlainObject(n)) out.push(["prev:" + n.id, "$LOOP_PREV." + n.id]);
  return out;
}

function uWhenEditor(node, entry) {
  const wrap = uH("div");
  const has = typeof node.when === "string";
  const parsed = has ? parseWhen(node.when, { loopBody: !!entry.parentKey }) : null;
  const status = uH("div", { class: "err-text" });
  if (has && !parsed.ok) status.textContent = "Does not parse: " + parsed.error + (parsed.atomText ? " (in `" + parsed.atomText + "`)" : "") + ".";
  const raw = uH("input", { type: "text", id: "when-raw", "data-path": "when", "aria-label": "when", placeholder: "no condition", value: has ? node.when : "", oninput: (e) => {
    const v = e.target.value;
    const p = v.trim() ? parseWhen(v, { loopBody: !!entry.parentKey }) : { ok: true };
    status.textContent = p.ok ? "" : "Does not parse: " + p.error + (p.atomText ? " (in `" + p.atomText + "`)" : "") + ".";
    uSetPath(["when"], v.trim() ? v : undefined, { inspector: false });
  } });
  wrap.append(raw, status);
  if (has && parsed.ok) {
    const producers = uWhenProducers(entry);
    const commit = (clauses, full) => uSetPath(["when"], clauses.length ? buildWhen(clauses) : undefined, full ? undefined : { inspector: false });
    const clauses = parsed.clauses;
    const encode = (r) => (r.kind === "input" ? "input:" + r.name : r.kind === "loop_prev" ? "prev:" + r.id : "node:" + r.id);
    clauses.forEach((atoms, ci) => {
      if (ci > 0) wrap.append(uH("div", { class: "help", text: "or" }));
      atoms.forEach((a, ai) => {
        const sel = uH("select", { "aria-label": "producer", "data-when": ci + ":" + ai + ":ref", onchange: (e) => {
          const [kind, id] = e.target.value.split(":");
          a.ref = kind === "input" ? { kind: "input", name: id } : kind === "prev" ? { kind: "loop_prev", id, field: a.ref.field || null } : { kind: "node", id, field: a.ref.field || null };
          commit(clauses, true);
        } }, producers.some((p) => p[0] === encode(a.ref)) ? null : uH("option", { value: encode(a.ref), text: refText(a.ref).split(".output")[0], selected: true }),
          producers.map(([v, l]) => uH("option", { value: v, text: l, selected: v === encode(a.ref) })));
        const field = a.ref.kind === "input" ? null : uH("input", { type: "text", size: 8, placeholder: "field", value: a.ref.field || "", "aria-label": "output field", oninput: (e) => {
          a.ref.field = e.target.value.trim() || null;
          commit(clauses, false);
        } });
        const op = uH("select", { "aria-label": "operator", onchange: (e) => {
          a.op = e.target.value;
          commit(clauses, true);
        } }, WHEN_OPS.map((o) => uH("option", { value: o, text: o, selected: o === a.op })));
        const val = uH("input", { type: "text", size: 9, value: a.expected, "aria-label": "value", oninput: (e) => {
          a.expected = e.target.value;
          commit(clauses, false);
        } });
        const typ = uH("select", { "aria-label": "value type", onchange: (e) => {
          a.expectedType = e.target.value;
          commit(clauses, true);
        } }, ["string", "number", "boolean"].map((t) => uH("option", { value: t, text: t === "string" ? "text" : t === "boolean" ? "true/false" : "number", selected: t === a.expectedType })));
        wrap.append(uH("div", { class: "when-row" }, sel, field, op, val, typ,
          uH("button", { class: "small", "aria-label": "Remove condition", text: "×", onclick: () => {
            atoms.splice(ai, 1);
            commit(clauses.filter((c) => c.length), true);
          } })));
      });
      wrap.append(uH("div", { class: "row" }, uH("button", { class: "small", text: "and…", onclick: () => {
        atoms.push({ ref: { kind: "node", id: (producers.find((p) => p[0].startsWith("node:")) || ["node:x"])[0].slice(5), field: null }, op: "==", expected: "value", expectedType: "string" });
        commit(clauses, true);
      } })));
    });
    wrap.append(uH("div", { class: "row" }, uH("button", { class: "small", text: "or…", onclick: () => {
      clauses.push([{ ref: { kind: "node", id: (producers.find((p) => p[0].startsWith("node:")) || ["node:x"])[0].slice(5), field: null }, op: "==", expected: "value", expectedType: "string" }]);
      commit(clauses, true);
    } })));
  } else if (!has) {
    wrap.append(uH("div", { class: "row" }, uH("button", { class: "small", "data-action": "add-when", text: "Add a condition", onclick: () => {
      const first = flattenNodes(uCur()).find((e) => e.node !== entry.node && e.list === entry.list && e.id);
      uSetPath(["when"], first ? "$" + first.id + ".output == 'value'" : "$INPUTS.name == 'value'");
    } })));
  }
  wrap.append(uH("div", { class: "help", text: "&& binds tighter than ||. No parentheses. Strings use single quotes." }));
  return wrap;
}

// ---- statistics in the inspector ----

function uHistogram(hist, max) {
  const keys = Object.keys(hist).map(Number).sort((a, b) => a - b);
  const top = Math.max(1, ...Object.values(hist));
  const end = Math.max(max || 0, ...keys);
  const bars = uH("div", { class: "bars" });
  const labels = uH("div", { class: "bar-labels" });
  for (let r = 1; r <= end && r <= 24; r++) {
    const n = hist[String(r)] || 0;
    bars.append(uH("span", { class: r === max ? "cap" : "", style: "height:" + (n ? Math.max(2, (n / top) * 36) : 1) + "px", title: "round " + r + ": " + n + " runs" }));
    labels.append(uH("span", { text: r }));
  }
  return uH("div", {}, bars, labels);
}

function uInspectStats(box, entry) {
  const stat = uNodeStat(entry.key);
  const s = uStats();
  box.append(uH("h3", { text: "Statistics" }));
  if (!s || (!stat && !(s.loops && s.loops[entry.key]) && !(s.pauses && s.pauses[entry.key]) && !(s.included && s.included[entry.key]))) {
    box.append(uH("p", { class: "muted", text: "No runs recorded for this node." }));
    return;
  }
  if (stat) {
    const kv = uH("dl", { class: "kv" });
    const row = (k, v, id) => kv.append(uH("dt", { text: k }), uH("dd", { "data-stat": id, text: String(v) }));
    row("Runs", stat.runs, "runs");
    row("Completed / failed / skipped", stat.completed + " / " + stat.failures + " / " + stat.skipped, "outcomes");
    row("Time: median / p90 / max", uFmtMs(stat.durMedian) + " / " + uFmtMs(stat.durP90) + " / " + uFmtMs(stat.durMax), "time");
    row("Total time", uFmtMs(stat.durTotal), "total");
    if (!stat.aggregate) row("Cost: sum / mean / median / p90", uFmtUsd(stat.costSum) + " / " + uFmtUsd(stat.costMean) + " / " + uFmtUsd(stat.costMedian) + " / " + uFmtUsd(stat.costP90), "cost");
    if (Object.keys(stat.failureKinds).length) row("Failure kinds", Object.entries(stat.failureKinds).map(([k, n]) => k + " ×" + n).join(", "), "kinds");
    box.append(kv);
  }
  const lp = s.loops && s.loops[entry.key];
  if (lp) box.append(uH("p", { class: "help", text: "Rounds used per run, against max_iterations " + lp.max + " (red). The cap was reached in " + lp.capHits + " of " + lp.runs + " runs." }), uHistogram(lp.hist, lp.max));
  const ps = s.pauses && s.pauses[entry.key];
  if (ps) {
    box.append(uH("p", { class: "help", text: "Answers: " + Object.entries(ps.answers).map(([k, n]) => k + " ×" + n).join(", ") + "." }),
      uH("dl", { class: "kv" }, uH("dt", { text: "Wait: median / p90 / max" }), uH("dd", { text: uFmtMs(ps.waitedMedian) + " / " + uFmtMs(ps.waitedP90) + " / " + uFmtMs(ps.waitedMax) }), uH("dt", { text: "Total waiting" }), uH("dd", { text: uFmtMs(ps.waitedSum) + " over " + ps.waitedN + " answers" })));
  }
  const inc = s.included && s.included[entry.key];
  if (inc) {
    box.append(uH("p", { class: "help", text: "Nodes this include expands to:" }));
    box.append(uH("table", { class: "ref" }, Object.entries(inc).map(([k, st]) => uH("tr", {}, uH("td", { text: k.split(".").pop() }), uH("td", { text: st.runs + " runs" }), uH("td", { text: uFmtMs(st.durMedian) }), uH("td", { text: uFmtUsd(st.costSum) })))));
  }
}

function uInspectSim(box, entry) {
  if (!ui.sim) return;
  const st = ui.sim.state.nodes.get(entry.key);
  box.append(uH("h3", { text: "Simulation" }));
  if (!st) {
    box.append(uH("p", { class: "muted", text: "Not reached yet." }));
    return;
  }
  box.append(uH("p", { text: "State: " + st.state + (st.cause ? " (" + st.cause.kind + (st.cause.detail ? ": " + st.cause.detail : "") + ")" : "") + (st.error ? " — " + st.error : "") }));
  const t = nodeType(entry.node);
  if (t !== "wait" && t !== "cancel" && t !== "approval") {
    box.append(uH("div", { class: "row" },
      uH("button", { class: "small", "data-action": "sim-fail", "aria-pressed": ui.simFail.has(entry.key), text: ui.simFail.has(entry.key) ? "Will fail (click to undo)" : "Fail this node", onclick: () => { if (ui.simFail.has(entry.key)) ui.simFail.delete(entry.key); else ui.simFail.add(entry.key); uRenderInspector(); } }),
      entry.node.timeout !== undefined ? uH("button", { class: "small", "data-action": "sim-timeout", "aria-pressed": ui.simTimeout.has(entry.key), text: ui.simTimeout.has(entry.key) ? "Will time out (click to undo)" : "Time out this node", onclick: () => { if (ui.simTimeout.has(entry.key)) ui.simTimeout.delete(entry.key); else ui.simTimeout.add(entry.key); uRenderInspector(); } }) : null));
  }
}

function uInspectWorkflow(box) {
  const m = uCur();
  const w = WORKFLOWS.find((x) => x.name === ui.wf);
  const s = uStats();
  box.append(uH("h2", { text: m.name || "(unnamed)" }), uH("p", { class: "help", text: w.path + " · " + w.lines + " lines · " + w.bytes + " bytes · " + (w.source === "repo" ? "repository " + w.repo : w.group || "personal") }));
  box.append(uField("name", uH("input", { type: "text", value: m.name || "", "data-path": "workflow.name", "aria-label": "workflow name", oninput: (e) => uEdit((x) => { x.name = e.target.value; }, { inspector: false }) })));
  box.append(uField("description", uH("textarea", { rows: 6, value: m.description || "", "aria-label": "workflow description", oninput: (e) => uEdit((x) => { x.description = e.target.value; }, { inspector: false }) })));
  const inputs = uH("textarea", { rows: 5, "aria-label": "workflow inputs", value: m.inputs === undefined ? "" : JSON.stringify(m.inputs, null, 2) });
  const ierr = uH("div", { class: "err-text" });
  inputs.addEventListener("input", () => {
    try {
      const v = inputs.value.trim() ? JSON.parse(inputs.value) : undefined;
      ierr.textContent = "";
      uEdit((x) => { if (v === undefined) delete x.inputs; else x.inputs = v; }, { inspector: false });
    } catch (ex) {
      ierr.textContent = "Not valid JSON yet: " + ex.message;
    }
  });
  box.append(uField("inputs", uH("div", {}, inputs, ierr)));
  const wfNote = NOTES[ui.wf] && NOTES[ui.wf].nodesComment;
  if (wfNote) {
    box.append(uH("div", { class: "notes", "data-notes": "workflow" }, uH("div", { class: "note-label", text: "Comment in the YAML, above the node list" }),
      wfNote.split("\n\n").map((p) => uH("blockquote", { "data-note": "comment", text: p }))));
  }
  box.append(uH("p", { class: "help", text: "Other workflow keys: " + (w.keys.filter((k) => !["name", "description", "inputs"].includes(k)).join(", ") || "none") + "." }));
  if (!s) return;
  box.append(uH("h3", { text: "Run history" }));
  const kv = uH("dl", { class: "kv" });
  const row = (k, v, id) => kv.append(uH("dt", { text: k }), uH("dd", { "data-stat": id, text: String(v) }));
  row("Runs", s.runs + " (" + Object.entries(s.byStatus).map(([k, n]) => n + " " + k).join(", ") + ")", "wf-runs");
  if (s.runCost && s.runCost.n) row("Run cost: median / p90 / max", uFmtUsd(s.runCost.median) + " / " + uFmtUsd(s.runCost.p90) + " / " + uFmtUsd(s.runCost.max), "wf-cost");
  row("Node time", uFmtMs(s.nodeMs), "wf-node-time");
  row("Waiting time", uFmtMs(s.waitMs), "wf-wait-time");
  row("Node spend", uFmtUsd(s.nodeSpend), "wf-spend");
  row("Run-level failures", s.wfFailed + (Object.keys(s.failExit).length ? " (" + Object.entries(s.failExit).map(([k, n]) => k + " ×" + n).join(", ") + ")" : ""), "wf-failed");
  if (Object.keys(s.cancelReasons).length) row("Cancelled", Object.entries(s.cancelReasons).map(([k, n]) => k + " ×" + n).join(", "), "wf-cancel");
  row("Legacy nodes", s.legacyNodes + " recorded nodes no longer in the file", "wf-legacy");
  box.append(kv);
}

// ---- bottom pane ----

function uRenderBottom() {
  const bottom = uClear(document.getElementById("bottom"));
  const errs = ui.issues.filter((i) => i.severity === "error").length;
  const diff = diffWorkflows(uCompareBase(), uCur());
  const fdiff = filesDiff(uFilesOfModel(uCompareBase()), uFiles());
  const changes = diff.nodesAdded.length + diff.nodesRemoved.length + diff.edgesAdded.length + diff.edgesRemoved.length + diff.conditions.length + diff.fields.length + diff.workflow.length + fdiff.added.length + fdiff.removed.length + fdiff.rewired.length;
  const tabs = uH("div", { class: "tabs", role: "tablist" }, UI_TABS.map(([id, label]) => uH("button", { role: "tab", "aria-selected": ui.tab === id, "data-tab": id, onclick: () => { ui.tab = id; uRenderBottom(); } }, label,
    id === "validation" ? uH("span", { class: "badge" + (errs ? " err" : ""), "data-count": "issues", text: ui.issues.length }) : null,
    id === "changes" && changes ? uH("span", { class: "badge", text: changes }) : null,
    id === "files" ? uH("span", { class: "badge", "data-count": "files", text: uFiles().files.length }) : null,
    id === "findings" ? uH("span", { class: "badge", text: FINDINGS.length }) : null)));
  tabs.append(uH("button", { class: "small", style: "margin-left:auto", "data-action": "toggle-pane", "aria-expanded": !ui.bottomClosed, text: ui.bottomClosed ? "Show pane ▴" : "Hide pane ▾", onclick: () => {
    ui.bottomClosed = !ui.bottomClosed;
    document.getElementById("app").classList.toggle("bottom-closed", ui.bottomClosed);
    uRenderBottom();
  } }));
  bottom.append(tabs);
  const pane = uH("div", { id: "tab-pane" });
  bottom.append(pane);
  if (ui.tab === "validation") uTabValidation(pane);
  else if (ui.tab === "changes") uTabChanges(pane, diff, fdiff);
  else if (ui.tab === "files") uTabFiles(pane);
  else if (ui.tab === "yaml") uTabYaml(pane);
  else if (ui.tab === "sim") uTabSim(pane);
  else uTabFindings(pane);
}

function uCompareBase() {
  if (ui.compare !== "snapshot") {
    const exp = (ui.experiments[ui.wf] || {})[ui.compare];
    if (exp) return exp;
    ui.compare = "snapshot";
  }
  return uSnap();
}

function uTabValidation(pane) {
  const counts = { error: 0, warning: 0, risk: 0 };
  for (const i of ui.issues) counts[i.severity]++;
  pane.append(uH("div", { class: "cols" }, uH("div", {},
    uH("p", { class: "help", text: "Mirrors Archon " + SCHEMA.engineVersion + ". Errors are what the engine rejects, warnings what it accepts and ignores, and run-time risks what it accepts and a run can fail on. The engine's own check is POST /api/workflows/validate." }),
    ui.notice ? uH("div", { class: "notice", "data-notice": "", text: ui.notice }) : null,
    uH("div", { class: "row" }, uH("span", { class: "pill fail", text: counts.error + " errors" }), uH("span", { class: "pill run", text: counts.warning + " warnings" }), uH("span", { class: "pill", text: counts.risk + " run-time risks" })),
    ui.issues.length ? ["error", "warning", "risk"].flatMap((sev) => ui.issues.filter((i) => i.severity === sev).map((i) => uH("div", { class: "issue", "data-rule": i.rule, "data-severity": sev, onclick: () => (i.key ? uSelect(i.key) : (ui.selected = null, ui.selEdge = null, uRenderCanvas(), uRenderInspector())) },
      uH("span", { class: "sev " + sev, text: sev === "risk" ? "run-time" : sev }), uH("span", { class: "mono", text: i.key || "workflow" }), uH("span", { text: i.message })))) : uH("p", { class: "good", text: "No issues." })),
    uH("div", {}, uH("h3", { text: "Known gaps" }), KNOWN_GAPS.length ? uH("ul", {}, KNOWN_GAPS.map((g) => uH("li", {}, uH("code", { text: g.rule }), " — " + g.note))) : uH("p", { class: "help", text: "No rule where this page and the engine disagreed in tests/engine_check.py." }))));
}

function uTabChanges(pane, diff, fdiff) {
  const exps = Object.keys(ui.experiments[ui.wf] || {});
  const hasBase = !BASELINE || !!BASELINE[ui.wf];
  pane.append(uH("div", { class: "row" }, uH("label", {}, "Compare the current edit against ", uH("select", { id: "compare-base", onchange: (e) => { ui.compare = e.target.value; uRenderBottom(); } },
    uH("option", { value: "snapshot", text: BASELINE ? "the baseline (" + META.baselineLabel + ")" : "the snapshot", selected: ui.compare === "snapshot" }), exps.map((n) => uH("option", { value: n, text: "experiment " + n, selected: ui.compare === n }))))));
  if (!hasBase && ui.compare === "snapshot") pane.append(uH("p", { class: "notice", "data-notice": "added", text: "The baseline has no workflow named " + ui.wf + ", so the table lists it as added. This tab shows only your edits since the page loaded." }));
  const filesChanged = fdiff.added.length + fdiff.removed.length + fdiff.rewired.length;
  if (diff.empty && !filesChanged) {
    pane.append(uH("p", { class: "muted", text: "No changes." }));
    return;
  }
  const list = (title, items, render) => {
    if (!items.length) return;
    pane.append(uH("h3", { text: title + " (" + items.length + ")" }), uH("ul", { "data-diff": title }, items.map((i) => uH("li", {}, render(i)))));
  };
  list("Nodes added", diff.nodesAdded, (k) => uH("code", { text: k }));
  list("Nodes removed", diff.nodesRemoved, (k) => uH("code", { text: k }));
  list("Edges added", diff.edgesAdded, (e) => uH("code", { text: e.from + " → " + e.to }));
  list("Edges removed", diff.edgesRemoved, (e) => uH("code", { text: e.from + " → " + e.to }));
  list("Conditions changed", diff.conditions, (c) => [uH("code", { text: c.key }), ": ", uH("code", { text: c.before === undefined ? "(none)" : c.before }), " → ", uH("code", { text: c.after === undefined ? "(none)" : c.after })]);
  const fileItem = (f) => [uH("code", { text: uFileLabel(f) }), uH("span", { class: "where", text: " " + FILE_WHERE[f.where] }),
    f.writers.length ? " — written by " + f.writers.map((w) => w.key).join(", ") : "", f.readers.length ? "; read by " + f.readers.join(", ") : ""];
  list("Files added", fdiff.added, fileItem);
  list("Files removed", fdiff.removed, (f) => [uH("code", { text: uFileLabel(f) }), uH("span", { class: "where", text: " " + FILE_WHERE[f.where] })]);
  list("Files with different writers or readers", fdiff.rewired, (f) => [uH("code", { text: uFileLabel(f) }),
    ": written by " + (f.was.writers.join(", ") || "no node") + " → " + (f.writers.map((w) => w.key).join(", ") || "no node"),
    "; read by " + (f.was.readers.join(", ") || "no node") + " → " + (f.readers.join(", ") || "no node")]);
  list("Workflow fields changed", diff.workflow, (f) => [uH("code", { text: f.field }), ": ", uH("code", { text: String(JSON.stringify(f.before)).slice(0, 80) }), " → ", uH("code", { text: String(JSON.stringify(f.after)).slice(0, 80) })]);
  if (diff.fields.length) {
    pane.append(uH("h3", { text: "Fields changed (" + diff.fields.length + ")" }));
    for (const f of diff.fields) {
      const det = uH("details", { open: !!f.lines, "data-diff": "field" }, uH("summary", {}, uH("code", { text: f.key + "." + f.field }), f.lines ? "" : ": " + String(f.before === undefined ? "(none)" : JSON.stringify(f.before)).slice(0, 60) + " → " + String(f.after === undefined ? "(none)" : JSON.stringify(f.after)).slice(0, 60)));
      if (f.lines) for (const l of f.lines) if (l.op !== " ") det.append(uH("div", { class: "diff-line " + (l.op === "+" ? "add" : "del"), text: l.op + " " + l.text }));
      pane.append(det);
    }
  }
}

function uTabFiles(pane) {
  const r = uFiles();
  const noReader = r.files.filter((f) => !f.readers.length && !f.external).length;
  const outside = r.files.filter((f) => f.external).length;
  const chipFor = (key, cls, title) => uH("button", { class: "chip " + cls, "data-node": key, title, onclick: (ev) => { ev.stopPropagation(); uSelect(key); }, text: key });
  const body = uH("tbody", {});
  const fill = () => {
    const q = ui.fileFilter.trim().toLowerCase();
    const shown = r.files.filter((f) => !q || uFileLabel(f).toLowerCase().includes(q) || FILE_WHERE[f.where].includes(q) || f.writers.some((w) => w.key.toLowerCase().includes(q)) || f.readers.some((k) => k.toLowerCase().includes(q)));
    uClear(body).append(...(shown.length ? shown.map((f) => uH("tr", { class: "file-row" + (ui.fileSel === f.id ? " sel" : ""), "data-file": f.id, onclick: () => uShowFile(f.id) },
      uH("td", {}, uH("code", { text: uFileLabel(f) }), uH("span", { class: "where", text: FILE_WHERE[f.where] })),
      uH("td", {}, uH("div", { class: "chips" }, f.writers.map((w) => chipFor(w.key, w.how === "deletes" ? "file gone" : "file", (w.how === "deletes" ? "Deletes it" : "Writes it") + " (" + (FILE_WRITE_HOW[w.how] || w.how) + ")")))),
      uH("td", {}, uH("div", { class: "chips" }, f.readers.map((k) => chipFor(k, "", "Reads it")))),
      uH("td", { class: "muted", text: f.external ? "made outside this workflow" : !f.readers.length ? (f.dir ? "" : "not read in this workflow") : "" }))) : [uH("tr", {}, uH("td", { class: "muted", colspan: 4, text: "No file matches." }))]));
  };
  pane.append(uH("div", { class: "row" },
    uH("input", { type: "text", class: "files-filter", id: "files-filter", "aria-label": "Filter files", placeholder: "Filter by file or node", value: ui.fileFilter, oninput: (e) => { ui.fileFilter = e.target.value; fill(); } }),
    uH("span", { class: "pill", text: r.files.length + " files" }), uH("span", { class: "pill", text: noReader + " not read here" }), uH("span", { class: "pill", text: outside + " made outside" }),
    uH("span", { class: "help", text: "Files this workflow creates while it runs, found by reading each node's shell and prompt text. Click a row to light up its writers and readers. The Files menu in the header lists them as rows in the pane under the graph, with a dot under each node that writes, reads or deletes the file, and picks which files to list." })));
  pane.append(uH("table", { class: "ref", id: "files-table" },
    uH("thead", {}, uH("tr", {}, ["File", "Written by", "Read by", "Note"].map((h) => uH("th", { text: h })))), body));
  fill();
}

function uTabYaml(pane) {
  const text = toYaml(uCur(), uBuilt());
  pane.append(uH("div", { class: "row" },
    uH("button", { "data-action": "copy-yaml", text: "Copy", onclick: (e) => uCopy(text, () => { e.target.textContent = "Copied"; setTimeout(() => (e.target.textContent = "Copy"), 1500); }) }),
    uH("button", { class: "primary", "data-action": "download", text: "Download", onclick: () => uDownload((uCur().name || "workflow") + ".yaml", text) }),
    uH("button", { "data-action": "reset", text: "Reset to snapshot", onclick: () => { ui.models[ui.wf] = cloneJson(uBuilt()); ui.notice = ""; uRefresh(); } }),
    uH("span", { class: "help", text: "Comments in the original YAML are not carried into this export. Applying a change to the real file keeps them." })));
  pane.append(uH("textarea", { id: "yaml-out", readonly: true, rows: 14, spellcheck: "false", value: text }));
}

// ---- simulation tab ----

function uSimStart() {
  const s = uStats();
  ui.sim = createSimulation(uCur(), { stats: s || undefined, failKeys: ui.simFail, timeoutKeys: ui.simTimeout });
  ui.simPrompt = ui.sim.start();
  uSimRender();
}

function uSimAnswer(v) {
  ui.simPrompt = ui.sim.answer(v);
  uSimRender();
}

function uSimAuto() {
  let guard = 0;
  while (ui.simPrompt && guard++ < 5000) ui.simPrompt = ui.sim.answer(simDefaultAnswer(ui.simPrompt));
  uSimRender();
}

function uSimRender() {
  uRenderCanvas();
  uRenderBottom();
  uRenderInspector();
}

function uTabSim(pane) {
  const sim = ui.sim;
  pane.append(uH("p", { class: "help", text: "Nodes run in dependency order under the trigger rules. You choose the outputs that conditions read, the pauses' answers and whether each loop's check passes. Select a node to make it fail or time out. Time and cost come from the statistics (medians)." }));
  pane.append(uH("div", { class: "row" },
    uH("button", { class: "primary", "data-action": "sim-start", text: sim ? "Restart" : "Start a run", onclick: uSimStart }),
    sim && ui.simPrompt ? uH("button", { "data-action": "sim-auto", text: "Answer with defaults to the end", onclick: uSimAuto }) : null,
    ui.simFail.size ? uH("span", { class: "help", text: "Will fail: " + [...ui.simFail].join(", ") }) : null,
    ui.simTimeout.size ? uH("span", { class: "help", text: "Will time out: " + [...ui.simTimeout].join(", ") }) : null));
  if (!sim) return;
  const p = ui.simPrompt;
  if (p) {
    const label = p.kind === "wait" ? "Pause " + p.key + (p.text ? ": " + p.text.slice(0, 160) : "") : p.kind === "loop" ? p.text : p.text + " (" + p.key + ")";
    pane.append(uH("div", { class: "prompt", "data-prompt": p.kind, "data-prompt-key": p.key }, uH("div", { text: label }),
      uH("div", { class: "opts" }, p.options.map((o) => uH("button", { "data-sim-option": o, text: o, onclick: () => uSimAnswer(p.kind === "loop" ? o === "passes" : o) })))));
  } else if (sim.state.result) {
    const r = sim.state.result;
    pane.append(uH("div", { class: "prompt", "data-result": r.status }, uH("strong", { text: "Run " + r.status + (r.reason ? ": " + r.reason : "") }),
      uH("dl", { class: "kv" },
        uH("dt", { text: "Node time" }), uH("dd", { "data-sim": "node-time", text: uFmtMs(r.nodeMs) }),
        uH("dt", { text: "Waiting time" }), uH("dd", { "data-sim": "wait-time", text: uFmtMs(r.waitMs) }),
        uH("dt", { text: "Cost" }), uH("dd", { "data-sim": "cost", text: uFmtUsd(r.cost) }),
        uH("dt", { text: "Nodes completed" }), uH("dd", { text: r.nodesRun + (r.noStats ? " (" + r.noStats + " without statistics)" : "") }))));
  }
  const log = uH("div", { class: "log", id: "sim-log" }, sim.state.log.map((l) => uH("div", { class: l.kind, text: (l.key ? l.key + ": " : "") + l.text })));
  pane.append(log);
  log.scrollTop = log.scrollHeight;
}

// ---- findings tab ----

function uFindingTargets(f) {
  const by = {};
  for (const n of f.nodes) {
    const i = n.indexOf("/");
    const wf = n.slice(0, i);
    (by[wf] = by[wf] || []).push(n.slice(i + 1));
  }
  return by;
}

function uShowFinding(f, wfName) {
  if (wfName !== ui.wf) uSwitch(wfName);
  const keys = uFindingTargets(f)[wfName] || [];
  ui.highlight = new Set(keys);
  ui.selected = keys.find((k) => uEntry(k)) || null;
  uRenderCanvas();
  uRenderInspector();
  const el = document.querySelector('g[data-key="' + (ui.selected || "") + '"]');
  if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center" });
}

function uMarksMarkdown() {
  const out = ["# My marks on the workflow findings", ""];
  for (const [mark, title] of [["try", "Try"], ["discuss", "Discuss"], ["dismiss", "Dismiss"]]) {
    const items = FINDINGS.filter((f) => ui.marks[f.id] === mark);
    out.push("## " + title, "");
    if (items.length) for (const f of items) out.push("- " + f.id + ". " + f.title);
    else out.push("- none");
    out.push("");
  }
  const unmarked = FINDINGS.filter((f) => !ui.marks[f.id]);
  out.push("## Not marked", "");
  out.push(unmarked.length ? unmarked.map((f) => "- " + f.id + ". " + f.title).join("\n") : "- none");
  return out.join("\n") + "\n";
}

function uTabFindings(pane) {
  pane.append(uH("div", { class: "row" },
    uH("span", { class: "help", text: (FINDINGS_NOTE ? FINDINGS_NOTE + " " : "") + "Mark each finding try, discuss or dismiss." }),
    uH("button", { "data-action": "copy-marks", text: "Copy my marks", onclick: (e) => uCopy(uMarksMarkdown(), () => { e.target.textContent = "Copied"; setTimeout(() => (e.target.textContent = "Copy my marks"), 1500); }) })));
  const tags = ["all", "edit", "restructure", "rethink", "docs", "decision"];
  pane.append(uH("div", { class: "row" }, tags.map((t) => uH("button", { class: "small", "data-tag-filter": t, "aria-pressed": (ui.tagFilter || "all") === t, text: t, onclick: () => { ui.tagFilter = t; uRenderBottom(); } }))));
  for (const f of FINDINGS) {
    if (ui.tagFilter && ui.tagFilter !== "all" && !f.tags.includes(ui.tagFilter)) continue;
    const targets = uFindingTargets(f);
    const card = uH("div", { class: "finding " + (ui.marks[f.id] || ""), "data-finding": f.id },
      uH("h3", {}, f.id + ". " + f.title),
      uH("div", {}, f.tags.map((t) => uH("span", { class: "tag " + t, text: t })), f.probe ? uH("span", { class: "tag probe", text: "probe needed" }) : null),
      uH("p", {}, uH("span", { class: "lbl", text: "Evidence " }), f.evidence),
      uH("p", {}, uH("span", { class: "lbl", text: "Proposed change " }), f.change),
      uH("p", {}, uH("span", { class: "lbl", text: "How to check " }), f.check),
      f.note ? uH("p", { class: "notice", "data-note": f.id, text: f.note }) : null,
      uH("div", { class: "row" }, Object.keys(targets).map((w) => uH("button", { class: "small", "data-show": f.id + ":" + w, disabled: !ui.models[w], text: "Show in graph" + (Object.keys(targets).length > 1 ? ": " + w : ""), title: ui.models[w] ? targets[w].join(", ") : w + " is not a workflow in this build", onclick: () => uShowFinding(f, w) })),
        !f.nodes.length ? uH("span", { class: "help", text: "Concerns no node." }) : null),
      uH("div", { class: "row" }, ["try", "discuss", "dismiss"].map((mk) => uH("button", { class: "small", "data-mark": f.id + ":" + mk, "aria-pressed": ui.marks[f.id] === mk, text: mk, onclick: () => {
        if (ui.marks[f.id] === mk) delete ui.marks[f.id];
        else ui.marks[f.id] = mk;
        uStoreSet("marks", ui.marks);
        uRenderBottom();
      } }))));
    pane.append(card);
  }
}

// ---- start ----

function uInit() {
  const app = document.getElementById("app");
  app.append(
    uH("header", { class: "top", id: "top" }),
    uH("main", { class: "work" },
      uH("aside", { class: "left", id: "left" }),
      uH("div", { class: "center" },
        uH("section", { class: "canvas", id: "canvas" },
          uH("div", { class: "canvas-tools" },
            uH("button", { "aria-label": "Zoom out", "data-action": "zoom-out", text: "−", onclick: () => uZoom(ui.zoom / 1.2) }),
            uH("button", { "aria-label": "Zoom in", "data-action": "zoom-in", text: "+", onclick: () => uZoom(ui.zoom * 1.2) }),
            uH("button", { "data-action": "zoom-fit", text: "Fit", onclick: uFit }),
            uH("span", { class: "help", text: "Drag a node to move it, drag from a right port to a left port to add a dependency, click − to collapse a loop." })),
          uH("div", { id: "graph-host" })),
        uH("section", { class: "lanes", id: "lanes", "aria-label": "Files", hidden: true },
          uH("div", { class: "lanes-split", id: "lanes-split", role: "separator", "aria-orientation": "horizontal", title: "Drag to resize the files pane", onpointerdown: uLanesSplitDown }),
          uH("div", { class: "lanes-head", id: "lanes-head" }),
          uH("div", { class: "lanes-scroll", id: "lanes-scroll" }, uH("div", { class: "lanes-body", id: "lanes-body" })))),
      uH("aside", { class: "right", id: "right" })),
    uH("section", { class: "bottom", id: "bottom" }));
  const canvas = document.getElementById("canvas");
  const lanes = document.getElementById("lanes");
  canvas.addEventListener("scroll", () => {
    const track = document.getElementById("lane-track");
    if (track) track.scrollLeft = canvas.scrollLeft;
  });
  lanes.addEventListener("pointerover", (ev) => {
    const el = ev.target.closest && ev.target.closest("[data-lane-file]");
    uSetHover(el ? { file: el.getAttribute("data-lane-file") } : null);
  });
  lanes.addEventListener("pointerleave", () => uSetHover(null));
  lanes.addEventListener("pointerdown", uLanesDown);
  const savedHeight = uStoreGet("lanes-height");
  if (typeof savedHeight === "number") uSizeLanes(savedHeight);
  document.getElementById("lanes-scroll").addEventListener("wheel", uLanesWheel, { passive: false });
  ui.marks = uStoreGet("marks") || {};
  for (const w of WORKFLOWS) {
    ui.built[w.name] = cloneJson(w.model);
    ui.snaps[w.name] = cloneJson(BASELINE && BASELINE[w.name] ? BASELINE[w.name].model : w.model);
    ui.models[w.name] = cloneJson(w.model);
    uLoadView(w.name);
  }
  ui.wf = WORKFLOWS.some((w) => w.name === "build") ? "build" : WORKFLOWS[0].name;
  uRenderHeader();
  uRenderLeft();
  uRefresh();
  uRenderHeaderCounts();
  document.addEventListener("keydown", (ev) => {
    const tag = ev.target && ev.target.tagName;
    if ((ev.key !== "Delete" && ev.key !== "Backspace") || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (ui.selEdge) {
      const e = ui.selEdge;
      ui.selEdge = null;
      uEdit((m) => removeEdge(m, e.from, e.to));
    }
  });
  window.__playground = { model: () => cloneJson(uCur()), yaml: () => toYaml(uCur(), uBuilt()), state: ui, switchTo: uSwitch };
}

function uZoom(z) {
  ui.zoom = Math.max(0.3, Math.min(2, z));
  uRenderCanvas();
}

function uFit() {
  const sc = document.getElementById("canvas");
  if (!ui.layout || !sc) return;
  ui.zoom = Math.max(0.5, Math.min(1, (sc.clientWidth - 20) / ui.vb.W));
  uRenderCanvas();
}

uInit();
