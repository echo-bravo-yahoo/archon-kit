// Validation that mirrors Archon 0.13.2. An issue has a severity: "error" (the engine rejects it),
// "warning" (the engine accepts and ignores it) or "risk" (the engine accepts it and a run can fail).
const VAL_SCHEMA = typeof SCHEMA !== "undefined" ? SCHEMA : require("../data/schema.json");
const VAL_LOOP_FIELDS = ["max_iterations", "until", "fresh_context", "until_bash", "interactive", "gate_message", "signal_completes", "until_field", "nodes"];
const VAL_LOOP_KEYS = ["prompt", "command", "max_iterations", "until", "until_bash", "until_field", "fresh_context", "interactive", "gate_message", "signal_completes"];
const VAL_GROUP_KEYS = ["nodes", "max_iterations", "until", "until_bash", "fresh_context", "interactive", "gate_message", "signal_completes"];
const VAL_RETRY_KEYS = ["max_attempts", "delay_ms", "on_error"];
const VAL_APPROVAL_KEYS = ["message", "decisions", "capture_response", "on_reject"];
const VAL_KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VAL_COMMON = new Set(VAL_SCHEMA.commonFields.map((f) => f.name));
const VAL_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];

function valIsPositive(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function valIsPositiveInt(v) {
  return valIsPositive(v) && Number.isInteger(v);
}

function valBlank(v) {
  return typeof v !== "string" || v.trim() === "";
}

// Is what the script prints partly decided by something the page cannot read: another script, a file,
// a command substitution or a variable? Then it can print a literal the text does not contain.
function valBashIsOpaque(text) {
  if (/(^|[\s;&|(])["']?(\$HOME|\$\{HOME\}|\$ARCHON_HOME|\$\{ARCHON_HOME(:-[^}]*)?\}|~|\.{0,2})\/[^\s"']*\.(sh|py|mjs|js)\b/.test(text)) return true;
  if (/\b(cat|jq|head|tail|grep|sed|awk|cut|tr|sort|find|ls|git|curl|read)\b|\$\(|`/.test(text)) return true;
  const printed = text.match(/\b(echo|printf)\b[^;&|>\n)}]*/g) || [];
  return printed.some((p) => p.includes("$"));
}

function valPrints(text, literal) {
  const esc = escapeRegExp(literal);
  return new RegExp("(^|[^A-Za-z0-9_-])" + esc + "($|[^A-Za-z0-9_-])").test(text);
}

function valOutputFieldDeclared(node, field) {
  const fmt = node.output_format;
  if (!isPlainObject(fmt)) return false;
  const props = isPlainObject(fmt.properties) ? fmt.properties : null;
  return !!props && Object.prototype.hasOwnProperty.call(props, field.split(".")[0]);
}

// validateWorkflow(wf) -> [{severity, key, rule, message}]
function validateWorkflow(wf) {
  const issues = [];
  const add = (severity, key, rule, message) => issues.push({ severity, key: key || null, rule, message });
  const all = flattenNodes(wf);
  const byKey = new Map(all.map((e) => [e.key, e]));

  if (valBlank(wf.name)) add("error", null, "workflow-name", "The workflow needs a name.");
  if (valBlank(wf.description)) add("error", null, "workflow-description", "The workflow needs a description.");
  if (!Array.isArray(wf.nodes)) {
    add("error", null, "workflow-nodes", "The workflow needs a nodes list.");
    return issues;
  }
  const wfKnown = new Set(VAL_SCHEMA.workflowFields.map((f) => f.name).concat(["container", "webSearchMode", "modelReasoningEffort"]));
  for (const k of Object.keys(wf)) {
    if (!wfKnown.has(k)) add("warning", null, "unknown-key", "Unknown workflow key '" + k + "'. The engine only logs a warning, so a misspelled key passes validation.");
  }
  const declaredInputs = new Set(isPlainObject(wf.inputs) ? Object.keys(wf.inputs) : []);
  if (wf.inputs !== undefined && !isPlainObject(wf.inputs)) add("error", null, "workflow-inputs", "inputs must map each name to { required, default, description }.");
  if (isPlainObject(wf.inputs)) {
    for (const [name, spec] of Object.entries(wf.inputs)) {
      if (!isPlainObject(spec)) add("error", null, "workflow-inputs", "Input '" + name + "' must be an object.");
      else for (const k of Object.keys(spec)) if (!["required", "default", "description"].includes(k)) add("warning", null, "unknown-key", "Unknown key '" + k + "' on input '" + name + "'.");
    }
  }

  const ctx = { wf, add, all, byKey, declaredInputs };
  validateList(ctx, wf.nodes, null, null);
  validatePauses(ctx);
  return issues;
}

function validateList(ctx, list, parentKey, loopEntry) {
  const { add } = ctx;
  const seen = new Set();
  for (const node of list) {
    if (!isPlainObject(node)) {
      add("error", parentKey, "node-shape", "A node must be a mapping.");
      continue;
    }
    const key = nodeKey(parentKey, node.id);
    if (typeof node.id === "string" && node.id.trim() !== "") {
      if (seen.has(node.id)) add("error", key, "duplicate-id", "The id '" + node.id + "' is used more than once in this " + (parentKey ? "loop body." : "workflow."));
      seen.add(node.id);
    }
  }
  const ids = new Set(list.filter(isPlainObject).map((n) => n.id));
  const outer = new Set();
  for (let up = parentKey; up; ) {
    const e = ctx.byKey.get(up);
    if (!e) break;
    for (const n of e.list) if (isPlainObject(n) && n !== e.node) outer.add(n.id);
    up = e.parentKey;
  }
  for (const node of list) {
    if (!isPlainObject(node)) continue;
    const key = nodeKey(parentKey, node.id);
    if (outer.has(node.id)) add("error", key, "shadowed-id", "Node id '" + node.id + "' shadows a node id in the enclosing graph.");
    for (const d of Array.isArray(node.depends_on) ? node.depends_on : []) {
      if (d === node.id) add("error", key, "cycle", "The node depends on itself.");
      else if (!ids.has(d)) add("error", key, "missing-dependency", "depends_on names '" + d + "', which is not a node in this " + (parentKey ? "loop body." : "workflow."));
    }
    if (node.depends_on !== undefined && !Array.isArray(node.depends_on)) add("error", key, "depends-on-shape", "depends_on must be a list of node ids.");
    validateNode(ctx, node, key, list, parentKey, loopEntry);
  }
  const topo = topoOrder(list.filter(isPlainObject));
  if (topo.cycle) {
    const first = topo.cycle[0];
    add("error", nodeKey(parentKey, first), "cycle", "These nodes depend on each other in a cycle: " + topo.cycle.join(", ") + ".");
  }
  if (parentKey) validateBodyPause(ctx, list, parentKey);
}

function validateBodyPause(ctx, list, loopKey) {
  const pauses = list.filter((n) => isPlainObject(n) && isPauseNode(n));
  if (!pauses.length) return;
  const dependents = new Map(list.map((n) => [n.id, 0]));
  for (const n of list) for (const d of Array.isArray(n.depends_on) ? n.depends_on : []) if (dependents.has(d)) dependents.set(d, dependents.get(d) + 1);
  const sinks = list.filter((n) => dependents.get(n.id) === 0);
  for (const p of pauses) {
    const key = nodeKey(loopKey, p.id);
    if (dependents.get(p.id) > 0) {
      ctx.add("error", key, "pause-not-last", "A pause in a loop body must be the body's last node, but other nodes depend on '" + p.id + "'.");
    } else if (sinks.length > 1) {
      const others = sinks.filter((s) => s !== p).map((s) => s.id);
      ctx.add("error", key, "pause-not-last", "A pause in a loop body must be the body's only terminal node, but " + others.join(", ") + " also end the body.");
    }
  }
}

function validatePauses(ctx) {
  const pauses = ctx.all.filter((e) => isPauseNode(e.node));
  const pathOf = (entry) => {
    const path = [];
    let cur = entry;
    while (cur) {
      path.unshift(cur);
      cur = cur.parentKey ? ctx.byKey.get(cur.parentKey) : null;
    }
    return path;
  };
  for (let i = 0; i < pauses.length; i++) {
    for (let j = i + 1; j < pauses.length; j++) {
      const a = pathOf(pauses[i]);
      const b = pathOf(pauses[j]);
      let d = 0;
      while (d < a.length && d < b.length && a[d].key === b[d].key) d++;
      if (d >= a.length || d >= b.length) continue;
      const list = a[d].list;
      if (list !== b[d].list) continue;
      const aAnc = ancestorIds(list, a[d].id);
      const bAnc = ancestorIds(list, b[d].id);
      if (!aAnc.has(b[d].id) && !bAnc.has(a[d].id)) {
        ctx.add("error", pauses[j].key, "concurrent-pauses", "The pauses '" + pauses[i].key + "' and '" + pauses[j].key + "' can run at the same time.");
      }
    }
  }
}

function validateNode(ctx, node, key, list, parentKey, loopEntry) {
  const { add } = ctx;
  const inLoop = !!parentKey;
  if (valBlank(node.id)) add("error", key, "missing-id", "The node has no id.");
  else if (node.id === "INPUTS") add("error", key, "reserved-id", "The id 'INPUTS' is reserved for $INPUTS.<name>.");
  else if (/\s/.test(node.id) || /[.$'"]/.test(node.id)) add("warning", key, "id-shape", "The id '" + node.id + "' has characters that break $id.output references; use letters, digits and underscores.");

  const typeKeys = typeKeysOf(node);
  if (typeKeys.length > 1) {
    add("error", key, "type-keys", "'" + typeKeys.join("', '") + "' are mutually exclusive: a node has exactly one type key.");
    return;
  }
  const type = nodeType(node);
  if (!type) {
    add("error", key, "type-keys", "The node has no type key. Use one of " + NODE_TYPE_KEYS.join(", ") + ".");
    return;
  }
  if (typeKeys.length === 0) {
    add("error", key, "type-value", "'" + type + "' cannot be empty.");
    return;
  }

  validateFieldSupport(ctx, node, key, type);
  validateCommon(ctx, node, key, type, inLoop);
  validateByType(ctx, node, key, type, inLoop, list, parentKey);
  validateRefs(ctx, node, key, type, list, parentKey, loopEntry);
}

function validateFieldSupport(ctx, node, key, type) {
  const { add } = ctx;
  const typeFieldSets = VAL_SCHEMA.typeFieldSets;
  const anyType = new Set(Object.values(typeFieldSets).flat());
  for (const k of Object.keys(node)) {
    if (NODE_TYPE_KEYS.includes(k)) continue;
    if (VAL_LOOP_FIELDS.includes(k) && !typeFieldSets[type].includes(k)) {
      add("error", key, "loop-field-misplaced", "'" + k + "' is only honoured inside 'loop:' or 'loop_group:'; at the top level nothing reads it.");
    } else if (anyType.has(k) && !typeFieldSets[type].includes(k)) {
      const owners = Object.keys(typeFieldSets).filter((t) => typeFieldSets[t].includes(k));
      const hint = k === "timeout" && NODE_AI_TYPES.includes(type) ? " Use idle_timeout for an AI node." : "";
      add("error", key, "field-not-supported", "'" + k + "' is only supported on " + owners.join(", ") + " nodes, not on " + type + " nodes." + hint);
    } else if (!VAL_COMMON.has(k) && !anyType.has(k) && !VAL_LOOP_FIELDS.includes(k)) {
      add("warning", key, "unknown-key", "Unknown key '" + k + "'. The engine only logs a warning, so a misspelled key passes validation.");
    }
  }
}

function validateCommon(ctx, node, key, type, inLoop) {
  const { add } = ctx;
  const honors = VAL_SCHEMA.honors[type];
  const errors = VAL_SCHEMA.fieldErrors[type] || [];
  const graph = new Set(VAL_SCHEMA.graphFields);
  for (const k of Object.keys(node)) {
    if (!VAL_COMMON.has(k) || graph.has(k)) continue;
    // The engine checks mutates_checkout on an include node at the top level only; in a loop body it is accepted.
    if (type === "include" && k === "mutates_checkout" && inLoop) add("warning", key, "ignored-field", "'mutates_checkout' is ignored on include nodes (the engine rejects it only outside a loop body).");
    else if (errors.includes(k)) {
      add("error", key, "field-not-allowed", "'" + k + "' is not supported on " + type + " nodes" + (type === "wait" && k === "retry" ? "; the persisted condition governs continuation" : "") + ".");
    } else if (honors !== "all" && !honors.includes(k)) {
      add("warning", key, "ignored-field", "'" + k + "' is ignored on " + type + " nodes.");
    }
  }
  if (node.trigger_rule !== undefined && !VAL_SCHEMA.triggerRules.some((r) => r.name === node.trigger_rule)) {
    add("error", key, "trigger-rule", "trigger_rule must be one of " + VAL_SCHEMA.triggerRules.map((r) => r.name).join(", ") + ".");
  }
  if (node.effort !== undefined && !VAL_EFFORTS.includes(node.effort)) add("error", key, "effort", "effort must be one of " + VAL_EFFORTS.join(", ") + ".");
  if (node.maxBudgetUsd !== undefined && !valIsPositive(node.maxBudgetUsd)) add("error", key, "maxBudgetUsd", "maxBudgetUsd must be a positive number.");
  if (node.idle_timeout !== undefined && !valIsPositive(node.idle_timeout)) add("error", key, "idle-timeout", "idle_timeout must be a finite positive number (ms).");
  if (Array.isArray(node.model) && node.model.length < 2) add("error", key, "model", "A model list needs at least two entries.");
  if (node.context !== undefined) {
    const c = node.context;
    if (isPlainObject(c)) {
      if (valBlank(c.resume)) add("error", key, "context", "'context.resume' must name a node.");
      else if (type !== "prompt" && type !== "command") add("error", key, "context", "'context.resume' is only supported on command and prompt nodes.");
    } else if (c !== "fresh" && c !== "shared") add("error", key, "context", "context must be fresh, shared or { resume: <node id> }.");
  }
  if (node.retry !== undefined && !errors.includes("retry") && isPlainObject(node.retry)) {
    const r = node.retry;
    if (r.max_attempts !== undefined && !(Number.isInteger(r.max_attempts) && r.max_attempts >= 1 && r.max_attempts <= 5)) add("error", key, "retry", "retry.max_attempts must be an integer from 1 to 5.");
    if (r.delay_ms !== undefined && !(typeof r.delay_ms === "number" && r.delay_ms >= 1000 && r.delay_ms <= 60000)) add("error", key, "retry", "retry.delay_ms must be from 1000 to 60000.");
    for (const k of Object.keys(r)) if (!VAL_RETRY_KEYS.includes(k)) add("warning", key, "unknown-key", "Unknown key 'retry." + k + "'.");
  } else if (node.retry !== undefined && !errors.includes("retry") && !isPlainObject(node.retry)) {
    add("error", key, "retry", "retry must be an object.");
  }
  if (isPlainObject(node.agents)) {
    if (!Object.keys(node.agents).length) add("error", key, "agents", "'agents' must have at least one entry.");
    for (const id of Object.keys(node.agents)) if (!VAL_KEBAB.test(id)) add("error", key, "agents", "agent IDs must be kebab-case (a-z, 0-9, hyphen): '" + id + "'.");
  }
  for (const k of ["allowed_tools", "denied_tools", "skills", "plugins"]) {
    if (node[k] !== undefined && !(Array.isArray(node[k]) && node[k].every((x) => typeof x === "string"))) add("error", key, k, k + " must be a list of strings.");
  }
  for (const k of ["always_run", "mutates_checkout", "persist_session"]) {
    if (node[k] !== undefined && typeof node[k] !== "boolean") add("error", key, k, k + " must be true or false.");
  }
}

function validateByType(ctx, node, key, type, inLoop, list, parentKey) {
  const { add } = ctx;
  switch (type) {
    case "prompt":
      if (valBlank(node.prompt)) add("error", key, "prompt", "prompt cannot be empty.");
      break;
    case "command": {
      const name = typeof node.command === "string" ? node.command.trim() : "";
      if (!name || name.includes("/") || name.includes("\\") || name.includes("..") || name.startsWith(".")) {
        add("error", key, "command", 'invalid command name "' + (node.command || "") + '": it must not contain path separators or \'..\', or start with \'.\'.');
      }
      validateWithBindings(ctx, node, key, "command");
      break;
    }
    case "bash":
      if (valBlank(node.bash)) add("error", key, "bash", "bash script cannot be empty.");
      validateTimeout(ctx, node, key);
      break;
    case "script":
      if (valBlank(node.script)) add("error", key, "script", "script cannot be empty.");
      if (node.runtime !== "bun" && node.runtime !== "uv") add("error", key, "runtime", "'runtime' is required for script nodes ('bun' or 'uv').");
      if (node.deps !== undefined && !(Array.isArray(node.deps) && node.deps.every((d) => typeof d === "string" && d))) add("error", key, "deps", "each dep must be a non-empty string.");
      validateTimeout(ctx, node, key);
      validateWithBindings(ctx, node, key, "script");
      break;
    case "loop":
      validateLoop(ctx, node, key);
      validateTimeout(ctx, node, key, true);
      break;
    case "loop_group":
      validateGroup(ctx, node, key, inLoop);
      validateTimeout(ctx, node, key, true);
      break;
    case "approval":
      validateApproval(ctx, node, key);
      break;
    case "wait":
      validateWait(ctx, node, key);
      break;
    case "cancel":
      if (valBlank(node.cancel)) add("error", key, "cancel", "cancel needs a reason.");
      break;
    case "include":
      if (valBlank(node.include)) add("error", key, "include", "'include' must be a non-empty workflow name.");
      if (node.with !== undefined) validateWithBindings(ctx, node, key, "include");
      validateFanOut(ctx, node, key, true);
      break;
    case "workflow":
      if (valBlank(node.workflow)) add("error", key, "workflow", "'workflow' must be a non-empty workflow name.");
      if (node.with !== undefined && node.input !== undefined) add("error", key, "workflow-input", "'with:' and 'input:' cannot both be set on a workflow node.");
      if (node.with !== undefined) validateWithBindings(ctx, node, key, "workflow");
      if (inLoop) add("error", key, "workflow-in-loop", "A workflow node is not allowed inside a loop body.");
      validateFanOut(ctx, node, key, false);
      break;
  }
}

function validateTimeout(ctx, node, key, loopLike) {
  if (node.timeout !== undefined && !valIsPositive(node.timeout)) ctx.add("error", key, "timeout", "'timeout' must be a positive number (ms).");
  if (node.on_timeout !== undefined && node.on_timeout !== "skip") ctx.add("error", key, "on-timeout", "on_timeout can only be 'skip'.");
}

function validateWithBindings(ctx, node, key, type) {
  const w = node.with;
  if (w === undefined) return;
  if (!isPlainObject(w)) {
    ctx.add("error", key, "with", "'with' on " + type + " nodes must be an object mapping input names to values.");
    return;
  }
  const envNames = new Map();
  for (const [name, v] of Object.entries(w)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) ctx.add("error", key, "with", "invalid " + type + " input name '" + name + "'; use letters, numbers, underscores or hyphens and start with a letter or underscore.");
    const env = "INPUTS_" + name.replace(/-/g, "_").toUpperCase();
    if (envNames.has(env)) ctx.add("error", key, "with", type + " bindings '" + envNames.get(env) + "' and '" + name + "' both map to env var '" + env + "'.");
    envNames.set(env, name);
    if (isPlainObject(v)) {
      if (typeof v.from !== "string" || !v.from.trim()) ctx.add("error", key, "with", type + " binding '" + name + "': 'from' must be a $node.output reference.");
      else if (!/^\$[A-Za-z_][A-Za-z0-9_-]*\.output(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(v.from.trim())) ctx.add("error", key, "with", type + " binding '" + name + "': 'from' must be exactly one whole '$node.output[.a.b]' reference, got '" + v.from + "'.");
    }
  }
}

function validateFanOut(ctx, node, key, isInclude) {
  const f = node.fan_out;
  if (f === undefined) return;
  if (!isPlainObject(f)) {
    ctx.add("error", key, "fan-out", "fan_out must be an object { items, as, max_parallel, join }.");
    return;
  }
  if (valBlank(f.items)) ctx.add("error", key, "fan-out", "'fan_out.items' must reference a node output that produces a JSON array.");
  if (f.join === "first_success") ctx.add("error", key, "fan-out", "'fan_out.join: first_success' (racing) is rejected; use 'all_done'.");
  if (isInclude && valBlank(f.as)) ctx.add("error", key, "fan-out", "'fan_out.as' is required on an include node.");
  if (!valBlank(f.as) && isPlainObject(node.with) && Object.prototype.hasOwnProperty.call(node.with, f.as)) ctx.add("error", key, "fan-out", "'fan_out.as: " + f.as + "' collides with a 'with:' key of the same name.");
}

function validateLoop(ctx, node, key) {
  const { add } = ctx;
  const l = node.loop;
  if (!isPlainObject(l)) {
    add("error", key, "loop", "loop must be an object { prompt or command, max_iterations, until... }.");
    return;
  }
  for (const k of Object.keys(l)) if (!VAL_LOOP_KEYS.includes(k)) add("warning", key, "unknown-key", "Unknown key 'loop." + k + "'.");
  if (!valIsPositiveInt(l.max_iterations)) add("error", key, "loop", "'loop.max_iterations' must be a positive integer.");
  const hasPrompt = typeof l.prompt === "string" && l.prompt.length > 0;
  const hasCommand = typeof l.command === "string" && l.command.trim().length > 0;
  if (hasPrompt && hasCommand) add("error", key, "loop", "loop node accepts exactly one of 'loop.prompt' or 'loop.command' (both were provided).");
  else if (!hasPrompt && !hasCommand) add("error", key, "loop", "loop node requires either 'loop.prompt' (inline) or 'loop.command' (file).");
  const channels = ["until", "until_bash", "until_field"].filter((f) => l[f] !== undefined);
  if (!channels.length) add("error", key, "loop", "loop node requires a completion channel: set 'loop.until', 'loop.until_bash' or 'loop.until_field'.");
  for (const f of ["until", "until_bash"]) if (l[f] !== undefined && valBlank(l[f])) add("error", key, "loop", "'loop." + f + "' must be non-blank.");
  if (l.interactive === true && !l.gate_message) add("error", key, "loop", "interactive loop requires 'loop.gate_message'.");
  if (l.until_field !== undefined) {
    const field = String(l.until_field).trim();
    const fmt = node.output_format;
    if (!isPlainObject(fmt)) {
      add("error", key, "until-field", "'loop.until_field' names '" + field + "' but this node declares no 'output_format'.");
    } else {
      const prop = isPlainObject(fmt.properties) ? fmt.properties[field] : undefined;
      if (prop === undefined) add("error", key, "until-field", "'loop.until_field' names '" + field + "', which is not declared in this node's output_format properties.");
      else {
        if (!(Array.isArray(fmt.required) && fmt.required.includes(field))) add("error", key, "until-field", "'loop.until_field' names '" + field + "', which must also be listed in output_format.required.");
        if (!isPlainObject(prop) || prop.type !== "boolean") add("error", key, "until-field", "'loop.until_field' names '" + field + "', which must be of type boolean.");
      }
    }
  }
}

function validateGroup(ctx, node, key, inLoop) {
  const { add } = ctx;
  const g = node.loop_group;
  if (!isPlainObject(g)) {
    add("error", key, "loop-group", "loop_group must be an object { nodes, max_iterations, until_bash }.");
    return;
  }
  for (const k of Object.keys(g)) {
    if (k === "until_field") add("warning", key, "unknown-key", "'loop_group.until_field' is ignored: a loop_group ends on until or until_bash.");
    else if (!VAL_GROUP_KEYS.includes(k)) add("warning", key, "unknown-key", "Unknown key 'loop_group." + k + "'.");
  }
  if (!valIsPositiveInt(g.max_iterations)) add("error", key, "loop-group", "'loop_group.max_iterations' must be a positive integer.");
  if (!Array.isArray(g.nodes) || !g.nodes.length) add("error", key, "loop-group", "'loop_group.nodes' must have at least one node.");
  else validateList(ctx, g.nodes, key, { node, key });
  const channels = ["until", "until_bash"].filter((f) => g[f] !== undefined);
  if (!channels.length) add("error", key, "loop-group", "loop_group requires a completion channel: set 'loop_group.until' or 'loop_group.until_bash'.");
  for (const f of channels) if (valBlank(g[f])) add("error", key, "loop-group", "'loop_group." + f + "' must be non-blank.");
}

function validateApproval(ctx, node, key) {
  const { add } = ctx;
  const a = node.approval;
  add("warning", key, "deprecated-approval", "The approval node type is deprecated; a wait node with form: approval or select replaces it.");
  if (!isPlainObject(a)) {
    add("error", key, "approval", "approval must be an object { message, decisions or on_reject }.");
    return;
  }
  for (const k of Object.keys(a)) if (!VAL_APPROVAL_KEYS.includes(k)) add("warning", key, "unknown-key", "Unknown key 'approval." + k + "'.");
  if (valBlank(a.message)) add("error", key, "approval", "'approval.message' must not be empty.");
  if (a.decisions !== undefined && a.on_reject !== undefined) add("error", key, "approval", "'approval.decisions' and 'approval.on_reject' are mutually exclusive.");
  if (Array.isArray(a.decisions)) {
    const ids = a.decisions.map((d) => (isPlainObject(d) ? d.id : undefined));
    if (!ids.length) add("error", key, "approval", "'approval.decisions' must declare at least one decision.");
    if (new Set(ids).size !== ids.length) add("error", key, "approval", "'approval.decisions' ids must be unique.");
    for (const id of ids) if (typeof id !== "string" || !VAL_KEBAB.test(id)) add("error", key, "approval", "'approval.decisions[].id' must be kebab-case.");
  }
}

function waitShapeOf(w) {
  return VAL_SCHEMA.waitShapes.filter((s) => s.keys.some((k) => w[k] !== undefined)).map((s) => s.name);
}

function validateWait(ctx, node, key) {
  const { add } = ctx;
  const w = node.wait;
  if (!isPlainObject(w)) {
    add("error", key, "wait", "wait must be an object: { duration_ms }, { until }, { event, deadline_ms } or { attention, form, options }.");
    return;
  }
  const shapes = waitShapeOf(w);
  if (shapes.length !== 1) {
    add("error", key, "wait-shape", shapes.length ? "wait mixes " + shapes.join(" and ") + " keys; use exactly one shape." : "wait needs one of duration_ms, until, event, or attention.");
    return;
  }
  const known = new Set(VAL_SCHEMA.waitShapes.flatMap((s) => s.keys));
  for (const k of Object.keys(w)) if (!known.has(k)) add("warning", key, "unknown-key", "Unknown key 'wait." + k + "'.");
  if (shapes[0] === "duration" && !valIsPositiveInt(w.duration_ms)) add("error", key, "wait", "'wait.duration_ms' must be a positive integer.");
  if (shapes[0] === "until") {
    if (valBlank(w.until)) add("error", key, "wait", "'wait.until' must not be empty.");
    else if (!/\$[A-Za-z_]/.test(w.until) && Number.isNaN(Date.parse(w.until))) add("error", key, "wait", "'wait.until' must be an ISO-8601 timestamp or contain a runtime reference.");
  }
  if (shapes[0] === "event") {
    if (valBlank(w.event)) add("error", key, "wait", "'wait.event' must not be empty.");
    if (!valIsPositiveInt(w.deadline_ms)) add("error", key, "wait", "'wait.deadline_ms' must be a positive integer.");
  }
  if (shapes[0] === "attention") {
    if (valBlank(w.attention)) add("error", key, "wait", "'wait.attention' must not be empty.");
    const form = w.form === undefined ? "message" : w.form;
    if (!VAL_SCHEMA.waitForms[form]) add("error", key, "wait", "wait.form must be message, approval, select or multi_select.");
    else {
      const needs = form === "select" || form === "multi_select";
      if (needs && w.options === undefined) add("error", key, "wait", "'wait.options' is required for form '" + form + "'.");
      if (!needs && w.options !== undefined) add("error", key, "wait", "'wait.options' is only valid for forms 'select' and 'multi_select', not '" + form + "'.");
      if (Array.isArray(w.options)) {
        const ids = w.options.map((o) => (isPlainObject(o) ? o.id : undefined));
        if (!ids.length) add("error", key, "wait", "'wait.options' must declare at least one option.");
        if (new Set(ids).size !== ids.length) add("error", key, "wait", "'wait.options' declares an id more than once.");
        for (const id of ids) if (typeof id !== "string" || !VAL_KEBAB.test(id)) add("error", key, "wait", "option id '" + id + "' must be kebab-case (lowercase letters, digits, single hyphens).");
      } else if (typeof w.options === "string" && !/^\s*\$[A-Za-z_][A-Za-z0-9_-]*\.output\.[A-Za-z_]/.test(w.options)) {
        add("error", key, "wait", "'wait.options' must be a list of options or one whole '$node.output.<field>' reference.");
      }
    }
  }
}

// ---- references and conditions ----

function producerScopeOk(ctx, id, key, list, parentKey, loopEntry) {
  // Returns "ok", "unknown" or "not-ancestor": whether `id` is a node this one can read.
  const ancestors = ancestorIds(list, key.split(".").pop());
  if (list.some((n) => n.id === id)) return ancestors.has(id) ? "ok" : "not-ancestor";
  if (loopEntry) {
    const outerEntry = ctx.byKey.get(loopEntry.key);
    return producerScopeOk(ctx, id, loopEntry.key, outerEntry.list, outerEntry.parentKey, outerEntry.parentKey ? { key: outerEntry.parentKey } : null);
  }
  return ctx.all.some((e) => e.id === id) ? "not-ancestor" : "unknown";
}

function validateRefs(ctx, node, key, type, list, parentKey, loopEntry) {
  const { add } = ctx;
  const inLoop = !!parentKey;
  const refs = collectRefs(node);
  const seenMsg = new Set();
  const once = (severity, rule, msg) => {
    const k = severity + rule + msg;
    if (!seenMsg.has(k)) {
      seenMsg.add(k);
      add(severity, key, rule, msg);
    }
  };
  for (const r of refs.nodes) {
    if (r.loopPrev) {
      if (!inLoop) once(r.via === "when" ? "error" : "risk", "loop-prev", "$LOOP_PREV." + r.id + " is valid only inside a loop body.");
      else if (!list.some((n) => n.id === r.id)) once("risk", "loop-prev", "$LOOP_PREV." + r.id + " names a node that is not in this loop body, so it has no previous-round output.");
      continue;
    }
    if (r.path === "loop_group.until_bash" && inLoopBody(node, r.id)) continue;
    if (r.id === node.id) {
      once("error", "self-reference", "The node reads its own output ($" + r.id + ".output).");
      continue;
    }
    const where = producerScopeOk(ctx, r.id, key, list, parentKey, loopEntry);
    const at = r.via === "when" ? "The condition" : "'" + r.path + "'";
    if (where === "unknown") once("error", "unknown-reference", at + " reads $" + r.id + ".output, but there is no node '" + r.id + "'.");
    else if (where === "not-ancestor") once("risk", "reference-not-dependency", at + " reads $" + r.id + ".output, but '" + r.id + "' is not among this node's dependencies, so it can fail at run time.");
  }
  for (const i of refs.inputs) {
    if (!ctx.declaredInputs.has(i.name)) once("risk", "undeclared-input", "'" + i.path + "' reads $INPUTS." + i.name + ", which the workflow does not declare under inputs.");
  }
  if (typeof node.when === "string") validateWhen(ctx, node, key, list, parentKey, loopEntry, once);
}

function inLoopBody(loopNode, id) {
  const body = bodyOf(loopNode);
  return !!body && body.some((n) => n.id === id);
}

function findProducer(ctx, id, list, loopEntry) {
  let found = list.find((n) => n.id === id);
  let entry = loopEntry;
  while (!found && entry) {
    const outer = ctx.byKey.get(entry.key);
    found = outer.list.find((n) => n.id === id);
    entry = outer.parentKey ? { key: outer.parentKey } : null;
  }
  return found || (ctx.all.find((e) => e.id === id) || {}).node;
}

function validateWhen(ctx, node, key, list, parentKey, loopEntry, once) {
  const parsed = parseWhen(node.when, { loopBody: !!parentKey });
  if (!parsed.ok) {
    once("error", "when-syntax", "The condition does not parse: " + parsed.error + (parsed.atomText ? " (in `" + parsed.atomText + "`)" : "") + ".");
    return;
  }
  for (const atom of whenAtoms(parsed)) {
    const ref = atom.ref;
    if (ref.kind === "input") continue;
    const producer = findProducer(ctx, ref.id, list, loopEntry);
    if (!producer) continue;
    const ptype = nodeType(producer);
    if (NODE_AI_TYPES.includes(ptype)) {
      const declared = isPlainObject(producer.output_format);
      if (!ref.field && !declared) once("error", "when-ai-output", "The condition compares the whole output of the AI node '" + ref.id + "' to a literal. That output is free-form prose, so the comparison silently fails. Declare output_format on '" + ref.id + "' and compare a field.");
      else if (ref.field && declared && !valOutputFieldDeclared(producer, ref.field)) once("error", "when-ai-output", "The condition reads '" + ref.id + "." + ref.field + "', which is not declared in the output_format of '" + ref.id + "'.");
      else if (ref.field && !declared) once("risk", "when-field-undeclared", "The condition reads '" + ref.id + "." + ref.field + "', but '" + ref.id + "' declares no output_format, so its output is free-form prose.");
    }
    if (ptype === "bash" && !ref.field && atom.op === "==" && typeof producer.bash === "string" && !valBashIsOpaque(producer.bash)) {
      if (!valPrints(producer.bash, atom.expected)) {
        once("risk", "when-literal-not-printed", "The condition compares $" + ref.id + ".output to '" + atom.expected + "', but the script of '" + ref.id + "' never prints that text.");
      }
    }
  }
}

if (typeof require !== "undefined") {
  var { NODE_TYPE_KEYS, NODE_AI_TYPES, flattenNodes, nodeKey, nodeType, typeKeysOf, isPauseNode, isPlainObject, bodyOf, ancestorIds, topoOrder, collectRefs, escapeRegExp } = require("./model.js");
  var { parseWhen, whenAtoms } = require("./when.js");
}
if (typeof module !== "undefined") module.exports = { validateWorkflow, valBashIsOpaque };
