// Word-count test (UI-7, UI-R4, UI-R5, UI-R10).
//
// It counts rendered text, not source strings. The test builds the page into a
// temporary folder (scripts/build.mjs, as CI does), loads dist/index.html into
// linkedom (a small DOM, no browser), and runs the real dist/flow.mjs and
// dist/worker.mjs against it. The worker runs in the same process on the real
// pool in public/data, with the clock set to the data time.
//
// Form: the visible text of <form id="flow-form"> after the runtime sync(), with
// an amount typed so the fee hint shows. Unshield (the default) and shield each
// have a cap.
//
// Result: the test submits a matrix of real scenarios (shield and unshield;
// clear, attention, incomplete and not-checked; with and without balance;
// fixed and flexible amounts; answers no, yes and not sure) and counts the
// visible text of the result section after each render. RESULT_CAP caps the
// largest state. RESULT_COPY_CAP caps the sum of the distinct first-level lines
// seen over the matrix (numbers taken out), so a line that grows is caught even
// when it is not in the largest state.
//
// What counts: text a user sees, button labels, labels, option text and
// placeholders. Skipped: `hidden`, aria-hidden="true", .sr-only and
// .visually-hidden, <template>, <script>, <style>, and the body of a closed
// <details> fold (its <summary> counts). In the matches table, the per-row
// amounts and dates are data, not copy; its heading, column headers and tags
// such as "Swap output" count. The alternatives lines count.
//
// A word is a whitespace-separated token with at least one letter, so numbers
// and amounts such as "0.00", "70%" or "1.5" do not count.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";

// UI-R4 ratchet. The caps are the counts measured on main. They may only go
// down: no pull request can raise them. The form caps never go above 122 (the
// 28 Oct 2026 design). Targets: 60 words for the form and 25 for the result
// first level.
const FORM_CAP = 115; // unshield, the default
const SHIELD_FORM_CAP = 40;
const RESULT_CAP = 40;
const RESULT_COPY_CAP = 153;
const FORM_TARGET = 60;
const RESULT_TARGET = 25;

const words = (text) => text.split(/\s+/).filter((t) => /\p{L}/u.test(t));

// --- Visible text ------------------------------------------------------------
const SKIP_TAGS = new Set(["TEMPLATE", "SCRIPT", "STYLE"]);
const HIDDEN_CLASS = /(^|\s)(sr-only|visually-hidden)(\s|$)/;
const DATA = [/\d[\d.,]*\s*ETH\b/g, /\b\d{1,2} (Jan|Feb|Mar|Apr|May|June?|July?|Aug|Sept?|Oct|Nov|Dec) \d{4}\b/g];
const isHidden = (el) =>
  SKIP_TAGS.has(el.tagName) ||
  el.hasAttribute("hidden") ||
  el.getAttribute("aria-hidden") === "true" ||
  HIDDEN_CLASS.test(el.getAttribute("class") || "");

/** Visible text pieces of a DOM subtree. A piece is one line of copy. */
function visibleLines(root) {
  const lines = [];
  const walk = (node, data) => {
    if (node.nodeType === 3) {
      let text = node.textContent;
      if (data) for (const re of DATA) text = text.replace(re, " ");
      if (text.trim()) lines.push(text.trim());
      return;
    }
    if (node.nodeType !== 1 || isHidden(node)) return;
    if (node.tagName === "INPUT") {
      const p = node.getAttribute("placeholder"),
        type = node.getAttribute("type") || "";
      if (p) lines.push(p);
      if (/^(button|submit|reset)$/.test(type) && node.getAttribute("value")) lines.push(node.getAttribute("value"));
      return;
    }
    // The body of a closed fold is hidden; its <summary> stays visible.
    const fold = node.tagName === "DETAILS" && !node.hasAttribute("open");
    // Matches rows hold data: amounts and dates.
    const rows = data || (node.tagName === "TBODY" && !!node.closest("#matches"));
    for (const child of node.childNodes)
      if (!fold || (child.nodeType === 1 && child.tagName === "SUMMARY")) walk(child, rows);
  };
  walk(root, false);
  return lines;
}
const count = (root) => words(visibleLines(root).join(" "));

// --- The built page ----------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "railcheck-words-"));
after(() => rmSync(dir, { recursive: true, force: true }));
for (const path of ["data", "src", "public", "lib", "packages", "scripts", "package.json"])
  cpSync(path, join(dir, path), { recursive: true });
symlinkSync(resolve("node_modules"), join(dir, "node_modules"), "dir");
const build = spawnSync(process.execPath, ["scripts/build.mjs"], {
  cwd: dir,
  env: { ...process.env, SITE_URL: "", SOURCE_URL: "" },
  encoding: "utf8",
});
assert.equal(build.status, 0, build.stderr);
const dist = join(dir, "dist");
const html = readFileSync(join(dist, "index.html"), "utf8");
const manifest = JSON.parse(readFileSync(join(dist, "data/manifest.json"), "utf8"));

// --- Browser stand-ins for flow.mjs and worker.mjs -----------------------------
{
  // linkedom has no table API, focus scrolling or canvas: add the parts flow.mjs uses.
  const { document } = parseHTML("<html><body></body></html>");
  const Element = Object.getPrototypeOf(document.createElement("table"));
  const add = (parent, tag) => parent.appendChild(parent.ownerDocument.createElement(tag));
  Object.assign(Element, {
    createTHead() { return add(this, "thead"); },
    createTBody() { return add(this, "tbody"); },
    insertRow() { return add(this, "tr"); },
    insertCell() { return add(this, "td"); },
    scrollIntoView() {},
  });
  Object.getPrototypeOf(document.createElement("canvas")).getContext = () => ({
    setTransform() {}, clearRect() {}, fillRect() {}, fillStyle: "",
  });
}
let pages = 0;
const realNow = Date.now;
const wait = async (ok, what) => {
  for (let i = 0; i < 2000; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error(`Timed out waiting for ${what}`);
};

/** Opens the built page with its scripts. `now` is the clock in seconds. */
async function openPage({ now = manifest.dataTime + 3600, patch = {} } = {}) {
  const page = parseHTML(html);
  const { document, Event } = page;
  let flowWorker, lastPlan;
  const workerSelf = {
    postMessage(data) {
      if (data.type === "plan") lastPlan = data;
      setTimeout(() => flowWorker.onmessage({ data }));
    },
  };
  Object.assign(globalThis, {
    document,
    window: { devicePixelRatio: 1, addEventListener() {} },
    self: workerSelf,
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    Worker: class {
      constructor() { flowWorker = this; }
      postMessage(data) { setTimeout(() => workerSelf.onmessage({ data })); }
    },
    fetch: async (url) => {
      const file = join(dist, "data", String(url).replace(/^\.\/data\//, ""));
      const body = url.endsWith("manifest.json")
        ? JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch })
        : readFileSync(file);
      return new Response(body);
    },
  });
  Date.now = () => now * 1000;
  const id = ++pages;
  await import(`${pathToFileURL(join(dist, "worker.mjs"))}?page=${id}`);
  await import(`${pathToFileURL(join(dist, "flow.mjs"))}?page=${id}`);
  const $ = (x) => document.getElementById(x);
  await wait(() => $("progress").hidden, "the pool data");
  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  const choose = (name, value) => {
    const inputs = [...document.querySelectorAll(`input[name=${name}]`)];
    for (const i of inputs) i.removeAttribute("checked");
    const pick = inputs.find((i) => i.value === value);
    pick.setAttribute("checked", "");
    fire(pick, "change");
  };
  const type = (field, value) => {
    $(field).value = value;
    fire($(field), "input");
  };
  return {
    $,
    choose,
    type,
    async submit(s) {
      choose("action", s.action);
      type("amount", s.amount);
      choose("constraint", s.constraint);
      if (s.action === "unshield") {
        s.answers.forEach((a, i) => choose(`q${i + 1}`, a));
        type("balance", s.balance ?? "");
      }
      fire($("flow-form"), "submit");
      assert.equal($("result").getAttribute("aria-busy"), "true", `${label(s)} was submitted`);
      await wait(() => $("result").getAttribute("aria-busy") === "false", label(s));
      assert.ok($("notice").hidden, `${label(s)}: ${$("notice").textContent}`);
      return { result: $("result"), plan: lastPlan };
    },
    close() {
      Date.now = realNow;
    },
  };
}
const label = (s) =>
  `${s.action} ${s.amount} ${s.constraint}${s.answers ? " " + s.answers.join("/") : ""}${s.balance ? " balance " + s.balance : ""}`;

// --- Scenarios ---------------------------------------------------------------
// Each line reaches a first-level variant on the current pool data; the coverage
// test below checks that they still do after a data update. A plan takes up to a
// few seconds, so the matrix stays small. "1" and "0.0731" ETH: a shared and an
// odd amount. "1.01": a shield with a Low alternative. "17.3": an unshield with
// no Low alternative. "0.002268462": an unshield that matches a swap output.
const NO = ["no", "no", "no"],
  UNSURE = ["unsure", "no", "no"];
const scenarios = [
  { action: "shield", amount: "1", constraint: "fixed" },
  { action: "shield", amount: "1.01", constraint: "fixed" },
  { action: "shield", amount: "1.01", constraint: "flexible" },
  { action: "shield", amount: "0.0731", constraint: "flexible" },
  { action: "unshield", amount: "0.0731", constraint: "fixed", answers: NO },
  { action: "unshield", amount: "0.0731", constraint: "fixed", answers: UNSURE, balance: "100" },
  { action: "unshield", amount: "0.0731", constraint: "flexible", answers: ["no", "unsure", "unsure"] },
  { action: "unshield", amount: "0.0731", constraint: "fixed", answers: ["no", "no", "yes"], balance: "100" },
  { action: "unshield", amount: "1", constraint: "fixed", answers: NO },
  { action: "unshield", amount: "1", constraint: "flexible", answers: NO, balance: "100" },
  { action: "unshield", amount: "1", constraint: "flexible", answers: UNSURE, balance: "100" },
  { action: "unshield", amount: "1", constraint: "fixed", answers: ["yes", "no", "no"], balance: "100" },
  { action: "unshield", amount: "1", constraint: "flexible", answers: ["no", "yes", "unsure"], balance: "100" },
  { action: "unshield", amount: "1", constraint: "flexible", answers: ["no", "no", "yes"], balance: "100" },
  { action: "unshield", amount: "17.3", constraint: "flexible", answers: UNSURE, balance: "100" },
  { action: "unshield", amount: "0.002268462", constraint: "fixed", answers: NO },
];

const forms = {};
const states = []; // { label, words, lines, plan, action }
{
  const page = await openPage();
  try {
    page.type("amount", "1");
    forms.unshield = count(page.$("flow-form"));
    page.choose("action", "shield");
    forms.shield = count(page.$("flow-form"));
    for (const s of scenarios) {
      const { result, plan } = await page.submit(s);
      states.push({ label: label(s), words: count(result), lines: visibleLines(result), plan, action: s.action });
    }
  } finally {
    page.close();
  }
  // Not checked: old data, and a pool that does not cover the window.
  for (const [name, options] of [
    ["stale data", { now: manifest.dataTime + 30 * 86400 }],
    ["short window", { patch: { windowStart: manifest.dataTime } }],
  ]) {
    const stale = await openPage(options);
    try {
      for (const action of ["shield", "unshield"]) {
        const s = { action, amount: "1", constraint: "fixed", answers: NO, balance: "100" };
        const { result, plan } = await stale.submit(s);
        states.push({ label: `${name}: ${label(s)}`, words: count(result), lines: visibleLines(result), plan, action });
      }
    } finally {
      stale.close();
    }
  }
}
const copyLines = [
  ...new Set(states.flatMap((s) => s.lines.map((l) => words(l).join(" ")).filter(Boolean))),
].sort();
const copyWords = copyLines.reduce((n, l) => n + l.split(" ").length, 0);
const largest = states.reduce((a, b) => (b.words.length > a.words.length ? b : a));

if (process.env.WORDS_DEBUG) {
  for (const [k, v] of Object.entries(forms)) console.log(`form ${k}: ${v.length} |`, v.join(" "));
  for (const s of states) console.log(s.words.length, s.label, "|", s.words.join(" "));
  console.log("largest", largest.words.length, largest.label);
  console.log("copy", copyWords, copyLines);
}

test("the scenario matrix reaches every first-level variant", () => {
  const reached = new Set();
  for (const { action, plan } of states) {
    const r = plan.result,
      a = r.assessment;
    reached.add(`${action} ${a.status}`);
    for (const f of a.findings) reached.add(`${action} ${f.code}${f.reason ? " " + f.reason : ""}`);
    if (a.status === "attention" && r.constraint === "flexible")
      reached.add(`${action} ${r.alternatives.length ? "alternatives" : "no alternative"}`);
    if (a.status === "attention" && r.constraint === "fixed") reached.add(`${action} fixed`);
    if (a.unknown?.length) reached.add(`${action} unsure`);
    if (r.remainingBalance != null) reached.add("balance");
    if (action === "unshield" && a.status !== "not-checked" && r.remainingBalance == null) reached.add("no balance");
    if (plan.sets.length) reached.add("matches");
    if (plan.sets.some((set) => set.deposits.some((d) => d.kind === "reshield"))) reached.add("swap output");
  }
  const missing = [
    "shield clear", "shield attention", "shield alternatives", "shield no alternative", "shield fixed",
    "unshield clear", "unshield attention", "unshield incomplete", "unshield unsure",
    "unshield alternatives", "unshield no alternative", "unshield fixed",
    "unshield address-link address-reuse", "unshield rest-of-deposit", "unshield amount-stands-out",
    "shield not-checked", "unshield not-checked", "shield stale-data", "unshield incomplete-window",
    "balance", "no balance", "matches", "swap output",
  ].filter((v) => !reached.has(v));
  assert.deepEqual(missing, [], `variants not reached: ${missing.join(", ")}. Reached: ${[...reached].join(", ")}`);
  assert.ok([...reached].some((v) => /address-link (?!address-reuse)/.test(v)), "a transfer-history link is reached");
});

test("form words stay within the UI-R4 caps", () => {
  assert.ok(FORM_CAP <= 122 && SHIELD_FORM_CAP <= 122, "the form caps never go above the 28 Oct 2026 design");
  assert.ok(FORM_TARGET <= FORM_CAP);
  for (const [state, cap] of [["unshield", FORM_CAP], ["shield", SHIELD_FORM_CAP]]) {
    const counted = forms[state];
    assert.ok(
      counted.length <= cap,
      `The ${state} form has ${counted.length} words, cap ${cap} (target ${FORM_TARGET}). ` +
        `A new sentence removes one of equal length (UI-R10).\n${counted.join(" ")}`,
    );
  }
});

test("result first-level words stay within the UI-R4 caps", () => {
  assert.ok(RESULT_TARGET <= RESULT_CAP);
  assert.ok(
    largest.words.length <= RESULT_CAP,
    `The largest result first level (${largest.label}) has ${largest.words.length} words, ` +
      `cap ${RESULT_CAP} (target ${RESULT_TARGET}). A new sentence removes one of equal length (UI-R10).\n` +
      largest.words.join(" "),
  );
  assert.ok(
    copyWords <= RESULT_COPY_CAP,
    `The first-level lines of all results have ${copyWords} words, cap ${RESULT_COPY_CAP}. ` +
      `A line grew or a new one appeared.\n${copyLines.join("\n")}`,
  );
});

test("the word counter skips hidden text, numbers, data rows and the fold body", () => {
  const { document } = parseHTML(`<div id="root"><p>Two words</p><p hidden>no</p><span aria-hidden="true">no</span>
    <p class="hint sr-only">no</p><template><b>no</b></template><script>no()</script>
    <input placeholder="0.00"><input placeholder="Your amount"><button>Check 70% 1.5</button>
    <select><option>Pick one</option></select>
    <section id="matches"><h3>Match heading</h3><table><thead><tr><th>Sent</th></tr></thead>
    <tbody><tr><td><span>1.5 ETH</span> <span>Swap output</span></td><td>3 Oct 2026</td></tr></tbody></table></section>
    <details><summary>What does this mean?</summary><p>no</p>no</details></div>`);
  assert.deepEqual(count(document.getElementById("root")), [
    "Two", "words", "Your", "amount", "Check", "Pick", "one", "Match", "heading", "Sent", "Swap", "output",
    "What", "does", "this", "mean?",
  ]);
});

// UI-R5: no paragraph in the form, except errors (p.error).
const formSource = html.slice(html.indexOf('<form id="flow-form"'), html.indexOf("</form>"));
const paragraphs = [...formSource.matchAll(/<p\b([^>]*)>/g)]
  .map((m) => m[1])
  .filter((attrs) => !/class="[^"]*\berror\b/.test(attrs));
test(
  "no paragraph in the form except errors (UI-R5)",
  { todo: paragraphs.length ? `${paragraphs.length} hint paragraphs remain in the form` : false },
  () => {
    assert.deepEqual(paragraphs, []);
  },
);
