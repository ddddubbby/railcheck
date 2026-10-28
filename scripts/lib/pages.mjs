// Text pages: one Markdown source gives the published Markdown and the HTML.
// Unpublished blocks are removed before either output is made.
import { Marked, Renderer } from "marked";

export const escape = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** Heading text to an id: "Step 1: Build the pool" → "step-1-build-the-pool". */
export const slug = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>|`/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Splits the header block and applies publication flags.
 * Header: lines "key: value" between two "---" lines at the top.
 * Flags: "<!-- if:name -->" … "<!-- end:name -->" stays only when flags[name] is true.
 */
export function readPage(source, flags = {}) {
  const head = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!head) throw Error("Page has no header block.");
  const meta = Object.fromEntries(
    head[1].split("\n").map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
  for (const key of ["title", "description", "updated"])
    if (!meta[key]) throw Error(`Page header has no ${key}.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.updated))
    throw Error("Page header updated must be YYYY-MM-DD.");
  let body = source.slice(head[0].length);
  body = body.replace(
    /<!-- if:([\w-]+) -->\n?([\s\S]*?)<!-- end:\1 -->\n?/g,
    (_, name, block) => (flags[name] ? block : ""),
  );
  if (/<!-- (?:if|end):/.test(body)) throw Error("Unclosed publication flag.");
  return { meta, body };
}

/** Published Markdown: the body without explicit heading ids. */
export const toMarkdown = ({ meta, body }) =>
  `${body.replace(/ \{#[\w-]+\}$/gm, "").trim()}\n`;

/** HTML for the body, and the H2/H3 entries for a table of contents. */
export function toHtml({ body }) {
  const toc = [],
    used = new Set();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth, text }) {
        const explicit = text.match(/ \{#([\w-]+)\}$/);
        let inner = this.parser.parseInline(tokens).replace(/ \{#[\w-]+\}$/, "");
        let id = explicit ? explicit[1] : slug(inner);
        if (used.has(id)) throw Error(`Duplicate heading id: ${id}.`);
        used.add(id);
        if (depth === 2 || depth === 3) toc.push({ depth, id, text: inner.replace(/<[^>]+>/g, "") });
        if (depth === 1) return `<h1 id="${id}">${inner}</h1>\n`;
        return `<h${depth} id="${id}">${inner}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const external = /^https?:/.test(href) ? ' rel="noopener noreferrer"' : "";
        return `<a href="${escape(href)}"${title ? ` title="${escape(title)}"` : ""}${external}>${inner}</a>`;
      },
      table(token) {
        // Wide tables scroll inside their box, not the page.
        const html = Renderer.prototype.table.call(this, token);
        return `<div class="table-wrap">${html}</div>\n`;
      },
    },
  });
  const html = marked.parse(body);
  return { html, toc };
}

const NAV = [
  ["/", "Check"],
  ["/how-it-works/", "How it works"],
  ["/docs/", "For wallets"],
];

/** Shared header. `path` marks the current page. Links live in a hamburger panel. */
export const header = (path) =>
  `<header><a class="brand" href="/">railcheck</a><button type="button" class="nav-toggle" id="nav-toggle" aria-expanded="false" aria-controls="site-menu"><span class="sr-only">Menu</span><span class="nav-toggle-bars" aria-hidden="true"></span></button><nav class="site-nav" id="site-menu" hidden>${NAV.map(
    ([href, label]) =>
      `<a class="nav-link" href="${href}"${href === path ? ' aria-current="page"' : ""}>${label}</a>`,
  ).join("")}</nav></header>`;

/** Shared footer. `dataDate` is shown only on pages that use the pool data. */
export const footer = (sourceURL, dataDate = "") =>
  `<footer><div class="footer-links"><a href="/how-it-works/">How it works</a><a href="/docs/">For wallets</a><a href="${escape(sourceURL)}" rel="noopener noreferrer">Source</a></div><p>Independent community project. Not affiliated with <a href="https://railgun.org/" rel="noopener noreferrer">RAILGUN</a>.</p><p>Not financial or legal advice. <a href="/how-it-works/#disclaimer">Disclaimer</a></p>${dataDate ? `<p id="data-date">${escape(dataDate)}</p>` : ""}</footer>`;

const longDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/**
 * A full text page. `tools` adds the version line and the Markdown controls (docs).
 * `jsonld` is one object; it becomes the only JSON-LD block on the page.
 */
export function renderPage({ path, meta, html, toc, sourceURL, jsonld, tools }) {
  const mdPath = `${path.replace(/\/$/, "")}.md`;
  const contents = toc.length
    ? `<nav class="toc" aria-label="On this page"><p class="toc-title">On this page</p><ol>${toc
        .map((t) => `<li class="toc-${t.depth}"><a href="#${t.id}">${t.text}</a></li>`)
        .join("")}</ol></nav>`
    : "";
  const bar = tools
    ? `<div class="doc-meta"><p>${escape(tools.version)} · Updated <time datetime="${meta.updated}">${longDate(meta.updated)}</time></p><p class="doc-tools"><a href="${mdPath}">View as Markdown</a><button type="button" class="copy-page" data-src="${mdPath}" hidden>Copy page as Markdown</button><a href="${escape(tools.issues)}" rel="noopener noreferrer">Report a problem</a></p></div>`
    : "";
  // The H1 comes first in the body; the meta bar goes right after it.
  const body = bar ? html.replace(/(<\/h1>\n)/, `$1${bar}`) : html;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escape(meta.title)}</title>
    <meta name="description" content="${escape(meta.description)}" />
    <meta name="theme-color" content="#121218" />
    <link rel="icon" href="/favicon.svg" />
    <link rel="stylesheet" href="/style.css" />
    <link rel="alternate" type="text/markdown" href="${mdPath}" />
    <link rel="describedby" href="/llms.txt" />
    <script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>
    <script type="module" src="/nav.mjs"></script>${tools ? '\n    <script type="module" src="/docs.mjs"></script>' : ""}
  </head>
  <body>
    <div class="shell doc-shell">
      ${header(path)}
      <div class="doc-layout">
        ${contents}
        <main class="reading">
${body}
        </main>
      </div>
      ${footer(sourceURL)}
    </div>
  </body>
</html>
`;
}
