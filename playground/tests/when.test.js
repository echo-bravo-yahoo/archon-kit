const test = require("node:test");
const assert = require("node:assert");
const { parseWhen, buildWhen, evalWhen, whenAtoms } = require("../src/when.js");

const resolver = (vals) => (ref) => vals[ref.kind === "input" ? "$INPUTS." + ref.name : "$" + ref.id + (ref.field ? "." + ref.field : "")];

test("each operator parses and evaluates", () => {
  const cases = [
    ["$a.output == 'x'", { "$a": "x" }, true],
    ["$a.output != 'x'", { "$a": "y" }, true],
    ["$a.output < 5", { "$a": "3" }, true],
    ["$a.output > 5", { "$a": "3" }, false],
    ["$a.output <= 3", { "$a": "3" }, true],
    ["$a.output >= 4", { "$a": "3" }, false],
  ];
  for (const [text, vals, want] of cases) {
    const p = parseWhen(text);
    assert.ok(p.ok, text);
    assert.strictEqual(evalWhen(p, resolver(vals)), want, text);
  }
});

test("&& binds tighter than ||", () => {
  const p = parseWhen("$a.output == '1' || $b.output == '1' && $c.output == '1'");
  assert.strictEqual(p.clauses.length, 2);
  assert.strictEqual(p.clauses[1].length, 2);
  const r = (a, b, c) => evalWhen(p, resolver({ "$a": a, "$b": b, "$c": c }));
  assert.strictEqual(r("1", "0", "0"), true);
  assert.strictEqual(r("0", "1", "0"), false);
  assert.strictEqual(r("0", "1", "1"), true);
});

test("parentheses and double quotes are rejected", () => {
  assert.strictEqual(parseWhen("($a.output == 'x')").ok, false);
  assert.match(parseWhen("($a.output == 'x')").error, /parentheses/);
  assert.strictEqual(parseWhen('$a.output == "x"').ok, false);
  assert.match(parseWhen('$a.output == "x"').error, /single quotes/);
});

test("a && or || inside quotes does not split", () => {
  const p = parseWhen("$a.output == 'x && y' || $b.output == 'p||q'");
  assert.ok(p.ok);
  assert.strictEqual(p.clauses.length, 2);
  assert.strictEqual(p.clauses[0][0].expected, "x && y");
});

test("== true compares text, and fields read through .output.field or shorthand", () => {
  const p = parseWhen("$v.output.ok == true");
  assert.ok(p.ok);
  assert.strictEqual(evalWhen(p, resolver({ "$v.ok": true })), true);
  const s = parseWhen("$v.ok == false");
  assert.strictEqual(s.clauses[0][0].ref.field, "ok");
  assert.strictEqual(buildWhen(s.clauses), "$v.output.ok == false");
});

test("nested shorthand, numeric operators on text and $LOOP_PREV outside a loop are errors", () => {
  assert.match(parseWhen("$a.b.c == 'x'").error, /nested shorthand/);
  assert.match(parseWhen("$a.output < 'x'").error, /parentheses|single|expected|numeric/);
  assert.match(parseWhen("$LOOP_PREV.a.output == 'x'").error, /loop body/);
  assert.ok(parseWhen("$LOOP_PREV.a.output.d == 'x'", { loopBody: true }).ok);
});

test("inputs and builder round trip", () => {
  const text = "$INPUTS.mode == 'fast' && $a.output.n >= 2";
  const p = parseWhen(text);
  assert.strictEqual(buildWhen(p.clauses), text);
  assert.strictEqual(whenAtoms(p).length, 2);
});

test("missing values throw", () => {
  assert.throws(() => evalWhen(parseWhen("$a.output == 'x'"), () => undefined));
});
