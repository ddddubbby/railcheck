// Word-count test (UI-7, UI-R4, UI-R5, UI-R10).
//
// Form: the test builds the page into a temporary folder (scripts/build.mjs,
// as CI does) and reads the <form id="flow-form"> of dist/index.html, so the
// answer labels the build inserts are counted too. It counts the text a user
// sees in the default state (unshield, before any result): element text,
// visible labels, button labels, option text, placeholders and the value of
// input buttons. It skips anything hidden: the `hidden` attribute,
// aria-hidden="true", .sr-only/.visually-hidden, <template>, <script>, <style>,
// and the body of a "What does this mean?" <details> (its <summary> counts).
// Note: at runtime, flow.mjs sets the button label from "Check amount" to
// "Check unshield amount"; the static label is what is counted.
//
// Result first level: the result is drawn at runtime by public/flow.mjs, and its
// strings are not in one module. The test reads them from the source of
// flow.mjs, one slot per line of the first level, and takes the longest
// alternative of each slot: heading, status chip, verdict, follow-up line,
// amount line, balance line and the "What does this mean?" summary. Their sum is
// an upper bound on the first level (some slots never show together, such as
// a shield verdict and the unshield balance line). The score digits and "/ 100" are numbers.
// It leaves out the matches panel, the fold body and the alternatives list
// (the "Use … ETH" buttons and the "No Low amount" line).
//
// A word is a whitespace-separated token with at least one letter, so numbers
// and amounts such as "0.00", "70%" or "${eth(x)}" do not count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// UI-R4 ratchet. The caps are the counts measured on main. They may only go
// down: no pull request can raise them. Targets: 60 words for the form and 25
// for the result first level.
const FORM_CAP = 106;
const RESULT_CAP = 35;
const FORM_TARGET = 60;
const RESULT_TARGET = 25;

const words = (text) => text.split(/\s+/).filter((t) => /\p{L}/u.test(t));

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const SKIP_TAGS = new Set(["template", "script", "style"]);
const HIDDEN_CLASS = /(^|\s)(sr-only|visually-hidden)(\s|$)/;
const decode = (s) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, "&");

/** A minimal HTML tokenizer: start tags with attributes, end tags and text. */
function tokens(html) {
  const out = [],
    re = /<!--[^]*?-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  for (const m of html.matchAll(re)) {
    if (m[1]) out.push({ type: "end", tag: m[1].toLowerCase() });
    else if (m[2]) {
      const attrs = {};
      for (const a of m[3].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))
        attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? "");
      out.push({ type: "start", tag: m[2].toLowerCase(), attrs, selfClosing: !!m[4] });
    } else if (m[5]) out.push({ type: "text", text: decode(m[5]) });
  }
  return out;
}

/** Visible text pieces of an HTML fragment, in document order. */
function visibleText(html) {
  const pieces = [],
    stack = []; // one entry per open element: is it hidden?
  const hidden = () => stack.some((e) => e.hidden);
  for (const t of tokens(html)) {
    if (t.type === "start") {
      const a = t.attrs,
        own =
          SKIP_TAGS.has(t.tag) ||
          "hidden" in a ||
          a["aria-hidden"] === "true" ||
          HIDDEN_CLASS.test(a.class || "");
      if (!own && !hidden() && t.tag === "input") {
        if (a.placeholder) pieces.push(a.placeholder);
        if (/^(button|submit|reset)$/.test(a.type || "") && a.value) pieces.push(a.value);
      }
      if (VOID.has(t.tag) || t.selfClosing) continue;
      // The body of a <details> fold is hidden; its <summary> stays visible.
      const parent = stack[stack.length - 1];
      const inFold = parent?.tag === "details" && !("open" in parent.attrs) && t.tag !== "summary";
      stack.push({ tag: t.tag, attrs: a, hidden: own || inFold });
    } else if (t.type === "end") {
      const i = stack.findLastIndex((e) => e.tag === t.tag);
      if (i >= 0) stack.length = i;
    } else if (!hidden()) {
      // Text directly inside a closed <details> but outside <summary> is fold body.
      const top = stack[stack.length - 1];
      if (!(top?.tag === "details" && !("open" in top.attrs))) pieces.push(t.text);
    }
  }
  return pieces.join(" ");
}

/** The outer HTML of the element that opens with `open`, by tag depth. */
function element(html, open) {
  const start = html.indexOf(open);
  assert.ok(start >= 0, `${open} is on the page`);
  const tag = open.match(/^<([a-z0-9-]+)/i)[1];
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = start;
  let depth = 0;
  for (const m of html.matchAll(re)) {
    if (m.index < start) continue;
    depth += m[1] ? -1 : 1;
    if (!depth) return html.slice(start, m.index + m[0].length);
  }
  throw Error(`${open} is not closed`);
}

function builtIndex() {
  const directory = mkdtempSync(join(tmpdir(), "railcheck-words-"));
  try {
    for (const path of ["data", "src", "public", "lib", "packages", "scripts", "package.json"])
      cpSync(path, join(directory, path), { recursive: true });
    symlinkSync(resolve("node_modules"), join(directory, "node_modules"), "dir");
    const run = spawnSync(process.execPath, ["scripts/build.mjs"], {
      cwd: directory,
      env: { ...process.env, SITE_URL: "", SOURCE_URL: "" },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    return readFileSync(join(directory, "dist/index.html"), "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const page = builtIndex();
const form = element(page, '<form id="flow-form"');

function formWords() {
  return words(visibleText(form));
}

// --- Result first level, from the source of flow.mjs -------------------------
const flow = readFileSync("public/flow.mjs", "utf8");
const engine = readFileSync("lib/engine/index.mjs", "utf8");
const between = (src, from, to) => {
  const a = src.indexOf(from),
    b = src.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `${from} … ${to} is in the source`);
  return src.slice(a, b);
};
// String and template literals. A ${…} part is an amount or a number.
const literals = (src) =>
  [...src.matchAll(/"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) =>
    m[1] !== undefined ? m[1] : m[2].replace(/\$\{[^}]*\}/g, "0"),
  );
// User text has a space or a full stop; codes such as "address-link" have neither.
const sentences = (src) => literals(src).filter((s) => /[\s.]/.test(s) && /\p{L}/u.test(s));
const longest = (name, options) => {
  assert.ok(options.length, `the ${name} slot has strings`);
  return options.map(words).reduce((a, b) => (b.length > a.length ? b : a));
};

function resultSlots() {
  const render = between(flow, "function render(", "function matches(");
  const firstLevel = render.slice(0, render.indexOf('el("details")'));
  const show = between(flow, "function show(", "window.addEventListener");
  const headline = between(flow, "function headline(", "function render(");
  const line = (src, re) => src.split("\n").find((l) => re.test(l)) || "";
  return {
    // "Shield risk" or "Unshield risk" replaces the static "Risk score".
    heading: longest("heading", literals(line(show, /result-heading"\)\.textContent =/))),
    // The status chip: an engine band, "Incomplete" or "Not checked".
    chip: longest("chip", [
      ...literals(line(engine, /score <= \d+ \?/)).filter((s) => /^\p{Lu}/u.test(s)),
      ...literals(line(render, /const band =/)).filter((s) => /^\p{Lu}/u.test(s)),
      ...literals(line(render, /return show\(/)).slice(0, 1),
    ]),
    // The verdict line: the longest headline or "not checked" message.
    verdict: longest("verdict", [...sentences(headline), ...sentences(line(render, /"verdict"\),?$/))]),
    // One line after the verdict: "Use a new address." or the unsure answers.
    followUp: longest(
      "follow-up",
      [...firstLevel.matchAll(/parts\.push\(el\("p", "([^"]+)"\)\)/g)].map((m) => m[1]),
    ),
    // What the pool records or the recipient gets.
    amount: longest(
      "amount",
      sentences(between(firstLevel, 'parts.push(\n    el(\n      "p",\n      a.action', '"hint"')),
    ),
    balance: longest("balance", sentences(line(firstLevel, /remainingBalance\)/))),
    summary: longest("summary", literals(line(render, /el\("summary", /)).slice(1)),
  };
}

test("form words stay within the UI-R4 cap", () => {
  const counted = formWords();
  assert.ok(FORM_CAP <= 122, "the form cap never goes above the 28 Oct 2026 design");
  assert.ok(FORM_TARGET <= FORM_CAP);
  assert.ok(
    counted.length <= FORM_CAP,
    `The form has ${counted.length} words, cap ${FORM_CAP} (target ${FORM_TARGET}). ` +
      `A new sentence removes one of equal length (UI-R10).\n${counted.join(" ")}`,
  );
});

test("result first-level words stay within the UI-R4 cap", () => {
  const slots = resultSlots();
  const counted = Object.values(slots).flat();
  assert.ok(RESULT_TARGET <= RESULT_CAP);
  assert.ok(
    counted.length <= RESULT_CAP,
    `The result first level has ${counted.length} words, cap ${RESULT_CAP} (target ${RESULT_TARGET}). ` +
      `A new sentence removes one of equal length (UI-R10).\n` +
      Object.entries(slots)
        .map(([k, v]) => `${k}: ${v.join(" ")}`)
        .join("\n"),
  );
});

test("the word counter skips hidden text, numbers and the fold body", () => {
  const html = `<form><p>Two words</p><p hidden>no</p><span aria-hidden="true">no</span>
    <p class="hint sr-only">no</p><template><b>no</b></template><script>no()</script>
    <input placeholder="0.00"><input placeholder="Your amount"><button>Check 70% 1.5</button>
    <select><option>Pick one</option></select>
    <details><summary>What does this mean?</summary><p>no</p>no</details></form>`;
  assert.deepEqual(words(visibleText(html)), [
    "Two", "words", "Your", "amount", "Check", "Pick", "one", "What", "does", "this", "mean?",
  ]);
});

// UI-R5: no paragraph in the form, except errors (p.error).
const paragraphs = [...form.matchAll(/<p\b([^>]*)>/g)]
  .map((m) => m[1])
  .filter((attrs) => !/class="[^"]*\berror\b/.test(attrs));
test(
  "no paragraph in the form except errors (UI-R5)",
  { todo: paragraphs.length ? `${paragraphs.length} hint paragraphs remain in the form` : false },
  () => {
    assert.deepEqual(paragraphs, []);
  },
);
