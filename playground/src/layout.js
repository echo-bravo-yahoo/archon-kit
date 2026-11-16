// Layered layout. Each scope (the top level, or one loop body) is ranked by longest path over depends_on,
// each rank is ordered by three barycenter sweeps, and ranks are columns drawn left to right. An expanded
// loop_group is a container that holds its body's layout; a collapsed one is a single card.
// The files a workflow creates are laid out as lanes (opts.lanes, from fileNodes() in files.js): one row per file,
// with a dot at the x of each node that touches it. The lane rows are drawn in a pane of their own, so they take no
// room in the graph.
const LAYOUT_DEFAULTS = { nodeW: 176, nodeH: 60, gapX: 44, gapY: 22, pad: 16, headerH: 28, laneH: 18, dotSpacing: 10 };

function layoutRanks(list) {
  const ids = new Set(list.map((n) => n.id));
  const deps = new Map(list.map((n) => [n.id, (Array.isArray(n.depends_on) ? n.depends_on : []).filter((d) => ids.has(d) && d !== n.id)]));
  const rank = new Map();
  const visiting = new Set();
  const visit = (id) => {
    if (rank.has(id)) return rank.get(id);
    if (visiting.has(id)) return -1;
    visiting.add(id);
    let r = 0;
    for (const d of deps.get(id)) r = Math.max(r, visit(d) + 1);
    visiting.delete(id);
    rank.set(id, r);
    return r;
  };
  for (const n of list) visit(n.id);
  return rank;
}

function layoutOrderRanks(list, rank) {
  const columns = [];
  for (const n of list) {
    const r = rank.get(n.id);
    (columns[r] = columns[r] || []).push(n.id);
  }
  for (let r = 0; r < columns.length; r++) if (!columns[r]) columns[r] = [];
  const preds = new Map(list.map((n) => [n.id, []]));
  const succs = new Map(list.map((n) => [n.id, []]));
  for (const n of list) {
    for (const d of Array.isArray(n.depends_on) ? n.depends_on : []) {
      if (preds.has(d) && d !== n.id) {
        preds.get(n.id).push(d);
        succs.get(d).push(n.id);
      }
    }
  }
  const pos = new Map();
  const reindex = () => columns.forEach((col) => col.forEach((id, i) => pos.set(id, i)));
  reindex();
  const sweep = (r, nbrs) => {
    const col = columns[r];
    const bary = new Map();
    col.forEach((id, i) => {
      const ns = nbrs.get(id).filter((x) => pos.has(x));
      bary.set(id, ns.length ? ns.reduce((a, x) => a + pos.get(x), 0) / ns.length : i);
    });
    col.sort((a, b) => bary.get(a) - bary.get(b) || pos.get(a) - pos.get(b));
    reindex();
  };
  for (let pass = 0; pass < 3; pass++) {
    for (let r = 1; r < columns.length; r++) sweep(r, preds);
    for (let r = columns.length - 2; r >= 0; r--) sweep(r, succs);
  }
  return columns;
}

// Lays out one list; returns boxes by node key in coordinates local to the scope, and the scope size.
function layoutScope(list, parentKey, opts, out) {
  const o = opts;
  const rank = layoutRanks(list);
  const columns = layoutOrderRanks(list, rank);
  const byId = new Map(list.map((n) => [n.id, n]));
  const sizes = new Map();
  const inner = new Map();
  for (const n of list) {
    const key = nodeKey(parentKey, n.id);
    const body = bodyOf(n);
    if (body && !o.collapsed.has(key)) {
      const sub = layoutScope(body, key, o, out);
      inner.set(n.id, sub);
      sizes.set(n.id, { w: sub.width + 2 * o.pad, h: sub.height + 2 * o.pad + o.headerH });
    } else sizes.set(n.id, { w: o.nodeW, h: o.nodeH });
  }
  const colItems = columns.map((ids) => ids.map((id) => ({ id })));
  const sizeOf = (it) => sizes.get(it.id);
  const colW = colItems.map((col) => Math.max(0, ...col.map((it) => sizeOf(it).w)));
  const colH = colItems.map((col) => col.reduce((a, it) => a + sizeOf(it).h, 0) + Math.max(0, col.length - 1) * o.gapY);
  const height = Math.max(0, ...colH);
  let x = 0;
  const boxes = new Map();
  colItems.forEach((col, r) => {
    let y = (height - colH[r]) / 2;
    for (const it of col) {
      const s = sizeOf(it);
      boxes.set(it.id, { x, y, w: s.w, h: s.h });
      y += s.h + o.gapY;
    }
    x += colW[r] + o.gapX;
  });
  const width = colItems.length ? x - o.gapX : 0;
  out.scopes.set(parentKey || "", { boxes, inner, rank, width, height, byId });
  return { boxes, width, height, inner };
}

// Turns scope-local boxes into absolute boxes, filling `nodes` and `containers`.
function layoutPlace(list, parentKey, scopeOut, origin, o, result) {
  const sc = scopeOut.scopes.get(parentKey || "");
  for (const n of list) {
    const key = nodeKey(parentKey, n.id);
    const b = sc.boxes.get(n.id);
    const box = { x: origin.x + b.x, y: origin.y + b.y, w: b.w, h: b.h };
    const body = bodyOf(n);
    const expanded = body && !o.collapsed.has(key);
    result.nodes[key] = Object.assign({ key, parentKey: parentKey || null, rank: sc.rank.get(n.id), loop: !!body, expanded: !!expanded }, box);
    if (expanded) {
      result.containers[key] = Object.assign({ key, headerH: o.headerH }, box);
      layoutPlace(body, key, scopeOut, { x: box.x + o.pad, y: box.y + o.pad + o.headerH }, o, result);
    }
  }
}

function layoutApplyOffsets(wf, result, offsets, o) {
  if (!offsets) return;
  const entries = flattenNodes(wf);
  const total = (key) => {
    let dx = 0;
    let dy = 0;
    let cur = key;
    while (cur) {
      const off = offsets[cur];
      if (off) {
        dx += off.dx || 0;
        dy += off.dy || 0;
      }
      cur = result.nodes[cur] ? result.nodes[cur].parentKey : null;
    }
    return { dx, dy };
  };
  for (const e of entries) {
    const box = result.nodes[e.key];
    if (!box) continue;
    const t = total(e.key);
    box.x += t.dx;
    box.y += t.dy;
    if (result.containers[e.key]) {
      result.containers[e.key].x = box.x;
      result.containers[e.key].y = box.y;
    }
  }
  // A container grows to hold children that were moved outside it.
  for (const e of [...entries].reverse()) {
    const c = result.containers[e.key];
    if (!c) continue;
    const kids = entries.filter((k) => k.parentKey === e.key && result.nodes[k.key]).map((k) => result.nodes[k.key]);
    if (!kids.length) continue;
    const minX = Math.min(c.x, ...kids.map((k) => k.x - o.pad));
    const minY = Math.min(c.y, ...kids.map((k) => k.y - o.pad - o.headerH));
    const maxX = Math.max(c.x + c.w, ...kids.map((k) => k.x + k.w + o.pad));
    const maxY = Math.max(c.y + c.h, ...kids.map((k) => k.y + k.h + o.pad));
    Object.assign(c, { x: minX, y: minY, w: maxX - minX, h: maxY - minY });
    Object.assign(result.nodes[e.key], { x: minX, y: minY, w: c.w, h: c.h });
  }
}

// The key the drawing uses for a node: the outermost collapsed loop that holds it, or the node itself.
function layoutVisibleKey(key, collapsed) {
  const parts = key.split(".");
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join(".");
    if (collapsed.has(prefix) && i < parts.length) return prefix;
  }
  return key;
}

// Producer key for an id read from the node `key`: this scope first, then the enclosing scopes.
function layoutResolveId(wf, key, id) {
  const entries = flattenNodes(wf);
  const self = entries.find((e) => e.key === key);
  let parentKey = self ? self.parentKey : null;
  for (;;) {
    const hit = entries.find((e) => e.parentKey === parentKey && e.id === id);
    if (hit) return hit.key;
    if (!parentKey) break;
    const up = entries.find((e) => e.key === parentKey);
    parentKey = up ? up.parentKey : null;
  }
  const any = entries.find((e) => e.id === id);
  return any ? any.key : null;
}

// Edges to draw: depends_on edges, plus (when showData) dotted references that have no depends_on edge.
function layoutEdges(wf, collapsed, showData) {
  const edges = [];
  const seen = new Set();
  const push = (from, to, kind) => {
    const f = layoutVisibleKey(from, collapsed);
    const t = layoutVisibleKey(to, collapsed);
    if (f === t) return;
    const id = kind + "|" + f + "|" + t;
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({ from: f, to: t, kind, realFrom: from, realTo: to });
  };
  for (const e of flattenNodes(wf)) {
    const direct = new Set((Array.isArray(e.node.depends_on) ? e.node.depends_on : []).map((d) => nodeKey(e.parentKey, d)));
    for (const d of direct) push(d, e.key, "dep");
    if (!showData) continue;
    for (const r of collectRefs(e.node).nodes) {
      const from = layoutResolveId(wf, e.key, r.id);
      if (!from || from === e.key) continue;
      if (r.loopPrev) push(from, e.key, "prev");
      else if (!direct.has(from)) push(from, e.key, "data");
    }
  }
  return edges;
}

// Lanes for files: one per file, ordered by the x of its first dot. A dot sits at the centre of each drawn node that
// touches the file (a node that writes and reads it gets two, spread dotSpacing apart); an expanded loop is anchored
// at its right edge, where its exit test runs. Dots that would overlap are pushed apart inside their node's width.
// Each lane gets y, the middle of its row in the lane pane, which starts at 0. A file with no drawn node gets no lane.
function layoutLanes(files, result, collapsed, o) {
  const lanes = [];
  for (const f of files) {
    const touches = new Map();
    const add = (k, kind) => {
      const v = layoutVisibleKey(k, collapsed);
      if (!touches.has(v)) touches.set(v, { w: false, r: false, d: false });
      touches.get(v)[kind] = true;
    };
    f.writers.forEach((k) => add(k, "w"));
    f.readers.forEach((k) => add(k, "r"));
    f.deleters.forEach((k) => add(k, "d"));
    const dots = [];
    for (const [node, t] of touches) {
      const b = result.nodes[node];
      if (!b) continue;
      const cx = b.loop && b.expanded ? b.x + b.w - 14 : b.x + b.w / 2;
      const kinds = ["w", "r", "d"].filter((k) => t[k]);
      kinds.forEach((kind, i) => dots.push({ node, kind, x: cx + (i - (kinds.length - 1) / 2) * o.dotSpacing, hi: b.x + b.w - 8 }));
    }
    if (!dots.length) continue;
    dots.sort((a, b) => a.x - b.x);
    for (let i = 1; i < dots.length; i++) if (dots[i].x - dots[i - 1].x < o.dotSpacing) dots[i].x = Math.min(dots[i].hi, dots[i - 1].x + o.dotSpacing);
    lanes.push({ key: f.key, id: f.id, name: f.name, where: f.where, dir: f.dir, x1: dots[0].x, x2: dots[dots.length - 1].x, dots });
  }
  lanes.sort((a, b) => a.x1 - b.x1 || a.name.localeCompare(b.name));
  lanes.forEach((l, i) => {
    l.y = i * o.laneH + o.laneH / 2;
    l.dots.forEach((d) => {
      d.y = l.y;
    });
  });
  result.laneH = o.laneH;
  result.lanes = lanes;
}

// layoutWorkflow(wf, {collapsed: [keys], offsets: {key: {dx, dy}}, showData, lanes}) -> {nodes, containers, lanes, edges, width, height}
// lanes are fileNodes() entries; the result's lanes are described at layoutLanes.
function layoutWorkflow(wf, options) {
  const opts = Object.assign({}, LAYOUT_DEFAULTS, options || {});
  opts.collapsed = new Set((options && options.collapsed) || []);
  const list = Array.isArray(wf.nodes) ? wf.nodes.filter(isPlainObject) : [];
  const scopeOut = { scopes: new Map() };
  const top = layoutScope(list, null, opts, scopeOut);
  const result = { nodes: {}, containers: {}, lanes: [], edges: [], width: top.width, height: top.height };
  layoutPlace(list, null, scopeOut, { x: 0, y: 0 }, opts, result);
  layoutApplyOffsets(wf, result, opts.offsets, opts);
  result.edges = layoutEdges(wf, opts.collapsed, !!opts.showData);
  let maxX = 0;
  let maxY = 0;
  for (const b of Object.values(result.nodes)) {
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  result.width = maxX;
  result.height = maxY;
  if (opts.lanes && opts.lanes.length) layoutLanes(opts.lanes, result, opts.collapsed, opts);
  return result;
}

// SVG path from the right edge of one box to the left edge of another.
function layoutEdgePath(a, b) {
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  if (x2 >= x1) {
    const dx = Math.max(24, (x2 - x1) / 2);
    return "M" + x1 + " " + y1 + " C" + (x1 + dx) + " " + y1 + " " + (x2 - dx) + " " + y2 + " " + x2 + " " + y2;
  }
  const dx = 48;
  const midY = y2 >= y1 ? Math.max(a.y + a.h, b.y + b.h) + 28 : Math.min(a.y, b.y) - 28;
  return "M" + x1 + " " + y1 + " C" + (x1 + dx) + " " + y1 + " " + (x1 + dx) + " " + midY + " " + (x1 - 40) + " " + midY + " L" + (x2 - 40) + " " + midY + " C" + (x2 - dx) + " " + midY + " " + (x2 - dx) + " " + y2 + " " + x2 + " " + y2;
}

if (typeof require !== "undefined") var { flattenNodes, nodeKey, bodyOf, isPlainObject, collectRefs } = require("./model.js");
if (typeof module !== "undefined") module.exports = { layoutWorkflow, layoutEdgePath, layoutVisibleKey, layoutResolveId, layoutEdges, layoutLanes, LAYOUT_DEFAULTS };
