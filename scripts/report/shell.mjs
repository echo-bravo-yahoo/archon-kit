// The page shell shared by the design pages and the build reports: a sticky table of contents
// on the left, collapsible sections on the right, and the colours and diff styles.
// The page loads no external resource, so it opens from a file or any static server.

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ENTITIES[c]);

const UNESCAPE = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
export const plainText = (html) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => UNESCAPE[e])
    .replace(/\s+/g, " ")
    .trim();

export function slugify(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

// `wanted` is an id the design chose for the section, kept when it is a plain name.
export function uniqueId(text, ids, wanted) {
  const base = wanted && /^[A-Za-z][\w-]*$/.test(wanted) ? wanted : slugify(text);
  let id = base;
  for (let n = 2; ids.has(id) || id === "toc"; n++) id = `${base}-${n}`;
  ids.add(id);
  return id;
}

function openSection(level, id, headingHtml, open) {
  const sub = level > 2 ? " sub" : "";
  return `<details class="sec${sub}" id="${id}"${open ? " open" : ""}><summary><h${level}>${headingHtml}</h${level}></summary><div class="sec-body">`;
}

// One collapsible section built in code. `title` is plain text.
export function section({ id, title, html, open = true, level = 2 }) {
  return `${openSection(level, id, escapeHtml(title), open)}${html}</div></details>\n`;
}

// Wraps each <h2> and its content in a <details>, and each <h3> in a nested one. `ids` is the
// set of ids already used on the page, so that several calls produce unique ids.
//
// Designs wrap each section in <section id="x"> and a section cannot cross a <details>, so the
// <section> tags are removed. The id of a <section> that opens right before a heading, or the
// heading's own id, becomes the id of the heading's <details>, which keeps the design's
// links to it. Any other element that has an id a <details> takes loses it.
export function sectionize(html, ids = new Set()) {
  const parts = html.split(/(<h[23](?:\s[^>]*)?>[\s\S]*?<\/h[23]>)/);
  const toc = [];
  const assigned = new Set();
  const headings = parts.map((part, i) => {
    if (i % 2 === 0) return null;
    const m = /^<h([23])((?:\s[^>]*)?)>([\s\S]*?)<\/h[23]>$/.exec(part);
    const own = /\sid="([^"]*)"/.exec(m[2])?.[1];
    const wrapper = /<section\b[^>]*?\sid="([^"]*)"[^>]*>\s*$/.exec(parts[i - 1])?.[1];
    const text = plainText(m[3]);
    const id = uniqueId(text, ids, own ?? wrapper);
    assigned.add(id);
    toc.push({ level: Number(m[1]), id, text });
    return { level: Number(m[1]), id, inner: m[3] };
  });
  const clean = (text) =>
    text
      .replace(/<\/?section(?:\s[^>]*)?>/g, "")
      .replace(/<[a-zA-Z][^>]*>/g, (tag) => tag.replace(/\sid="([^"]*)"/, (attr, id) => (assigned.has(id) ? "" : attr)));
  const open = [];
  let out = "";
  const closeTo = (level) => {
    while (open.length && open.at(-1) >= level) {
      open.pop();
      out += "</div></details>";
    }
  };
  parts.forEach((part, i) => {
    const h = headings[i];
    if (!h) {
      out += clean(part);
      return;
    }
    closeTo(h.level);
    out += openSection(h.level, h.id, h.inner, true);
    open.push(h.level);
  });
  closeTo(0);
  return { html: out, toc };
}

const CSS = `
:root { --page:#f6f4ee; --surface:#fff; --ink:#15130f; --muted:#6b665a; --line:#cfcabb; --accent:#1b5fb3; --paper:#e9e6dc; --warn:#8a5a00; --good:#1f7a3a; --bad:#b3261e;
  --add-bg:#e6f6e9; --del-bg:#fbe9e7; --add-ink:#1f7a3a; --del-ink:#b3261e; }
@media (prefers-color-scheme: dark) { :root { --page:#161512; --surface:#201f1b; --ink:#ece9de; --muted:#9a9585; --line:#3a382f; --accent:#6aa5ee; --warn:#e0b050; --good:#6fcf8a; --bad:#f2877f;
  --add-bg:#16301d; --del-bg:#3a1b19; --add-ink:#6fcf8a; --del-ink:#f2877f; } }
* { box-sizing: border-box; }
html { color-scheme: light dark; }
body { margin: 0; background: var(--page); color: var(--ink); font: 16px/1.55 system-ui, sans-serif; }
.content { grid-column: 2; grid-row: 1; min-width: 0; }
.layout { display: grid; grid-template-columns: 15rem minmax(0, 52rem); gap: 0 2rem; max-width: 70rem; margin: 0 auto; padding: 0 16px; }
#toc { grid-column: 1; grid-row: 1; position: sticky; top: 0; align-self: start; max-height: 100vh; overflow: auto; padding: 24px 0; font-size: 14px; }
#toc p { margin: 0 0 6px; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
#toc ol { margin: 8px 0 0; padding: 0; list-style: none; }
#toc li { margin: 0; }
#toc li.l3 { padding-left: 14px; font-size: 13px; }
#toc a { display: block; padding: 3px 8px; border-left: 2px solid transparent; color: var(--ink); text-decoration: none; }
#toc a:hover { background: var(--surface); }
#toc a[aria-current="location"] { border-left-color: var(--accent); color: var(--accent); font-weight: 600; }
#toc button { margin-right: 6px; padding: 2px 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--ink); font: inherit; font-size: 12px; cursor: pointer; }
@media (max-width: 960px) { .layout { grid-template-columns: minmax(0, 1fr); } .content { grid-column: 1; grid-row: 2; } #toc { position: static; max-height: none; padding-bottom: 0; } }
header { padding-top: 28px; }
.status { display: inline-block; margin: 0; padding: 2px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 13px; }
h1 { margin: 12px 0 4px; font-size: 2rem; }
.meta { margin: 0 0 8px; color: var(--muted); font-size: 14px; }
h2 { margin: 0; font-size: 1.35rem; }
h3 { margin: 0; font-size: 1.1rem; }
details.sec { margin-top: 1.6rem; padding-top: .9rem; border-top: 1px solid var(--line); scroll-margin-top: 12px; }
details.sec.sub { margin-top: 1rem; padding-top: 0; border-top: 0; }
details.sec > summary { display: flex; align-items: baseline; gap: .55rem; cursor: pointer; list-style: none; }
details.sec > summary::-webkit-details-marker { display: none; }
details.sec > summary::before { content: ""; flex: none; width: .5em; height: .5em; border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(-45deg); transition: transform .12s; }
details.sec[open] > summary::before { transform: translateY(-.15em) rotate(45deg); }
.sec-body { padding-top: .4rem; overflow-x: auto; }
a { color: var(--accent); }
p, ul, ol { margin: .6rem 0; }
code, pre { font: 13.5px/1.45 ui-monospace, monospace; }
code { padding: 0 .25em; background: var(--surface); border: 1px solid var(--line); border-radius: 4px; overflow-wrap: anywhere; }
pre { overflow-x: auto; padding: 10px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; }
pre code { padding: 0; border: 0; background: none; overflow-wrap: normal; }
table { border-collapse: collapse; width: 100%; margin: .8rem 0; font-size: 15px; }
th, td { padding: 6px 10px; border: 1px solid var(--line); text-align: left; vertical-align: top; }
th { background: var(--surface); }
@media print { #toc { display: none; } .layout { display: block; max-width: none; } details.sec > summary::before { display: none; } }
footer { margin: 3rem 0 2rem; color: var(--muted); font-size: 13px; }
@media screen { footer { margin-bottom: 70vh; } }
.callout { margin: 1rem 0; padding: 10px 14px; background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 6px; }
.callout.warn { border-left-color: var(--warn); }
.callout.bad { border-left-color: var(--bad); }
.callout p:first-child { margin-top: 0; }
.callout p:last-child { margin-bottom: 0; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 10px; margin: 1rem 0; }
.stat { padding: 8px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; }
.stat b { display: block; font-size: 1.3rem; }
.stat > span { color: var(--muted); font-size: 13px; }
.badge { display: inline-block; padding: 0 8px; border-radius: 999px; border: 1px solid currentColor; font-size: 12px; font-weight: 600; }
.badge.pass { color: var(--good); }
.badge.fail { color: var(--bad); }
.add { color: var(--add-ink); }
.del { color: var(--del-ink); }
details.file { margin: 1rem 0; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }
details.file > summary { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0 1rem; overflow-wrap: anywhere; padding: 6px 10px; cursor: pointer; font: 13.5px/1.45 ui-monospace, monospace; }
.why { margin: 0; padding: 6px 10px; border-top: 1px solid var(--line); font-size: 14px; }
.hunk { overflow-x: auto; border-top: 1px solid var(--line); }
table.diff { width: auto; min-width: 100%; margin: 0; font: 12.5px/1.45 ui-monospace, monospace; }
table.diff td { padding: 0 8px; border: 0; }
table.diff td.no { width: 3.4em; color: var(--muted); text-align: right; user-select: none; }
table.diff td.mark { width: 1.4em; user-select: none; }
table.diff td.code { white-space: pre; }
table.diff tr.add { background: var(--add-bg); color: inherit; }
table.diff tr.del { background: var(--del-bg); color: inherit; }
`;

const SCRIPT = `
(() => {
  const toc = document.getElementById("toc");
  const idOf = (a) => decodeURIComponent(a.getAttribute("href").slice(1));
  const reveal = (el) => {
    for (let d = el.closest("details"); d; d = d.parentElement?.closest("details")) d.open = true;
  };
  const go = (id, smooth) => {
    const t = document.getElementById(id);
    if (!t) return false;
    reveal(t);
    t.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
    return true;
  };
  toc.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const id = idOf(a);
    if (!go(id, true)) return;
    e.preventDefault();
    history.replaceState(null, "", "#" + id);
  });
  if (location.hash) go(decodeURIComponent(location.hash.slice(1)), false);
  window.addEventListener("hashchange", () => go(decodeURIComponent(location.hash.slice(1)), true));

  const links = new Map([...toc.querySelectorAll('a[href^="#"]')].map((a) => [idOf(a), a]));
  const summaries = [...document.querySelectorAll("details.sec > summary")];
  const update = () => {
    const passed = summaries.filter((s) => s.getBoundingClientRect().top <= 120);
    const current = (passed.at(-1) ?? summaries[0])?.parentElement.id;
    for (const [id, a] of links) {
      if (id === current) a.setAttribute("aria-current", "location");
      else a.removeAttribute("aria-current");
    }
  };
  const observer = new IntersectionObserver(update, { rootMargin: "-120px 0px 0px 0px" });
  summaries.forEach((s) => observer.observe(s));
  document.addEventListener("toggle", update, true);
  update();

  const setAll = (open) => document.querySelectorAll("details").forEach((d) => (d.open = open));
  const actions = toc.querySelector(".actions");
  for (const [label, open] of [["Expand all", true], ["Collapse all", false]]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => setAll(open));
    actions.append(b);
  }
  window.addEventListener("beforeprint", () => setAll(true));
})();
`;

// `body` is HTML, `banner` is HTML shown under the title, `toc` is [{ level, id, text }] and
// `css` is extra CSS.
export function page({ title, pageTitle = title, status = "", meta = "", banner = "", body, toc = [], footer = "", css = "" }) {
  const items = toc.map((t) => `<li class="l${t.level}"><a href="#${t.id}">${escapeHtml(t.text)}</a></li>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pageTitle)}</title>
<style>${CSS}${css}</style>
</head>
<body>
<div class="layout">
<div class="content">
<header>
${status ? `<p class="status">${escapeHtml(status)}</p>` : ""}
<h1>${escapeHtml(title)}</h1>
${meta ? `<p class="meta">${escapeHtml(meta)}</p>` : ""}
${banner}
</header>
<main>
${body}
</main>
${footer ? `<footer>${escapeHtml(footer)}</footer>` : "<footer></footer>"}
</div>
<nav id="toc" aria-label="Contents">
<p>Contents</p>
<div class="actions"></div>
<ol>
${items}
</ol>
</nav>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
