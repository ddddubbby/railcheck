import { test } from "node:test";
import assert from "node:assert/strict";
import { readPage, toMarkdown, toHtml, renderPage, slug } from "../scripts/lib/pages.mjs";

const source = `---
title: Test page
description: A page for tests.
updated: 2026-10-17
---
# Test page

Intro with [a link](https://example.com) and [a page](/docs/).

## Step 1: Build the \`pool\`

| Key | Value |
| --- | --- |
| a | <b>&</b> |

\`\`\`js
const x = 1 < 2;
\`\`\`

## Data {#data}

Text.

<!-- if:mcp -->
## For AI agents

Secret plan.
<!-- end:mcp -->
`;

test("page header and publication flags", () => {
  const page = readPage(source);
  assert.equal(page.meta.title, "Test page");
  assert.equal(page.meta.updated, "2026-10-17");
  assert.doesNotMatch(page.body, /Secret plan|if:mcp/);
  assert.match(readPage(source, { mcp: true }).body, /Secret plan/);
  assert.throws(() => readPage("# no header"), /header/);
  assert.throws(() => readPage(source.replace("updated: 2026-10-17", "updated: soon")), /YYYY-MM-DD/);
  assert.throws(() => readPage(source.replace("<!-- end:mcp -->", "")), /Unclosed/);
});

test("Markdown and HTML come from the same published body", () => {
  const page = readPage(source);
  const md = toMarkdown(page);
  const { html, toc } = toHtml(page);
  assert.doesNotMatch(md + html, /Secret plan/);
  assert.match(md, /^## Data$/m);
  assert.doesNotMatch(md, /\{#data\}/);
  assert.match(html, /<h2 id="data">Data<a class="anchor" href="#data"/);
  assert.match(html, /<h2 id="step-1-build-the-pool">Step 1: Build the <code>pool<\/code>/);
  assert.deepEqual(toc.map((t) => t.id), ["step-1-build-the-pool", "data"]);
  assert.match(html, /<div class="table-wrap"><table>/);
  assert.match(html, /const x = 1 &lt; 2;/);
  assert.match(html, /<a href="https:\/\/example.com" rel="noopener noreferrer">a link<\/a>/);
  assert.match(html, /<a href="\/docs\/">a page<\/a>/);
  assert.throws(() => toHtml(readPage(source.replace("## Data {#data}", "## Step 1: Build the pool"))), /Duplicate/);
  assert.equal(slug("Step 1: Build the <code>pool</code>"), "step-1-build-the-pool");
});

test("rendered page has one JSON-LD block, the Markdown link and the tools", () => {
  const page = readPage(source);
  const { html, toc } = toHtml(page);
  const out = renderPage({
    path: "/docs/",
    meta: page.meta,
    html,
    toc,
    sourceURL: "https://github.com/x/y",
    jsonld: { "@context": "https://schema.org", name: "</script>" },
    tools: { version: "Preview 0.1.0", issues: "https://github.com/x/y/issues" },
  });
  assert.equal((out.match(/application\/ld\+json/g) || []).length, 1);
  assert.doesNotMatch(out, /<\/script>"/);
  assert.match(out, /<link rel="alternate" type="text\/markdown" href="\/docs.md" \/>/);
  assert.match(out, /aria-current="page">For wallets/);
  assert.match(out, /<\/h1>\n<div class="doc-meta"><p>Preview 0.1.0 · Updated <time datetime="2026-10-17">17 Oct 2026<\/time>/);
  assert.match(out, /<button type="button" class="copy-page" data-src="\/docs.md" hidden>/);
  assert.match(out, /<nav class="toc"/);
});
