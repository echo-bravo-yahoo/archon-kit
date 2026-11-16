// The pieces the report kinds share: the run's state file, the gate table, test repairs, the
// stats banner, the how-to-answer section and the page of a Markdown report.
import fs from "node:fs";
import path from "node:path";
import { chooseHunks, isSkipped, parseDiff, renderDiff } from "./diff.mjs";
import { renderMarkdown } from "./markdown.mjs";
import { escapeHtml, section, sectionize } from "./shell.mjs";

export const readText = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
export const readArtifact = (dir, name) => readText(path.join(dir, name))?.trim() || null;

// The value of the last `key=value` line of the run's `state` file, the way `state.sh get` reads it.
export function readState(dir, key) {
  let value = null;
  for (const line of (readText(path.join(dir, "state")) ?? "").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0 && line.slice(0, eq) === key) value = line.slice(eq + 1).trim();
  }
  return value || null;
}

export function gateRows(markdown) {
  return [...(markdown ?? "").matchAll(/^\| `(.+)` \| (.+) \|$/gm)].map((m) => ({ gate: m[1], result: m[2].replace(/\*\*/g, "") }));
}

export function gatesSection(markdown, md) {
  const rows = gateRows(markdown);
  if (!rows.length) return md(markdown);
  const body = rows
    .map((r) => `<tr><td><code>${escapeHtml(r.gate)}</code></td><td><span class="badge ${/passed/.test(r.result) ? "pass" : "fail"}">${escapeHtml(r.result)}</span></td></tr>`)
    .join("");
  return `<table><thead><tr><th>Gate command</th><th>Result</th></tr></thead><tbody>${body}</tbody></table>`;
}

// One diff per line of repair-ranges.txt ("<base> <head>"), limited to the tests lane's pathspecs.
export function repairDiffs({ artifacts, git, diffArgs, lane, diffOptions }) {
  const ranges = (readArtifact(artifacts, "repair-ranges.txt") ?? "").split("\n").filter(Boolean);
  return ranges
    .map((line, i) => {
      const [base, head] = line.trim().split(/\s+/);
      const label = `<p><strong>Repair commit ${i + 1}</strong> <code>${escapeHtml(String(base).slice(0, 9))}..${escapeHtml(String(head).slice(0, 9))}</code></p>`;
      try {
        if ([base, head].some((r) => !r || r.startsWith("-"))) throw new Error("the range is not two commits");
        const files = parseDiff(git(...diffArgs, base, head, "--", ...lane)).filter((f) => !isSkipped(f.path, diffOptions));
        const chosen = chooseHunks(files, [], { maxFiles: 10, maxPicks: 20, maxLines: 300 }, []);
        return label + (chosen.files.length ? chosen.files.map((c) => renderDiff(c.file, c.hunks, diffOptions)).join("") : "<p>No change inside the tests lane.</p>");
      } catch (error) {
        return `${label}<p>The diff could not be read: ${escapeHtml(error.message.split("\n")[0])}</p>`;
      }
    })
    .join("");
}

export const stat = (value, label) => `<div class="stat"><b>${value}</b><span>${escapeHtml(label)}</span></div>`;

// `stuck` is only true for a run whose definition predates the failure at five rounds: such a run still pauses
// after three rounds that did not pass and records `pause-kind=stuck`, and it calls this builder from disk.
export function howToAnswer(run, stuck) {
  const respond = `archon workflow respond ${run}`;
  return `<ul>
<li><code>approve</code> lands these commits on local main. After that the run needs no one: it rebases onto main, resolves any conflict, re-runs the gates and lands once main has not moved. Nothing is pushed.</li>
<li><code>rework</code> sends your note back for another implement round. A note that needs a test changed goes to the repair stage.</li>
<li><code>abandon</code> cancels the run and leaves the branch and its worktree.</li>
</ul>
<pre><code>${escapeHtml(`${respond} approve\n${respond} rework "your note"\n${respond} abandon`)}</code></pre>
${stuck ? `<div class="callout bad"><p>This pause cannot land the change, so <code>approve</code> counts as <code>rework</code>. Every answer starts another round, and the run fails when it reaches round 30.</p></div>` : ""}`;
}

// A Markdown report as sections: its text before the first ## is the summary, and each ## and ###
// is a section. Returns the title, the section HTML and the contents entries.
export function markdownSections(report, design, mdOptions) {
  const title = /^# (.+)\n/.exec(report)?.[1].trim() || design;
  const body = report.replace(/^# .*\n/, "");
  const first = body.search(/^## /m);
  const intro = (first < 0 ? body : body.slice(0, first)).trim();
  const ids = new Set(["summary"]);
  const sections = [];
  const toc = [];
  if (intro) {
    sections.push(section({ id: "summary", title: "Summary", html: renderMarkdown(intro, mdOptions) }));
    toc.push({ level: 2, id: "summary", text: "Summary" });
  }
  if (first >= 0) {
    const split = sectionize(renderMarkdown(body.slice(first), { ...mdOptions, demote: 0 }), ids);
    sections.push(split.html);
    toc.push(...split.toc);
  }
  return { title, sections, toc, ids };
}
