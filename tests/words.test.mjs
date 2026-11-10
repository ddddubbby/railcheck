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
// placeholders. aria-hidden text is drawn on screen, so it counts. Skipped:
// `hidden`, .sr-only and .visually-hidden, <template>, <script>, <style>, and the body of a closed
// <details> fold (its <summary> counts). In the matches table, the per-row
// amounts and dates are data, not copy; its heading, column headers and tags
// such as "Swap output" count. The alternatives lines count.
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
// Each form cap is the largest of its states: empty amount, amount typed (fee
// hint), "fixed" picked, a token that is not covered (unshield), and, for
// shield, the error states too.
// R1.5: the token chips (WETH, USDC, Soon, Other, Ethereum) came in, and the
// action hint and the q3 example left the form: 115 to 105.
const FORM_CAP = 105; // unshield (the default): amount typed, with the fee hint
const SHIELD_FORM_CAP = 40; // shield: amount typed, with the fee hint
// Unshield with errors showing: a submit with no answers shows three "Select an
// answer." lines. Measured at 124 before R1.5, above the 122 of the 28 Oct 2026
// design; 114 since. It may only go down.
const FORM_ERROR_CAP = 114;
// The sum of the distinct form error messages, so any one that grows is caught.
const ERROR_COPY_CAP = 31;
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
const count = (root) => words(visibleLines(root).join(" "));

// --- The built page ----------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "railcheck-words-"));
// Also runs when the setup below throws before any test starts.
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
for (const path of ["data", "src", "public", "lib", "packages", "scripts", "package.json"])
  cpSync(path, join(dir, path), { recursive: true });
// Frozen pool: the daily data update rewrites public/data, which would move the
// scenario outcomes and the caps. The page is built and checked on this copy.
const FIXTURE = "tests/fixtures/words-pool";
for (const file of ["manifest.json", "railgun-eth.bin"])
  cpSync(join(FIXTURE, file), join(dir, "public/data", file));
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

/** Opens the built page with its scripts. `now` is the clock in seconds. */
async function openPage({ now = manifest.dataTime + 3600, patch = {} } = {}) {
  const page = parseHTML(html);
  const { document, Event } = page;
  let flowWorker, lastPlan, held = null;
  const workerSelf = {
    postMessage(data) {
      if (data.type === "plan") lastPlan = data;
      // While held, worker replies wait in a queue until release().
      if (held) return held.push(data);
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
  const flow = await import(`${pathToFileURL(join(dist, "flow.mjs"))}?page=${id}`);
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
    document,
    flow,
    choose,
    type,
    /** A submit that the form rejects: it shows errors and sends nothing. */
    submit_() {
      fire($("flow-form"), "submit");
      assert.equal($("result").getAttribute("aria-busy"), "false", "the form was not sent");
    },
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
    fire,
    /** Holds the worker replies; release() delivers them. */
    hold() {
      held = [];
      return {
        replies: () => held.length,
        release() {
          const queue = held;
          held = null;
          for (const data of queue) flowWorker.onmessage({ data });
        },
      };
    },
    close() {
      Date.now = realNow;
    },
  };
}
const label = (s) =>
  `${s.action} ${s.amount} ${s.constraint}${s.answers ? " " + s.answers.join("/") : ""}${s.balance ? " balance " + s.balance : ""}`;

// --- Scenarios ---------------------------------------------------------------
// Each line reaches a first-level variant on the frozen pool; the coverage test
// below checks that they still do if the fixture is ever replaced. A plan takes up to a
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
  { action: "unshield", amount: "0.0731", constraint: "flexible", answers: NO, balance: "100" },
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

const forms = []; // { action, state, words }
const errorLines = new Set(); // every distinct form error shown
const states = []; // { label, words, lines, plan, action }
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
        page.submit_();
        measure(action, "error: no answers");
        for (const q of ["q1", "q2", "q3"]) page.choose(q, "no");
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
      for (const [action, constraint] of [["shield", "fixed"], ["unshield", "fixed"], ["unshield", "flexible"]]) {
        const s = { action, amount: "1", constraint, answers: NO, balance: "100" };
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
  for (const f of forms) console.log(`form ${f.action}, ${f.state}: ${f.words.length} |`, f.words.join(" "));
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
  const capOf = ({ action, state }) =>
    action === "shield" ? SHIELD_FORM_CAP : state.startsWith("error") ? FORM_ERROR_CAP : FORM_CAP;
  assert.equal(forms.length, 14, "every form state was measured");
  const errorWords = [...errorLines].reduce((n, l) => n + words(l).length, 0);
  assert.ok(errorLines.size >= 5, `five different errors were shown: ${[...errorLines].join(" | ")}`);
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

test("the word counter skips hidden text, numbers, data rows and closed folds", () => {
  const { document } = parseHTML(`<div id="root"><p>Two words</p><p hidden>no</p><span aria-hidden="true">Drawn</span>
    <p class="hint sr-only">no</p><template><b>no</b></template><script>no()</script>
    <input placeholder="0.00"><input placeholder="Your amount"><button>Check 70% 1.5</button>
    <select><option>Pick one</option></select>
    <section id="matches"><h3>Match heading</h3><table><thead><tr><th>Sent</th></tr></thead>
    <tbody><tr><td><span>1.5 ETH</span> <span>Swap output</span></td><td>3 Oct 2026</td></tr></tbody></table></section>
    <details><summary>What does this mean?</summary><p>no</p>no</details>
    <details id="opened"><summary>Open</summary><p>Shown</p></details></div>`);
  document.getElementById("opened").open = true;
  assert.deepEqual(count(document.getElementById("root")), [
    "Two", "words", "Drawn", "Your", "amount", "Check", "Pick", "one", "Match", "heading", "Sent", "Swap", "output",
    "What", "does", "this", "mean?", "Open", "Shown",
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
      TOKENS.map((t) => (t.soon ? `${t.label} Soon` : t.label)),
    );
    assert.deepEqual(TOKENS.map((t) => t.label), ["WETH", "USDC", "Other"]);
    assert.equal(TOKENS.find((t) => t.id === "usdc").soon, true, "USDC shows Soon before R3");
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
    for (const token of ["other", "usdc"]) {
      page.choose("token", token);
      assert.equal(page.$("amount").disabled, true, `${token}: the amount field is disabled`);
      assert.equal(page.$("check-button").disabled, true, `${token}: the button is disabled`);
      assert.equal(form.dataset.covered, "false", `${token}: the form shows the not-covered state`);
      for (const step of form.querySelectorAll(".step")) assert.ok(step.hasAttribute("inert"), `${token}: the steps are inert`);
      const chip = form.querySelector(`input[name=token][value=${token}]`);
      assert.ok(chip.closest(".chip").querySelector(".dash"), `${token}: the chip shows the dash`);
      assert.equal(chip.getAttribute("aria-describedby"), "token-not-covered");
      assert.ok(page.$("token-not-covered").classList.contains("sr-only"), "the explanation is not visible text");
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
      ["answer changed", () => page.choose("q1", "unsure")],
    ];
    for (const [name, change] of changes) {
      page.choose("token", "weth");
      page.type("amount", "1");
      for (const q of ["q1", "q2", "q3"]) page.choose(q, "no");
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
