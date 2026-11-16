import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DUE = path.join(here, "..", "scripts", "due-instant.sh");

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const run = (when, { PATH } = {}) =>
  spawnSync("bash", [DUE, when], { encoding: "utf8", env: { ...process.env, ...(PATH ? { PATH } : {}) } });

// A directory of stubs put ahead of /usr/bin and /bin only, so a gdate that the machine has
// under Homebrew cannot reach the script. The stub date answers like BSD date: it has no -d.
function stubs({ gdate }) {
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "due-instant-")));
  made.push(bin);
  fs.writeFileSync(path.join(bin, "date"), '#!/bin/sh\ncase "$*" in\n  *" -d "*) echo "date: illegal option -- d" >&2; exit 1 ;;\nesac\nexec /bin/date "$@"\n', { mode: 0o755 });
  if (gdate) fs.writeFileSync(path.join(bin, "gdate"), '#!/bin/sh\ncase "$*" in\n  *@0*) exit 0 ;;\nesac\necho 2099-01-01T00:00:00Z\n', { mode: 0o755 });
  return `${bin}:/usr/bin:/bin`;
}

const GNU_DATE = spawnSync("date", ["-u", "-d", "@0"]).status === 0;

test("an ISO-8601 instant in the future prints unchanged", () => {
  const r = run("2099-06-01T09:30:00Z");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "2099-06-01T09:30:00Z\n");
});

test("an instant that is not in the future fails and says what time it is", () => {
  const r = run("2020-01-01T00:00:00Z");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^instant 2020-01-01T00:00:00Z is not in the future \(now \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\)\n$/);
  assert.equal(r.stdout, "");
});

test("an ISO-8601 instant needs no GNU date", () => {
  const r = run("2099-06-01T09:30:00Z", { PATH: stubs({ gdate: false }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "2099-06-01T09:30:00Z\n");
});

test("a relative time is read by GNU date and counted from now", { skip: !GNU_DATE && "needs GNU date" }, () => {
  const r = run("+2 days");
  assert.equal(r.status, 0, r.stderr);
  const at = Date.parse(r.stdout.trim());
  assert.ok(Math.abs(at - (Date.now() + 2 * 86400e3)) < 5000, r.stdout);
});

test("without GNU date or gdate a relative time fails with the install line and an ISO example", () => {
  const r = run("+7 days", { PATH: stubs({ gdate: false }) });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /relative times need GNU date \(macOS: brew install coreutils, which provides gdate\); pass an ISO-8601 instant such as 2026-11-03T09:00:00Z/);
});

test("gdate is used for a relative time when date has no -d", () => {
  const r = run("next monday 09:00", { PATH: stubs({ gdate: true }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "2099-01-01T00:00:00Z\n");
});
