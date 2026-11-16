const test = require("node:test");
const assert = require("node:assert");
const { filesOfBash, filesOfPrompt, filesOfNode, workflowFiles, fileNodes, filesDiff } = require("../src/files.js");
const rules = require("../data/files.json");
const { loadDump, wf } = require("./load.js");

const ids = (list) => list.map((f) => f.id).sort();
const bash = (text) => filesOfBash(text, rules);

test("a redirect to a file in the artifacts directory writes it, and a later cat reads it", () => {
  const r = bash('printf "%s\\n" "$deliver" > "$ARTIFACTS_DIR/deliver.txt"\ncat "$ARTIFACTS_DIR/deliver.txt"');
  assert.deepStrictEqual(ids(r.writes), ["artifacts:deliver.txt"]);
  assert.deepStrictEqual(ids(r.reads), ["artifacts:deliver.txt"]);
  assert.strictEqual(r.writes[0].how, "redirect");
});

test("stderr redirects, /dev/null and comments create no file", () => {
  const r = bash('# writes "$ARTIFACTS_DIR/never.txt"\necho x >&2\necho y 2>&1\necho z > /dev/null\nawk \'$1 > 3\' "$ARTIFACTS_DIR/in.txt"');
  assert.deepStrictEqual(r.writes, []);
  assert.deepStrictEqual(ids(r.reads), ["artifacts:in.txt"]);
});

test("append, tee, touch, mkdir, cp and mv write; rm deletes", () => {
  const r = bash([
    'echo a >> "$ARTIFACTS_DIR/log.txt"',
    'echo b | tee "$ARTIFACTS_DIR/url.txt"',
    'touch "$ARTIFACTS_DIR/flag"',
    'mkdir -p "$ARTIFACTS_DIR/out"',
    'cp "$src/x.md" "$ARTIFACTS_DIR/copy.md"',
    'mv "$ARTIFACTS_DIR/a.md" "$ARTIFACTS_DIR/b.md"',
    'rm -f "$ARTIFACTS_DIR/gone.txt"',
  ].join("\n"));
  const how = Object.fromEntries(r.writes.map((w) => [w.id, w.how]));
  assert.deepStrictEqual(how, {
    "artifacts:log.txt": "redirect", "artifacts:url.txt": "tee", "artifacts:flag": "touch", "artifacts:out": "mkdir",
    "artifacts:copy.md": "cp", "artifacts:b.md": "mv", "artifacts:gone.txt": "deletes",
  });
  assert.ok(r.writes.find((w) => w.id === "artifacts:out").dir);
  assert.ok(ids(r.reads).includes("artifacts:a.md"), "the source of a move is read");
});

test("a variable that holds a path resolves, and a bare use of it counts", () => {
  const r = bash('f="$ARTIFACTS_DIR/report.md"\n[ -s "$f" ] || exit 1\nout="$ARTIFACTS_DIR/brief.md"\n{ cat "$f"; } > "$out"');
  assert.deepStrictEqual(ids(r.writes), ["artifacts:brief.md"]);
  assert.deepStrictEqual(ids(r.reads), ["artifacts:report.md"]);
});

test("a for loop over literal words expands the path", () => {
  const r = bash('for f in plan.md tests.sha; do\n  [ ! -f "$src/$f" ] || cp "$src/$f" "$ARTIFACTS_DIR/$f"\ndone');
  assert.deepStrictEqual(ids(r.writes), ["artifacts:plan.md", "artifacts:tests.sha"]);
});

test("a file read and written by one node shows in both lists", () => {
  const r = bash('n="$ARTIFACTS_DIR/count.txt"\nc=$(( $(cat "$n") + 1 )); printf \'%s\\n\' "$c" > "$n"');
  assert.deepStrictEqual(ids(r.writes), ["artifacts:count.txt"]);
  assert.deepStrictEqual(ids(r.reads), ["artifacts:count.txt"]);
});

test("report directories resolve from --design-dir and from $HOME/.archon/designs", () => {
  const a = bash('dir=$("$HOME/.archon/scripts/build-settings.sh" --design-dir "$slug")\nprintf x > "$dir/plan-report.html"');
  assert.deepStrictEqual(ids(a.writes), ["designs:plan-report.html"]);
  const b = bash('dir="$HOME/.archon/designs/$repo/$slug"\nout="$dir/index.html"\nrm -f "$out"');
  assert.deepStrictEqual(ids(b.writes), ["designs:index.html"]);
});

test("a script the page knows writes its files, unless it only lists", () => {
  assert.deepStrictEqual(ids(bash('bash "$HOME/.archon/scripts/run-gates.sh" feature --list').writes), []);
  assert.deepStrictEqual(ids(bash('bash "$HOME/.archon/scripts/run-gates.sh" feature').writes), ["artifacts:gate-report.md", "artifacts:gates"]);
  const m = bash('r=$(bash "$HOME/.archon/scripts/mutation-check.sh" "$ARTIFACTS_DIR/mutations.json" "$ARTIFACTS_DIR/mutation-report.md")');
  assert.deepStrictEqual(ids(m.writes), ["artifacts:gates", "artifacts:mutation-report.md", "artifacts:state"]);
  assert.deepStrictEqual(ids(m.reads).filter((x) => x !== "artifacts:coverage-bug.md"), ["artifacts:mutations.json"]);
  const s = bash('"$HOME/.archon/scripts/lane.sh" stage tests "$ARTIFACTS_DIR"\n"$HOME/.archon/scripts/lane.sh" unstage');
  assert.deepStrictEqual(s.writes.map((w) => w.id + ":" + w.how), ["gitdir:archon-stage:script", "gitdir:archon-stage:deletes"]);
});

test("state.sh set writes the state file and get reads it, whether called by path or through a $st alias", () => {
  const a = bash('"$HOME/.archon/scripts/state.sh" set plan-loop settled\nx=$("$HOME/.archon/scripts/state.sh" get build-loop)');
  assert.deepStrictEqual(ids(a.writes), ["artifacts:state"]);
  assert.deepStrictEqual(ids(a.reads), ["artifacts:state"]);
  const b = bash('st="$HOME/.archon/scripts/state.sh"\n"$st" set landed yes\ng=$("$st" get gates-status)');
  assert.deepStrictEqual(ids(b.writes), ["artifacts:state"]);
  assert.deepStrictEqual(ids(b.reads), ["artifacts:state"]);
  assert.deepStrictEqual(ids(bash('ARTIFACTS_DIR="$src" "$HOME/.archon/scripts/state.sh" get tests-sha').writes), []);
});

test("run-log.sh writes run.log, and the report page builder logs there too", () => {
  assert.deepStrictEqual(ids(bash('"$HOME/.archon/scripts/run-log.sh" land "$HOME/.archon/scripts/worktree-land"').writes), ["artifacts:run.log"]);
  assert.deepStrictEqual(ids(bash('"$HOME/.archon/scripts/run-log.sh" rebase git rebase "$base"').reads), []);
  const r = bash('"$HOME/.archon/scripts/report.sh" page review --out "$d/review-report.html" --design "$slug"');
  assert.deepStrictEqual(ids(r.writes), ["artifacts:run.log"]);
  assert.ok(ids(r.reads).includes("artifacts:state") && ids(r.reads).includes("artifacts:report.md"));
  assert.deepStrictEqual(ids(bash('"$HOME/.archon/scripts/report.sh" page plan --out "$d/plan-report.html"').writes), ["artifacts:run.log"]);
});

test("--out names a file the command writes", () => {
  const r = bash('report.sh page plan --out "$dir/plan-report.html" --spec "$ARTIFACTS_DIR/spec.json"\ndir=$("$HOME/.archon/scripts/build-settings.sh" --design-dir "$s")');
  assert.ok(ids(r.reads).includes("artifacts:spec.json"));
  assert.ok(!ids(r.writes).includes("artifacts:spec.json"));
});

test("a prompt writes the file it is told to write and reads the rest", () => {
  const r = filesOfPrompt([
    "Write the plan to $ARTIFACTS_DIR/plan.md. Read $ARTIFACTS_DIR/plan-notes.md first.",
    "Write the tests for the plan at $ARTIFACTS_DIR/plan.md.",
    "Append to $ARTIFACTS_DIR/test-repairs.md, for each test. Move $ARTIFACTS_DIR/old.md to\n$ARTIFACTS_DIR/old-<unix time>.md.",
    "Put a graphic in $ARTIFACTS_DIR/files/ and link it.",
  ].join(" "));
  assert.deepStrictEqual(ids(r.writes), ["artifacts:files", "artifacts:old-<unix time>.md", "artifacts:plan.md", "artifacts:test-repairs.md"]);
  assert.deepStrictEqual(ids(r.reads), ["artifacts:old.md", "artifacts:plan-notes.md", "artifacts:plan.md"]);
  assert.ok(r.writes.find((w) => w.id === "artifacts:files").dir);
});

test("an include node takes the files of the workflow it includes", () => {
  const child = wf([{ id: "v", bash: 'echo ok > "$ARTIFACTS_DIR/verdict.txt"' }], { name: "child" });
  const parent = wf([{ id: "rev", include: "child" }]);
  const r = filesOfNode(parent.nodes[0], { rules, getWorkflow: (n) => (n === "child" ? child : null) });
  assert.deepStrictEqual(r.writes.map((w) => [w.id, w.how]), [["artifacts:verdict.txt", "include"]]);
});

test("a loop reads the file its exit test greps", () => {
  const w = wf([{ id: "cycle", loop_group: { max_iterations: 3, until_bash: 'grep -qx settled "$ARTIFACTS_DIR/loop.txt"', nodes: [{ id: "r", bash: 'printf settled > "$ARTIFACTS_DIR/loop.txt"' }] } }]);
  const r = workflowFiles(w, { rules });
  const f = r.files.find((x) => x.name === "loop.txt");
  assert.deepStrictEqual(f.writers.map((x) => x.key), ["cycle.r"]);
  assert.deepStrictEqual(f.readers, ["cycle"]);
});

test("a loop that tests the state file reads it", () => {
  const w = wf([{ id: "cycle", loop_group: { max_iterations: 3, until_bash: '[ "$("$HOME/.archon/scripts/state.sh" get loop)" = settled ]', nodes: [{ id: "r", bash: '"$HOME/.archon/scripts/state.sh" set loop settled' }] } }]);
  const f = workflowFiles(w, { rules }).files.find((x) => x.name === "state");
  assert.deepStrictEqual(f.writers.map((x) => x.key), ["cycle.r"]);
  assert.deepStrictEqual(f.readers, ["cycle"]);
});

test("a file with a reader and no writer is marked as made outside, and one inside a written directory is not", () => {
  const w = wf([
    { id: "a", bash: 'cat "$ARTIFACTS_DIR/input.md"; mkdir -p "$ARTIFACTS_DIR/pages"' },
    { id: "b", depends_on: ["a"], bash: 'cat "$ARTIFACTS_DIR/pages/one.html"' },
  ]);
  const r = workflowFiles(w, { rules });
  assert.strictEqual(r.files.find((f) => f.name === "input.md").external, true);
  assert.strictEqual(r.files.find((f) => f.name === "pages/one.html").external, false);
});

function buildFiles() {
  const d = loadDump();
  const byName = Object.fromEntries(d.workflows.map((w) => [w.name, w.model]));
  return { model: byName.build, files: workflowFiles(byName.build, { rules, getWorkflow: (n) => byName[n] }) };
}

test("the state file is written by sync_base and read by ship_decision and the report in build", () => {
  const { files: r } = buildFiles();
  const f = r.files.find((x) => x.id === "artifacts:state");
  assert.ok(f.writers.some((w) => w.key === "sync_base"), "sync_base records the delivery mode");
  assert.ok(f.readers.includes("ship_decision") && f.readers.includes("build_cycle.report"));
  assert.deepStrictEqual(r.byNode.sync_base.writes.map((w) => w.id), ["artifacts:state"]);
  const node = fileNodes(r, "all").find((n) => n.id === "artifacts:state");
  assert.strictEqual(node.key, "file:artifacts:state");
  assert.ok(node.writers.includes("sync_base"));
  assert.ok(node.readers.includes("ship_decision") && node.readers.includes("build_cycle.report"));
  const review = r.byNode["build_cycle.review"].writes.map((w) => w.id);
  assert.ok(review.includes("artifacts:report.md") && review.includes("artifacts:state"), "the included reviewer's files");
});

test("the adopting sync_resolve prompt reads the state file", () => {
  const { files: r } = buildFiles();
  assert.ok(r.byNode["sync_cycle.sync_resolve"].reads.some((x) => x.id === "artifacts:state"));
});

test("build's files passed between nodes include the plan, the approved spec and the state file, and leave out run.log", () => {
  const { model, files: r } = buildFiles();
  const linked = fileNodes(r, "linked", model).map((n) => n.name);
  for (const name of ["plan.md", "spec-approved.json", "state"]) assert.ok(linked.includes(name), name);
  assert.ok(!linked.includes("run.log"), "nothing reads run.log");
  assert.ok(fileNodes(r, "all").some((n) => n.name === "run.log"));
});

test("undeclared dependencies are a subset of the files passed between nodes", () => {
  const { model, files: r } = buildFiles();
  const linked = new Set(fileNodes(r, "linked", model).map((n) => n.id));
  const undeclared = fileNodes(r, "undeclared", model);
  assert.ok(undeclared.every((n) => linked.has(n.id)));
  assert.ok(undeclared.length < linked.size);
});

test("no run file build used to write remains in the list of all files", () => {
  const { files: r } = buildFiles();
  const names = new Set(r.files.map((f) => f.name));
  const removed = ["plan-loop.txt", "plan-decision.txt", "red-ok.txt", "build-loop.txt", "not-ready-rounds.txt", "pause-kind.txt", "review-verdict.txt", "gates-status.txt", "mutation-status.txt", "landed.txt", "deliver.txt", "tests.sha", "repair.sha", "sync-pre.sha", "sync-base.txt", "ship-decision.txt", "pr-url.txt", "pr-body.md", "handoffs-proposed.json", "sync-notes.md", "rebase.log", "land.log", "sync-gates.log", "red-gates.log", "shots.log", "plan-report.log", "report-build.log"];
  for (const name of removed) assert.ok(!names.has(name), name + " is still written or read");
  assert.ok([...names].every((n) => !/^blocked-/.test(n) && !/^mut-/.test(n)));
});

test("every file in the real workflows has a clean name and a writer or a reason", () => {
  const d = loadDump();
  const byName = Object.fromEntries(d.workflows.map((w) => [w.name, w.model]));
  for (const w of d.workflows) {
    const r = workflowFiles(w.model, { rules, getWorkflow: (n) => byName[n] });
    for (const f of r.files) {
      assert.ok(!/[@$"()]/.test(f.name), w.name + ": " + f.id + " has an unresolved name");
      assert.ok(f.where !== "other", w.name + ": " + f.id);
    }
  }
});

test("filesDiff lists files added, removed and rewired between two models", () => {
  const before = workflowFiles(wf([{ id: "a", bash: 'echo > "$ARTIFACTS_DIR/x.txt"; echo > "$ARTIFACTS_DIR/old.txt"' }, { id: "b", depends_on: ["a"], bash: 'cat "$ARTIFACTS_DIR/x.txt"' }]), { rules });
  const after = workflowFiles(wf([{ id: "a", bash: 'echo > "$ARTIFACTS_DIR/x.txt"; echo > "$ARTIFACTS_DIR/new.txt"' }, { id: "b", depends_on: ["a"], bash: "true" }, { id: "c", depends_on: ["a"], bash: 'cat "$ARTIFACTS_DIR/x.txt"' }]), { rules });
  const d = filesDiff(before, after);
  assert.deepStrictEqual(d.added.map((f) => f.name), ["new.txt"]);
  assert.deepStrictEqual(d.removed.map((f) => f.name), ["old.txt"]);
  assert.deepStrictEqual(d.rewired.map((f) => f.name), ["x.txt"]);
});

test("fileNodes keeps deleters apart from writers and can leave out files no other node reads", () => {
  const w = wf([{ id: "a", bash: 'echo > "$ARTIFACTS_DIR/x.txt"; echo > "$ARTIFACTS_DIR/log.txt"; rm -f "$ARTIFACTS_DIR/old.txt"' }, { id: "b", depends_on: ["a"], bash: 'cat "$ARTIFACTS_DIR/x.txt"; rm "$ARTIFACTS_DIR/x.txt"' }]);
  const r = workflowFiles(w, { rules });
  const all = fileNodes(r, "all");
  assert.deepStrictEqual(all.map((n) => n.name), ["log.txt", "old.txt", "x.txt"]);
  const x = all.find((n) => n.name === "x.txt");
  assert.deepStrictEqual([x.writers, x.deleters, x.readers], [["a"], ["b"], ["b"]]);
  assert.deepStrictEqual(fileNodes(r, "linked", w).map((n) => n.name), ["x.txt"]);
});

// solo.txt: only its writer reads it. log.txt: nothing reads it. flag.txt: only the loop's exit test reads it.
// gone.txt: only deleted. nowriter.txt: nothing in the workflow writes it. handed.txt, fromPre.txt and fromBody.txt are
// read by a node the declared order puts after the writer; hidden.txt by a node nothing orders after the writer.
const MODE_MODEL = () =>
  wf([
    { id: "pre", bash: 'echo > "$ARTIFACTS_DIR/fromPre.txt"' },
    {
      id: "a",
      bash: 'echo > "$ARTIFACTS_DIR/handed.txt"; echo > "$ARTIFACTS_DIR/solo.txt"; cat "$ARTIFACTS_DIR/solo.txt"; echo > "$ARTIFACTS_DIR/log.txt"; echo > "$ARTIFACTS_DIR/hidden.txt"',
    },
    { id: "b", depends_on: ["a"], bash: 'cat "$ARTIFACTS_DIR/handed.txt"; cat "$ARTIFACTS_DIR/nowriter.txt"; rm -f "$ARTIFACTS_DIR/gone.txt"' },
    { id: "c", bash: 'cat "$ARTIFACTS_DIR/hidden.txt"' },
    {
      id: "cycle",
      depends_on: ["pre"],
      loop_group: {
        max_iterations: 2,
        until_bash: 'grep -qx x "$ARTIFACTS_DIR/flag.txt"',
        nodes: [{ id: "r", bash: 'echo x > "$ARTIFACTS_DIR/flag.txt"; echo > "$ARTIFACTS_DIR/fromBody.txt"; cat "$ARTIFACTS_DIR/fromPre.txt"' }],
      },
    },
    { id: "after", depends_on: ["cycle"], bash: 'cat "$ARTIFACTS_DIR/fromBody.txt"' },
  ]);

test("fileNodes modes: all draws every file, linked the files one node makes and another reads, undeclared the ones no declared order explains", () => {
  const w = MODE_MODEL();
  const r = workflowFiles(w, { rules });
  const names = (mode) => fileNodes(r, mode, w).map((n) => n.name).sort();
  assert.deepStrictEqual(names("all"), ["flag.txt", "fromBody.txt", "fromPre.txt", "gone.txt", "handed.txt", "hidden.txt", "log.txt", "nowriter.txt", "solo.txt"]);
  assert.deepStrictEqual(names("linked"), ["fromBody.txt", "fromPre.txt", "handed.txt", "hidden.txt"]);
  assert.deepStrictEqual(names("undeclared"), ["hidden.txt"]);
});

test("fileNodes linked and undeclared need no workflow to run, and then treat no node as a loop or as ordered", () => {
  const r = workflowFiles(MODE_MODEL(), { rules });
  assert.ok(fileNodes(r, "linked").some((n) => n.name === "flag.txt"), "without the model, a loop reader counts as a reader");
  assert.ok(fileNodes(r, "undeclared").length >= 1);
});
