const test = require("node:test");
const assert = require("node:assert");
const { createSimulation, runSimulation, simTrigger, simDefaultAnswer, simPrintedWords } = require("../src/sim.js");
const { loadDump, wf } = require("./load.js");

const b = (id, extra) => Object.assign({ id, bash: "echo " + id }, extra || {});
const stateOf = (sim, key) => sim.state.nodes.get(key);
const run = (w, answers, options) => runSimulation(w, options || {}, (p) => (typeof answers === "function" ? answers(p) : simDefaultAnswer(p)));

test("trigger rules decide from dependency states", () => {
  const c = { state: "completed" };
  const f = { state: "failed" };
  const s = { state: "skipped", cause: { kind: "condition" } };
  const uf = { state: "skipped", cause: { kind: "upstream_failed" } };
  assert.strictEqual(simTrigger("all_success", [c, c]).run, true);
  assert.strictEqual(simTrigger("all_success", [c, s]).run, false);
  assert.strictEqual(simTrigger("all_success", [c, f]).cause.kind, "upstream_failed");
  assert.strictEqual(simTrigger("all_success", [c, s]).cause.kind, "trigger_rule");
  assert.strictEqual(simTrigger("one_success", [f, c]).run, true);
  assert.strictEqual(simTrigger("one_success", [f, s]).run, false);
  assert.strictEqual(simTrigger("all_done", [f, s]).run, true);
  assert.strictEqual(simTrigger("none_failed_min_one_success", [c, s]).run, true);
  assert.strictEqual(simTrigger("none_failed_min_one_success", [c, f]).run, false);
  assert.strictEqual(simTrigger("none_failed_min_one_success", [c, uf]).run, false);
  assert.strictEqual(simTrigger("none_failed_min_one_success", [s, s]).run, false);
  assert.strictEqual(simTrigger("none_failed_min_one_success", [s, s]).cause.kind, "trigger_rule");
});

test("a false condition skips with the cause 'condition' and the skip spreads under all_success", () => {
  const w = wf([b("a", { bash: "echo idle" }), b("c", { depends_on: ["a"], when: "$a.output == 'go'" }), b("d", { depends_on: ["c"] }), b("e", { depends_on: ["c"], trigger_rule: "all_done" })]);
  const sim = run(w, () => "idle");
  assert.strictEqual(stateOf(sim, "c").cause.kind, "condition");
  assert.strictEqual(stateOf(sim, "d").cause.kind, "trigger_rule");
  assert.strictEqual(stateOf(sim, "e").state, "completed");
  assert.strictEqual(sim.state.result.status, "completed");
});

test("a failed node makes its dependents skip with upstream_failed and the run fails", () => {
  const w = wf([b("a"), b("c", { depends_on: ["a"] }), b("d", { depends_on: ["a"], trigger_rule: "all_done" })]);
  const sim = run(w, null, { failKeys: new Set(["a"]) });
  assert.strictEqual(stateOf(sim, "a").state, "failed");
  assert.strictEqual(stateOf(sim, "c").cause.kind, "upstream_failed");
  assert.strictEqual(stateOf(sim, "d").state, "completed");
  assert.strictEqual(sim.state.result.status, "failed");
});

test("a timeout skips a node with on_timeout: skip and fails one without", () => {
  const w = wf([b("a", { timeout: 1000, on_timeout: "skip" }), b("c", { timeout: 1000 })]);
  const sim = run(w, null, { timeoutKeys: new Set(["a", "c"]) });
  assert.strictEqual(stateOf(sim, "a").cause.kind, "timeout");
  assert.strictEqual(stateOf(sim, "c").state, "failed");
});

test("a pause offers its options and its answer is the output", () => {
  const w = wf([{ id: "w", wait: { attention: "pick", form: "select", options: [{ id: "one" }, { id: "two" }] } }, b("x", { depends_on: ["w"], when: "$w.output.decision == 'two'" })]);
  const prompts = [];
  const sim = run(w, (p) => {
    prompts.push(p);
    return "two";
  });
  assert.deepStrictEqual(prompts[0].options, ["one", "two"]);
  assert.strictEqual(prompts[0].kind, "wait");
  assert.strictEqual(stateOf(sim, "x").state, "completed");
  assert.deepStrictEqual(sim.state.outputs.get("w"), { decision: "two", text: "" });
});

test("a condition on a node that did not run fails the node, as the engine does at run time", () => {
  const w = wf([b("a", { bash: "echo x", when: "$z.output == 'x'" }), b("z", { depends_on: ["a"] })]);
  const sim = run(w, () => "x");
  assert.strictEqual(stateOf(sim, "a").state, "failed");
  assert.match(stateOf(sim, "a").error, /did not run/);
});

test("a loop asks after each round and fails when max_iterations is used up", () => {
  const w = wf([{ id: "g", loop_group: { nodes: [b("r")], max_iterations: 3, until_bash: "false" } }, b("after", { depends_on: ["g"] })]);
  const checks = [];
  const sim = run(w, (p) => {
    checks.push(p.round);
    return "does not pass";
  });
  assert.deepStrictEqual(checks, [1, 2, 3]);
  assert.strictEqual(stateOf(sim, "g").state, "failed");
  assert.strictEqual(stateOf(sim, "after").cause.kind, "upstream_failed");
  assert.strictEqual(sim.state.result.status, "failed");
  const ok = run(w, (p) => (p.round === 2 ? "passes" : "does not pass"));
  assert.strictEqual(stateOf(ok, "g").state, "completed");
  assert.strictEqual(ok.state.rounds.get("g"), 2);
});

test("$LOOP_PREV reads the previous round's output and is empty in round 1", () => {
  const w = wf([{ id: "g", loop_group: { max_iterations: 3, until_bash: "true", nodes: [b("r", { bash: "echo idle" }), b("s", { depends_on: ["r"], when: "$LOOP_PREV.r.output == 'second'" })] } }]);
  const sim = createSimulation(w, {});
  const afterRound = [];
  let p = sim.start();
  while (p) {
    if (p.kind === "output") p = sim.answer("second");
    else {
      afterRound.push(sim.state.nodes.get("g.s").state);
      p = sim.answer(p.round === 2 ? "passes" : "does not pass");
    }
  }
  assert.deepStrictEqual(afterRound, ["skipped", "completed"]);
});

test("cancel ends the run", () => {
  const w = wf([b("a"), { id: "stop", depends_on: ["a"], cancel: "enough" }, b("later", { depends_on: ["stop"] })]);
  const sim = run(w, null);
  assert.strictEqual(sim.state.result.status, "cancelled");
  assert.strictEqual(sim.state.result.reason, "enough");
  assert.strictEqual(stateOf(sim, "later").cause.kind, "cancelled");
});

test("the result splits node time and waiting time and sums the costs from the statistics", () => {
  const w = wf([b("a"), { id: "w", depends_on: ["a"], wait: { attention: "ok?", form: "approval" } }]);
  const stats = { nodes: { a: { durMedian: 1000, costMedian: 0.5 } }, pauses: { w: { waitedMedian: 60000 } }, included: {} };
  const sim = run(w, null, { stats });
  assert.deepStrictEqual([sim.state.result.nodeMs, sim.state.result.waitMs, sim.state.result.cost], [1000, 60000, 0.5]);
});

test("printed words come from echo and printf arguments", () => {
  assert.deepStrictEqual(simPrintedWords("if x; then printf 'red\\n'; else echo green; fi"), ["red", "green"]);
  assert.deepStrictEqual(simPrintedWords("printf '%s\\n' \"$d\""), []);
});

test("a simulated build with plan_gate and final_gate approved reaches handoff", () => {
  const d = loadDump();
  const w = d.workflows.find((x) => x.name === "build");
  const asked = [];
  const sim = run(w.model, (p) => {
    asked.push(p.key);
    if (p.key === "plan_cycle.plan_gate" || p.key === "build_cycle.final_gate") return "approve";
    return simDefaultAnswer(p);
  }, { stats: d.stats.workflows.build });
  assert.ok(asked.includes("plan_cycle.plan_gate") && asked.includes("build_cycle.final_gate"));
  assert.strictEqual(stateOf(sim, "handoff").state, "completed");
  assert.strictEqual(sim.state.result.status, "completed");
  assert.ok(sim.state.result.cost > 0 && sim.state.result.waitMs > 0);
});
