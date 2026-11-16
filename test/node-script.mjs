import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

// The bash of node `id`: the block that follows its `bash: |` key, dedented by the node's indent plus 4.
export function nodeScript(file, id) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^ *- id: ${id}$`).test(l));
  assert.ok(start >= 0, `no node ${id} in ${file}`);
  const indent = lines[start].match(/^ */)[0].length;
  const key = new RegExp(`^ {${indent + 2}}bash: \\|$`);
  let i = start + 1;
  while (i < lines.length && !key.test(lines[i])) {
    assert.ok(!new RegExp(`^ {0,${indent}}- id:`).test(lines[i]), `node ${id} has no bash block`);
    i++;
  }
  const pad = " ".repeat(indent + 4);
  const body = [];
  for (i += 1; i < lines.length; i++) {
    if (lines[i] === "") body.push("");
    else if (lines[i].startsWith(pad)) body.push(lines[i].slice(pad.length));
    else break;
  }
  return `${body.join("\n")}\n`;
}

const quote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
export const subst = (script, vars) => {
  let out = script;
  for (const [k, v] of Object.entries(vars).sort((a, b) => b[0].length - a[0].length)) out = out.split(k).join(quote(v));
  return out;
};

// Runs node `id` of `file` with the engine substitutions in `vars` replaced, in `cwd`, with `env` added to the
// environment (an undefined value removes the variable).
export function runNodeBash(file, id, { cwd, vars = {}, env = {} }) {
  const full = { ...process.env, ...env };
  for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k];
  return spawnSync("bash", ["-c", subst(nodeScript(file, id), vars)], { cwd, encoding: "utf8", env: full });
}
