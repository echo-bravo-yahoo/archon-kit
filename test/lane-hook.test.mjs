import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STAGES, pathspecGlob, writeTargets, run, commandText, patchTargets } from "../scripts/lane-hook.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, "..", "scripts", "lane-hook.mjs");
const STAGE_SH = path.join(here, "..", "scripts", "lane.sh");
const HOME = os.homedir();

// The hook treats the temp directory as writable, so with a HOME inside it no directory is outside
// the worktree and the cases that look for one cannot fail.
const HOME_IN_TMP = [os.tmpdir(), "/tmp"].some((t) => {
  const tmp = fs.realpathSync(t);
  const home = fs.realpathSync(HOME);
  return home === tmp || home.startsWith(tmp + path.sep);
});
const NEEDS_HOME_OUTSIDE_TMP = { skip: HOME_IN_TMP && "HOME is inside the temp directory, which the hook treats as writable" };

// Test repositories live under $HOME, because the temp directory is writable by convention and
// would hide the outside-the-worktree cases.
const made = [];
const mkdtemp = (parent, prefix) => {
  const d = fs.mkdtempSync(path.join(parent, prefix));
  made.push(d);
  return fs.realpathSync(d);
};
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const sh = (cwd, cmd, ...args) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = (root, rel, body = "x\n") => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

const SETTINGS_ENTRY = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash",
        hooks: [
          {
            type: "command",
            command: `sh -c '[ -f "\${ARCHON_HOME:-$HOME/.archon}/scripts/lane-hook.mjs" ] && exec node "\${ARCHON_HOME:-$HOME/.archon}/scripts/lane-hook.mjs"; exit 0'`,
          },
        ],
      },
    ],
  },
};

function mkRepo({ lanes = { tests: ["test/**"], protected: ["vendor/kit/**"] } } = {}) {
  const root = mkdtemp(HOME, "lane-hook-test-");
  sh(root, "git", "init", "-q", "-b", "main");
  sh(root, "git", "config", "user.email", "t@example.com");
  sh(root, "git", "config", "user.name", "t");
  if (lanes) write(root, ".archon/lanes.json", JSON.stringify(lanes));
  write(root, ".gitignore", "node_modules/\n*.log\n");
  write(root, ".claude/settings.json", JSON.stringify(SETTINGS_ENTRY));
  write(root, "test/a.js");
  write(root, "test/sub/b.js");
  write(root, "src/a.js");
  write(root, "vendor/kit/k.svg");
  write(root, "docs/readme.md");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "init");
  return root;
}

const setStage = (root, stage, ...allow) => sh(root, "bash", STAGE_SH, "stage", stage, ...allow);
const clearStage = (root) => sh(root, "bash", STAGE_SH, "unstage");

// Runs the hook in-process and returns null (allowed) or the deny reason.
function judge(root, tool_name, tool_input, { cwd = root, env = {} } = {}) {
  const out = run(JSON.stringify({ tool_name, tool_input, cwd }), { CLAUDE_PROJECT_DIR: root, ...env });
  if (out === "") return null;
  const j = JSON.parse(out);
  assert.equal(j.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(j.hookSpecificOutput.permissionDecision, "deny");
  return j.hookSpecificOutput.permissionDecisionReason;
}
const write_ = (root, rel, opts) => judge(root, "Write", { file_path: path.resolve(root, rel), content: "x" }, opts);
const bash = (root, command, opts) => judge(root, "Bash", { command }, opts);

// ---------------------------------------------------------------------------------------------

test("glob matcher agrees with git's :(glob) pathspecs", () => {
  const repo = mkdtemp(os.tmpdir(), "lane-glob-");
  sh(repo, "git", "init", "-q");
  const corpus = [
    "test/a.js", "test/sub/b.js", "test/sub/deep/c.test.js", "testfile", "tests/a.js", "src/a.js",
    "src/x/y.js", "src/x/y/z.js", "src/a.test.js", "a.test.js", "x.test.js", "sub/x.test.js",
    "native/host/tests/t.c", "native/host/tests/sub/u.c", "native/host/test/x", "native/x.c",
    "ui/test/a.js", "ui/test/b/c.js", "ui/tests/a.js", "configs/a", "configs/b/c.mjs",
    "configs.mjs", "configs.mjs.bak", "configsX/a", "vendor/kit/a.svg", "vendor/kit/x/y.svg", "vendor/kitten/a",
    "vendor/examples/e", "pkg/test/a.js", "pkg/sub/test/b.js", "a/b", "a/x/b", "a/x/y/b", "a/bb", "ab", "src/.hidden.js",
    "[x]/f", "file with space.js",
  ];
  for (const f of corpus) write(repo, f);
  sh(repo, "git", "add", "-A");
  const globs = [
    "test/**", "native/host/tests/**", "ui/test/**", "configs/**", "configs.mjs", "vendor/kit/**",
    "**/test/**", "*.test.js", "src/**/*.js", "vendor/kit", "a/**/b", "**", "src/*", "te?t/**", "[st]rc/**",
    "test/**/*.js", "**/*.test.js", "native/**/tests/**", "*", "a/*/b", "[!s]*/a.js",
  ];
  for (const g of globs) {
    const expected = sh(repo, "git", "ls-files", "--cached", "--others", "-z", "--", `:(glob)${g}`)
      .split("\0").filter(Boolean).sort();
    const re = pathspecGlob(g);
    const actual = corpus.filter((f) => re.test(f)).sort();
    assert.deepEqual(actual, expected, `glob ${g}`);
  }
});

test("analyzer finds the write targets of each recognized form", () => {
  const t = (cmd, cwd = "/w") => writeTargets(cmd, cwd).targets.map((x) => x.path);
  assert.deepEqual(t("echo a > test/f"), ["/w/test/f"]);
  assert.deepEqual(t("echo a >> test/f"), ["/w/test/f"]);
  assert.deepEqual(t("echo a >| test/f"), ["/w/test/f"]);
  assert.deepEqual(t("echo a &> test/f"), ["/w/test/f"]);
  assert.deepEqual(t("echo a 2> test/err"), ["/w/test/err"]);
  assert.deepEqual(t("echo a >test/f"), ["/w/test/f"]);
  assert.deepEqual(t("echo a >&test/f"), ["/w/test/f"]);
  assert.deepEqual(t("echo a | tee test/f /tmp/g"), ["/w/test/f", "/tmp/g"]);
  assert.deepEqual(t("tee -a test/f < in"), ["/w/test/f"]);
  assert.deepEqual(t("touch -d yesterday test/f"), ["/w/test/f"]);
  assert.deepEqual(t("mkdir -p test/a test/b"), ["/w/test/a", "/w/test/b"]);
  assert.deepEqual(t("rmdir test/a"), ["/w/test/a"]);
  assert.deepEqual(t("truncate -s 0 test/f"), ["/w/test/f"]);
  assert.deepEqual(t("chmod +x test/f"), ["/w/test/f"]);
  assert.deepEqual(t("chmod -x test/f"), ["/w/test/f"]);
  assert.deepEqual(t("chmod 644 test/f src/g"), ["/w/test/f", "/w/src/g"]);
  assert.deepEqual(t("cp src/a test/b"), ["/w/test/b"]);
  assert.deepEqual(t("cp -r src/a src/b test/"), ["/w/test/a", "/w/test/b"]);
  assert.deepEqual(t("cp -t test src/a"), ["/w/test/a"]);
  assert.deepEqual(t("cp --target-directory=test src/a"), ["/w/test/a"]);
  assert.deepEqual(t("install -m 644 src/a test/b"), ["/w/test/b"]);
  assert.deepEqual(t("install -d test/x test/y"), ["/w/test/x", "/w/test/y"]);
  assert.deepEqual(t("ln -s ../src/a test/link"), ["/w/test/link"]);
  assert.deepEqual(t("mv src/a test/b"), ["/w/test/b", "/w/src/a"]);
  assert.deepEqual(t("sed -i 's/a/b/' test/f src/g"), ["/w/test/f", "/w/src/g"]);
  assert.deepEqual(t("sed -i.bak -e 's/a/b/' test/f"), ["/w/test/f"]);
  assert.deepEqual(t("sed -n 's/a/b/p' test/f"), []);
  assert.deepEqual(t("perl -pi -e 's/a/b/' test/f"), ["/w/test/f"]);
  assert.deepEqual(t("perl -i.bak -pe 's/a/b/' test/f"), ["/w/test/f"]);
  assert.deepEqual(t("perl -ne 'print' test/f"), []);
  assert.deepEqual(t("dd if=/dev/zero of=test/blob bs=1"), ["/w/test/blob"]);
  assert.deepEqual(t("git checkout -- test/f"), ["/w/test/f"]);
  assert.deepEqual(t("git checkout main -- test/f src/g"), ["/w/test/f", "/w/src/g"]);
  assert.deepEqual(t("git restore test/f"), ["/w/test/f"]);
  assert.deepEqual(t("git restore --staged test/f"), []);
  assert.deepEqual(t("git rm -r test/f"), ["/w/test/f"]);
  assert.deepEqual(t("git rm --cached test/f"), []);
  assert.deepEqual(t("git mv test/a test/b"), ["/w/test/a", "/w/test/b"]);
  assert.deepEqual(t("git -C sub checkout -- f"), ["/w/sub/f"]);
});

test("analyzer follows quoting, separators, substitutions, subshells and cd", () => {
  const t = (cmd, cwd = "/w") => writeTargets(cmd, cwd).targets.map((x) => x.path);
  const base = mkdtemp(os.tmpdir(), "lane-an-");
  fs.mkdirSync(path.join(base, "sub"));
  const tb = (cmd) => t(cmd, base);
  assert.deepEqual(t(`echo "a > b" 'c > d'`), []);
  assert.deepEqual(t(`echo "a" > "test/with space"`), ["/w/test/with space"]);
  assert.deepEqual(t("a && b > x || c > y; d > z | e > w"), ["/w/x", "/w/y", "/w/z", "/w/w"]);
  assert.deepEqual(t("echo $(echo hi > test/inner)"), ["/w/test/inner"]);
  assert.deepEqual(t("echo `echo hi > test/inner`"), ["/w/test/inner"]);
  assert.deepEqual(t(`bash -c 'echo hi > test/z'`), ["/w/test/z"]);
  assert.deepEqual(tb(`bash -lc "cd sub && echo hi > z"`), [`${base}/sub/z`]);
  assert.deepEqual(t(`sh -c 'bash -c "echo hi > deep"'`), ["/w/deep"]);
  assert.deepEqual(writeTargets(`sh -c 'sh -c "sh -c \\"echo hi > too-deep\\""'`, "/w").unresolved, 1);
  assert.deepEqual(tb("cd sub && echo x > f"), [`${base}/sub/f`]);
  assert.deepEqual(tb("cd sub; cd ..; touch f"), [`${base}/f`]);
  assert.deepEqual(t("cd /tmp && touch f"), ["/tmp/f"]);
  assert.deepEqual(tb("cd .. && touch f"), [`${path.dirname(base)}/f`]);
  assert.deepEqual(tb("(cd sub && touch a); touch b"), [`${base}/sub/a`, `${base}/b`]);
  // a cd to a directory that does not exist fails in bash and leaves the directory unchanged
  assert.deepEqual(tb("cd nowhere && touch f"), [`${base}/f`]);
  assert.deepEqual(tb("cd sub && cd sub && touch f"), [`${base}/sub/f`]);
  assert.deepEqual(tb("mkdir -p newd && cd newd && touch f"), [`${base}/newd`, `${base}/newd/f`]);
  assert.equal(writeTargets("cd sub && cd - && touch f", base).targets.length, 0);
  assert.deepEqual(t("cat > a.txt <<'EOF'\nbody > not-a-target\nEOF\ntouch after"), ["/w/a.txt", "/w/after"]);
  assert.deepEqual(t("cat <<-EOF > a.txt\n\tbody > nope\n\tEOF\ntouch after"), ["/w/a.txt", "/w/after"]);
  assert.deepEqual(t("bash <<EOF\necho hi > from-heredoc\nEOF"), ["/w/from-heredoc"]);
  assert.deepEqual(t("FOO=1 BAR='x y' env -u Z touch f"), ["/w/f"]);
  assert.deepEqual(t("sudo -u root rm f"), ["/w/f"]);
  assert.deepEqual(t("timeout 30 touch f"), ["/w/f"]);
  assert.deepEqual(t("if true; then touch a; fi"), ["/w/a"]);
  assert.deepEqual(t("for f in a b; do touch $f; done"), []);
  assert.deepEqual(t("touch test/{a,b}.js {src,test}/c"), ["/w/test/a.js", "/w/test/b.js", "/w/src/c", "/w/test/c"]);
  assert.deepEqual(t("touch ~/x $HOME/y"), [path.join(HOME, "x"), path.join(HOME, "y")]);
  assert.deepEqual(t("echo hi # > test/commented"), []);
  assert.deepEqual(t("touch \\\n  test/continued"), ["/w/test/continued"]);
});

test("analyzer yields no target for reads and for commands without a write form", () => {
  const t = (cmd) => writeTargets(cmd, "/w");
  for (const cmd of [
    "echo a > /dev/null", "echo a 2>&1", "grep x test/a", "node --test test/a.test.js", "ls test/", "cat test/a | wc -l",
    "git status", "git commit -m 'a > b'", "git diff -- test/a", "npm test", "python3 -c 'open(\"test/x\",\"w\")'",
  ]) {
    const r = t(cmd);
    assert.deepEqual(r.targets.filter((x) => x.path !== "/dev/null"), [], cmd);
    assert.equal(r.unresolved, 0, cmd);
  }
});

test("analyzer reports an unresolved target and does not guess it", () => {
  for (const cmd of ["cat x > $R/y", "touch $(pwd)/f", "cp a $DEST", "cd $X && touch f"]) {
    const r = writeTargets(cmd, "/w");
    assert.deepEqual(r.targets.filter((x) => /test/.test(x.path)), [], cmd);
    assert.ok(r.unresolved >= 1, cmd);
  }
});

test("stage table", () => {
  assert.deepEqual(STAGES, {
    tests: { lane: "tests", mode: "in" },
    repair: { lane: "tests", mode: "in" },
    implement: { lane: "tests", mode: "out" },
    sync_fix: { lane: "protected", mode: "out" },
  });
});

test("no marker allows every call", () => {
  const root = mkRepo();
  assert.equal(write_(root, "src/a.js"), null);
  assert.equal(write_(root, "test/a.js"), null);
  assert.equal(bash(root, "echo x > /etc/passwd"), null);
});

test("tests and repair stages may write only the tests lane", () => {
  for (const stage of ["tests", "repair"]) {
    const root = mkRepo();
    setStage(root, stage);
    assert.equal(write_(root, "test/new.js"), null, stage);
    assert.equal(write_(root, "test/deep/er/new.js"), null, stage);
    assert.match(write_(root, "src/a.js"), /outside the tests lane/, stage);
    assert.match(write_(root, "docs/readme.md"), /outside the tests lane/, stage);
    assert.match(write_(root, "vendor/kit/k.svg"), /outside the tests lane/, stage);
    assert.equal(bash(root, "echo x > test/f"), null, stage);
    assert.match(bash(root, "echo x > src/f"), /outside the tests lane/, stage);
    assert.match(bash(root, "cp test/a.js src/b.js"), /outside the tests lane/, stage);
    assert.match(bash(root, "sed -i s/a/b/ src/a.js"), /outside the tests lane/, stage);
    assert.equal(bash(root, "mkdir -p test/newdir"), null, stage);
    assert.equal(bash(root, "mkdir -p test"), null, stage);
    assert.equal(bash(root, "rm -rf test/sub"), null, stage);
    assert.match(bash(root, "rm -rf src"), /outside the tests lane/, stage);
    assert.match(bash(root, "rm -rf ."), /outside the tests lane/, stage);
    assert.match(bash(root, "mv test/a.js src/"), /outside the tests lane/, stage);
  }
});

test("implement stage may not write the tests lane", () => {
  const root = mkRepo();
  setStage(root, "implement");
  assert.equal(write_(root, "src/new.js"), null);
  assert.equal(write_(root, "docs/readme.md"), null);
  assert.match(write_(root, "test/a.js"), /inside the tests lane/);
  assert.match(write_(root, "test/brand/new.js"), /blocked\.md/);
  assert.match(judge(root, "Edit", { file_path: path.join(root, "test/a.js") }), /inside the tests lane/);
  assert.match(judge(root, "MultiEdit", { file_path: path.join(root, "test/a.js") }), /inside the tests lane/);
  assert.match(judge(root, "NotebookEdit", { notebook_path: path.join(root, "test/n.ipynb") }), /inside the tests lane/);
  assert.match(bash(root, "echo x > test/f"), /inside the tests lane/);
  assert.match(bash(root, "cp src/a.js test/b.js"), /inside the tests lane/);
  assert.match(bash(root, "cp src/a.js test/"), /inside the tests lane/);
  assert.match(bash(root, "mv test/a.js src/a2.js"), /inside the tests lane/);
  assert.match(bash(root, "rm test/a.js"), /inside the tests lane/);
  assert.match(bash(root, "rm -rf test"), /inside the tests lane/);
  assert.match(bash(root, "rm -rf ."), /inside the tests lane/);
  assert.match(bash(root, "sed -i s/a/b/ test/a.js"), /inside the tests lane/);
  assert.match(bash(root, "git checkout -- test/a.js"), /inside the tests lane/);
  assert.match(bash(root, "git checkout -- ."), /inside the tests lane/);
  assert.match(bash(root, "cd test && touch f"), /inside the tests lane/);
  assert.match(bash(root, "bash -c 'echo x > test/f'"), /inside the tests lane/);
  assert.equal(bash(root, "echo x > src/f"), null);
  assert.equal(bash(root, "rm -rf src"), null);
  assert.equal(bash(root, "cat test/a.js > src/copy.js"), null);
  assert.equal(bash(root, "node --test test/a.test.js"), null);
});

test("sync_fix stage may not write the protected set, and a repository without one confines nothing", () => {
  const root = mkRepo();
  setStage(root, "sync_fix");
  assert.match(write_(root, "vendor/kit/k.svg"), /inside the protected lane/);
  assert.match(bash(root, "echo x > vendor/kit/new.svg"), /inside the protected lane/);
  assert.equal(write_(root, "test/a.js"), null);
  assert.equal(write_(root, "src/a.js"), null);

  const bare = mkRepo({ lanes: { tests: ["test/**"] } });
  setStage(bare, "sync_fix");
  assert.equal(write_(bare, "vendor/kit/k.svg"), null);
  assert.equal(write_(bare, "test/a.js"), null);
});

test("the marker is found from a subdirectory and without CLAUDE_PROJECT_DIR", () => {
  const root = mkRepo();
  setStage(root, "implement");
  const sub = path.join(root, "src");
  const out = run(JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(root, "test/a.js") }, cwd: sub }), {});
  assert.match(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, /inside the tests lane/);
  assert.equal(
    run(JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(root, "src/a.js") }, cwd: sub }), {}),
    "",
  );
});

test("a linked worktree has its own marker", () => {
  const root = mkRepo();
  const wt = path.join(path.dirname(root), `${path.basename(root)}-wt`);
  made.push(wt);
  sh(root, "git", "worktree", "add", "-q", "-b", "wt", wt);
  setStage(wt, "implement");
  assert.match(write_(wt, "test/a.js"), /inside the tests lane/);
  assert.equal(write_(root, "test/a.js"), null);
  const gitdir = sh(wt, "git", "rev-parse", "--git-dir").trim();
  assert.match(write_(wt, path.join(path.resolve(wt, gitdir), "archon-stage")), /outside the worktree|git directory/);
  assert.match(write_(wt, ".git"), /git directory/);
  assert.equal(write_(wt, "src/a.js"), null);
  clearStage(wt);
  assert.equal(write_(wt, "test/a.js"), null);
});

test("a path ignored by git stays writable", () => {
  const root = mkRepo();
  setStage(root, "implement");
  assert.equal(write_(root, "test/node_modules/pkg/index.js"), null);
  assert.equal(bash(root, "echo x > test/run.log"), null);
  assert.equal(bash(root, "rm -rf test/node_modules"), null);
  setStage(root, "tests");
  assert.equal(bash(root, "mkdir -p node_modules"), null);
  assert.equal(bash(root, "rm -rf node_modules"), null);
  assert.equal(write_(root, "node_modules/pkg/index.js"), null);
  assert.equal(write_(root, "src/debug.log"), null);
  assert.match(write_(root, "src/new.js"), /outside the tests lane/);
});

test("outside the worktree only the conventions and the declared directories are writable", NEEDS_HOME_OUTSIDE_TMP, () => {
  const root = mkRepo();
  const declared = mkdtemp(HOME, "lane-hook-art-");
  const sibling = mkdtemp(HOME, "lane-hook-sib-");
  setStage(root, "implement", declared);
  assert.match(write_(root, path.join(HOME, "outside.txt")), /outside the worktree/);
  assert.match(write_(root, path.join(sibling, "x")), /outside the worktree/);
  assert.match(write_(root, path.join(declared, "..", path.basename(sibling), "x")), /outside the worktree/);
  assert.equal(write_(root, path.join(declared, "blocked.md")), null);
  assert.equal(write_(root, path.join(declared, "deep", "x.md")), null);
  assert.equal(write_(root, "/tmp/lane-scratch.txt"), null);
  assert.equal(write_(root, path.join(os.tmpdir(), "lane-scratch.txt")), null);
  assert.equal(bash(root, "echo x > /dev/null"), null);
  assert.equal(bash(root, "echo x > /dev/stderr"), null);
  assert.equal(bash(root, "echo x > /dev/tty"), null);
  assert.match(bash(root, "echo x > /dev/sda"), /outside the worktree/);
  assert.equal(bash(root, `echo x > ${declared}/blocked.md`), null);
  assert.match(bash(root, `echo x > ${sibling}/f`), /outside the worktree/);
  assert.equal(bash(root, "touch /tmp/lane-scratch"), null);
  assert.match(bash(root, `cp src/a.js ${HOME}/stolen.js`), /outside the worktree/);
  assert.match(bash(root, "cd .. && touch f"), /outside the worktree/);
  assert.match(bash(root, "cd /home && touch f"), /outside the worktree/);
  assert.equal(bash(root, "cd /tmp && touch f"), null);
  assert.match(bash(root, "touch f", { cwd: HOME }), /outside the worktree/);
  for (const stage of ["tests", "repair", "sync_fix"]) {
    setStage(root, stage);
    assert.match(write_(root, path.join(HOME, "outside.txt")), /outside the worktree/, stage);
  }
});

test("the marker and the git directory cannot be written", () => {
  const root = mkRepo();
  setStage(root, "tests");
  assert.match(write_(root, ".git/archon-stage"), /git directory/);
  assert.match(write_(root, ".git/config"), /git directory/);
  assert.match(write_(root, ".git/hooks/pre-commit"), /git directory/);
  assert.match(bash(root, "echo '{}' > .git/archon-stage"), /git directory/);
  assert.match(bash(root, "rm .git/archon-stage"), /git directory/);
  assert.match(bash(root, "rm -rf .git"), /git directory/);
  setStage(root, "implement");
  assert.match(write_(root, ".git/archon-stage"), /git directory/);
});

test("a symlink inside the worktree cannot reach outside it", NEEDS_HOME_OUTSIDE_TMP, () => {
  const root = mkRepo();
  const elsewhere = mkdtemp(HOME, "lane-hook-link-");
  fs.symlinkSync(elsewhere, path.join(root, "src", "escape"));
  setStage(root, "implement");
  assert.match(write_(root, "src/escape/x"), /outside the worktree/);
});

test("a broken marker, missing lanes and internal errors refuse the call", () => {
  const root = mkRepo();
  const marker = path.join(root, ".git", "archon-stage");

  setStage(root, "implement");
  const boom = run(JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(root, "src/a.js") }, cwd: root }),
    { CLAUDE_PROJECT_DIR: root }, () => { throw new Error("boom"); });
  assert.match(JSON.parse(boom).hookSpecificOutput.permissionDecisionReason, /internal error.*boom/s);

  fs.writeFileSync(marker, "not json");
  assert.match(write_(root, "src/a.js"), /not valid JSON/);
  fs.writeFileSync(marker, JSON.stringify({ stage: 1, allow: [] }));
  assert.match(write_(root, "src/a.js"), /must be/);
  fs.writeFileSync(marker, JSON.stringify({ stage: "implement" }));
  assert.match(write_(root, "src/a.js"), /must be/);
  fs.writeFileSync(marker, JSON.stringify({ stage: "implement", allow: [3] }));
  assert.match(write_(root, "src/a.js"), /must be/);

  setStage(root, "implement");
  fs.renameSync(path.join(root, ".archon/lanes.json"), path.join(root, ".archon/lanes.off"));
  assert.match(write_(root, "src/a.js"), /lanes\.json is missing or invalid/);
  fs.writeFileSync(path.join(root, ".archon/lanes.json"), "{oops");
  assert.match(write_(root, "src/a.js"), /lanes\.json is missing or invalid/);
  fs.writeFileSync(path.join(root, ".archon/lanes.json"), JSON.stringify({ tests: [] }));
  assert.match(write_(root, "src/a.js"), /declares no "tests" globs/);
  fs.writeFileSync(path.join(root, ".archon/lanes.json"), JSON.stringify({ tests: "test/**" }));
  assert.match(write_(root, "src/a.js"), /declares no "tests" globs/);

  const garbled = run("{not json", { CLAUDE_PROJECT_DIR: root });
  assert.match(JSON.parse(garbled).hookSpecificOutput.permissionDecisionReason, /not valid JSON/);
});

test("a stage the table does not name, no marker, and a non-git directory allow the call", () => {
  const root = mkRepo();
  fs.writeFileSync(path.join(root, ".git", "archon-stage"), JSON.stringify({ stage: "review", allow: [] }));
  assert.equal(write_(root, "test/a.js"), null);
  clearStage(root);
  assert.equal(write_(root, "test/a.js"), null);
  assert.equal(run("{not json", { CLAUDE_PROJECT_DIR: root }), "");

  const plain = mkdtemp(os.tmpdir(), "lane-nogit-");
  assert.equal(run(JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(plain, "x") }, cwd: plain }), {}), "");
});

test("the hook script prints nothing on allow, deny JSON on refuse, and exits 0 both times", () => {
  const root = mkRepo();
  setStage(root, "implement");
  const call = (file) =>
    spawnSync("node", [HOOK], {
      input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(root, file) }, cwd: root }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: "utf8",
    });
  const ok = call("src/a.js");
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, "");
  const bad = call("test/a.js");
  assert.equal(bad.status, 0);
  assert.equal(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("lane.sh stage, unstage and verify", () => {
  const root = mkRepo();
  const marker = path.join(root, ".git", "archon-stage");
  setStage(root, "tests");
  const noSnapshot = () => {
    const { snapshot, ...rest } = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert.match(snapshot, /^[0-9a-f]{40}$/);
    return rest;
  };
  assert.deepEqual(noSnapshot(), { stage: "tests", allow: [] });
  setStage(root, "implement", "/a/b", "/c d");
  assert.deepEqual(noSnapshot(), { stage: "implement", allow: ["/a/b", "/c d"] });
  clearStage(root);
  assert.equal(fs.existsSync(marker), false);
  clearStage(root);

  sh(root, "bash", STAGE_SH, "verify");
  fs.writeFileSync(path.join(root, ".claude/settings.json"), JSON.stringify({ attribution: { commit: "" } }));
  assert.throws(() => sh(root, "bash", STAGE_SH, "verify"), /does not enforce the lanes/);
  fs.writeFileSync(path.join(root, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "other.sh" }] }] } }));
  assert.throws(() => sh(root, "bash", STAGE_SH, "verify"), /does not enforce the lanes/);
  fs.rmSync(path.join(root, ".claude/settings.json"));
  assert.throws(() => sh(root, "bash", STAGE_SH, "verify"), /does not enforce the lanes/);
  assert.throws(() => sh(root, "bash", STAGE_SH, "bogus"), /unknown command/);
});

// ---- Codex payloads -------------------------------------------------------------------------------

const patch = (...ops) => `*** Begin Patch\n${ops.join("\n")}\n*** End Patch\n`;
const add = (f) => `*** Add File: ${f}\n+x`;
const upd = (f, to) => `*** Update File: ${f}\n${to ? `*** Move to: ${to}\n` : ""}@@\n-a\n+b`;
const del = (f) => `*** Delete File: ${f}`;

test("patchTargets reads every path an apply_patch patch adds, updates, deletes or moves to", () => {
  assert.deepEqual(patchTargets(patch(add("a.js"), upd("b.js", "c.js"), del("d.js"))), ["a.js", "b.js", "c.js", "d.js"]);
  assert.deepEqual(patchTargets("*** Add File: with space.js  \r\n"), ["with space.js"]);
  assert.deepEqual(patchTargets("no patch here"), []);
});

test("commandText joins an argv array and takes the script of a shell -c call", () => {
  assert.equal(commandText("echo a"), "echo a");
  assert.equal(commandText(["echo", "a", ">", "f"]), "echo a > f");
  assert.equal(commandText(["bash", "-lc", "echo a > f"]), "echo a > f");
  assert.equal(commandText(["/bin/sh", "-c", "echo a > f"]), "echo a > f");
  assert.equal(commandText(undefined), "");
});

test("an apply_patch call is judged by the files its patch writes, whichever field holds the patch", () => {
  const root = mkRepo();
  setStage(root, "implement");
  for (const shape of [(p) => ({ command: p }), (p) => ({ patch: p }), (p) => ({ input: p }), (p) => ({ command: ["apply_patch", p] }), (p) => ({ nested: { text: p } })]) {
    assert.equal(judge(root, "apply_patch", shape(patch(add("src/new.js")))), null);
    assert.match(judge(root, "apply_patch", shape(patch(add("test/new.js")))), /inside the tests lane/);
    assert.match(judge(root, "apply_patch", shape(patch(add("src/ok.js"), upd("test/a.js")))), /test\/a\.js/);
    assert.match(judge(root, "apply_patch", shape(patch(del("test/a.js")))), /inside the tests lane/);
    assert.match(judge(root, "apply_patch", shape(patch(upd("src/a.js", "test/moved.js")))), /test\/moved\.js/);
  }
  setStage(root, "tests");
  assert.equal(judge(root, "apply_patch", { command: patch(add("test/new.js")) }), null);
  assert.match(judge(root, "apply_patch", { command: patch(add("src/new.js")) }), /outside the tests lane/);
});

test("apply_patch paths are resolved against the payload's cwd, and one outside the worktree is refused", NEEDS_HOME_OUTSIDE_TMP, () => {
  const root = mkRepo();
  setStage(root, "implement");
  assert.match(judge(root, "apply_patch", { command: patch(add("b.js")) }, { cwd: path.join(root, "test", "sub") }), /test\/sub\/b\.js/);
  assert.equal(judge(root, "apply_patch", { command: patch(add("c.js")) }, { cwd: path.join(root, "src") }), null);
  assert.match(judge(root, "apply_patch", { command: patch(add("../../elsewhere/x.js")) }), /outside the worktree/);
});

test("an apply_patch call whose files cannot be read is refused while a stage is confined, and allowed with no marker", () => {
  const root = mkRepo();
  assert.equal(judge(root, "apply_patch", { command: "garbage" }), null);
  setStage(root, "implement");
  assert.match(judge(root, "apply_patch", { command: "garbage" }), /cannot tell which files this apply_patch call writes/);
  assert.match(judge(root, "apply_patch", {}), /cannot tell which files/);
  clearStage(root);
  assert.equal(judge(root, "apply_patch", { command: "garbage" }), null);
});

test("a Codex shell call is judged whether its command is a string or an argv array", () => {
  const root = mkRepo();
  setStage(root, "implement");
  for (const tool of ["Bash", "shell", "local_shell", "shell_command", "exec_command"]) {
    assert.match(judge(root, tool, { command: "echo x > test/a.js" }), /inside the tests lane/, tool);
    assert.match(judge(root, tool, { command: ["bash", "-lc", "echo x > test/a.js"] }), /inside the tests lane/, tool);
    assert.match(judge(root, tool, { command: ["tee", "test/a.js"] }), /inside the tests lane/, tool);
    assert.equal(judge(root, tool, { command: ["bash", "-lc", "echo x > src/a.js"] }), null, tool);
  }
});

test("a shell call that runs apply_patch is judged by the patch in its text", () => {
  const root = mkRepo();
  setStage(root, "implement");
  const heredoc = (p) => `apply_patch <<'EOF'\n${p}EOF`;
  assert.match(judge(root, "Bash", { command: heredoc(patch(add("test/n.js"))) }), /test\/n\.js/);
  assert.equal(judge(root, "Bash", { command: heredoc(patch(add("src/n.js"))) }), null);
  assert.match(judge(root, "shell", { command: ["apply_patch", patch(upd("test/a.js"))] }), /test\/a\.js/);
});
