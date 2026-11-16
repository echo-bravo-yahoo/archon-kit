// Unified diffs for the review report: parse, choose the hunks worth reading, and render them as
// HTML tables. Lines are coloured as added or removed; a plugin may add syntax highlighting.
import path from "node:path";
import { escapeHtml } from "./shell.mjs";

const unquote = (p) => (p.startsWith('"') ? p.slice(1, -1) : p);

// Reads `git diff --no-color --no-ext-diff --no-renames -U3`.
export function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git (?:"?a\/.*?"?) ("?b\/.*"?)$/.exec(line);
      file = { path: unquote(m ? m[1] : line.slice(11)).replace(/^b\//, ""), add: 0, del: 0, hunks: [] };
      files.push(file);
      hunk = null;
    } else if (file && line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      hunk = { newStart: newNo, newLen: m[4] === undefined ? 1 : Number(m[4]), add: 0, del: 0, lines: [] };
      file.hunks.push(hunk);
    } else if (hunk && /^[ +-]/.test(line)) {
      const t = line[0];
      const entry = { t, text: line.slice(1), oldNo: t === "+" ? null : oldNo, newNo: t === "-" ? null : newNo };
      if (t !== "+") oldNo++;
      if (t !== "-") newNo++;
      if (t === "+") {
        hunk.add++;
        file.add++;
      } else if (t === "-") {
        hunk.del++;
        file.del++;
      }
      hunk.lines.push(entry);
    }
  }
  return files;
}

const globToRegExp = (glob) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*")}$`);

const NOT_CODE = /package-lock/;

// `picks` is [{ path, from, to, why }] with line numbers in the new version of the file. Returns
// { fallback, files: [{ file, hunks: [{ hunk, why }] }] }. A pick for a path that is not in the
// diff, or whose range overlaps no hunk, is ignored. When no pick matches, the largest hunks of
// the files outside `testGlobs` are taken instead. `testGlobs` are plain globs or `:(glob)` pathspecs.
export function chooseHunks(files, picks, { maxFiles = 10, maxPicks = 14, maxLines = 450 } = {}, testGlobs = []) {
  const chosen = new Map();
  const taken = new Set();
  let lines = 0;
  let used = 0;
  const take = (file, hunk, why) => {
    if (taken.has(hunk)) return false;
    if (!chosen.has(file) && chosen.size >= maxFiles) return false;
    if (lines && lines + hunk.lines.length > maxLines) return false;
    taken.add(hunk);
    const shown = Math.min(hunk.lines.length, maxLines);
    lines += shown;
    if (!chosen.has(file)) chosen.set(file, []);
    chosen.get(file).push({ hunk: shown < hunk.lines.length ? { ...hunk, lines: hunk.lines.slice(0, shown), more: hunk.lines.length - shown } : hunk, why });
    return true;
  };
  for (const pick of picks ?? []) {
    if (used >= maxPicks) break;
    const file = files.find((f) => f.path === pick.path);
    if (!file) continue;
    const [from, to] = [Math.min(pick.from, pick.to), Math.max(pick.from, pick.to)];
    const hit = file.hunks.filter((h) => h.newStart <= to && from <= h.newStart + Math.max(h.newLen, 1) - 1);
    let any = false;
    for (const hunk of hit) any = take(file, hunk, pick.why) || any;
    if (any) used++;
  }
  if (chosen.size) {
    for (const entries of chosen.values()) entries.sort((a, b) => a.hunk.newStart - b.hunk.newStart);
    return { fallback: false, files: [...chosen].map(([file, hunks]) => ({ file, hunks })) };
  }
  const tests = testGlobs.map((g) => globToRegExp(g.replace(/^:\(glob\)/, "")));
  const ranked = files
    .filter((f) => !NOT_CODE.test(f.path) && !tests.some((r) => r.test(f.path)))
    .flatMap((file) => file.hunks.map((hunk) => ({ file, hunk })))
    .sort((a, b) => b.hunk.add + b.hunk.del - (a.hunk.add + a.hunk.del));
  let count = 0;
  for (const { file, hunk } of ranked) if (count < maxPicks && take(file, hunk, "")) count++;
  for (const entries of chosen.values()) entries.sort((a, b) => a.hunk.newStart - b.hunk.newStart);
  return { fallback: true, files: [...chosen].map(([file, hunks]) => ({ file, hunks })) };
}

// Closes the spans that are open at each newline and reopens them on the next line, because a
// highlighter may let a span, such as a block comment, cross a newline.
export function splitLines(html) {
  const out = [];
  const open = [];
  let cur = "";
  for (const tok of html.match(/<span[^>]*>|<\/span>|\n|[^<\n]+|</g) ?? []) {
    if (tok === "\n") {
      out.push(cur + "</span>".repeat(open.length));
      cur = open.join("");
    } else {
      cur += tok;
      if (tok.startsWith("<span")) open.push(tok);
      else if (tok === "</span>") open.pop();
    }
  }
  out.push(cur + "</span>".repeat(open.length));
  return out;
}

const DEFAULT_SKIP = /\.(png|jpe?g|gif|pdf|zip)$/i;

// `options` is { highlight(code, lang) => html | null, skip: RegExp, languages: { ".ext": lang } }, all
// optional, taken from the plugin. A file is skipped when the default pattern or `skip` matches.
export function isSkipped(file, options = {}) {
  return DEFAULT_SKIP.test(file) || (options.skip instanceof RegExp && options.skip.test(file));
}

export const languageFor = (file, options = {}) => options.languages?.[path.extname(path.basename(file))] ?? null;

// One HTML string per line of the hunk. The text is highlighted without its +/- markers.
export function highlightHunk(lines, lang, options = {}) {
  const plain = () => lines.map((l) => escapeHtml(l.text));
  if (typeof options.highlight !== "function") return plain();
  try {
    const html = options.highlight(lines.map((l) => l.text).join("\n"), lang);
    if (typeof html !== "string") return plain();
    const split = splitLines(html);
    return split.length === lines.length ? split : plain();
  } catch (error) {
    options.onError?.("highlight", error);
    return plain();
  }
}

const MARK = { "+": "+", "-": "−", " ": "" };
const ROW = { "+": "add", "-": "del", " ": "ctx" };

// A line this long is data, such as an embedded image, and would make the page heavy.
const MAX_LINE = 300;
const clip = (l) => (l.text.length > MAX_LINE ? { ...l, text: `${l.text.slice(0, MAX_LINE)} …` } : l);

function renderHunk(hunk, lang, why, options) {
  const code = highlightHunk(hunk.lines.map(clip), lang, options);
  const rows = hunk.lines
    .map(
      (l, i) =>
        `<tr class="${ROW[l.t]}"><td class="no">${l.oldNo ?? ""}</td><td class="no">${l.newNo ?? ""}</td><td class="mark">${MARK[l.t]}</td><td class="code">${code[i] ?? ""}</td></tr>`,
    )
    .join("");
  const more = hunk.more ? `<p class="why">${hunk.more} more lines in this hunk are not shown.</p>` : "";
  return `${why ? `<p class="why">${escapeHtml(why)}</p>` : ""}<div class="hunk"><table class="diff"><tbody>${rows}</tbody></table></div>${more}`;
}

// `hunks` is [{ hunk, why }]. Returns a <details> for the file.
export function renderDiff(file, hunks, options = {}) {
  const lang = languageFor(file.path, options);
  const body = hunks.map(({ hunk, why }) => renderHunk(hunk, lang, why, options)).join("");
  return `<details class="file" open><summary><span>${escapeHtml(file.path)}</span><span><span class="add">+${file.add}</span> <span class="del">−${file.del}</span></span></summary>${body}</details>\n`;
}
