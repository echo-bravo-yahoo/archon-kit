// Markdown for a report section. Raw HTML in the source is escaped, and headings move down by
// `demote` levels, never above <h2>, because the page title is the only <h1>.
import { Marked } from "./vendor/marked.esm.mjs";
import { escapeHtml } from "./shell.mjs";

// `fences` is { name: (code) => html }, supplied by the plugin. A fence with no entry is a plain
// code block, and one whose renderer throws falls back to a plain block after `onError`.
export function renderMarkdown(src, { demote = 2, fences = {}, onError = () => {} } = {}) {
  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      html: ({ text }) => escapeHtml(text),
      heading({ tokens, depth }) {
        const d = Math.max(2, Math.min(6, depth + demote));
        return `<h${d}>${this.parser.parseInline(tokens)}</h${d}>\n`;
      },
      code({ text, lang }) {
        const name = (lang ?? "").trim().split(/\s+/)[0];
        if (!name || !Object.hasOwn(fences, name) || typeof fences[name] !== "function") return false;
        try {
          return String(fences[name](text));
        } catch (error) {
          onError("fences", error);
          return false;
        }
      },
    },
  });
  return md.parse(src);
}
