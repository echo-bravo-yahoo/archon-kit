// Run simulator. A run is a generator: it runs nodes in dependency order under the trigger rules and the
// `when` semantics, and yields a prompt whenever a choice is needed (a node output that a condition reads,
// a pause's answer, a loop's check). The cost and time come from the statistics.
const SIM_OTHER = "(other)";
const SIM_POSITIVE = ["approve", "land", "fresh", "plan", "ask", "pause", "design", "edit", "ready", "go", "green", "yes", "true"];

function simTrigger(rule, deps) {
  if (!deps.length) return { run: true };
  const blocked = (list) => {
    const hard = list.some((d) => d.state === "failed" || (d.state === "skipped" && d.cause && d.cause.kind === "upstream_failed"));
    return hard ? { kind: "upstream_failed" } : { kind: "trigger_rule" };
  };
  const completed = deps.filter((d) => d.state === "completed");
  if (rule === "one_success") return completed.length ? { run: true } : { run: false, cause: blocked(deps) };
  if (rule === "all_done") return { run: true };
  if (rule === "none_failed_min_one_success") {
    const failed = deps.filter((d) => d.state === "failed" || (d.state === "skipped" && d.cause && d.cause.kind === "upstream_failed"));
    if (failed.length) return { run: false, cause: { kind: "upstream_failed" } };
    return completed.length ? { run: true } : { run: false, cause: { kind: "trigger_rule" } };
  }
  const notDone = deps.filter((d) => d.state !== "completed");
  return notDone.length ? { run: false, cause: blocked(notDone) } : { run: true };
}

// Words a bash script prints on its own, taken from the quoted arguments of echo and printf.
function simPrintedWords(text) {
  const words = [];
  const add = (w) => {
    const word = (w || "").replace(/\\n$/, "").trim();
    if (/^[a-z][a-z0-9_-]{0,24}$/.test(word) && word !== "s" && !words.includes(word)) words.push(word);
  };
  const stmts = text.match(/\b(?:echo|printf)\b[^;&|>\n)}]*/g) || [];
  for (const s of stmts) {
    for (const m of s.matchAll(/'([^'$]*)'|"([^"$]*)"/g)) add(m[1] !== undefined ? m[1] : m[2]);
    const bare = /^echo\s+(?:-n\s+)?([a-z][a-z0-9_-]*)\s*$/.exec(s.trim());
    if (bare) add(bare[1]);
  }
  return words;
}

// readers: which literals the conditions compare each node's output (or one field of it) with.
function simReaders(wf) {
  const readers = new Map();
  for (const e of flattenNodes(wf)) {
    if (typeof e.node.when !== "string") continue;
    const parsed = parseWhen(e.node.when, { loopBody: true });
    if (!parsed.ok) continue;
    for (const atom of whenAtoms(parsed)) {
      if (atom.ref.kind === "input") continue;
      if (!readers.has(atom.ref.id)) readers.set(atom.ref.id, new Map());
      const paths = readers.get(atom.ref.id);
      const p = atom.ref.field || "";
      if (!paths.has(p)) paths.set(p, []);
      if (!paths.get(p).includes(atom.expected)) paths.get(p).push(atom.expected);
    }
  }
  return readers;
}

function simFieldOptions(node, field, literals) {
  const opts = [...literals];
  const fmt = isPlainObject(node.output_format) ? node.output_format : null;
  const prop = fmt && isPlainObject(fmt.properties) ? fmt.properties[field.split(".")[0]] : null;
  if (prop && Array.isArray(prop.enum)) for (const v of prop.enum) if (!opts.includes(String(v))) opts.push(String(v));
  if (prop && prop.type === "boolean") for (const v of ["true", "false"]) if (!opts.includes(v)) opts.push(v);
  return opts;
}

function simDefaultAnswer(prompt) {
  if (prompt.kind === "loop") return true;
  const real = prompt.options.filter((o) => o !== SIM_OTHER);
  const positive = SIM_POSITIVE.find((p) => real.includes(p));
  if (positive) return positive;
  return real.length ? real[0] : prompt.options[0];
}

// createSimulation(wf, {stats, failKeys, timeoutKeys}) -> {state, prompt(), start(), answer(value), done()}
function createSimulation(wf, options) {
  const opts = options || {};
  const S = {
    wf,
    stats: opts.stats || { nodes: {}, pauses: {}, included: {} },
    failKeys: opts.failKeys || new Set(),
    timeoutKeys: opts.timeoutKeys || new Set(),
    readers: simReaders(wf),
    entries: flattenNodes(wf),
    nodes: new Map(),
    outputs: new Map(),
    prev: new Map(),
    rounds: new Map(),
    log: [],
    nodeMs: 0,
    waitMs: 0,
    cost: 0,
    noStats: new Set(),
    result: null,
  };
  const gen = simRoot(S);
  let current = null;
  let finished = false;
  const advance = (value) => {
    const r = gen.next(value);
    if (r.done) {
      finished = true;
      current = null;
      S.result = r.value;
    } else current = r.value;
    return current;
  };
  return {
    state: S,
    prompt: () => current,
    done: () => finished,
    start: () => advance(undefined),
    answer: (value) => advance(value),
  };
}

function simLog(S, kind, key, text) {
  S.log.push({ kind, key: key || null, text });
}

function simResolveKey(S, id, parentKey) {
  let scope = parentKey;
  for (;;) {
    const hit = S.entries.find((e) => e.parentKey === (scope || null) && e.id === id);
    if (hit) return hit.key;
    if (!scope) return null;
    const up = S.entries.find((e) => e.key === scope);
    scope = up ? up.parentKey : null;
  }
}

function simValueOf(output, field) {
  if (output === undefined) return undefined;
  if (!field) return output;
  let cur = output;
  for (const p of field.split(".")) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function simCharge(S, entry) {
  const st = S.stats.nodes && S.stats.nodes[entry.key];
  if (!st || st.aggregate) {
    if (!st) S.noStats.add(entry.key);
    return;
  }
  if (typeof st.durMedian === "number") S.nodeMs += st.durMedian;
  if (typeof st.costMedian === "number") S.cost += st.costMedian;
}

function simChargeInclude(S, entry) {
  const inc = (S.stats.included || {})[entry.key];
  if (!inc) return;
  for (const st of Object.values(inc)) {
    if (st.aggregate) continue;
    if (typeof st.durMedian === "number") S.nodeMs += st.durMedian;
    if (typeof st.costMedian === "number") S.cost += st.costMedian;
  }
}

function* simRoot(S) {
  const status = yield* simRunList(S, S.wf.nodes, null, false);
  const failed = [...S.nodes.values()].some((n) => n.state === "failed");
  const final = status === "cancelled" ? "cancelled" : status === "failed" || failed ? "failed" : "completed";
  const result = {
    status: final, reason: S.cancelReason || null, nodeMs: S.nodeMs, waitMs: S.waitMs, cost: S.cost,
    noStats: S.noStats.size, nodesRun: [...S.nodes.values()].filter((n) => n.state === "completed").length,
  };
  simLog(S, "end", null, "Run " + final + (S.cancelReason ? ": " + S.cancelReason : "") + ".");
  return result;
}

// Runs one graph (the workflow, or one loop-body round). Returns "completed", "failed" or "cancelled".
function* simRunList(S, list, parentKey, inLoop) {
  const nodes = list.filter(isPlainObject);
  const ids = new Set(nodes.map((n) => n.id));
  const state = new Map();
  const pending = new Set(nodes.map((n) => n.id));
  const keyOf = (n) => nodeKey(parentKey, n.id);
  for (const n of nodes) S.nodes.set(keyOf(n), { state: "pending", round: S.rounds.get(parentKey) || 0 });
  let cancelled = false;
  while (pending.size && !cancelled) {
    const ready = nodes.find((n) => pending.has(n.id) && (Array.isArray(n.depends_on) ? n.depends_on : []).filter((d) => ids.has(d)).every((d) => !pending.has(d)));
    if (!ready) {
      for (const id of pending) {
        const n = nodes.find((x) => x.id === id);
        S.nodes.set(keyOf(n), { state: "skipped", cause: { kind: "trigger_rule", detail: "its dependencies never finished (a cycle)" } });
        state.set(id, S.nodes.get(keyOf(n)));
      }
      break;
    }
    pending.delete(ready.id);
    const key = keyOf(ready);
    const deps = (Array.isArray(ready.depends_on) ? ready.depends_on : []).filter((d) => ids.has(d)).map((d) => state.get(d));
    const rule = ready.trigger_rule || "all_success";
    const trig = simTrigger(rule, deps);
    const finish = (rec) => {
      S.nodes.set(key, rec);
      state.set(ready.id, rec);
    };
    if (!trig.run) {
      const why = trig.cause.kind === "upstream_failed" ? "a dependency failed" : "a dependency was skipped (" + rule + ")";
      finish({ state: "skipped", cause: Object.assign({ detail: why }, trig.cause) });
      simLog(S, "skip", key, "Skipped: " + (trig.cause.kind === "upstream_failed" ? "upstream_failed" : "trigger_rule " + rule) + ".");
      continue;
    }
    // condition
    if (typeof ready.when === "string") {
      const verdict = simWhen(S, ready, parentKey);
      if (verdict.error) {
        finish({ state: "failed", error: verdict.error });
        simLog(S, "fail", key, "Failed: " + verdict.error);
        continue;
      }
      if (!verdict.result) {
        finish({ state: "skipped", cause: { kind: verdict.parsed === false ? "condition_parse_error" : "condition", detail: ready.when } });
        simLog(S, "skip", key, "Skipped: condition false (" + ready.when + ").");
        continue;
      }
    }
    const type = nodeType(ready);
    if (type === "cancel") {
      finish({ state: "completed" });
      S.cancelReason = String(ready.cancel);
      simLog(S, "cancel", key, "Cancelled the run: " + ready.cancel);
      cancelled = true;
      continue;
    }
    if (S.failKeys.has(key)) {
      finish({ state: "failed", error: "failure injected" });
      simCharge(S, { key });
      simLog(S, "fail", key, "Failed (injected).");
      continue;
    }
    if (S.timeoutKeys.has(key) && (type === "bash" || type === "script" || type === "loop" || type === "loop_group") && ready.timeout !== undefined) {
      if (ready.on_timeout === "skip") {
        finish({ state: "skipped", cause: { kind: "timeout", detail: "timeout " + ready.timeout + " ms, on_timeout: skip" } });
        simLog(S, "skip", key, "Skipped: timeout.");
      } else {
        finish({ state: "failed", error: "timeout" });
        simLog(S, "fail", key, "Failed: timeout after " + ready.timeout + " ms.");
      }
      continue;
    }
    if (type === "loop_group") {
      const res = yield* simRunLoop(S, ready, key);
      finish({ state: res === "failed" ? "failed" : "completed", rounds: S.rounds.get(key) });
      if (res === "cancelled") cancelled = true;
      continue;
    }
    if (type === "wait" || type === "approval") {
      const out = yield* simPause(S, ready, key);
      finish({ state: "completed", output: out });
      S.outputs.set(key, out);
      continue;
    }
    if (type === "include") simChargeInclude(S, { key });
    else simCharge(S, { key });
    finish({ state: "completed" });
    simLog(S, "run", key, "Ran " + type + ".");
    yield* simAskOutputs(S, ready, key);
  }
  if (cancelled) {
    for (const id of pending) S.nodes.set(keyOf(nodes.find((n) => n.id === id)), { state: "skipped", cause: { kind: "cancelled", detail: "the run was cancelled" } });
    return "cancelled";
  }
  return [...state.values()].some((s) => s.state === "failed") ? "failed" : "completed";
}

// Asks for the output of a node that a condition reads, one prompt per field path.
function* simAskOutputs(S, node, key) {
  const paths = S.readers.get(node.id);
  if (!paths) return;
  const type = nodeType(node);
  let whole;
  const fields = {};
  for (const [path, literals] of paths) {
    const options = simFieldOptions(node, path, literals);
    if (type === "bash" && !path) for (const w of simPrintedWords(node.bash || "")) if (!options.includes(w)) options.push(w);
    options.push(SIM_OTHER);
    const value = yield { kind: "output", key, id: node.id, field: path, options, text: path ? "Output field '" + path + "' of " + node.id : "Output of " + node.id };
    const v = value === SIM_OTHER ? "" : String(value);
    if (path) {
      fields[path] = v;
    } else whole = v;
    simLog(S, "output", key, "Output " + (path ? path + " " : "") + "= " + (v === "" ? "(other)" : v));
  }
  if (Object.keys(fields).length) {
    const obj = {};
    for (const [p, v] of Object.entries(fields)) setPath(obj, p.split("."), v);
    S.outputs.set(key, whole !== undefined ? whole : obj);
    if (whole !== undefined) S.outputs.set(key + "#fields", obj);
  } else S.outputs.set(key, whole);
}

function simWhen(S, node, parentKey) {
  const parsed = parseWhen(node.when, { loopBody: !!parentKey });
  if (!parsed.ok) return { parsed: false, result: false };
  try {
    const result = evalWhen(parsed, (ref) => {
      if (ref.kind === "input") return "";
      const key = simResolveKey(S, ref.id, parentKey);
      if (ref.kind === "loop_prev") {
        const v = simOutputValue(S.prev, key, ref.field);
        if (v === undefined) throw new Error("no previous round");
        return v;
      }
      const st = key ? S.nodes.get(key) : null;
      if (!st || st.state !== "completed") throw new Error("reads the output of '" + ref.id + "', which did not run");
      const v = simOutputValue(S.outputs, key, ref.field);
      if (v === undefined) throw new Error("no output value for " + ref.id + (ref.field ? "." + ref.field : ""));
      return v;
    });
    return { parsed: true, result };
  } catch (e) {
    if (/no previous round/.test(e.message)) return { parsed: true, result: false };
    return { error: e.message };
  }
}

// The value of a node's output (or of one field of it) from a map of outputs keyed by node key.
function simOutputValue(map, key, field) {
  const whole = map.get(key);
  const fields = map.get(key + "#fields");
  if (!field) return whole !== undefined ? whole : fields;
  return simValueOf(fields !== undefined ? fields : whole, field);
}

function simPauseOptions(node) {
  const w = isPlainObject(node.wait) ? node.wait : {};
  if (nodeType(node) === "approval") {
    const ds = node.approval && Array.isArray(node.approval.decisions) ? node.approval.decisions.map((d) => d.id) : ["approve", "reject"];
    return ds;
  }
  const form = w.form || "message";
  if (form === "approval") return ["approve", "reject"];
  if ((form === "select" || form === "multi_select") && Array.isArray(w.options)) return w.options.map((o) => o.id);
  return [];
}

function* simPause(S, node, key) {
  const w = isPlainObject(node.wait) ? node.wait : {};
  const st = (S.stats.pauses || {})[key];
  if (nodeType(node) === "wait" && w.attention === undefined) {
    const ms = typeof w.duration_ms === "number" ? w.duration_ms : st && st.waitedMedian ? st.waitedMedian : 0;
    S.waitMs += ms;
    simLog(S, "wait", key, "Waited " + Math.round(ms / 1000) + " s (" + (w.duration_ms ? "duration_ms" : w.until ? "until" : "event") + ").");
    return { status: "satisfied", waited_ms: ms };
  }
  const options = simPauseOptions(node);
  const form = w.form || "message";
  const text = nodeType(node) === "approval" ? node.approval.message : w.attention;
  let decision = "";
  if (options.length) decision = yield { kind: "wait", key, id: node.id, form, options, text: String(text || "") };
  else yield { kind: "wait", key, id: node.id, form, options: ["answer"], text: String(text || "") };
  const ms = st && typeof st.waitedMedian === "number" ? st.waitedMedian : 0;
  S.waitMs += ms;
  const out = form === "multi_select" ? { decisions: decision ? [decision] : [], text: "" } : options.length ? { decision, text: "" } : { text: "" };
  simLog(S, "wait", key, "Answered" + (decision ? " " + decision : "") + " after " + Math.round(ms / 60000) + " min (median wait).");
  return out;
}

function* simRunLoop(S, node, key) {
  const g = node.loop_group;
  const max = g.max_iterations;
  S.prev = new Map();
  let result = "failed";
  for (let round = 1; round <= max; round++) {
    S.rounds.set(key, round);
    simLog(S, "round", key, "Round " + round + " of " + max + ".");
    const status = yield* simRunList(S, g.nodes, key, true);
    if (status === "cancelled") return "cancelled";
    if (status === "failed") {
      simLog(S, "fail", key, "Failed at round " + round + ": a node in the body failed.");
      return "failed";
    }
    const verdict = yield {
      kind: "loop", key, id: node.id, round, max, options: ["passes", "does not pass"],
      text: "Does until_bash pass after round " + round + "? " + String(g.until_bash || g.until || ""),
    };
    const passes = verdict === true || verdict === "passes";
    simLog(S, "loop-check", key, "until_bash " + (passes ? "passes" : "does not pass") + " after round " + round + ".");
    if (passes) {
      result = "completed";
      break;
    }
    // the next round's $LOOP_PREV reads this round's outputs
    S.prev = new Map(S.outputs);
    for (const e of S.entries) if (e.parentKey === key) S.prev.set(e.key, S.outputs.get(e.key));
  }
  if (result !== "completed") {
    simLog(S, "fail", key, "Exceeded max iterations (" + max + ") without a passing until_bash check.");
    return "failed";
  }
  return "completed";
}

// Runs a simulation to the end, answering each prompt with answerFn(prompt).
function runSimulation(wf, options, answerFn) {
  const sim = createSimulation(wf, options);
  let p = sim.start();
  let guard = 0;
  while (p && guard++ < 5000) p = sim.answer(answerFn(p));
  return sim;
}

if (typeof require !== "undefined") {
  var { flattenNodes, nodeKey, nodeType, isPlainObject, setPath } = require("./model.js");
  var { parseWhen, whenAtoms, evalWhen } = require("./when.js");
}
if (typeof module !== "undefined") module.exports = { createSimulation, runSimulation, simTrigger, simReaders, simDefaultAnswer, simPrintedWords, SIM_OTHER };
