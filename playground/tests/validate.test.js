const test = require("node:test");
const assert = require("node:assert");
const { validateWorkflow } = require("../src/validate.js");
const { loadDump, wf } = require("./load.js");

const b = (id, extra) => Object.assign({ id, bash: "echo " + id }, extra || {});
const p = (id, extra) => Object.assign({ id, prompt: "do " + id }, extra || {});
const group = (id, nodes, extra) => ({ id, loop_group: Object.assign({ nodes, max_iterations: 3, until_bash: "true" }, extra || {}) });
const pause = (id, extra) => Object.assign({ id, wait: { attention: "ok?", form: "approval" } }, extra || {});
const rulesOf = (w) => validateWorkflow(w).map((i) => i.severity + ":" + i.rule);

// [rule, severity, failing workflow, passing workflow]
const CASES = [
  ["type-keys", "error", wf([{ id: "a" }]), wf([b("a")])],
  ["type-keys", "error", wf([{ id: "a", bash: "x", prompt: "y" }]), wf([b("a")])],
  ["missing-id", "error", wf([{ bash: "x" }]), wf([b("a")])],
  ["reserved-id", "error", wf([b("INPUTS")]), wf([b("a")])],
  ["duplicate-id", "error", wf([b("a"), b("a")]), wf([b("a"), b("c")])],
  ["missing-dependency", "error", wf([b("a", { depends_on: ["zz"] })]), wf([b("z"), b("a", { depends_on: ["z"] })])],
  ["cycle", "error", wf([b("a", { depends_on: ["c"] }), b("c", { depends_on: ["a"] })]), wf([b("a"), b("c", { depends_on: ["a"] })])],
  ["when-syntax", "error", wf([b("a"), b("c", { depends_on: ["a"], when: "($a.output == 'x')" })]), wf([b("a"), b("c", { depends_on: ["a"], when: "$a.output == 'x'" })])],
  ["when-ai-output", "error", wf([p("a"), b("c", { depends_on: ["a"], when: "$a.output == 'x'" })]), wf([p("a", { output_format: { type: "object", properties: { f: { type: "string" } } } }), b("c", { depends_on: ["a"], when: "$a.output.f == 'x'" })])],
  ["field-not-supported", "error", wf([p("a", { timeout: 5 })]), wf([p("a", { idle_timeout: 5 })])],
  ["field-not-supported", "error", wf([b("a", { with: { x: "1" } })]), wf([b("a")])],
  ["loop-field-misplaced", "error", wf([b("a", { max_iterations: 3 })]), wf([b("a")])],
  ["field-not-allowed", "error", wf([group("g", [b("a")], {}), Object.assign(group("h", [b("a2")]), { retry: { max_attempts: 2 } })]), wf([group("g", [b("a")])])],
  ["field-not-allowed", "error", wf([pause("w", { retry: { max_attempts: 2 } })]), wf([pause("w")])],
  ["field-not-allowed", "error", wf([{ id: "i", include: "x", mutates_checkout: false }]), wf([{ id: "i", include: "x" }])],
  ["unknown-key", "warning", wf([group("g", [b("a")], { until_field: "done" })]), wf([group("g", [b("a")])])],
  ["loop-group", "error", wf([group("g", [])]), wf([group("g", [b("a")])])],
  ["loop", "error", wf([{ id: "l", loop: { prompt: "x", max_iterations: 2 } }]), wf([{ id: "l", loop: { prompt: "x", max_iterations: 2, until_bash: "true" } }])],
  ["until-field", "error", wf([{ id: "l", loop: { prompt: "x", max_iterations: 2, until_field: "done" } }]), wf([{ id: "l", output_format: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] }, loop: { prompt: "x", max_iterations: 2, until_field: "done" } }])],
  ["wait-shape", "error", wf([{ id: "w", wait: { duration_ms: 5, attention: "x" } }]), wf([{ id: "w", wait: { duration_ms: 5 } }])],
  ["wait", "error", wf([{ id: "w", wait: { attention: "x", form: "select" } }]), wf([{ id: "w", wait: { attention: "x", form: "select", options: [{ id: "go" }] } }])],
  ["wait", "error", wf([{ id: "w", wait: { attention: "x", form: "select", options: [{ id: "Go On" }] } }]), wf([{ id: "w", wait: { attention: "x", form: "select", options: [{ id: "go-on" }] } }])],
  ["pause-not-last", "error", wf([group("g", [pause("w"), b("after", { depends_on: ["w"] })])]), wf([group("g", [b("before"), pause("w", { depends_on: ["before"] })])])],
  ["concurrent-pauses", "error", wf([pause("w1"), pause("w2")]), wf([pause("w1"), pause("w2", { depends_on: ["w1"] })])],
  ["workflow-in-loop", "error", wf([group("g", [{ id: "c", workflow: "other" }])]), wf([{ id: "c", workflow: "other" }])],
  ["workflow-input", "error", wf([{ id: "c", workflow: "o", input: "x", with: { a: "1" } }]), wf([{ id: "c", workflow: "o", input: "x" }])],
  ["runtime", "error", wf([{ id: "s", script: "x" }]), wf([{ id: "s", script: "x", runtime: "uv" }])],
  ["unknown-reference", "error", wf([b("a", { bash: "echo $zz.output" })]), wf([b("z"), b("a", { depends_on: ["z"], bash: "echo $z.output" })])],
  ["loop-prev", "risk", wf([b("a", { bash: "echo $LOOP_PREV.q.output" })]), wf([group("g", [b("q"), b("a", { depends_on: ["q"], bash: "echo $LOOP_PREV.q.output" })])])],
  ["loop-prev", "error", wf([b("a"), b("c", { depends_on: ["a"], when: "$LOOP_PREV.a.output == 'x'" })]), wf([group("g", [b("a"), b("c", { depends_on: ["a"], when: "$LOOP_PREV.a.output == 'x'" })])])],
  ["shadowed-id", "error", wf([b("a"), group("g", [b("a")])]), wf([b("a"), group("g", [b("z")])])],
  ["when-ai-output", "error", wf([p("a"), b("c", { depends_on: ["a"], when: "$a.output == 'x'" })]), wf([p("a", { output_format: { type: "object" } }), b("c", { depends_on: ["a"], when: "$a.output == 'x'" })])],
  ["when-ai-output", "error", wf([p("a", { output_format: { type: "object", properties: { f: { type: "string" } } } }), b("c", { depends_on: ["a"], when: "$a.output.zz == 'x'" })]), wf([p("a", { output_format: { type: "object", properties: { f: { type: "string" } } } }), b("c", { depends_on: ["a"], when: "$a.output.f == 'x'" })])],
  ["when-field-undeclared", "risk", wf([p("a"), b("c", { depends_on: ["a"], when: "$a.output.f == 'x'" })]), wf([p("a", { output_format: { type: "object", properties: { f: { type: "string" } } } }), b("c", { depends_on: ["a"], when: "$a.output.f == 'x'" })])],
  ["trigger-rule", "error", wf([b("a", { trigger_rule: "sometimes" })]), wf([b("a", { trigger_rule: "all_done" })])],
  ["ignored-field", "warning", wf([b("a", { model: "opus" })]), wf([p("a", { model: "opus" })])],
  ["unknown-key", "warning", wf([b("a", { dependz_on: ["x"] })]), wf([b("a")])],
  ["deprecated-approval", "warning", wf([{ id: "a", approval: { message: "ok?" } }]), wf([pause("a")])],
  ["reference-not-dependency", "risk", wf([b("a"), b("c", { bash: "echo $a.output" })]), wf([b("a"), b("c", { depends_on: ["a"], bash: "echo $a.output" })])],
  ["undeclared-input", "risk", wf([b("a", { bash: "echo $INPUTS.nope" })]), wf([b("a", { bash: "echo $INPUTS.base" })], { inputs: { base: { default: "main" } } })],
  ["when-literal-not-printed", "risk", wf([b("a", { bash: "echo idle" }), b("c", { depends_on: ["a"], when: "$a.output == 'pause'" })]), wf([b("a", { bash: "echo pause" }), b("c", { depends_on: ["a"], when: "$a.output == 'pause'" })])],
];

for (const [rule, sev, bad, good] of CASES) {
  test(rule + " (" + sev + "): fails and passes", () => {
    assert.ok(rulesOf(bad).includes(sev + ":" + rule), "expected " + sev + ":" + rule + " in " + JSON.stringify(rulesOf(bad)));
    assert.ok(!rulesOf(good).includes(sev + ":" + rule), "unexpected " + sev + ":" + rule + " in " + JSON.stringify(rulesOf(good)));
  });
}

test("a reference to a transitive dependency is accepted", () => {
  const w = wf([b("a"), b("m", { depends_on: ["a"] }), b("c", { depends_on: ["m"], bash: "echo $a.output" })]);
  assert.deepStrictEqual(validateWorkflow(w), []);
});

test("a pause in a loop body that is the body's only terminal node is accepted", () => {
  const w = wf([group("g", [b("r"), b("s", { depends_on: ["r"] }), pause("w", { depends_on: ["s"] })])]);
  assert.deepStrictEqual(validateWorkflow(w), []);
});

test("references to nodes outside a loop body are checked against the loop's own dependencies", () => {
  const ok = wf([b("cfg"), group("g", [b("a", { bash: "echo $cfg.output" })])].map((n, i) => (i === 1 ? Object.assign(n, { depends_on: ["cfg"] }) : n)));
  assert.ok(!rulesOf(ok).some((r) => r.endsWith("reference-not-dependency")));
  const bad = wf([b("cfg"), group("g", [b("a", { bash: "echo $cfg.output" })])]);
  assert.ok(rulesOf(bad).includes("risk:reference-not-dependency"));
});

test("a loop's own until_bash may read the body's outputs", () => {
  const w = wf([group("g", [b("a")], { until_bash: "test '$a.output' = done" })]);
  assert.ok(!rulesOf(w).some((r) => r.endsWith("reference-not-dependency") || r.endsWith("unknown-reference")));
});

test("a script called through ARCHON_HOME is opaque, so a literal it may print is not reported missing", () => {
  const call = (bash) => wf([b("a", { bash }), b("c", { depends_on: ["a"], when: "$a.output == 'rescue'" })]);
  for (const bash of ['python3 -I "${ARCHON_HOME:-$HOME/.archon}/scripts/route.py"', 'bash "$ARCHON_HOME/scripts/route.sh"', 'bash "${ARCHON_HOME}/scripts/route.sh"']) {
    assert.ok(!rulesOf(call(bash)).some((r) => r.endsWith("when-literal-not-printed")), bash);
  }
  assert.ok(rulesOf(call("echo idle")).some((r) => r.endsWith("when-literal-not-printed")), "a script that only echoes another word is still reported");
});

test("the real workflows have no errors, warnings or risks", () => {
  for (const w of loadDump().workflows) assert.deepStrictEqual(validateWorkflow(w.model), [], w.name);
});
