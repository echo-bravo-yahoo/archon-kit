// Parser, evaluator and builder for `when` conditions. Mirrors Archon 0.13.2: the expression is split on
// || and then && outside single quotes, and each atom must match one regular expression. There are no
// parentheses, and the only string quote is the single quote.
var WHEN_OPS = ["==", "!=", "<=", ">=", "<", ">"];
const WHEN_ID = "[A-Za-z_][A-Za-z0-9_-]*";
const WHEN_FIELD = "[A-Za-z_][A-Za-z0-9_]*";
const WHEN_PATH = WHEN_FIELD + "(?:\\." + WHEN_FIELD + ")*";
const WHEN_RHS = "(?:'([^']*)'|(-?\\d+(?:\\.\\d+)?|true|false))";
const WHEN_OP = "\\s*(" + WHEN_OPS.join("|") + ")\\s*";
const WHEN_NODE_ATOM = new RegExp("^(?:\\$INPUTS\\.(" + WHEN_ID + ")|\\$(" + WHEN_ID + ")\\.(" + WHEN_FIELD + ")(?:\\.(" + WHEN_PATH + "))?)" + WHEN_OP + WHEN_RHS + "$");
const WHEN_PREV_ATOM = new RegExp("^\\$LOOP_PREV\\.(" + WHEN_ID + ")\\.output(?:\\.(" + WHEN_PATH + "))?" + WHEN_OP + WHEN_RHS + "$");

function whenSplit(text, sep) {
  const parts = [];
  let cur = "";
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "'") {
      quoted = !quoted;
      cur += text[i++];
    } else if (!quoted && text.startsWith(sep, i)) {
      parts.push(cur.trim());
      cur = "";
      i += sep.length;
    } else cur += text[i++];
  }
  parts.push(cur.trim());
  return parts;
}

function whenExplainBadAtom(atom) {
  if (/[()]/.test(atom)) return "parentheses are not supported; && binds tighter than ||";
  if (/"/.test(atom)) return "strings use single quotes, not double quotes";
  if (!/^\$/.test(atom)) return "the left side must be a $reference such as $id.output or $INPUTS.name";
  if (!WHEN_OPS.some((op) => atom.includes(op))) return "an operator is missing; use one of " + WHEN_OPS.join(" ");
  return "expected $id.output[.field] <op> 'text' | number | true | false";
}

function whenParseAtom(text) {
  const t = text.trim();
  let m = WHEN_PREV_ATOM.exec(t);
  if (m) {
    const [, id, field, op, str, lit] = m;
    return whenFinishAtom({ kind: "loop_prev", id, field: field || null }, op, str, lit, text);
  }
  m = WHEN_NODE_ATOM.exec(t);
  if (!m) return { error: whenExplainBadAtom(t) };
  const [, input, id, first, rest, op, str, lit] = m;
  if (input !== undefined) return whenFinishAtom({ kind: "input", name: input }, op, str, lit, text);
  if (id === "INPUTS") return { error: "use $INPUTS.name for an input" };
  if (id === "LOOP_PREV") return { error: "$LOOP_PREV.<id>.output[.field] needs the node id and .output" };
  if (first === "output") return whenFinishAtom({ kind: "node", id, field: rest || null }, op, str, lit, text);
  if (rest !== undefined) return { error: "nested shorthand: write $" + id + ".output." + first + "." + rest + " for a nested field" };
  return whenFinishAtom({ kind: "node", id, field: first, shorthand: true }, op, str, lit, text);
}

function whenFinishAtom(ref, op, str, lit, text) {
  const expected = str !== undefined ? str : lit;
  const expectedType = str !== undefined ? "string" : /^(true|false)$/.test(lit) ? "boolean" : "number";
  if (op !== "==" && op !== "!=" && !Number.isFinite(parseFloat(expected))) {
    return { error: "the operator " + op + " needs a numeric right-hand side" };
  }
  return { atom: { ref, op, expected, expectedType, text: text.trim() } };
}

// parseWhen(text, {loopBody}) -> {ok: true, clauses: [[atom]]} or {ok: false, error, atomText}
function parseWhen(text, opts) {
  const loopBody = !!(opts && opts.loopBody);
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "the condition is empty", atomText: "" };
  const clauses = [];
  for (const clause of whenSplit(text.trim(), "||")) {
    const atoms = [];
    for (const raw of whenSplit(clause, "&&")) {
      const res = whenParseAtom(raw);
      if (res.error) return { ok: false, error: res.error, atomText: raw };
      if (res.atom.ref.kind === "loop_prev" && !loopBody) {
        return { ok: false, error: "$LOOP_PREV is valid only inside a loop body", atomText: raw };
      }
      atoms.push(res.atom);
    }
    clauses.push(atoms);
  }
  return { ok: true, clauses };
}

function refText(ref) {
  if (ref.kind === "input") return "$INPUTS." + ref.name;
  if (ref.kind === "loop_prev") return "$LOOP_PREV." + ref.id + ".output" + (ref.field ? "." + ref.field : "");
  return "$" + ref.id + ".output" + (ref.field ? "." + ref.field : "");
}

function whenLiteralText(atom) {
  return atom.expectedType === "string" ? "'" + atom.expected + "'" : String(atom.expected);
}

function atomText(atom) {
  return refText(atom.ref) + " " + atom.op + " " + whenLiteralText(atom);
}

function buildWhen(clauses) {
  return clauses.map((atoms) => atoms.map(atomText).join(" && ")).join(" || ");
}

function whenAtoms(parsed) {
  return parsed && parsed.ok ? parsed.clauses.flat() : [];
}

// resolve(ref) returns the referenced value or undefined when there is none. A value is compared as
// text, so true compares equal to 'true'.
function evalAtom(atom, resolve) {
  const v = resolve(atom.ref);
  if (v === undefined) throw new Error("no value for " + refText(atom.ref));
  const actual = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (atom.op === "==") return actual === atom.expected;
  if (atom.op === "!=") return actual !== atom.expected;
  const a = parseFloat(actual);
  const b = parseFloat(atom.expected);
  if (!Number.isFinite(a)) return false;
  if (atom.op === "<") return a < b;
  if (atom.op === ">") return a > b;
  if (atom.op === "<=") return a <= b;
  return a >= b;
}

function evalWhen(parsed, resolve) {
  if (!parsed.ok) throw new Error(parsed.error);
  for (const atoms of parsed.clauses) {
    let all = true;
    for (const atom of atoms) {
      if (!evalAtom(atom, resolve)) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

if (typeof module !== "undefined") module.exports = { WHEN_OPS, whenSplit, parseWhen, buildWhen, atomText, refText, whenAtoms, evalWhen, evalAtom };
