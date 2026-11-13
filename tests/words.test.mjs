// Word-count test (UI-7, UI-R4, UI-R5, UI-R10).
//
// It counts rendered text, not source strings. The test builds the page into a
// temporary folder (scripts/build.mjs, as CI does), loads dist/index.html into
// linkedom (a small DOM, no browser), and runs the real dist/flow.mjs and
// dist/worker.mjs against it. The worker runs in the same process on a frozen
// copy of the real pool (tests/fixtures/words-pool, taken from public/data on
// 10 Nov 2026), with the clock set to the fixture's dataTime.
//
// Form: the visible text of <form id="flow-form"> after the runtime sync(), with
// and without an amount typed. Unshield (the default) and shield each have a cap.
//
// Result: the test submits a matrix of real scenarios (shield and unshield;
// clear, attention, incomplete and not-checked; with and without balance;
// fixed and flexible amounts; link answers left at "?", or set to no or yes) and counts the
// visible text of the result section after each render. RESULT_CAP caps the
// largest state. RESULT_COPY_CAP caps the sum of the distinct first-level lines
// seen over the matrix (numbers taken out), so a line that grows is caught even
// when it is not in the largest state.
//
// What counts: text a user sees, button labels, labels, option text and
// placeholders. aria-hidden text is drawn on screen, so it counts. Skipped:
// `hidden`, .sr-only and .visually-hidden, <template>, <script>, <style>, and the body of a closed
// <details> fold (its <summary> counts). In the matches table, the per-row
// amounts and dates are data, not copy; its heading and column headers count.
// Its kind tags ("Shield", "Swap output") are a per-row value too: each distinct
// tag counts once per result, as a legend would (R1.7). The state pip labels
// (Amount, Links, Coverage) count. The alternatives lines count.
//
// A word is a whitespace-separated token with at least one letter, so numbers
// and amounts such as "0.00", "70%" or "1.5" do not count.
import { test } from "node:test";
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
// Each form cap is the largest of its states: empty amount, amount typed,
// "fixed" picked, a token that is not covered (unshield), and, for
// shield, the error states too. The open links panel has its own cap.
// R1.5: the token chips (WETH, USDC, Soon, Other, Ethereum) came in, and the
// action hint and the q3 example left the form: 115 to 105.
// R1.6: the link questions moved into the closed "Check links" panel and are
// optional: 105 to 53.
// UI-R5: the fee hint and the balance hint left the form (the result already
// shows the recipient amount and the balance left): 53 to 38, shield 40 to 39,
// errors 60 to 45, links open 104 to 89.
const FORM_CAP = 38; // unshield (the default)
const SHIELD_FORM_CAP = 39; // shield, its error states included
// Unshield with an error showing. The "Select an answer." errors left with R1.6:
// 114 to 60. It may only go down.
const FORM_ERROR_CAP = 45;
// Unshield with the links panel open: its four questions and toggles (UI-5).
const LINKS_FORM_CAP = 89;
// The sum of the distinct form error messages, so any one that grows is caught.
const ERROR_COPY_CAP = 28;
// R1.7: the three state pips came in (three words), one verdict line replaced the
// headline and its follow-up lines, the recipient amount moved to the fold, and
// the matches panel lost its sentence-like heading and visible column names:
// 40 to 25, the target. Kind tags count once per label; with every tag counted,
// the largest result (17.3 ETH, ten matching shield lines) has 33 words.
const RESULT_CAP = 25;
// The same largest state with every kind tag counted, one per matching shield
// line (strict). Measured at R1.7; it may only go down too.
const RESULT_STRICT_CAP = 33;
// R1.6: the link headlines share "That links them, whatever the amount.", and
// the incomplete headline reuses "Some answers are not sure.": 153 to 148.
// R1.7: 148 to 114.
const RESULT_COPY_CAP = 114;
// UI-3: the verdict is one line of 10 words or fewer.
const VERDICT_CAP = 10;
const FORM_TARGET = 60;
const RESULT_TARGET = 25;

const words = (text) => text.split(/\s+/).filter((t) => /\p{L}/u.test(t));

// --- Visible text ------------------------------------------------------------
const SKIP_TAGS = new Set(["TEMPLATE", "SCRIPT", "STYLE"]);
const HIDDEN_CLASS = /(^|\s)(sr-only|visually-hidden)(\s|$)/;
const DATA = [/\d[\d.,]*\s*(?:ETH|USDT|USDC)\b/g,/\b\d{1,2} (Jan|Feb|Mar|Apr|May|June?|July?|Aug|Sept?|Oct|Nov|Dec) \d{4}\b/g];
const isHidden = (el) =>
  SKIP_TAGS.has(el.tagName) ||
  el.hasAttribute("hidden") ||
  HIDDEN_CLASS.test(el.getAttribute("class") || "");

/** Visible text pieces of a DOM subtree. A piece is one line of copy. */
function visibleLines(root, { tagsOnce = true } = {}) {
  const lines = [],
    tags = new Set();
  const walk = (node, data) => {
    if (node.nodeType === 3) {
      let text = node.textContent;
      if (data) for (const re of DATA) text = text.replace(re, " ");
      if (text.trim()) lines.push(text.trim());
      return;
    }
    if (node.nodeType !== 1 || isHidden(node)) return;
    // A kind tag in a data row: the first of each label counts.
    if (data && tagsOnce && node.classList?.contains("kind-tag")) {
      const tag = node.textContent.trim();
      if (tags.has(tag)) return;
      tags.add(tag);
    }
    if (node.tagName === "INPUT") {
      const p = node.getAttribute("placeholder"),
        type = node.getAttribute("type") || "";
      if (p) lines.push(p);
      if (/^(button|submit|reset)$/.test(type) && node.getAttribute("value")) lines.push(node.getAttribute("value"));
      return;
    }
    // The body of a closed fold is hidden; its <summary> stays visible.
    // linkedom does not reflect `details.open = true` to the attribute: check both.
    const fold = node.tagName === "DETAILS" && !node.hasAttribute("open") && node.open !== true;
    // Matches rows hold data: amounts and dates.
    const rows = data || (node.tagName === "TBODY" && !!node.closest("#matches"));
    for (const child of node.childNodes)
      if (!fold || (child.nodeType === 1 && child.tagName === "SUMMARY")) walk(child, rows);
  };
  walk(root, false);
  return lines;
}
const count = (root, options) => words(visibleLines(root, options).join(" "));

// --- The built page ----------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "railcheck-words-"));
// Also runs when the setup below throws before any test starts.
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
for (const path of ["data", "src", "public", "lib", "packages", "scripts", "package.json"])
  cpSync(path, join(dir, path), { recursive: true });
// Frozen pool: the daily data update rewrites public/data, which would move the
// scenario outcomes and the caps. The page is built and checked on this copy.
const FIXTURE = "tests/fixtures/words-pool";
// R3.4: the USDT and USDC pools, frozen on 11 Nov 2026. The frozen manifest has
// no `pools`, so the default page covers WETH only; `openPage(STABLE_PAGE)`
// adds the stable entries (stables.json) and moves the clock to their data.
// A stable pool must come from the same run as WETH (dataTime and lastBlock),
// so that page also gives the WETH entry the stable pools' block (SAME_RUN).
for (const file of ["manifest.json", "railgun-eth.bin", "railgun-usdt.bin", "railgun-usdc.bin"])
  cpSync(join(FIXTURE, file), join(dir, "public/data", file));
const STABLES = JSON.parse(readFileSync(join(FIXTURE, "stables.json"), "utf8"));
const SAME_RUN = {
  dataTime: STABLES.usdt.dataTime,
  lastBlock: STABLES.usdt.lastBlock,
  lastBlockHash: STABLES.usdt.lastBlockHash,
};
const STABLE_PAGE = { now: STABLES.usdt.dataTime + 3600, patch: { ...SAME_RUN, pools: STABLES } };
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
assert.equal(manifest.sha256, JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8")).sha256, "the page uses the frozen pool");

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

/**
 * Opens the built page with its scripts. `now` is the clock in seconds. `motion`
 * turns reduced motion off; `raf` replaces requestAnimationFrame and
 * cancelAnimationFrame. `holdPools` holds the worker's "pools" message from the
 * start: the page opens once WETH is ready, and `pools.release()` delivers it.
 */
async function openPage({ now = manifest.dataTime + 3600, patch = {}, motion = false, raf, holdPools = false } = {}) {
  const page = parseHTML(html);
  const { document, Event } = page;
  let flowWorker, lastPlan, held = null, stablesLoaded = false;
  // Replies held from the start, and which ones (null: every reply).
  let only = null;
  if (holdPools) {
    held = [];
    only = (data) => data.type === "pools";
  }
  const sent = [], // every message flow.mjs sent to the worker
    fetched = []; // every URL the worker fetched
  const workerSelf = {
    postMessage(data) {
      if (data.type === "plan") lastPlan = data;
      // While held, worker replies wait in a queue until release().
      if (held && (!only || only(data))) return held.push(data);
      setTimeout(() => {
        flowWorker.onmessage({ data });
        // The stable pools report after WETH is ready.
        if (data.type === "pools") stablesLoaded = true;
      });
    },
  };
  Object.assign(globalThis, {
    document,
    window: { devicePixelRatio: 1, addEventListener() {} },
    self: workerSelf,
    matchMedia: () => ({ matches: !motion, addEventListener() {} }),
    requestAnimationFrame: raf?.request ?? (() => 0),
    cancelAnimationFrame: raf?.cancel ?? (() => {}),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    Worker: class {
      constructor() { flowWorker = this; }
      postMessage(data) {
        sent.push(data);
        setTimeout(() => workerSelf.onmessage({ data }));
      }
    },
    fetch: async (url) => {
      fetched.push(String(url));
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
  const flow = await import(`${pathToFileURL(join(dist, "flow.mjs"))}?page=${id}`);
  const $ = (x) => document.getElementById(x);
  await wait(() => $("progress").hidden && (stablesLoaded || held?.length > 0), "the pool data");
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
    document,
    flow,
    sent,
    fetched,
    plan: () => lastPlan,
    choose,
    type,
    /** A submit that the form rejects: it shows errors and sends nothing. */
    submit_() {
      fire($("flow-form"), "submit");
      assert.equal($("result").getAttribute("aria-busy"), "false", "the form was not sent");
    },
    async submit(s) {
      if (s.token) choose("token", s.token);
      choose("action", s.action);
      type("amount", s.amount);
      choose("constraint", s.constraint);
      if (s.action === "unshield") {
        // No answers: every toggle stays at "?", the default.
        LINKS.forEach((q, i) => choose(q, s.answers?.[i] ?? "unsure"));
        type("balance", s.balance ?? "");
      }
      fire($("flow-form"), "submit");
      assert.equal($("result").getAttribute("aria-busy"), "true", `${label(s)} was submitted`);
      await wait(() => $("result").getAttribute("aria-busy") === "false", label(s));
      assert.ok($("notice").hidden, `${label(s)}: ${$("notice").textContent}`);
      return { result: $("result"), plan: lastPlan };
    },
    fire,
    /** Holds the worker replies; release() delivers them. */
    hold() {
      held = [];
      only = null;
      return {
        replies: () => held.length,
        release() {
          const queue = held;
          held = null;
          for (const data of queue) flowWorker.onmessage({ data });
        },
      };
    },
    /** The "pools" message held by `holdPools`. */
    pools: holdPools && {
      replies: () => held?.length ?? 0,
      release() {
        const queue = held;
        held = only = null;
        stablesLoaded = true;
        for (const data of queue) flowWorker.onmessage({ data });
      },
    },
    close() {
      Date.now = realNow;
    },
  };
}
// The four toggles of the links panel, in order (UI-5).
const LINKS = ["addressReuse", "pastTransfer", "restOfDeposit", "swapGasPayer"];
const label = (s) =>
  `${s.token ? s.token + " " : ""}${s.action} ${s.amount} ${s.constraint}${s.answers ? " " + s.answers.join("/") : ""}${s.balance ? " balance " + s.balance : ""}`;

// --- Scenarios ---------------------------------------------------------------
// Each line reaches a first-level variant on the frozen pool; the coverage test
// below checks that they still do if the fixture is ever replaced. A plan takes up to a
// few seconds, so the matrix stays small. "1" and "0.0731" ETH: a shared and an
// odd amount. "1.01": a shield with a Low alternative. "17.3": an unshield with
// no Low alternative. "0.002268462": an unshield that matches a swap output.
// Answers are the four link toggles; a scenario without answers leaves all four
// at "?", the default since R1.6.
const NO = ["no", "no", "no", "no"],
  UNSURE = ["unsure", "no", "no", "no"];
const scenarios = [
  { action: "shield", amount: "1", constraint: "fixed" },
  { action: "shield", amount: "1.01", constraint: "fixed" },
  { action: "shield", amount: "1.01", constraint: "flexible" },
  { action: "shield", amount: "0.0731", constraint: "flexible" },
  { action: "unshield", amount: "0.0731", constraint: "fixed" },
  { action: "unshield", amount: "0.0731", constraint: "fixed", answers: NO },
  { action: "unshield", amount: "0.0731", constraint: "flexible", answers: NO, balance: "100" },
  { action: "unshield", amount: "0.0731", constraint: "fixed", answers: UNSURE, balance: "100" },
  { action: "unshield", amount: "0.0731", constraint: "flexible", answers: ["no", "unsure", "unsure", "no"] },
  { action: "unshield", amount: "0.0731", constraint: "fixed", answers: ["no", "no", "yes", "no"], balance: "100" },
  { action: "unshield", amount: "1", constraint: "fixed" },
  { action: "unshield", amount: "1", constraint: "fixed", answers: NO },
  { action: "unshield", amount: "1", constraint: "flexible", answers: NO, balance: "100" },
  { action: "unshield", amount: "1", constraint: "flexible", balance: "100" },
  { action: "unshield", amount: "1", constraint: "fixed", answers: ["yes", "no", "no", "no"], balance: "100" },
  { action: "unshield", amount: "1", constraint: "flexible", answers: ["no", "yes", "unsure", "unsure"], balance: "100" },
  { action: "unshield", amount: "1", constraint: "flexible", answers: ["no", "no", "yes", "no"], balance: "100" },
  { action: "unshield", amount: "1", constraint: "flexible", answers: ["no", "no", "no", "yes"], balance: "100" },
  { action: "unshield", amount: "17.3", constraint: "flexible", balance: "100" },
  { action: "unshield", amount: "0.002268462", constraint: "fixed", answers: NO },
  { action: "unshield", amount: "0.002268462", constraint: "fixed", answers: ["no", "no", "no", "unsure"] },
];

const forms = []; // { action, state, words }
const errorLines = new Set(); // every distinct form error shown
const states = []; // { label, words, strict, lines, verdict, pips, plan, action }
// One measured result: the counted words, the count with every kind tag
// (strict), the verdict line and the pip states on screen.
const measured = (name, result, plan, action) => ({
  label: name,
  words: count(result),
  strict: count(result, { tagsOnce: false }),
  lines: visibleLines(result),
  verdict: result.querySelector(".verdict")?.textContent ?? "",
  pips: Object.fromEntries([...result.querySelectorAll(".pip")].map((p) => [p.dataset.pip, p.dataset.state])),
  // The spoken name: the visible label and the visually hidden state (the cue is aria-hidden).
  pipNames: Object.fromEntries(
    [...result.querySelectorAll(".pip")].map((p) => [
      p.dataset.pip,
      [...p.childNodes].filter((n) => n.nodeType !== 1 || n.getAttribute("aria-hidden") !== "true").map((n) => n.textContent).join(""),
    ]),
  ),
  plan,
  action,
});
// The swap-output history does not reach back to the window start: the manifest
// says so, and the worker passes it to the engine (coverage "limited").
const noHistory = { metrics: { ...manifest.metrics, reshieldHistoryComplete: false } };
{
  const page = await openPage();
  try {
    // Form states, before any result. Errors come from real submits.
    const form = page.$("flow-form"),
      measure = (action, state) => {
        forms.push({ action, state, words: count(form) });
        for (const error of form.querySelectorAll(".error")) if (!error.hidden) errorLines.add(words(error.textContent).join(" "));
      };
    for (const action of ["unshield", "shield"]) {
      page.choose("action", action);
      page.type("amount", "");
      measure(action, "empty amount");
      page.submit_();
      measure(action, "error: empty amount");
      page.type("amount", "abc");
      page.submit_();
      measure(action, "error: invalid amount");
      page.type("amount", "1");
      measure(action, "amount typed");
      page.choose("constraint", "fixed");
      measure(action, "amount typed, fixed");
      page.choose("constraint", "flexible");
      if (action === "unshield") {
        // The links panel, open (UI-5). Closed again for the states below.
        assert.equal(page.flow.openLinks(), true);
        measure(action, "links open");
        page.$("links").removeAttribute("open");
        page.$("links").open = false;
        page.type("balance", "0.5");
        page.submit_();
        measure(action, "error: balance below amount");
        page.type("balance", "");
        // A token that is not covered: the form stays on screen, dimmed.
        for (const token of ["usdc", "other"]) {
          page.choose("token", token);
          measure(action, `token ${token}`);
        }
        page.choose("token", "weth");
      }
    }
    for (const s of scenarios) {
      const { result, plan } = await page.submit(s);
      states.push(measured(label(s), result, plan, s.action));
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
      for (const [action, constraint] of [["shield", "fixed"], ["unshield", "fixed"], ["unshield", "flexible"]]) {
        const s = { action, amount: "1", constraint, answers: NO, balance: "100" };
        const { result, plan } = await stale.submit(s);
        states.push(measured(`${name}: ${label(s)}`, result, plan, action));
      }
    } finally {
      stale.close();
    }
  }
  // Incomplete swap-output history (the live manifest has it complete).
  const partial = await openPage({ patch: noHistory });
  try {
    for (const s of [
      { action: "shield", amount: "1", constraint: "fixed" },
      { action: "unshield", amount: "0.0731", constraint: "fixed", answers: NO },
      { action: "unshield", amount: "1", constraint: "flexible", answers: NO, balance: "100" },
    ]) {
      const { result, plan } = await partial.submit(s);
      states.push(measured(`no swap-output history: ${label(s)}`, result, plan, s.action));
    }
  } finally {
    partial.close();
  }
  // R3.4: USDT, with its own pool, 6 decimals and its symbol in the copy. The
  // form and the results are under the same caps as WETH.
  const stable = await openPage(STABLE_PAGE);
  try {
    const form = stable.$("flow-form");
    stable.choose("token", "usdt");
    for (const action of ["unshield", "shield"]) {
      stable.choose("action", action);
      stable.type("amount", "1000");
      forms.push({ action, state: "usdt amount typed", words: count(form) });
      stable.type("amount", "1000.1234567");
      stable.submit_();
      forms.push({ action, state: "error: usdt 7 decimals", words: count(form) });
      for (const error of form.querySelectorAll(".error")) if (!error.hidden) errorLines.add(words(error.textContent).join(" "));
    }
    for (const s of [
      { token: "usdt", action: "shield", amount: "1000", constraint: "fixed" },
      { token: "usdt", action: "shield", amount: "1234.56", constraint: "flexible" },
      { token: "usdt", action: "unshield", amount: "997.5", constraint: "fixed" },
      { token: "usdt", action: "unshield", amount: "1000", constraint: "fixed", answers: NO },
      { token: "usdt", action: "unshield", amount: "5000", constraint: "flexible", answers: NO, balance: "10000" },
    ]) {
      const { result, plan } = await stable.submit(s);
      states.push(measured(label(s), result, plan, s.action));
    }
  } finally {
    stable.close();
  }
}
// The unit after an amount is a value, like the amount: a line that differs
// only in the ETH, USDT or USDC after a number is one line of copy. A USDT or
// USDC anywhere else is copy and counts.
const copyLines = [
  ...new Set(states.flatMap((s) => s.lines.map((l) => words(l.replace(/(\d[\d.,]*\s*)(?:USDT|USDC)\b/g, "$1ETH")).join(" ")).filter(Boolean))),
].sort();
const copyWords = copyLines.reduce((n, l) => n + l.split(" ").length, 0);
const largest = states.reduce((a, b) => (b.words.length > a.words.length ? b : a));
const largestStrict = states.reduce((a, b) => (b.strict.length > a.strict.length ? b : a));

if (process.env.WORDS_DEBUG) {
  for (const f of forms) console.log(`form ${f.action}, ${f.state}: ${f.words.length} |`, f.words.join(" "));
  for (const s of states) console.log(s.words.length, `(strict ${s.strict.length})`, s.label, JSON.stringify(s.pips), "|", s.words.join(" "));
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
    if (a.addressLinks?.unknown?.includes("swapGasPayer")) reached.add(`${action} swap gas payer unknown`);
    if (r.remainingBalance != null) reached.add("balance");
    if (action === "unshield" && a.status !== "not-checked" && r.remainingBalance == null) reached.add("no balance");
    if (plan.sets.length) reached.add("matches");
    if (plan.sets.some((set) => set.deposits.some((d) => d.kind === "reshield"))) reached.add("swap output");
    for (const m of a.coverage?.missing ?? []) reached.add(`${action} coverage ${m}`);
  }
  const missing = [
    "shield clear", "shield attention", "shield alternatives", "shield no alternative", "shield fixed",
    "unshield clear", "unshield attention", "unshield incomplete", "unshield unsure",
    "unshield alternatives", "unshield no alternative", "unshield fixed",
    "unshield address-link address-reuse", "unshield address-link swap-gas-payer", "unshield swap gas payer unknown",
    "unshield rest-of-deposit", "unshield amount-stands-out",
    "shield not-checked", "unshield not-checked", "shield stale-data", "unshield incomplete-window",
    "balance", "no balance", "matches", "swap output",
    "unshield coverage rest-of-deposit", "unshield coverage swap-output-history", "shield coverage swap-output-history",
  ].filter((v) => !reached.has(v));
  assert.deepEqual(missing, [], `variants not reached: ${missing.join(", ")}. Reached: ${[...reached].join(", ")}`);
  assert.ok(reached.has("unshield address-link past-transfer"), "a transfer-history link is reached");
});

test("form words stay within the UI-R4 caps", () => {
  assert.ok(FORM_CAP <= 122 && SHIELD_FORM_CAP <= 122, "the form caps never go above the 28 Oct 2026 design");
  // R1.6 brought the default unshield form under FORM_TARGET; the error and
  // links-open states are still above it.
  assert.ok(LINKS_FORM_CAP <= 122, "the open links panel stays within the 28 Oct 2026 design");
  const capOf = ({ action, state }) =>
    action === "shield"
      ? SHIELD_FORM_CAP
      : state.startsWith("error")
        ? FORM_ERROR_CAP
        : state === "links open"
          ? LINKS_FORM_CAP
          : FORM_CAP;
  assert.equal(forms.length, 18, "every form state was measured");
  const errorWords = [...errorLines].reduce((n, l) => n + words(l).length, 0);
  assert.ok(errorLines.size >= 4, `four different errors were shown: ${[...errorLines].join(" | ")}`);
  assert.ok(
    errorWords <= ERROR_COPY_CAP,
    `The form errors have ${errorWords} words, cap ${ERROR_COPY_CAP}.\n${[...errorLines].join("\n")}`,
  );
  for (const f of forms)
    assert.ok(
      f.words.length <= capOf(f),
      `The ${f.action} form (${f.state}) has ${f.words.length} words, cap ${capOf(f)} (target ${FORM_TARGET}). ` +
        `A new sentence removes one of equal length (UI-R10).\n${f.words.join(" ")}`,
    );
});

test("result first-level words stay within the UI-R4 caps", () => {
  // R1.7 reached the target: the cap is the target, and it may only go down.
  assert.ok(RESULT_CAP <= RESULT_TARGET);
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
  assert.ok(
    largestStrict.strict.length <= RESULT_STRICT_CAP,
    `With every kind tag counted, the largest result first level (${largestStrict.label}) has ` +
      `${largestStrict.strict.length} words, cap ${RESULT_STRICT_CAP}.\n${largestStrict.strict.join(" ")}`,
  );
});

test("a result that needs attention, or scores above Low, fills at least one pip", () => {
  let checked = 0;
  for (const s of states) {
    const a = s.plan.result.assessment;
    if (a.status !== "attention" && !(a.band && a.band !== "Low")) continue;
    checked++;
    assert.ok(Object.values(s.pips).includes("filled"), `${s.label} (${a.status}, ${a.band}): no filled pip ${JSON.stringify(s.pips)}`);
  }
  assert.ok(checked >= 10, `${checked} attention states were checked`);
  // The rest of a shield, with a Low amount and no address link: the Links pip
  // carries it, and says so to screen readers.
  const rest = states.find((s) => s.label === "unshield 0.0731 fixed no/no/yes/no balance 100");
  assert.ok(rest, "the rest-of-shield state is in the matrix");
  const a = rest.plan.result.assessment;
  assert.equal(a.status, "attention");
  assert.equal(a.amountExposure.band, "Low");
  assert.equal(a.addressLinks.state, "none-reported");
  assert.ok(a.findings.some((f) => f.code === "rest-of-deposit"));
  assert.deepEqual(rest.pips, { amount: "empty", links: "filled", coverage: "empty" });
  assert.equal(rest.pipNames.links, "Links: found");
});

test("UI-3: each result has one verdict line of 10 words or fewer", () => {
  for (const s of states) {
    const verdicts = s.lines.length && s.verdict;
    assert.ok(verdicts, `${s.label}: a verdict line shows`);
    assert.ok(
      words(s.verdict).length <= VERDICT_CAP,
      `${s.label}: "${s.verdict}" has ${words(s.verdict).length} words, cap ${VERDICT_CAP}`,
    );
  }
});

test("the word counter skips hidden text, numbers, data rows and closed folds", () => {
  const { document } = parseHTML(`<div id="root"><p>Two words</p><p hidden>no</p><span aria-hidden="true">Drawn</span>
    <p class="hint sr-only">no</p><template><b>no</b></template><script>no()</script>
    <input placeholder="0.00"><input placeholder="Your amount"><button>Check 70% 1.5</button>
    <select><option>Pick one</option></select>
    <section id="matches"><h3>Match heading</h3><table><thead><tr><th>Sent</th></tr></thead>
    <tbody><tr><td><span>1.5 ETH</span> <span class="kind-tag">Swap output</span></td><td>3 Oct 2026</td></tr>
    <tr><td><span>1.4 ETH</span> <span class="kind-tag">Swap output</span> <span class="kind-tag">Shield</span></td><td>2 Oct 2026</td></tr></tbody></table></section>
    <details><summary>What does this mean?</summary><p>no</p>no</details>
    <details id="opened"><summary>Open</summary><p>Shown</p></details></div>`);
  document.getElementById("opened").open = true;
  assert.deepEqual(count(document.getElementById("root")), [
    "Two", "words", "Drawn", "Your", "amount", "Check", "Pick", "one", "Match", "heading", "Sent", "Swap", "output",
    "Shield", "What", "does", "this", "mean?", "Open", "Shown",
  ]);
  // Strict: every kind tag counts.
  assert.equal(count(document.getElementById("root"), { tagsOnce: false }).length, 22);
});

// UI-R5: no paragraph in the form, except errors (p.error).
const formSource = html.slice(html.indexOf('<form id="flow-form"'), html.indexOf("</form>"));
const paragraphs = [...formSource.matchAll(/<p\b([^>]*)>/g)]
  .map((m) => m[1])
  .filter((attrs) => !/class="[^"]*\berror\b/.test(attrs));
test("no paragraph in the form except errors (UI-R5)", async () => {
  assert.ok(formSource.includes('class="error"'), "the error paragraphs are in the source checked");
  assert.deepEqual(paragraphs, [], "the built form has no paragraph but p.error");
  // At runtime too, with an amount typed and the balance shown, in each state.
  const page = await openPage(STABLE_PAGE);
  try {
    const form = page.$("flow-form");
    for (const token of ["weth", "usdt"])
      for (const action of ["unshield", "shield"]) {
        page.choose("token", token);
        page.choose("action", action);
        page.type("amount", "1000");
        const extra = [...form.querySelectorAll("p")].filter((p) => !p.classList.contains("error"));
        assert.deepEqual(extra.map((p) => p.outerHTML), [], `${token} ${action}`);
      }
    // Every aria-describedby in the form names an element on the page.
    for (const input of form.querySelectorAll("[aria-describedby]"))
      for (const id of input.getAttribute("aria-describedby").split(/\s+/))
        assert.ok(page.$(id), `${input.id || input.name}: #${id} exists`);
    assert.equal(page.$("amount").getAttribute("aria-describedby"), "amount-error");
    assert.equal(page.$("balance").getAttribute("aria-describedby"), "balance-error");
  } finally {
    page.close();
  }
});

// --- Token chips (UI-1, UI-R1) -------------------------------------------------
test("the token chips render from the config, WETH checked, with the Ethereum tag", async () => {
  const page = await openPage();
  try {
    const { TOKENS } = page.flow,
      chips = [...page.document.querySelectorAll("#token-chips .chip")],
      inputs = chips.map((c) => c.querySelector("input[name=token]"));
    // One source: the HTML has no chip of its own; every chip comes from TOKENS.
    assert.ok(!/name="token"/.test(html), "src/index.html has no hard-coded chip");
    assert.deepEqual(inputs.map((i) => i.value), TOKENS.map((t) => t.id));
    assert.deepEqual(
      chips.map((c) => words(visibleLines(c).join(" ")).join(" ")),
      TOKENS.map((t) => t.label),
    );
    assert.deepEqual(TOKENS.map((t) => t.label), ["WETH", "USDT", "USDC", "Other"]);
    assert.ok(!page.document.querySelector("#token-chips .soon"), "no chip shows Soon since R3.4");
    // The frozen manifest has no stable pools: their chips stay not covered.
    // linkedom keeps the checked state in the attribute, which :checked reads.
    assert.deepEqual([...page.document.querySelectorAll("input[name=token]:checked")].map((i) => i.value), ["weth"]);
    for (const [i, t] of TOKENS.entries()) {
      assert.equal(chips[i].dataset.covered, String(t.covered));
      assert.equal(!!chips[i].querySelector(".dash[aria-hidden=true]"), !t.covered, `${t.label}: the dash marks a token that is not covered`);
    }
    // A native radio group with an accessible name.
    const group = page.$("tokens");
    assert.equal(group.tagName, "FIELDSET");
    assert.equal(group.querySelector("legend").textContent.trim(), "Token");
    assert.ok(group.querySelector(".chain-tag").textContent.includes("Ethereum"));
    assert.ok(!group.querySelector(".chain-tag input, .chain-tag button"), "the chain tag is not interactive");
    assert.equal(page.$("flow-form").firstElementChild, group, "the chips come first, before the amount");
    assert.equal(page.$("amount").disabled, false);
    assert.equal(page.$("check-button").disabled, false);
  } finally {
    page.close();
  }
});

test("a token that is not covered turns the form off before typing, and WETH turns it back on", async () => {
  const page = await openPage();
  try {
    const form = page.$("flow-form");
    page.type("amount", "1.5");
    for (const token of ["other", "usdc", "usdt"]) {
      page.choose("token", token);
      assert.equal(page.$("amount").disabled, true, `${token}: the amount field is disabled`);
      assert.equal(page.$("check-button").disabled, true, `${token}: the button is disabled`);
      assert.equal(form.dataset.covered, "false", `${token}: the form shows the not-covered state`);
      for (const step of form.querySelectorAll(".step")) assert.ok(step.hasAttribute("inert"), `${token}: the steps are inert`);
      const chip = form.querySelector(`input[name=token][value=${token}]`);
      assert.ok(chip.closest(".chip").querySelector(".dash"), `${token}: the chip shows the dash`);
      // A stable whose pool is not published, or not complete, says so.
      const why = token === "other" ? "token-not-covered" : "token-incomplete";
      assert.equal(chip.getAttribute("aria-describedby"), why);
      assert.ok(page.$(why).classList.contains("sr-only"), "the explanation is not visible text");
      page.$("flow-form").dispatchEvent(new page.document.defaultView.Event("submit", { cancelable: true }));
      assert.equal(page.$("result").getAttribute("aria-busy"), "false", `${token}: nothing is sent`);
    }
    page.choose("token", "weth");
    assert.equal(page.$("amount").disabled, false);
    assert.equal(page.$("check-button").disabled, false);
    assert.equal(form.dataset.covered, "true");
    assert.ok(![...form.querySelectorAll(".step")].some((s) => s.hasAttribute("inert")));
    assert.equal(page.$("amount").value, "1.5", "the typed amount stays");
  } finally {
    page.close();
  }
});

test("a change during the scan drops the check in flight: no stale result, focus or announcement", async () => {
  const page = await openPage();
  try {
    const heading = page.$("result-heading");
    let focused = 0;
    heading.focus = () => focused++;
    const changes = [
      ["token other", () => page.choose("token", "other")],
      ["token usdc", () => page.choose("token", "usdc")],
      ["amount typed", () => page.type("amount", "2")],
    ];
    for (const [name, change] of changes) {
      page.choose("token", "weth");
      page.type("amount", "1");
      page.$("announcement").textContent = "";
      const worker = page.hold();
      page.fire(page.$("flow-form"), "submit");
      assert.equal(page.$("result").getAttribute("aria-busy"), "true", `${name}: the check was sent`);
      await wait(() => worker.replies() > 0, `${name}: the plan reply`);
      change();
      assert.ok(page.$("result").hidden, `${name}: the panel hides at once`);
      assert.equal(page.$("result").getAttribute("aria-busy"), "false", `${name}: the panel is no longer busy`);
      assert.equal(page.$("check-button").hasAttribute("aria-busy"), false, `${name}: the button is no longer busy`);
      worker.release();
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(page.$("result").hidden, `${name}: the late reply shows no result`);
      assert.equal(page.$("result-copy").children.length, 0, `${name}: no result copy`);
      assert.equal(page.$("announcement").textContent, "", `${name}: no announcement`);
      assert.equal(focused, 0, `${name}: focus does not move`);
    }
  } finally {
    page.close();
  }
});

// --- Stable pools (R3.4) --------------------------------------------------------
const POOL_URLS = ["./data/manifest.json", "./data/railgun-eth.bin", "./data/railgun-usdc.bin", "./data/railgun-usdt.bin"];

test("R3.4: every pool is fetched at load, whatever chip is picked, and nothing after", async () => {
  for (const pick of ["weth", "usdt", "usdc", "other"]) {
    const page = await openPage(STABLE_PAGE);
    try {
      assert.deepEqual([...page.fetched].sort(), POOL_URLS, `${pick}: the load requests`);
      if (pick !== "other") {
        await page.submit({ token: pick, action: "unshield", amount: "1000", constraint: "fixed", answers: NO });
        assert.equal(page.plan().token, pick);
      } else page.choose("token", pick);
      assert.deepEqual([...page.fetched].sort(), POOL_URLS, `${pick}: no request after load`);
    } finally {
      page.close();
    }
  }
});

test("R3.4: USDT and USDC are covered when their pools load complete; an incomplete one is not", async () => {
  const chipOf = (page, id) => page.document.querySelector(`input[name=token][value=${id}]`).closest(".chip");
  const page = await openPage(STABLE_PAGE);
  try {
    for (const id of ["usdt", "usdc"]) {
      const chip = chipOf(page, id);
      assert.equal(chip.dataset.covered, "true", `${id}: covered`);
      assert.ok(!chip.querySelector(".dash"), `${id}: no dash`);
      assert.ok(!chip.querySelector("input").hasAttribute("aria-describedby"), `${id}: no not-covered note`);
      page.choose("token", id);
      assert.equal(page.$("amount").disabled, false, `${id}: the form is on`);
      assert.deepEqual([...page.$("flow-form").querySelectorAll(".amount-wrap > span")].map((s) => s.textContent), [id.toUpperCase(), id.toUpperCase()]);
    }
    page.choose("token", "weth");
    assert.deepEqual([...page.$("flow-form").querySelectorAll(".amount-wrap > span")].map((s) => s.textContent), ["ETH", "ETH"]);
  } finally {
    page.close();
  }
  // A USDT entry with a short window: published, fetched, but not covered.
  const short = { ...STABLES, usdt: { ...STABLES.usdt, windowStart: STABLES.usdt.dataTime - 30 * 86400 } };
  const partial = await openPage({ ...STABLE_PAGE, patch: { ...STABLE_PAGE.patch, pools: short } });
  try {
    assert.deepEqual([...partial.fetched].sort(), POOL_URLS);
    const chip = chipOf(partial, "usdt");
    assert.equal(chip.dataset.covered, "false");
    assert.ok(chip.querySelector(".dash[aria-hidden=true]"), "the dash marks it");
    assert.equal(chip.querySelector("input").getAttribute("aria-describedby"), "token-incomplete");
    assert.equal(chipOf(partial, "usdc").dataset.covered, "true", "USDC is not affected");
    partial.type("amount", "1000");
    partial.choose("token", "usdt");
    assert.equal(partial.$("flow-form").dataset.covered, "false");
    assert.equal(partial.$("amount").disabled, true);
    partial.fire(partial.$("flow-form"), "submit");
    assert.equal(partial.$("result").getAttribute("aria-busy"), "false", "nothing is sent");
    assert.ok(partial.$("notice").hidden, "no error notice");
  } finally {
    partial.close();
  }
});

test("R3.4: USDT amounts use 6 decimals; a 7th is rejected, and a token change re-reads the amount", async () => {
  const page = await openPage(STABLE_PAGE);
  try {
    page.choose("token", "usdt");
    page.type("amount", "1000.1234567");
    page.submit_();
    assert.equal(page.$("amount-error").hidden, false);
    assert.match(page.$("amount-error").textContent, /decimal point/);
    // Valid for WETH (18 decimals): the error goes. Back on USDT it shows at once.
    page.choose("token", "weth");
    assert.equal(page.$("amount-error").hidden, true);
    page.choose("token", "usdt");
    assert.equal(page.$("amount-error").hidden, false);
    assert.equal(page.$("amount").getAttribute("aria-invalid"), "true");
    page.$("amount").value = "1000.123456";
    page.fire(page.$("flow-form"), "submit");
    await settled(page, "the USDT result");
    const message = page.sent.findLast((m) => m.type === "plan");
    assert.equal(message.token, "usdt");
    assert.equal(message.amount, "1000.123456");
    // The amount after the fee, once a form hint, is in the result fold.
    assert.ok(
      [...page.$("result-copy").querySelectorAll("details p")].some((p) => p.textContent === "The recipient gets 997.623148 USDT."),
      "the recipient amount after the fee",
    );
  } finally {
    page.close();
  }
});

test("R3.4: a USDT result shows USDT amounts, and a token change never leaves it under another chip", async () => {
  const page = await openPage(STABLE_PAGE);
  try {
    const { result } = await page.submit({ token: "usdt", action: "unshield", amount: "5000", constraint: "flexible", answers: NO, balance: "10000" });
    const text = result.textContent;
    assert.match(text, /Use 4987\.5 USDT · scores \d+/);
    assert.match(text, /Balance left: 5000 USDT\./);
    assert.doesNotMatch(text, /ETH/);
    assert.ok([...result.querySelectorAll("#matches tbody .match-leg")].some((l) => / USDT/.test(l.textContent)), "the matches are in USDT");
    // A result on screen, then another chip: it hides at once.
    page.choose("token", "weth");
    assert.ok(page.$("result").hidden);
    // A USDT check in flight, then WETH: the late USDT reply is dropped.
    page.choose("token", "usdt");
    page.type("amount", "1000");
    const worker = page.hold();
    page.fire(page.$("flow-form"), "submit");
    await wait(() => worker.replies() > 0, "the USDT reply");
    page.choose("token", "weth");
    worker.release();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(page.$("result").hidden, "no USDT result under the WETH chip");
    assert.equal(page.$("result-copy").children.length, 0);
  } finally {
    page.close();
  }
});

test("R3.4: a WETH result is unchanged with the stable pools published", async () => {
  for (const s of [
    { action: "unshield", amount: "1", constraint: "flexible", answers: NO, balance: "100" },
    { action: "unshield", amount: "17.3", constraint: "flexible", balance: "100" },
    { action: "shield", amount: "1.01", constraint: "flexible" },
  ]) {
    const seen = [];
    for (const options of [{ now: STABLE_PAGE.now, patch: SAME_RUN }, STABLE_PAGE]) {
      const page = await openPage(options);
      try {
        const { result, plan } = await page.submit(s);
        seen.push({ html: result.innerHTML, plan: JSON.stringify(plan.result) });
      } finally {
        page.close();
      }
    }
    assert.equal(seen[1].plan, seen[0].plan, `${label(s)}: the same result`);
    assert.equal(seen[1].html, seen[0].html, `${label(s)}: the same page`);
  }
});

test("R3.4: USDT picked and typed before the pools arrive: the form waits off, then turns on in place", async () => {
  const page = await openPage({ ...STABLE_PAGE, holdPools: true });
  try {
    const form = page.$("flow-form"),
      before = page.sent.length;
    assert.equal(page.pools.replies(), 1, "the pools message is held");
    page.choose("token", "usdt");
    page.type("amount", "1000.123456");
    // Not covered yet: off, and nothing goes to the worker.
    assert.equal(form.dataset.covered, "false");
    assert.equal(page.$("amount").disabled, true);
    assert.equal(page.$("check-button").disabled, true);
    for (const step of form.querySelectorAll(".step")) assert.ok(step.hasAttribute("inert"));
    page.fire(form, "submit");
    assert.equal(page.$("result").getAttribute("aria-busy"), "false", "nothing is sent");
    assert.ok(page.$("result").hidden);
    assert.equal(page.sent.length, before, "no message to the worker");
    assert.ok(page.$("notice").hidden, "no notice");
    assert.ok(page.$("amount-error").hidden, "no error for a 6-decimal amount");
    // The pools arrive: the form turns on in place, the amount kept, in USDT.
    page.pools.release();
    assert.deepEqual([...page.document.querySelectorAll("input[name=token]:checked")].map((i) => i.value), ["usdt"], "USDT stays picked");
    assert.equal(form.dataset.covered, "true");
    assert.equal(page.$("amount").disabled, false);
    assert.equal(page.$("check-button").disabled, false);
    assert.ok(![...form.querySelectorAll(".step")].some((s) => s.hasAttribute("inert")));
    assert.equal(page.$("amount").value, "1000.123456", "the typed amount stays");
    assert.ok(page.$("amount-error").hidden);
    assert.ok(page.$("notice").hidden);
    assert.deepEqual([...form.querySelectorAll(".amount-wrap > span")].map((s) => s.textContent), ["USDT", "USDT"]);
    // 6 decimals: a 7th is still refused, then the 6-decimal amount is sent.
    page.type("amount", "1000.1234567");
    page.submit_();
    assert.equal(page.$("amount-error").hidden, false);
    page.type("amount", "1000.123456");
    page.fire(form, "submit");
    await settled(page, "the USDT result");
    const message = page.sent.findLast((m) => m.type === "plan");
    assert.equal(message.token, "usdt");
    assert.equal(message.amount, "1000.123456");
  } finally {
    page.close();
  }
});

test("R3.4: a late pools message never changes a WETH result on screen", async () => {
  const page = await openPage({ ...STABLE_PAGE, holdPools: true });
  try {
    let focused = 0;
    page.$("result-heading").focus = () => focused++;
    const { result } = await page.submit({ action: "unshield", amount: "1", constraint: "flexible", answers: NO, balance: "100" });
    const state = () => ({
        html: result.innerHTML,
        hidden: result.hidden,
        busy: result.getAttribute("aria-busy"),
        said: page.$("announcement").textContent,
      }),
      shown = state(),
      sent = page.sent.length;
    assert.equal(page.pools.replies(), 1, "the pools message is still held");
    focused = 0;
    page.pools.release();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(state(), shown, "the same result");
    assert.equal(page.sent.length, sent, "no new check");
    assert.equal(focused, 0, "focus does not move");
    assert.ok(page.$("notice").hidden);
    assert.equal(page.document.querySelector("input[name=token][value=usdt]").closest(".chip").dataset.covered, "true", "the chips update");
  } finally {
    page.close();
  }
});

test("a stable chip says its pool is loading until the pools message, then why it is not covered", async () => {
  const describedBy = (page, id) => page.document.querySelector(`input[name=token][value=${id}]`).getAttribute("aria-describedby");
  // Complete pools: loading, then covered.
  const page = await openPage({ ...STABLE_PAGE, holdPools: true });
  try {
    assert.match(page.$("token-loading").textContent, /still loading/);
    assert.doesNotMatch(page.$("token-loading").textContent, /did not load|not complete/);
    assert.ok(page.$("token-loading").classList.contains("sr-only"), "not visible text");
    for (const id of ["usdt", "usdc"]) assert.equal(describedBy(page, id), "token-loading", `${id}: loading`);
    assert.equal(describedBy(page, "other"), "token-not-covered", "Other is never loading");
    assert.equal(describedBy(page, "weth"), null);
    page.pools.release();
    for (const id of ["usdt", "usdc"]) assert.equal(describedBy(page, id), null, `${id}: covered`);
  } finally {
    page.close();
  }
  // No stable pools in the manifest: loading, then not complete.
  const none = await openPage({ holdPools: true });
  try {
    assert.equal(describedBy(none, "usdt"), "token-loading");
    none.pools.release();
    assert.equal(describedBy(none, "usdt"), "token-incomplete");
    assert.match(none.$("token-incomplete").textContent, /did not load or is not complete/);
  } finally {
    none.close();
  }
});

// --- Links panel (UI-5, UI-R2, UI-R7, UI-R9) -----------------------------------
const settled = (page, what) =>
  wait(() => !page.$("result").hidden && page.$("result").getAttribute("aria-busy") === "false", what);

test("UI-R2: the check runs with only token and amount, and the result is incomplete in amber", async () => {
  const page = await openPage();
  try {
    page.type("amount", "0.0731");
    page.fire(page.$("flow-form"), "submit");
    await settled(page, "the result with no answers");
    assert.ok(page.$("notice").hidden);
    assert.ok(![...page.$("flow-form").querySelectorAll(".error")].some((e) => !e.hidden), "no error shows");
    const message = page.sent.findLast((m) => m.type === "plan");
    assert.deepEqual(message.context, {
      addressReuse: undefined,
      pastTransfer: undefined,
      restOfDeposit: undefined,
      swapGasPayer: undefined,
    });
    const a = page.plan().result.assessment;
    assert.equal(a.status, "incomplete");
    assert.equal(a.addressLinks.state, "unknown");
    assert.equal(a.band, "Low", "the amount alone scores Low on this pool");
    // UI-R7: unknown never looks safe. Incomplete takes the amber state.
    assert.equal(page.$("band").textContent, "Incomplete");
    assert.equal(page.$("result").dataset.band, "Medium");
    const css = readFileSync(join(dist, "style.css"), "utf8");
    assert.match(css, /\.result\[data-band="Medium"\]\s*\{\s*--band:\s*var\(--medium\)/);
    assert.match(css, /--medium:\s*#e8c36a/, "Medium is the amber token");
    // The Links pip carries "not sure" now (R1.7): no sentence repeats it (UI-R3).
    assert.equal(page.document.querySelector(".pip[data-pip=links]").dataset.state, "unknown");
    assert.doesNotMatch(page.$("result-copy").textContent, /not sure|No issue found/);
  } finally {
    page.close();
  }
});

test("each toggle maps to its context value, the swap gas payer included", async () => {
  const page = await openPage();
  try {
    page.type("amount", "1");
    const cases = [
      [["yes", "yes", "yes", "yes"], { addressReuse: true, pastTransfer: true, restOfDeposit: true, swapGasPayer: "public-wallet" }],
      [["no", "no", "no", "no"], { addressReuse: false, pastTransfer: false, restOfDeposit: false, swapGasPayer: "broadcaster" }],
      [["unsure", "unsure", "unsure", "unsure"], { addressReuse: undefined, pastTransfer: undefined, restOfDeposit: undefined, swapGasPayer: undefined }],
      [["no", "unsure", "no", "yes"], { addressReuse: false, pastTransfer: undefined, restOfDeposit: false, swapGasPayer: "public-wallet" }],
    ];
    for (const [answers, context] of cases) {
      page.choose("action", "unshield"); // hides any result, so the toggles below do not re-run
      LINKS.forEach((q, i) => page.choose(q, answers[i]));
      page.fire(page.$("flow-form"), "submit");
      await settled(page, answers.join("/"));
      assert.deepEqual(page.sent.findLast((m) => m.type === "plan").context, context, answers.join("/"));
    }
    // The engine reads the last one: the public wallet gives the address link.
    const a = page.plan().result.assessment;
    assert.deepEqual(a.addressLinks.reasons, ["swap-gas-payer"]);
    assert.ok(a.score >= 90);
    assert.match(page.$("result-copy").textContent, /A public wallet paid the swap gas\./);
    assert.doesNotMatch(page.$("result-copy").textContent, /Use a new address/);
  } finally {
    page.close();
  }
});

test("a toggle change re-runs the check in place; a reply for the old answers is dropped", async () => {
  const page = await openPage();
  try {
    const heading = page.$("result-heading");
    let focused = 0;
    heading.focus = () => focused++;
    page.type("amount", "1");
    page.fire(page.$("flow-form"), "submit");
    await settled(page, "the first result");
    assert.equal(page.$("band").textContent, "Medium");
    focused = 0;
    const before = page.sent.length;
    page.choose("addressReuse", "yes");
    assert.equal(page.$("result").getAttribute("aria-busy"), "true", "the check runs again at once");
    assert.equal(page.sent.length, before + 1);
    assert.equal(page.sent.at(-1).context.addressReuse, true);
    await settled(page, "the re-run");
    assert.equal(page.$("band").textContent, "Critical");
    assert.match(page.$("result-copy").textContent, /Same address as the shield\./);
    assert.equal(focused, 0, "a re-run leaves focus in the panel");

    // A change while the check is in flight: the old reply never renders.
    const worker = page.hold();
    page.choose("addressReuse", "no");
    await wait(() => worker.replies() > 0, "the first reply");
    page.choose("pastTransfer", "yes");
    await wait(() => worker.replies() > 1, "the second reply");
    worker.release();
    await settled(page, "the result for the last answers");
    assert.match(page.$("result-copy").textContent, /The addresses have a transfer history\./);
    assert.equal(page.plan().result.assessment.addressLinks.reasons[0], "past-transfer");

    // No result on screen: a toggle does not start a check.
    page.type("amount", "2");
    const count = page.sent.length;
    page.choose("restOfDeposit", "no");
    assert.equal(page.sent.length, count);
    assert.ok(page.$("result").hidden);
  } finally {
    page.close();
  }
});

test("the links panel: closed by default, after the amount, keyboard reachable, one fieldset per row, hidden for shield", async () => {
  const page = await openPage();
  try {
    const links = page.$("links"),
      summary = links.firstElementChild;
    assert.equal(links.tagName, "DETAILS");
    assert.ok(!links.hasAttribute("open"), "closed by default");
    assert.equal(summary.tagName, "SUMMARY", "a native disclosure: Tab reaches it, Enter and Space open it");
    assert.equal(summary.id, "links-toggle");
    assert.equal(summary.textContent.trim(), "Check links");
    assert.ok(!summary.hasAttribute("tabindex"));
    const order = [...page.$("flow-form").querySelectorAll("*")],
      at = (el) => order.indexOf(el);
    assert.ok(at(page.$("amount")) < at(links), "after the amount");
    assert.ok(at(links) < at(page.$("check-button")), "before the button");
    const rows = [...links.querySelectorAll("fieldset")];
    assert.equal(rows.length, 4);
    const legends = rows.map((row) => row.querySelector("legend").textContent.trim());
    assert.equal(new Set(legends).size, 4, "no question twice (UI-R9)");
    rows.forEach((row, i) => {
      assert.ok(words(legends[i]).length <= 12, `"${legends[i]}" has 12 words or fewer`);
      const inputs = [...row.querySelectorAll("input[type=radio]")];
      assert.deepEqual(inputs.map((input) => input.name), Array(3).fill(LINKS[i]));
      assert.deepEqual(inputs.map((input) => input.value), ["yes", "no", "unsure"]);
      assert.deepEqual(inputs.map((input) => input.closest("label").textContent.trim()), ["Yes", "No", "?"]);
      assert.equal(inputs[2].getAttribute("aria-label"), "? Not sure", '"?" has a spoken name');
      assert.deepEqual([...row.querySelectorAll("input:checked")].map((input) => input.value), ["unsure"], '"?" is the default');
    });
    assert.equal(page.flow.openLinks(), true);
    assert.ok(links.hasAttribute("open"), "openLinks() opens it in place (R1.7 calls it from the pip)");
    page.choose("action", "shield");
    assert.ok(page.$("unshield-options").hidden, "hidden for shield");
    assert.ok(links.closest("[hidden]"));
    assert.equal(page.flow.openLinks(), false, "nothing to open for a shield");
    page.type("amount", "1");
    page.fire(page.$("flow-form"), "submit");
    assert.equal(page.sent.at(-1).context, undefined, "a shield sends no link answers");
    await settled(page, "the shield result");
  } finally {
    page.close();
  }
});

test("a double submit runs one scan loop, and the result stops it", async () => {
  // A fake frame clock: queued callbacks run only when tick() is called.
  const frames = new Map();
  let next = 0;
  const raf = {
    request: (fn) => (frames.set(++next, fn), next),
    cancel: (id) => frames.delete(id),
  };
  const loops = () => [...frames.values()].filter((fn) => fn.name === "animate").length;
  const tick = () => {
    const queued = [...frames];
    frames.clear();
    for (const [, fn] of queued) fn();
  };
  const page = await openPage({ motion: true, raf });
  try {
    page.type("amount", "1");
    page.fire(page.$("flow-form"), "submit");
    page.fire(page.$("flow-form"), "submit"); // double click or double Enter
    assert.equal(loops(), 1, "one scan loop after two submits");
    tick();
    tick();
    assert.equal(loops(), 1, "still one loop after a few frames");
    await settled(page, "the result");
    assert.equal(loops(), 0, "no scan sweep over the settled result");
  } finally {
    page.close();
  }
});

// --- Three-part result (R1.7: UI-3, UI-4, UI-5, UI-R3, UI-R7, UI-R8) -------------
const pipsOf = (page) =>
  Object.fromEntries([...page.document.querySelectorAll("#pips .pip")].map((p) => [p.dataset.pip, p.dataset.state]));
async function result(s, options) {
  const page = await openPage(options);
  try {
    const { result: panel, plan } = await page.submit(s);
    return { page, panel, a: plan.result.assessment, pips: pipsOf(page) };
  } finally {
    page.close();
  }
}

test("UI-3: the pips follow the three parts of the result, for each status", async () => {
  const cases = [
    // [name, scenario, page options, status, pips]
    ["clear", { action: "unshield", amount: "0.0731", constraint: "fixed", answers: NO }, {}, "clear",
      { amount: "empty", links: "empty", coverage: "empty" }],
    ["attention by amount", { action: "unshield", amount: "1", constraint: "fixed", answers: NO }, {}, "attention",
      { amount: "filled", links: "empty", coverage: "empty" }],
    ["attention by link", { action: "unshield", amount: "0.0731", constraint: "fixed", answers: ["yes", "no", "no", "no"] }, {}, "attention",
      { amount: "empty", links: "filled", coverage: "empty" }],
    ["incomplete by unknown answers", { action: "unshield", amount: "0.0731", constraint: "fixed" }, {}, "incomplete",
      { amount: "empty", links: "unknown", coverage: "unknown" }],
    ["incomplete by an unknown address answer", { action: "unshield", amount: "0.0731", constraint: "fixed", answers: UNSURE }, {}, "incomplete",
      { amount: "empty", links: "unknown", coverage: "empty" }],
    ["incomplete by history", { action: "unshield", amount: "0.0731", constraint: "fixed", answers: NO }, { patch: noHistory }, "incomplete",
      { amount: "empty", links: "empty", coverage: "unknown" }],
    ["shield clear", { action: "shield", amount: "1", constraint: "fixed" }, {}, "clear",
      { amount: "empty", coverage: "empty" }],
    ["shield incomplete by history", { action: "shield", amount: "1", constraint: "fixed" }, { patch: noHistory }, "incomplete",
      { amount: "empty", coverage: "unknown" }],
    ["not-checked", { action: "unshield", amount: "1", constraint: "fixed", answers: NO }, { now: manifest.dataTime + 30 * 86400 }, "not-checked",
      { links: "unknown", coverage: "unknown" }],
  ];
  for (const [name, s, options, status, expected] of cases) {
    const { page, a, pips } = await result(s, options);
    assert.equal(a.status, status, name);
    assert.deepEqual(pips, expected, name);
    if (name === "incomplete by history") assert.deepEqual(a.coverage.missing, ["swap-output-history"]);
    // Each pip: a one-word visible label, a cue, and its state in the accessible name.
    for (const pip of page.document.querySelectorAll("#pips .pip")) {
      const label = { amount: "Amount", links: "Links", coverage: "Coverage" }[pip.dataset.pip];
      assert.deepEqual(words(visibleLines(pip).join(" ")), [label], `${name}: ${label} shows one word`);
      assert.equal(visibleLines(pip).includes("?"), pip.dataset.state === "unknown", `${name}: "?" marks unknown only`);
      assert.ok(pip.querySelector(".pip-cue[aria-hidden=true]"), `${name}: ${label} has a cue`);
      assert.match(pip.textContent.trim(), new RegExp(`^\\??${label}: [a-z ]+$`), `${name}: ${label} has a spoken state`);
    }
    // UI-R3: no sentence repeats a pip.
    assert.doesNotMatch(page.$("result-copy").firstElementChild.textContent, /not sure|links them/i, name);
  }
});

test("the worker passes the manifest's swap-output history flag to the engine", async () => {
  for (const [complete, options] of [[true, {}], [false, { patch: noHistory }]]) {
    const { a } = await result({ action: "unshield", amount: "0.0731", constraint: "fixed", answers: NO }, options);
    assert.equal(a.snapshot.reshieldHistoryComplete, complete);
    assert.equal(a.coverage.state, complete ? "complete" : "limited");
    assert.equal(a.status, complete ? "clear" : "incomplete");
  }
});

// A small cascade for the custom properties in style.css: top-level rules only
// (no @media), ordered by specificity and then source order, inherited down the
// tree, var() resolved. linkedom has no getComputedStyle; the same rules were
// also checked in a browser.
const css = readFileSync(join(dist, "style.css"), "utf8");
const rules = (() => {
  const out = [];
  let i = 0,
    order = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    const head = css.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, "").trim();
    let depth = 1,
      j = open + 1;
    for (; depth && j < css.length; j++) depth += css[j] === "{" ? 1 : css[j] === "}" ? -1 : 0;
    if (!head.startsWith("@")) {
      const props = [...css.slice(open + 1, j - 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]);
      if (props.length) for (const selector of head.split(",").map((x) => x.trim())) out.push({ selector, props, order: order++ });
    }
    i = j;
  }
  return out;
})();
const specificity = (sel) => {
  const ids = (sel.match(/#[\w-]+/g) || []).length,
    classes = (sel.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length,
    tags = (sel.replace(/\[[^\]]+\]|[.#:][\w-]+(\([^)]*\))?/g, " ").match(/[a-z][\w-]*/gi) || []).length;
  return ids * 10000 + classes * 100 + tags;
};
const matchesRule = (node, selector) => {
  if (selector === ":root") return node === node.ownerDocument.documentElement;
  try {
    return node.matches(selector);
  } catch {
    return false;
  }
};
function customProps(el) {
  const chain = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) chain.unshift(n);
  let props = {};
  for (const node of chain) {
    const own = rules
      .filter((r) => matchesRule(node, r.selector))
      .sort((x, y) => specificity(x.selector) - specificity(y.selector) || x.order - y.order);
    const next = { ...props };
    for (const r of own) for (const [k, v] of r.props) next[k] = v;
    // var() resolves on the element that declares it.
    const resolve = (v, depth = 0) =>
      depth > 8 ? v : v.replace(/var\((--[\w-]+)\)/g, (_, name) => resolve(next[name] ?? "", depth + 1));
    for (const k of Object.keys(next)) next[k] = resolve(next[k]);
    props = next;
  }
  return props;
}

test("UI-R7: incomplete and not-checked never use the green state, in classes or colours", async () => {
  const root = customProps(parseHTML(html).document.documentElement),
    green = root["--low"],
    amber = root["--medium"];
  assert.equal(green, "#5fe0ac");
  assert.equal(amber, "#e8c36a");
  const cases = [
    ["clear", { action: "unshield", amount: "0.0731", constraint: "fixed", answers: NO }, {}],
    ["incomplete by unknown answers", { action: "unshield", amount: "0.0731", constraint: "fixed" }, {}],
    ["incomplete by history", { action: "unshield", amount: "0.0731", constraint: "fixed", answers: NO }, { patch: noHistory }],
    ["shield incomplete by history", { action: "shield", amount: "1", constraint: "fixed" }, { patch: noHistory }],
    ["attention", { action: "unshield", amount: "1", constraint: "fixed", answers: NO }, {}],
    ["not-checked", { action: "unshield", amount: "1", constraint: "fixed", answers: NO }, { now: manifest.dataTime + 30 * 86400 }],
  ];
  const seen = new Set();
  for (const [name, s, options] of cases) {
    const { page, panel, a } = await result(s, options);
    seen.add(a.status);
    assert.equal(panel.dataset.status, a.status, name);
    const band = customProps(panel)["--band"],
      pips = [...page.document.querySelectorAll("#pips .pip")];
    if (a.status === "clear") assert.equal(band, green, `${name}: green is for clear only`);
    else if (a.status === "incomplete" || a.status === "not-checked") {
      assert.equal(band, amber, `${name}: the amber state`);
      assert.notEqual(panel.dataset.band, "Low", `${name}: not the Low band`);
      assert.doesNotMatch(`${panel.className} ${page.$("band").className}`, /clear|low/i, name);
      assert.equal(customProps(page.$("band"))["--band"], amber, `${name}: the status chip is amber`);
    } else assert.notEqual(band, green, name);
    for (const pip of pips) {
      const colour = customProps(pip)["--pip"];
      assert.notEqual(colour, green, `${name}: the ${pip.dataset.pip} pip is never green`);
      if (pip.dataset.state === "unknown") assert.equal(colour, amber, `${name}: "?" is amber`);
      if (pip.dataset.state === "empty") assert.equal(colour, root["--muted"], `${name}: empty is a neutral outline`);
      if (pip.dataset.state === "filled") assert.equal(colour, band, `${name}: filled takes the band colour`);
    }
  }
  assert.deepEqual([...seen].sort(), ["attention", "clear", "incomplete", "not-checked"], "a visual check for each status");
});

test("UI-5: the Links pip is a button that opens the links panel in place", async () => {
  const page = await openPage();
  try {
    page.type("amount", "0.0731");
    page.fire(page.$("flow-form"), "submit");
    await settled(page, "the result");
    const pip = page.document.querySelector(".pip[data-pip=links]"),
      links = page.$("links");
    assert.equal(pip.tagName, "BUTTON");
    assert.equal(pip.getAttribute("type"), "button");
    assert.equal(pip.getAttribute("aria-controls"), "links");
    assert.ok(!links.hasAttribute("open"));
    let focused = 0,
      scrolled = 0;
    page.$("links-toggle").focus = () => focused++;
    links.scrollIntoView = () => scrolled++;
    // A native button: Enter and Space fire click.
    page.fire(pip, "click");
    assert.ok(links.hasAttribute("open"), "the panel opens");
    assert.equal(focused, 1, "focus moves to the panel");
    assert.equal(scrolled, 1, "the panel scrolls into view");
    assert.ok(!page.$("result").hidden, "the result stays");
    // Coverage opens it too when the open part is the rest-of-shield answer.
    assert.equal(page.document.querySelector(".pip[data-pip=coverage]").tagName, "BUTTON");
    // A shield has no Links pip, and its pips are not interactive.
    page.choose("action", "shield");
    page.fire(page.$("flow-form"), "submit");
    await settled(page, "the shield result");
    assert.equal(page.document.querySelector(".pip[data-pip=links]"), null);
    assert.equal(page.document.querySelectorAll("#pips button").length, 0);
  } finally {
    page.close();
  }
});

test("UI-4, UI-R6, UI-R8: the matches panel stays open under the crowd, with a kind tag and icon per row", async () => {
  const page = await openPage();
  try {
    const { result: panel, plan } = await page.submit({ action: "unshield", amount: "0.002268462", constraint: "fixed", answers: NO });
    const box = page.$("matches"),
      order = [...panel.children].map((c) => c.id);
    assert.ok(!box.hidden);
    // Directly under the meter: readout, crowd, matches, then the copy.
    const at = order.indexOf("readout");
    assert.deepEqual(order.slice(at, at + 3), ["readout", "crowd", "matches"]);
    assert.ok(!box.closest("details"), "not in a fold");
    const legs = plan.sets.flatMap((set) => set.deposits),
      tags = [...box.querySelectorAll("tbody .kind-tag")];
    assert.equal(tags.length, legs.length, "one tag per shield line");
    tags.forEach((tag, i) => {
      const kind = legs[i].kind === "reshield" ? "swap-output" : "shield";
      assert.equal(tag.dataset.kind, kind);
      assert.equal(tag.textContent.trim(), kind === "shield" ? "Shield" : "Swap output");
      assert.equal(tag.querySelector("svg").getAttribute("aria-hidden"), "true");
    });
    assert.ok(tags.some((t) => t.dataset.kind === "swap-output") && tags.some((t) => t.dataset.kind === "shield"));
    const icons = new Set(tags.map((t) => t.querySelector("path").getAttribute("d")));
    assert.equal(icons.size, 2, "each kind has its own icon");
    // No sentence in the panel: the heading and the tags are its only words.
    assert.deepEqual([...new Set(words(visibleLines(box, { tagsOnce: false }).join(" ")))].sort(), ["Matches", "Shield", "Swap", "output"]);
    // UI-R8: never "reshield", in text or markup.
    assert.doesNotMatch(page.document.body.textContent, /reshield/i);
    assert.doesNotMatch(page.document.body.innerHTML, /reshield/i);
  } finally {
    page.close();
  }
});
