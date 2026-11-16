#!/usr/bin/env node
// usage: lane-replay.mjs --repo <name> [--workflow build] [--all]
//   --all  print each refused command in full instead of its first 400 characters
// Replays the tool calls of past confined build stages through lane-hook.mjs's analyzer and
// decision logic, against the current checkout of the run's repository, and lists the calls the
// hook would refuse. The logs are ~/.archon/workspaces/_local/<repo>/logs/*.jsonl.
//
// A run's worktree is replaced by a throwaway linked worktree of <workspace>/<repo> (removed at
// the end; the workspace is the `workspace` setting of kit.json), so a path into the main
// checkout counts as outside the worktree. A stage's working directory carries from one call to
// the next, as it does in the Bash tool.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildContext, checkTarget, writeTargets } from "./lane-hook.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const REPO = opt("--repo");
if (!REPO) {
  console.error("usage: lane-replay.mjs --repo <name> [--workflow build] [--all]");
  process.exit(2);
}
const WORKFLOWS = new Set(opt("--workflow", "build").split(","));
const ALL = args.includes("--all");

// log step -> hook stage. The review step runs while the implement marker is still set.
const STEPS = {
  tests: "tests",
  "build_cycle.implement": "implement",
  "build_cycle.repair_tests": "repair",
  "sync_cycle.sync_fix": "sync_fix",
  "build_cycle.review__review": "implement",
};

const HOME = os.homedir();
const ARCHON_HOME = process.env.ARCHON_HOME || path.join(HOME, ".archon");
const ws = path.join(ARCHON_HOME, "workspaces", "_local", REPO);
// The directory that holds the repositories is the `workspace` setting of kit.json.
// kit-settings.sh refuses a kit.json that is not a JSON object, and so does this script.
const workspace = (() => {
  try {
    return execFileSync("bash", [path.join(ARCHON_HOME, "scripts", "kit-settings.sh"), "workspace"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    console.error(String(e.stderr || e.message).trim());
    process.exit(1);
  }
})();
const checkout = path.join(workspace, REPO);
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A run's worktree: Archon's own layout, or the older ~/.archon/builds/<repo>-<slug> that the
// queue-started builds used.
const WT_RE = new RegExp(
  `${esc(ws)}/worktrees/(?:archon/[^/\\s'"]+|[^/\\s'"]+)|${esc(path.join(ARCHON_HOME, "builds", REPO))}-[^/\\s'"]+`,
  "g",
);

const replayRoot = path.join(ws, "worktrees", `replay-${process.pid}`);
execFileSync("git", ["-C", checkout, "worktree", "add", "-q", "--detach", replayRoot, "HEAD"], { stdio: "inherit" });
const cleanup = () => {
  try {
    execFileSync("git", ["-C", checkout, "worktree", "remove", "--force", replayRoot], { stdio: "ignore" });
  } catch {
    // leave it for `git worktree prune`
  }
};
process.on("exit", cleanup);

const lanes = JSON.parse(fs.readFileSync(path.join(replayRoot, ".archon", "lanes.json"), "utf8"));
const fix = (s) => s.replaceAll(WT_RE, replayRoot);

const stats = {};
const denied = [];
const logs = fs.readdirSync(path.join(ws, "logs")).filter((f) => f.endsWith(".jsonl"));
for (const file of logs) {
  let workflow = null;
  let runId = null;
  const cwds = {};
  for (const line of fs.readFileSync(path.join(ws, "logs", file), "utf8").split("\n")) {
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type === "workflow_start") {
      workflow = d.workflow_name;
      runId = d.workflow_id;
      continue;
    }
    if (!WORKFLOWS.has(workflow) || d.type !== "provider_event" || d.event?.type !== "tool_call") continue;
    const stage = STEPS[d.step];
    if (!stage) continue;
    const name = d.event.name;
    const input = d.event.rawInput ?? {};
    const key = `${workflow}/${d.step}`;
    const s = (stats[key] ??= { calls: 0, write: 0, bash: 0, denied: 0, unresolved: 0, targets: 0 });
    s.calls++;

    const ctx = buildContext({
      root: replayRoot,
      stage,
      allow: [path.join(ws, "artifacts", "runs", runId)],
      lanes,
    });
    if (!ctx) continue;
    const cwdKey = `${runId}/${d.step}`;
    const cwd = cwds[cwdKey] ?? replayRoot;
    let targets = [];
    let shown = "";
    if (name === "Bash" && typeof input.command === "string") {
      s.bash++;
      const cmd = fix(input.command);
      const r = writeTargets(cmd, cwd);
      // The Bash tool returns to the start folder when a command ends outside the working directories.
      cwds[cwdKey] = r.endCwd && (r.endCwd === replayRoot || r.endCwd.startsWith(`${replayRoot}/`)) ? r.endCwd : replayRoot;
      targets = r.targets;
      s.targets += targets.length;
      if (r.unresolved) s.unresolved++;
      shown = cmd;
    } else if ((name === "Write" || name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") && (input.file_path || input.notebook_path)) {
      s.write++;
      const f = fix(input.file_path ?? input.notebook_path);
      targets = [{ path: path.resolve(cwd, f), recursive: false }];
      s.targets++;
      shown = `${name} ${f}`;
    } else continue;

    for (const t of targets) {
      const reason = checkTarget(ctx, t);
      if (reason) {
        s.denied++;
        denied.push({ key, run: runId.slice(0, 8), outside: /outside the worktree|git directory/.test(reason), shown, reason });
        break;
      }
    }
  }
}

console.log("calls per stage (write = Write/Edit calls, targets = write targets found, unresolved = calls with a target the analyzer could not resolve):");
for (const [k, v] of Object.entries(stats)) {
  console.log(`  ${k}: ${v.calls} calls (${v.bash} Bash, ${v.write} Write/Edit), ${v.targets} targets, ${v.unresolved} unresolved, ${v.denied} would be refused`);
}
const section = (title, items) => {
  console.log(`\n${title}: ${items.length}`);
  for (const x of items) {
    const text = ALL ? x.shown : x.shown.length > 400 ? `${x.shown.slice(0, 400)} ...` : x.shown;
    console.log(`\n[${x.key} run ${x.run}]\n  ${text.replace(/\n/g, "\n  ")}\n  => ${x.reason}`);
  }
};
section("would be refused outside the worktree", denied.filter((x) => x.outside));
section("would be refused inside the worktree", denied.filter((x) => !x.outside));
