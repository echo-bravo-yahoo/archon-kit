#!/usr/bin/env node
// The kit's default report page builder. Each page is one self-contained HTML file.
//
//   node build.mjs KIND --out FILE --design SLUG --run ID --artifacts DIR [--status TEXT] [--plugin FILE] ...
//
//   plan      --spec FILE [--options-page URL]   the plan gate: spec { summary, files, question }, plan.md, plan-notes.md
//   review    --base REF --head REF --picks FILE [--shots DIR]   the final gate: the diff, gate-report.md, report.md,
//             test-repairs.md, repair-ranges.txt, mutation-report.md and the `state` keys review-verdict and pause-kind
//   research  --spec FILE                         report.md, steer.md and follow-up-plan.json (both optional); the banner
//             shows { confidence }, the round and the follow-up runs it proposes
//   any other --report FILE                       a Markdown report, with --status as its status line
//
// --plugin names an ES module whose default export adds to the page: `css`, `fences`, `highlight`,
// `diff` ({ skip, languages }) and `sections[kind](ctx, kit)`. Every hook runs in a try/catch, and an
// error writes `plugin <hook>: <message>` to stderr and costs that hook's output, not the page.
// Exits 1 when a required input cannot be read and 2 when a flag is missing.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chooseHunks, isSkipped, parseDiff, renderDiff } from "./diff.mjs";
import { renderMarkdown } from "./markdown.mjs";
import { gateRows, gatesSection, howToAnswer, markdownSections, readArtifact, readState, readText, repairDiffs, stat } from "./sections.mjs";
import { escapeHtml, page, plainText, section, sectionize, slugify, uniqueId } from "./shell.mjs";

const COMMON = ["out", "design", "run", "artifacts", "status", "plugin"];
const KIND_FLAGS = { plan: ["spec", "options-page"], review: ["base", "head", "picks", "shots"], research: ["spec"] };
const OTHER_FLAGS = ["report"];

const fail = (message, code = 1) => {
  console.error(`build: ${message}`);
  process.exit(code);
};

function parseArgs(argv) {
  const [kind, ...rest] = argv;
  if (!kind || kind.startsWith("-")) fail("usage: build.mjs KIND --out FILE --design SLUG --run ID --artifacts DIR [flags] (see the header of this file)", 2);
  const known = [...COMMON, ...(KIND_FLAGS[kind] ?? OTHER_FLAGS)];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i].replace(/^--/, "");
    if (!rest[i].startsWith("--") || !known.includes(name)) {
      console.error(`build: ignoring unknown flag ${rest[i]}`);
      if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) i++;
      continue;
    }
    if (rest[i + 1] === undefined) fail(`--${name} needs a value`, 2);
    flags[name] = rest[++i];
  }
  for (const name of ["out", "design", "run", "artifacts"]) if (flags[name] === undefined) fail(`${kind} needs --${name}`, 2);
  return { kind, flags };
}

const warn = (hook, error) => console.error(`plugin ${hook}: ${error?.message ?? error}`);
const readJson = (file, what) => {
  const text = file === undefined ? null : readText(file);
  if (text === null) fail(`cannot read ${what} ${file}`);
  try {
    return JSON.parse(text);
  } catch (error) {
    return fail(`${what} ${file} is not JSON: ${error.message}`);
  }
};

async function loadPlugin(file) {
  if (!file) return {};
  try {
    const mod = await import(pathToFileURL(path.resolve(file)).href);
    const plugin = mod.default;
    return plugin && typeof plugin === "object" ? plugin : {};
  } catch (error) {
    console.error(`plugin load: ${error?.message ?? error}`);
    return {};
  }
}

// Reads one plugin hook, so that a getter that throws costs that hook.
function hook(name, read) {
  try {
    return read();
  } catch (error) {
    warn(name, error);
    return undefined;
  }
}

const git = (...args) =>
  execFileSync("git", ["-c", "core.quotepath=off", ...args], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
const DIFF_ARGS = ["diff", "--no-color", "--no-ext-diff", "--no-renames", "-U3"];

function validRef(ref) {
  if (typeof ref !== "string" || !ref || ref.startsWith("-")) return false;
  try {
    git("rev-parse", "--verify", "-q", `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

function testLane() {
  const lane = path.join(process.env.ARCHON_HOME || path.join(process.env.HOME ?? "", ".archon"), "scripts", "lane.sh");
  try {
    return execFileSync("bash", [lane, "list", "--set", "tests"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const stamp = () => new Date().toISOString().slice(0, 16).replace("T", " ");

function write(out, html) {
  const dest = path.resolve(out);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, html);
    fs.renameSync(tmp, dest);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  console.log(`built ${out} (${(html.length / 1024).toFixed(0)} KB)`);
}

// ---- review ----------------------------------------------------------------------------------------

function buildReview(f, env) {
  const picks = readJson(f.picks, "picks file");
  const art = f.artifacts;
  // Only a run whose definition predates the failure at five rounds records this (see howToAnswer).
  const stuck = readState(art, "pause-kind") === "stuck";
  const gateReport = readArtifact(art, "gate-report.md");
  const review = readArtifact(art, "report.md");
  const verdict = readState(art, "review-verdict") ?? /^Verdict:\s*(\w+)/im.exec(review ?? "")?.[1]?.toLowerCase() ?? "unknown";
  const repairs = readArtifact(art, "test-repairs.md");
  const lane = testLane();
  const md = (src) => renderMarkdown(src, env.md);

  let files = [];
  let commits = [];
  let changes = false;
  const bad = ["base", "head"].filter((k) => !validRef(f[k]));
  if (bad.length) {
    console.error(`build: skipping the Changes sections, because --${bad.join(" and --")} does not name a commit`);
  } else {
    try {
      files = parseDiff(git(...DIFF_ARGS, `${f.base}...${f.head}`));
      commits = git("log", "--no-color", "--no-ext-diff", "--no-merges", "--pretty=%h %s", `${f.base}..${f.head}`).trim().split("\n").filter(Boolean);
      changes = true;
    } catch (error) {
      console.error(`build: skipping the Changes sections: ${error.message.split("\n")[0]}`);
    }
  }
  const added = files.reduce((s, x) => s + x.add, 0);
  const removed = files.reduce((s, x) => s + x.del, 0);
  const rows = gateRows(gateReport);
  const passed = rows.filter((r) => /passed/.test(r.result)).length;

  const items = [];
  const add = (id, title, html, open = true) => items.push({ id, title, html: section({ id, title, html, open }) });

  // What the owner's own answers showed leads the page, because an interactive run exists to get them.
  if (picks.findings?.trim()) add("findings", "What the run found", md(picks.findings));
  // Open items sit in the Summary's entry, so a plugin section placed after the Summary comes after them.
  const openItems = (Array.isArray(picks.open_items) ? picks.open_items : []).filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().replace(/\s+/g, " "));
  const openHtml = openItems.length ? section({ id: "open-items", title: "Open items", html: md(openItems.map((x) => `- ${x}`).join("\n")) }) : "";
  const openToc = openItems.length ? [{ level: 2, id: "open-items", text: "Open items" }] : [];
  if (picks.summary?.trim()) {
    items.push({
      ids: ["summary", ...openToc.map((t) => t.id)],
      html: section({ id: "summary", title: "Summary", html: md(picks.summary) }) + openHtml,
      toc: [{ level: 2, id: "summary", text: "Summary" }, ...openToc],
    });
  } else if (openItems.length) {
    items.push({ ids: ["open-items"], html: openHtml, toc: openToc });
  }
  if (repairs) {
    const diffs = repairDiffs({ artifacts: art, git, diffArgs: DIFF_ARGS, lane, diffOptions: env.diff });
    add("test-repairs", "Test repairs", `<p>The repair stage changed these tests because the implementer could not satisfy them.</p>${md(repairs.replace(/^# Test repairs\s*\n/, ""))}${diffs}`);
  }
  if (changes) {
    const shown = files.filter((x) => !isSkipped(x.path, env.diff));
    const chosen = chooseHunks(shown, picks.picks, { maxFiles: 10, maxPicks: 14, maxLines: 450 }, lane);
    const hunkCount = chosen.files.reduce((n, c) => n + c.hunks.length, 0);
    const note = chosen.fallback
      ? `<div class="callout warn"><p>No pick matched a change, so these are the largest hunks of the source files outside the tests lane.</p></div>`
      : "";
    add(
      "key-changes",
      "Key changes",
      `${note}<p>${hunkCount} hunk${hunkCount === 1 ? "" : "s"} in ${chosen.files.length} of ${files.length} changed files.</p>${chosen.files.map((c) => renderDiff(c.file, c.hunks, env.diff)).join("")}`,
    );
  }
  if (gateReport) add("gates", "Gate commands", gatesSection(gateReport, md));
  const mutation = readArtifact(art, "mutation-report.md");
  if (mutation) add("mutation", "Mutation check", md(mutation.replace(/^# .*\n/, "")));
  if (review) add("review", "Review", md(review));
  const answers = readArtifact(art, "owner-notes.md");
  if (answers) add("owner-answers", "Your answers during the run", md(answers.replace(/^# .*\n/, "")), false);
  if (changes) {
    const fileRows = files
      .slice(0, 60)
      .map((x) => `<tr><td><code>${escapeHtml(x.path)}</code></td><td class="add">+${x.add}</td><td class="del">−${x.del}</td></tr>`)
      .join("");
    const more = files.length > 60 ? `<p>${files.length - 60} more files are not listed.</p>` : "";
    const more2 = commits.length > 30 ? `<p>${commits.length - 30} more commits are not listed.</p>` : "";
    add(
      "all-changes",
      "All changes",
      `<table><thead><tr><th>File</th><th>Added</th><th>Removed</th></tr></thead><tbody>${fileRows}</tbody></table>${more}<p><strong>Commits</strong></p><ul>${commits
        .slice(0, 30)
        .map((c) => `<li>${escapeHtml(c)}</li>`)
        .join("")}</ul>${more2}`,
      false,
    );
  }
  const answer = { id: "how-to-answer", title: "How to answer", html: section({ id: "how-to-answer", title: "How to answer", html: howToAnswer(f.run, stuck) }) };

  const openStat = openItems.length ? stat(String(openItems.length), openItems.length === 1 ? "open item" : "open items") : "";
  const banner = `<div class="stats">${stat(rows.length ? `${passed} of ${rows.length}` : "none", "gate commands passed")}${stat(escapeHtml(verdict), "review verdict")}${openStat}${stat(String(files.length), "files changed")}${stat(`<span class="add">+${added}</span> <span class="del">−${removed}</span>`, "lines added and removed")}</div>`;
  const all = env.insert(items.map((i) => ({ ids: i.ids ?? [i.id], html: i.html, toc: i.toc ?? [{ level: 2, id: i.id, text: i.title }] })), { picks }, [
    { ids: [answer.id], html: answer.html, toc: [{ level: 2, id: answer.id, text: answer.title }] },
  ]);
  return {
    title: `${f.design} review`,
    status: f.status || (stuck ? "Stuck: this pause cannot land the change" : "Ready to land"),
    meta: `Run ${f.run}. Generated ${stamp()} UTC.`,
    banner,
    all,
  };
}

// ---- plan ------------------------------------------------------------------------------------------

// The options page shares this shell, so its <main> holds finished sections and its contents list
// names their headings. Null when the file is missing or is not such a page.
function optionsSections(file) {
  const html = readText(file);
  const main = html && /<main>([\s\S]*)<\/main>/.exec(html);
  if (!main) return null;
  const toc = [...html.matchAll(/<li class="l([23])"><a href="#([^"]*)">([\s\S]*?)<\/a><\/li>/g)].map((m) => ({ level: Number(m[1]), id: m[2], text: plainText(m[3]) }));
  return toc.length ? { html: main[1], toc } : null;
}

// The hand-offs a plan's approval starts, from handoffs-approved.json. Null when the file is missing or
// invalid, which a run that predates the file also leaves, so the page then says nothing about them.
function readHandoffs(art) {
  try {
    const list = JSON.parse(readArtifact(art, "handoffs-approved.json") ?? "null");
    return Array.isArray(list) ? list.filter((h) => h && typeof h.workflow === "string") : null;
  } catch {
    return null;
  }
}

const handoffLabel = (h) => {
  const inputs = (Array.isArray(h.inputs) ? h.inputs : []).filter((i) => i && typeof i.name === "string").map((i) => `${i.name}=${i.value}`);
  return [h.workflow, ...inputs].join(" ");
};

// What approving the plan does, and which stages the plan skips: the second callout of the banner.
function approveCallout(handoffs, excuses) {
  const lines = [];
  if (handoffs) {
    lines.push(
      handoffs.length
        ? `Approve starts this build, then: ${handoffs.map((h) => `<code>${escapeHtml(handoffLabel(h))}</code>`).join(", ")}.`
        : "Approve starts this build and nothing after it.",
    );
  }
  for (const x of Array.isArray(excuses) ? excuses : []) {
    if (x && typeof x.node === "string" && typeof x.reason === "string") lines.push(`Skips <code>${escapeHtml(x.node)}</code>: ${escapeHtml(x.reason.trim())}`);
  }
  return lines.length ? `<div class="callout">${lines.map((l) => `<p>${l}</p>`).join("")}</div>` : "";
}

function buildPlan(f, env) {
  const spec = readJson(f.spec, "spec file");
  const art = f.artifacts;
  const md = (src, o) => renderMarkdown(src, { ...env.md, ...o });
  const options = f["options-page"] ? optionsSections(path.resolve(path.dirname(f.out), f["options-page"])) : null;
  const ids = new Set(["summary", "files", "plan-overview", "owner-notes", "options-page", ...(options?.toc ?? []).map((t) => t.id)]);
  const items = [];
  const add = (id, title, html) => items.push({ ids: [id], html: section({ id, title, html }), toc: [{ level: 2, id, text: title }] });

  if (spec.summary?.trim()) add("summary", "Summary", md(spec.summary));
  if (options) items.push({ ids: options.toc.map((t) => t.id), html: options.html, toc: options.toc });
  if (spec.files?.length) add("files", "Files it will touch", `<ul>${spec.files.map((x) => `<li><code>${escapeHtml(x)}</code></li>`).join("")}</ul>`);
  const plan = readArtifact(art, "plan.md")?.replace(/^# .*\n/, "");
  if (plan) {
    const first = plan.search(/^## /m);
    const overview = (first < 0 ? plan : plan.slice(0, first)).trim();
    if (overview) add("plan-overview", "Plan overview", md(overview));
    if (first >= 0) {
      const split = sectionize(md(plan.slice(first), { demote: 0 }), ids);
      items.push({ ids: split.toc.map((t) => t.id), html: split.html, toc: split.toc });
    }
  }
  const notes = readArtifact(art, "plan-notes.md");
  if (notes) add("owner-notes", "Your earlier notes", md(notes));
  if (f["options-page"] && !options) add("options-page", "Options page", `<p>The planner drew the options for you to choose from: <a href="${escapeHtml(f["options-page"])}">open the options page</a>.</p>`);

  const question = spec.question?.trim() ? `<div class="callout">${md(`**Decision:** ${spec.question.trim()}`)}</div>` : "";
  return {
    title: `${f.design} plan`,
    status: f.status || "Plan awaiting your decision",
    meta: `Run ${f.run}. Generated ${stamp()} UTC.`,
    banner: question + approveCallout(readHandoffs(art), spec.excuses),
    all: env.insert(items, { spec }, []),
  };
}

// ---- research ---------------------------------------------------------------------------------------

// The follow-up runs the research pause can start, from follow-up-plan.json. Null when the file is missing
// or invalid, which a run whose page is built before `follow_plan` also leaves.
function readFollowUps(art) {
  try {
    const list = JSON.parse(readArtifact(art, "follow-up-plan.json") ?? "null");
    return Array.isArray(list) ? list.filter((x) => x && typeof x.workflow === "string") : null;
  } catch {
    return null;
  }
}

const followUpLabel = (x) => {
  const inputs = (Array.isArray(x.inputs) ? x.inputs : []).filter((i) => i && typeof i.name === "string").map((i) => `${i.name}=${i.value}`);
  return [x.workflow, ...(typeof x.repo === "string" && x.repo ? ["in", x.repo] : []), ...inputs].join(" ");
};

function followUpsSection(list, ids) {
  const id = uniqueId("Follow-up runs it proposes", ids, "follow-ups");
  const rows = list
    .map((x) => {
      const inputs = (Array.isArray(x.inputs) ? x.inputs : []).filter((i) => i && typeof i.name === "string");
      return `<tr><td><code>${escapeHtml(x.workflow)}</code></td><td>${typeof x.repo === "string" && x.repo ? `<code>${escapeHtml(x.repo)}</code>` : "this repository"}</td><td>${inputs.map((i) => `<code>${escapeHtml(`${i.name}=${i.value}`)}</code>`).join(" ")}</td><td>${escapeHtml(typeof x.note === "string" ? x.note : "")}</td></tr>`;
    })
    .join("");
  const html = `<p>Answering <code>follow-up</code> at the pause starts these runs, each from the report.</p><table><thead><tr><th>Workflow</th><th>Repository</th><th>Inputs</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table>`;
  return { ids: [id], html: section({ id, title: "Follow-up runs it proposes", html }), toc: [{ level: 2, id, text: "Follow-up runs it proposes" }] };
}

function buildResearch(f, env, report, spec) {
  const art = f.artifacts;
  const { title, sections, toc, ids } = markdownSections(report, f.design, env.md);
  const round = (readArtifact(art, "steer.md")?.match(/^## Note\s*$/gm)?.length ?? 0) + 1;
  const followUps = readFollowUps(art);
  const count = followUps?.length ?? 0;
  const status = f.status || `Round ${round}${followUps ? `: ${count ? `${count} follow-up run${count === 1 ? "" : "s"} proposed` : "no follow-up proposed"}` : ""}`;

  const stats = [];
  if (typeof spec?.confidence === "string" && spec.confidence) stats.push(stat(escapeHtml(spec.confidence), "confidence"));
  stats.push(stat(String(round), "round"));
  if (followUps) stats.push(stat(String(count), count === 1 ? "follow-up run proposed" : "follow-up runs proposed"));
  const decision = followUps
    ? `<div class="callout"><p>${
        count
          ? `<strong>Your decision:</strong> close, dig deeper with a note, or start the follow-ups: ${followUps.map((x) => `<code>${escapeHtml(followUpLabel(x))}</code>`).join(", ")}.`
          : "<strong>Your decision:</strong> close, or dig deeper with a note."
      }</p></div>`
    : "";

  const hasSummary = toc[0]?.id === "summary";
  const items = [];
  if (hasSummary) items.push({ ids: ["summary"], html: sections[0], toc: [toc[0]] });
  if (count) items.push(followUpsSection(followUps, ids));
  const rest = hasSummary ? 1 : 0;
  const restToc = toc.slice(rest);
  items.push({ ids: restToc.map((t) => t.id), html: sections.slice(rest).join(""), toc: restToc });
  return { title, status, meta: `Run ${f.run}. Generated ${stamp()} UTC.`, banner: `<div class="stats">${stats.join("")}</div>${decision}`, all: env.insert(items, {}, []) };
}

// ---- cleanup and any other kind ---------------------------------------------------------------------

function buildMarkdown(f, env, report, status) {
  const { title, sections, toc } = markdownSections(report, f.design, env.md);
  const items = [{ ids: toc.map((t) => t.id), html: sections.join(""), toc }];
  return { title, status, meta: `Run ${f.run}. Generated ${stamp()} UTC.`, banner: "", all: env.insert(items, {}, []) };
}

// ---- plugin ----------------------------------------------------------------------------------------

const KIT = { escapeHtml, section, renderMarkdown, renderDiff, parseDiff, chooseHunks, sectionize, plainText, slugify, uniqueId };

function pluginEnv(plugin, kind, f) {
  const diff = hook("diff", () => plugin.diff) ?? {};
  const fences = hook("fences", () => ({ ...(plugin.fences ?? {}) })) ?? {};
  const highlight = typeof plugin.highlight === "function" ? (code, lang) => plugin.highlight(code, lang) : undefined;
  const env = {
    css: hook("css", () => (typeof plugin.css === "string" ? plugin.css : "")) ?? "",
    diff: {
      skip: hook("diff", () => diff.skip),
      languages: hook("diff", () => diff.languages),
      highlight,
      onError: warn,
    },
    md: { fences, onError: warn },
  };
  // Inserts the plugin's sections for this kind into `items` ([{ ids, html, toc }]), each after the
  // section its `after` names, and puts `tail` last. The result is the page's { body, toc }.
  env.insert = (items, extra, tail) => {
    const list = [...items];
    const make = hook("sections", () => plugin.sections?.[kind]);
    if (typeof make === "function") {
      const stateObj = {};
      for (const line of (readText(path.join(f.artifacts, "state")) ?? "").split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) stateObj[line.slice(0, eq)] = line.slice(eq + 1).trim();
      }
      let extras = [];
      try {
        const ctx = { kind, design: f.design, run: f.run, artifacts: f.artifacts, args: f, picks: extra.picks ?? null, spec: extra.spec ?? null, state: stateObj };
        extras = make(ctx, KIT);
        if (!Array.isArray(extras)) extras = [];
      } catch (error) {
        warn("sections", error);
      }
      const used = new Set(list.flatMap((i) => i.ids).concat(tail.flatMap((i) => i.ids)));
      for (const x of extras) {
        if (!x || typeof x.title !== "string" || typeof x.html !== "string") continue;
        const id = uniqueId(x.title, used, x.id);
        const item = { ids: [id], html: section({ id, title: x.title, html: x.html }), toc: [{ level: 2, id, text: x.title }] };
        const at = typeof x.after === "string" ? list.findIndex((i) => i.ids.includes(x.after)) : -1;
        if (at >= 0) {
          let end = at + 1;
          while (end < list.length && list[end].pluginAfter === x.after) end++;
          item.pluginAfter = x.after;
          list.splice(end, 0, item);
        } else list.push(item);
      }
    }
    list.push(...tail);
    return list;
  };
  return env;
}

// ---- main ------------------------------------------------------------------------------------------

const { kind, flags } = parseArgs(process.argv.slice(2));
const plugin = await loadPlugin(flags.plugin);
const env = pluginEnv(plugin, kind, flags);
try {
  let built;
  if (kind === "review") built = buildReview(flags, env);
  else if (kind === "plan") built = buildPlan(flags, env);
  else if (kind === "research") {
    const spec = readJson(flags.spec, "spec file");
    const report = readArtifact(flags.artifacts, "report.md");
    if (!report) fail(`cannot read ${path.join(flags.artifacts, "report.md")}, or it is empty`);
    built = buildResearch(flags, env, report, spec);
  } else {
    const report = flags.report === undefined ? null : readText(flags.report)?.trim();
    if (!report) fail(`cannot read ${flags.report}, or it is empty`);
    built = buildMarkdown(flags, env, report, flags.status || "Workflow cleanup");
  }
  const { all, ...head } = built;
  write(flags.out, page({ ...head, body: all.map((i) => i.html).join(""), toc: all.flatMap((i) => i.toc), css: env.css }));
} catch (error) {
  fail(error.stack ?? String(error));
}
