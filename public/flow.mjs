// One flow for shield and unshield: assess, optionally adjust, review.
// Amounts and answers stay in memory: no storage, no URL, no network after load.
import { parseAmount, formatWei, ETH_ASSET, USDT_ASSET, USDC_ASSET } from "./lib/engine/index.mjs";

// Token chips: the one source for the chip row. Adding a token is a one-line
// change here. `covered: false` shows the dash and turns the form off. A token
// with `pool: true` starts as not covered and turns covered when the worker
// reports its pool loaded, verified and complete (a full 180-day window). The
// first entry is the default.
export const TOKENS = [
  { id: "weth", label: "WETH", asset: ETH_ASSET, covered: true },
  { id: "usdt", label: "USDT", asset: USDT_ASSET, covered: false, pool: true },
  { id: "usdc", label: "USDC", asset: USDC_ASSET, covered: false, pool: true },
  { id: "other", label: "Other", covered: false },
];
// Per page load: which tokens are covered (stable pools after "ready") and the
// shields in each pool file.
const covered = Object.fromEntries(TOKENS.map((t) => [t.id, t.covered])),
  counts = {};

// The form stays hidden until this module runs. Without JavaScript, the noscript
// message replaces it.
document.documentElement.classList.remove("no-js");
const $ = (id) => document.getElementById(id),
  form = $("flow-form"),
  panel = $("result"),
  canvas = $("crowd"),
  ctx = canvas.getContext("2d"),
  reduced = matchMedia("(prefers-reduced-motion: reduce)");
let worker,
  ready = false,
  // The "pools" message (or a load error) has come: until then a stable chip
  // says its pool is still loading.
  settled = false,
  request = 0,
  last = null,
  pool = 0,
  start = 0,
  frame,
  lastSets = [],
  lastLit = [];
// The links panel (UI-5): four optional toggles, "?" (unsure) by default. Each
// name is the engine context field; "?" is undefined, never "no".
const LINKS = {
  addressReuse: { yes: true, no: false },
  pastTransfer: { yes: true, no: false },
  restOfDeposit: { yes: true, no: false },
  swapGasPayer: { yes: "public-wallet", no: "broadcaster" },
};
// The asset of the form: the last token picked that has one. Amounts are typed,
// parsed and shown in its decimals, with its word (ETH for WETH, else the symbol).
let asset = ETH_ASSET;
const unit = () => asset.unit ?? asset.symbol;
const eth = (wei) => `${formatWei(BigInt(wei), undefined, asset)} ${unit()}`;
const date = (t) =>
  new Date(t * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
const el = (tag, content, cls) => {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (cls) node.className = cls;
  return node;
};
const action = () => form.querySelector("input[name=action]:checked")?.value || "unshield";
const value = (name) => form.querySelector(`input[name=${name}]:checked`)?.value;

function notice(message) {
  $("notice").hidden = !message;
  $("notice").textContent = message || "";
}
function load() {
  $("progress").hidden = false;
  worker = new Worker("/worker.mjs", { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.type === "ready") {
      ready = true;
      $("progress").hidden = true;
      $("data-date").textContent = "Data updated " + date(data.manifest.dataTime);
      // File rows, swap outputs included: lit ids are positions in the file.
      pool = data.manifest.count;
      Object.assign(counts, data.counts);
      notice();
    }
    // The stable pools, after WETH: each is covered only when it loaded,
    // verified and complete.
    if (data.type === "pools") {
      Object.assign(counts, data.counts);
      for (const t of TOKENS) if (t.pool) covered[t.id] = !!data.covered?.[t.id];
      settled = true;
      chips(true);
      coverage();
    }
    if (data.type === "error" && data.id === undefined) {
      settled = true;
      chips(true);
      return notice(data.message);
    }
    if (data.id !== request) return;
    // Never one token's result under another token's chip.
    if (data.token && data.token !== token().id) return;
    if (data.type === "plan") {
      // Keep the scan on screen briefly so the result does not flash.
      // aria-busy stays true until render puts the result on the page.
      const wait = reduced.matches ? 0 : Math.max(0, 600 - (performance.now() - start));
      setTimeout(() => {
        if (data.id !== request) return;
        render(data);
        stop();
      }, wait);
    }
    if (data.type === "error") {
      stop();
      panel.hidden = true;
      notice(data.message);
    }
  };
  worker.onerror = () => {
    settled = true;
    chips(true);
    notice("The pool data did not load. Check your connection, then try again.");
  };
  worker.postMessage({ type: "load" });
}

// One radio per token. Built before the form shows. When the pools load, the
// chips are updated in place: the tick and the dash take the same room, so
// nothing moves.
function chips(update = false) {
  if (update) {
    for (const chip of $("token-chips").children) face(chip, TOKENS.find((t) => t.id === chip.querySelector("input").value));
    return;
  }
  $("token-chips").replaceChildren(
    ...TOKENS.map((token, i) => {
      const chip = el("label", undefined, "chip"),
        input = el("input");
      Object.assign(input, { type: "radio", name: "token", value: token.id });
      if (!i) input.setAttribute("checked", "");
      chip.append(input, el("span"));
      face(chip, token);
      return chip;
    }),
  );
}
function face(chip, token) {
  const input = chip.querySelector("input"),
    box = chip.querySelector("span"),
    on = covered[token.id];
  chip.dataset.covered = on;
  if (on) input.removeAttribute("aria-describedby");
  else
    input.setAttribute("aria-describedby", !token.pool ? "token-not-covered" : settled ? "token-incomplete" : "token-loading");
  box.replaceChildren();
  if (!on) {
    const dash = el("span", undefined, "dash");
    dash.setAttribute("aria-hidden", "true");
    box.append(dash);
  }
  box.append(token.label);
}
const token = () => TOKENS.find((t) => t.id === value("token")) || TOKENS[0];
// Fail early: a token that is not covered turns the form off before any typing.
// The typed amount stays, so switching back to a covered token goes on from it.
function coverage() {
  const t = token(),
    off = !covered[t.id];
  form.dataset.covered = !off;
  $("amount").disabled = off;
  $("check-button").disabled = off;
  for (const step of form.querySelectorAll(".step")) step.toggleAttribute("inert", off);
  if (t.asset && t.asset !== asset) {
    asset = t.asset;
    for (const span of form.querySelectorAll(".amount-wrap > span")) span.textContent = unit();
    reparse();
  }
}
// A new token has other decimals: the typed amounts are read again. An amount
// the new token cannot take shows its error at once, without moving focus.
function reparse() {
  for (const id of ["amount", "balance"]) {
    const input = $(id),
      error = $(id + "-error"),
      text = input.value.trim();
    try {
      if (text) parseAmount(text, asset);
      error.hidden = true;
      input.removeAttribute("aria-invalid");
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      input.setAttribute("aria-invalid", "true");
    }
  }
}
// The form follows the action: shield has no address questions.
function sync() {
  const shield = action() === "shield";
  $("amount-label").textContent = shield ? "Amount to shield" : "Amount to unshield";
  $("constraint-legend").textContent = shield
    ? "Can the amount change a little?"
    : "Can the amount be smaller?";
  $("flexible-label").textContent = shield ? "Yes, within 10%" : "Yes, down to 70%";
  $("unshield-options").hidden = shield;
  $("check-button").textContent = shield ? "Check shield amount" : "Check unshield amount";
  // The old message names the old action, so clear it when the action changes.
  for (const id of ["amount", "balance"]) {
    $(id + "-error").hidden = true;
    $(id).removeAttribute("aria-invalid");
  }
}
// Reads an amount field: its text, "" when optional and empty, or null when invalid.
function field(id, optional = false, emptyMessage = "Enter an amount.") {
  const input = $(id),
    error = $(id + "-error"),
    text = input.value.trim();
  try {
    if (!(optional && !text)) {
      if (!text) throw Error(emptyMessage);
      parseAmount(text, asset);
    }
    error.hidden = true;
    input.removeAttribute("aria-invalid");
    return text;
  } catch (e) {
    error.textContent = e.message;
    error.hidden = false;
    input.setAttribute("aria-invalid", "true");
    input.focus();
    return null;
  }
}
// A re-run from the links panel is quiet: focus and scroll stay in the panel.
let quiet = false;
function submit(event, options = {}) {
  event?.preventDefault();
  quiet = !!options.quiet;
  if (!covered[token().id]) return;
  const verb = action() === "shield" ? "shield" : "unshield",
    amount = field("amount", false, `Enter the amount that you will ${verb}.`);
  if (amount === null) return;
  const message = { type: "plan", token: token().id, action: action(), amount, constraint: value("constraint") };
  if (message.action === "unshield") {
    const balance = field("balance", true);
    if (balance === null) return;
    if (balance && parseAmount(balance, asset) < parseAmount(amount, asset)) {
      const input = $("balance"),
        error = $("balance-error");
      error.textContent = "The balance is less than the amount.";
      error.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
    message.context = Object.fromEntries(
      Object.entries(LINKS).map(([q, map]) => [q, map[value(q)]]),
    );
    message.balance = balance;
  }
  if (!ready)
    return notice("The pool data did not load. Check your connection, then try again.");
  request++;
  last = message;
  // The crowd of the picked pool: lit ids are positions in its file.
  pool = counts[message.token] ?? pool;
  $("check-button").setAttribute("aria-busy", "true");
  start = performance.now();
  panel.hidden = false;
  panel.setAttribute("aria-busy", "true");
  $("readout").hidden = true;
  $("band").textContent = "";
  $("result-copy").replaceChildren();
  $("pips").hidden = true;
  matches([]);
  $("scan-label").hidden = false;
  if (!reduced.matches) animate();
  else draw([]);
  worker.postMessage({ ...message, id: request });
}
// The pixel crowd: each cell is a group of deposits; lit cells match the amount.
function draw(ids, scan = 0) {
  const width = canvas.clientWidth,
    height = 64,
    dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const count = pool || 1,
    group = Math.ceil(count / 600),
    cells = Math.ceil(count / group),
    columns = Math.max(1, Math.floor(width / 7)),
    rows = Math.ceil(cells / columns),
    stepY = height / Math.max(rows, 1),
    stepX = width / columns,
    lit = new Set(ids.map((id) => Math.floor(id / group))),
    color = getComputedStyle(panel).getPropertyValue("--band").trim();
  for (let i = 0; i < cells; i++) {
    const x = i % columns,
      y = Math.floor(i / columns);
    ctx.fillStyle = lit.has(i)
      ? color
      : scan && Math.abs(x / columns - scan) < 0.07
        ? "rgba(174,188,229,.6)"
        : "rgba(255,255,255,.10)";
    ctx.fillRect(x * stepX, y * stepY, Math.max(1, stepX - 2), Math.max(1, stepY - 2));
  }
}
// One scan loop at a time: a second submit (double click, double Enter) cancels
// the frame the first one queued, so stop() always ends the only loop.
function animate() {
  draw([], ((performance.now() - start) % 600) / 600);
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(animate);
}
function stop() {
  cancelAnimationFrame(frame);
  $("check-button").removeAttribute("aria-busy");
  panel.setAttribute("aria-busy", "false");
}
function readout(score, band) {
  $("readout").hidden = false;
  $("scan-label").hidden = true;
  const meter = $("meter");
  meter.setAttribute("aria-valuenow", score);
  meter.setAttribute("aria-valuetext", `${score} out of 100. ${band}.`);
  [...meter.children].forEach((cell, i) => cell.classList.toggle("on", i < Math.ceil(score / 10)));
  if (reduced.matches) return ($("score").textContent = score);
  const begin = performance.now();
  const decode = () => {
    if (performance.now() - begin >= 280) return ($("score").textContent = score);
    $("score").textContent = String(Math.floor(Math.random() * 100)).padStart(2, "0");
    requestAnimationFrame(decode);
  };
  decode();
}

const QUESTION = {
  addressReuse: "same address",
  pastTransfer: "past transfers",
  restOfDeposit: "rest of shield",
  swapGasPayer: "swap gas from a public wallet",
};
// The three state pips (UI-3), read from the v2 parts of the result. "filled": a
// problem was found, in the band colour. "unknown": shown as "?", in amber.
// "empty": nothing found, a neutral outline. null: the pip does not apply and is
// not shown (Links for a shield, Amount when nothing was scored). No state uses
// the green of a Low band (UI-R7).
// The rest-of-shield answer is a link too: its question is in the links panel,
// which the Links pip opens. So a rest-of-deposit finding fills the Links pip, and
// every attention result has at least one filled pip.
export function pipStates(a) {
  const exposure = a.amountExposure,
    rest = a.findings?.some((f) => f.code === "rest-of-deposit"),
    links = rest && a.addressLinks ? "found" : a.addressLinks?.state,
    coverage = a.coverage?.state;
  return {
    amount: exposure ? (exposure.band === "Low" ? "empty" : "filled") : null,
    links: { found: "filled", unknown: "unknown", "none-reported": "empty" }[links] ?? null,
    coverage: { limited: "unknown", complete: "empty" }[coverage] ?? null,
  };
}
const PIP = {
  amount: { label: "Amount", says: { filled: "stands out", empty: "blends in" } },
  links: { label: "Links", says: { filled: "found", unknown: "unknown", empty: "none reported" } },
  coverage: { label: "Coverage", says: { unknown: "limited", empty: "complete" } },
};
// One pip per part: a cue and a one-word label. The state is in the accessible
// name only ("Links: unknown"). Links opens the links panel in place (UI-5);
// Coverage does too when the missing part is the rest-of-shield answer.
function pips(a) {
  const states = pipStates(a),
    answers = a.action === "unshield";
  $("pips").replaceChildren(
    ...Object.entries(states)
      .filter(([, state]) => state)
      .map(([name, state]) => {
        const { label, says } = PIP[name],
          opens = answers && (name === "links" || (name === "coverage" && a.coverage.missing.includes("rest-of-deposit"))),
          pip = el(opens ? "button" : "span", undefined, "pip"),
          cue = el("span", state === "unknown" ? "?" : undefined, "pip-cue");
        cue.setAttribute("aria-hidden", "true");
        pip.dataset.pip = name;
        pip.dataset.state = state;
        pip.append(cue, label, el("span", `: ${says[state]}`, "sr-only"));
        if (opens) {
          pip.type = "button";
          pip.setAttribute("aria-controls", "links");
          pip.onclick = () => openLinks();
        }
        const item = el("li");
        item.append(pip);
        return item;
      }),
  );
  $("pips").hidden = false;
}
// The verdict: the most important finding first, in 10 words or fewer. The pips
// already show what is unknown, so the verdict does not repeat it (UI-R3).
function headline(a) {
  const codes = a.findings.map((f) => f.code),
    link = a.findings.find((f) => f.code === "address-link");
  if (a.action === "shield")
    return a.status === "attention"
      ? "Stands out: a full unshield is easy to match."
      : a.status === "clear"
        ? "This shield blends in."
        : "No amount issue found.";
  if (link)
    return {
      "address-reuse": "Same address as the shield. Use a new address.",
      "past-transfer": "The addresses have a transfer history. Use a new address.",
      // A new address does not help when the swap gas already links the funds.
      "swap-gas-payer": "A public wallet paid the swap gas.",
    }[link.reason];
  if (codes.includes("rest-of-deposit")) return "Your unshields add up to one shield.";
  if (codes.includes("amount-stands-out")) return "This amount points to shields.";
  if (a.status === "incomplete") return "No amount issue found.";
  return "No issue found by the available checks.";
}
// First level (UI-3): band, meter, pips, one verdict line and what to do.
// Everything that explains it waits in "What does this mean?".
function render({ result: r, sets, lit, count, manifest }) {
  const a = r.assessment,
    parts = [],
    notes = [];
  panel.dataset.status = a.status;
  if (a.status === "not-checked") {
    panel.dataset.band = "Medium";
    $("readout").hidden = true;
    $("scan-label").hidden = true;
    pips(a);
    matches([]);
    draw([]);
    return show("Not checked", [
      el("p", a.findings[0].code === "stale-data" ? "The pool data is too old. Reload later." : "The data does not cover 180 days.", "verdict"),
    ]);
  }
  const band = a.status === "incomplete" ? "Incomplete" : a.band;
  // UI-R7: incomplete takes the amber state, never the green one.
  panel.dataset.band = band === "Incomplete" ? "Medium" : a.band;
  lastSets = sets || [];
  lastLit = lit || [];
  readout(a.score, band);
  pips(a);
  matches(lastSets);
  draw(lastLit);
  parts.push(el("p", headline(a), "verdict"));
  const found = a.findings.find((f) => f.code === "address-link");
  if (found) notes.push(el("p", "That links them, whatever the amount."));
  if (a.status === "attention" && !found) {
    if (r.constraint !== "flexible") notes.push(el("p", "Your amount is fixed, so no alternative is shown."));
    else if (r.alternatives.length)
      for (const alt of r.alternatives) {
        const amount = a.action === "shield" ? alt.amounts.shieldInput : alt.amounts.unshieldAmount,
          use = el("button", `Use ${eth(amount)} · scores ${alt.score}`, "secondary");
        use.type = "button";
        use.onclick = () => choose(amount);
        parts.push(use);
      }
    else if (a.action === "shield") parts.push(el("p", "No Low amount within 10%. Keep yours."));
    else {
      // The range searched follows from "down to 70%": it waits in the fold.
      parts.push(el("p", "No Low amount found."));
      notes.push(el("p", `No Low amount between ${formatWei(BigInt(r.searched.from), undefined, asset)} and ${eth(r.searched.to)}.`));
    }
  }
  if (a.action === "unshield" && r.remainingBalance !== null)
    parts.push(el("p", `Balance left: ${eth(r.remainingBalance)}.`, "hint"));
  // The table comes first, so its explanation leads the fold.
  if (lastSets.length)
    notes.unshift(
      el(
        "p",
        lastSets.some((set) => set.deposits.length > 1)
          ? "An observer can link your unshield to one of the shields above, or to a set of them that adds up to it."
          : "An observer can link your unshield to one of the shields above.",
      ),
      el("p", "Matches show the amount sent before the shield fee, and the date in UTC.", "hint"),
    );
  if (lastSets.some((set) => set.deposits.some((d) => d.kind === "reshield")))
    notes.splice(2, 0, el("p", "A swap output comes from a private swap, not from a shield sent by an address.", "hint"));
  if (a.coverage?.missing.includes("swap-output-history"))
    notes.push(el("p", "The swap output history is not complete, so a match can be missing."));
  if (a.action === "shield") notes.push(el("p", "Check again when you unshield."));
  // What was checked, in one line, unknown answers included.
  const answers =
    a.action === "unshield"
      ? Object.entries(QUESTION).map(([q, label]) => {
          const v = last.context[q];
          return `${label} ${v == null ? "unknown" : v === true || v === "public-wallet" ? "yes" : "no"}`;
        })
      : [];
  const details = el("details");
  details.append(el("summary", "What does this mean?"), ...notes);
  details.append(
    el(
      "p",
      a.action === "shield"
        ? `The pool records ${eth(a.amounts.poolCredit)}.`
        : `The recipient gets ${eth(a.amounts.recipientAmount)}.`,
    ),
  );
  if (a.action === "shield")
    details.append(
      el(
        "p",
        a.senders === null
          ? `${a.deposits} ${a.deposits === 1 ? "shield has" : "shields have"} this pool amount.`
          : `${a.senders} transaction ${a.senders === 1 ? "sender" : "senders"}, ${a.deposits} shields with this pool amount.`,
      ),
    );
  if (a.action === "unshield" && a.modelScore !== a.score) details.append(el("p", `Amount score ${a.modelScore}.`));
  if (a.notes.includes("split-completes-total")) details.append(el("p", "If you unshield the rest later, your unshields add up to your shield."));
  details.append(el("p", "A filled dot is a problem found, ? is not known, and an empty dot is none found.", "hint"));
  details.append(el("p", `Checked: amount${answers.length ? ", " + answers.join(", ") : ""}. Not covered: timing, IP addresses.`, "hint"));
  details.append(el("p", `${count.toLocaleString("en")} shields, last 180 days, data of ${date(manifest.dataTime)}.`, "hint"));
  // What shield and unshield mean: a link that was a hint in the form (UI-R5).
  const words = el("p", undefined, "hint"),
    link = el("a", "What shield and unshield mean");
  link.href = "/how-it-works/#words";
  words.append(link);
  details.append(words);
  parts.push(details);
  show(band, parts);
}
// The shields an unshield of this amount could be linked to, open right under
// the meter and its pixel crowd: they are the reason for the score, so they
// never hide in the fold (UI-4, UI-R6). No sentence here: the heading, the data
// and a kind tag per row. The column names are for screen readers; the fold
// explains them.
function matches(sets) {
  const box = $("matches");
  box.hidden = !sets.length;
  if (!sets.length) return box.replaceChildren();
  const heading = el("h3", "Matches");
  heading.id = "matches-heading";
  box.replaceChildren(heading, matchTable(sets));
}
// Kind tags (UI-4, UI-R8): a shield sent from an address, or a swap output made
// by a private swap. The engine calls the second a "reshield"; the page never does.
const SVG = "http://www.w3.org/2000/svg";
const KIND = {
  shield: { label: "Shield", path: "M6 1 10.5 2.8V6c0 2.6-1.9 4.4-4.5 5C3.4 10.4 1.5 8.6 1.5 6V2.8Z" },
  "swap-output": { label: "Swap output", path: "M1.5 4h8M7 1.5 9.5 4 7 6.5M10.5 8h-8M5 5.5 2.5 8 5 10.5" },
};
function kindTag(kind) {
  const { label, path } = KIND[kind],
    tag = el("span", undefined, "kind-tag"),
    icon = document.createElementNS(SVG, "svg"),
    line = document.createElementNS(SVG, "path");
  tag.dataset.kind = kind;
  icon.setAttribute("viewBox", "0 0 12 12");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  line.setAttribute("d", path);
  icon.append(line);
  tag.append(icon, label);
  return tag;
}
function matchTable(sets) {
  const table = el("table"),
    head = table.createTHead(),
    row = head.insertRow(),
    body = table.createTBody(),
    // A pool amount (nano-ETH for WETH, base units for USDT and USDC) before the
    // shield fee, to 6 decimals.
    sent = (stored) => {
      const scale = 10n ** BigInt(asset.decimals - asset.unitDecimals),
        round = 10n ** BigInt(Math.max(0, asset.decimals - 6)),
        gross = (BigInt(stored) * scale * 10000n) / 9975n;
      return eth(((gross + round / 2n) / round) * round);
    };
  head.className = "sr-only";
  for (const name of ["Matching shields sent", "Dates (UTC)"]) {
    const th = el("th", name);
    th.scope = "col";
    row.append(th);
  }
  // One line per shield in a set, so amounts and dates line up.
  for (const set of sets) {
    const row = body.insertRow(),
      amounts = row.insertCell(),
      dates = row.insertCell();
    set.deposits.forEach((d, i) => {
      const leg = el("span", undefined, "match-leg");
      if (i) leg.append(el("span", "+ ", "match-plus"));
      leg.append(sent(d.amount), kindTag(d.kind === "reshield" ? "swap-output" : "shield"));
      amounts.append(leg);
      dates.append(el("span", date(d.time), "match-leg"));
    });
  }
  return table;
}
function show(band, parts) {
  $("band").textContent = band || "";
  $("result-heading").textContent = action() === "shield" ? "Shield risk" : "Unshield risk";
  $("result-copy").replaceChildren(...parts);
  panel.hidden = false;
  $("announcement").textContent = `${band}. ${parts[0].textContent}`;
  if (quiet) return;
  $("result-heading").focus({ preventScroll: true });
  panel.scrollIntoView({ block: "start", behavior: reduced.matches ? "instant" : "smooth" });
}
window.addEventListener("resize", () => {
  if (!panel.hidden && !$("readout").hidden) draw(lastLit);
});
// Choosing an alternative updates the same result. A smaller unshield amount is
// not the rest of a deposit, so a "yes" there becomes "no"; other answers stay.
function choose(amount) {
  $("amount").value = formatWei(BigInt(amount), undefined, asset);
  if (action() === "unshield" && value("restOfDeposit") === "yes")
    form.querySelector("input[name=restOfDeposit][value=no]").checked = true;
  submit();
}
// A changed input makes the old result stale, and the check in flight too: its
// reply would show a result for inputs that are gone. A new request id makes the
// worker reply and the delayed render after the scan drop it.
function drop() {
  request++;
  stop();
  panel.hidden = true;
}
// A changed input also clears its own error.
form.addEventListener("input", (e) => {
  // A link toggle also fires "change", which re-runs the check: leave it to that.
  if (Object.hasOwn(LINKS, e.target.name)) return;
  const error = $(e.target.id + "-error");
  if (error) {
    error.hidden = true;
    e.target.removeAttribute("aria-invalid");
  }
  drop();
});
form.addEventListener("change", (e) => {
  if (e.target.name === "token") coverage();
  if (e.target.name === "action") sync();
  // A toggle changed while a result shows (or a check runs): check again, so
  // the result never stays stale. drop() ends the check in flight first.
  const again = Object.hasOwn(LINKS, e.target.name) && !panel.hidden;
  drop();
  if (again) submit(undefined, { quiet: true });
});
// Opens the links panel in place (UI-5). The Links pip in the result (R1.7)
// calls this too.
export function openLinks() {
  const links = $("links");
  if (action() !== "unshield") return false;
  links.setAttribute("open", "");
  $("links-toggle").focus({ preventScroll: true });
  links.scrollIntoView({ block: "nearest", behavior: reduced.matches ? "instant" : "smooth" });
  return true;
}
form.addEventListener("submit", submit);
chips();
coverage();
sync();
load();
