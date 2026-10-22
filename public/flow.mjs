// One flow for shield and unshield: assess, optionally adjust, review.
// Amounts and answers stay in memory: no storage, no URL, no network after load.
import { parseAmount, formatWei } from "./lib/engine/index.mjs";

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
  request = 0,
  last = null,
  pool = 0,
  start = 0,
  frame,
  lastSets = [],
  lastLit = [];
const ANSWER = { yes: true, no: false, unsure: undefined };
const eth = (wei) => formatWei(BigInt(wei));
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
const COVERED = { weth: true, usdc: false, other: false };
const UNIT = { weth: "ETH", usdc: "USDC", other: "—" };
const token = () => form.querySelector("input[name=token]:checked")?.value || "weth";
const covered = () => COVERED[token()] === true;
const constraint = () => ($("constraint").checked ? "flexible" : "fixed");

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
      pool = data.manifest.count;
      notice();
    }
    if (data.type === "error" && data.id === undefined) return notice(data.message);
    if (data.id !== request) return;
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
  worker.onerror = () =>
    notice("The pool data did not load. Check your connection, then try again.");
  worker.postMessage({ type: "load" });
}

// The form follows the action and token: unsupported tokens stop before amount.
function sync() {
  const shield = action() === "shield",
    ok = covered(),
    unit = UNIT[token()] || "—";
  $("amount-label").textContent = "Amount";
  $("amount-unit").textContent = unit;
  $("balance-unit").textContent = unit;
  $("token-status").hidden = ok;
  $("amount").disabled = !ok;
  $("constraint").disabled = !ok;
  $("balance").disabled = !ok;
  $("check-button").disabled = !ok;
  $("amount-step").classList.toggle("not-covered", !ok);
  $("questions").hidden = !ok || shield;
  $("check-button").textContent = "Check";
  // The old message names the old action, so clear it when the action changes.
  for (const id of ["amount", "balance"]) {
    $(id + "-error").hidden = true;
    $(id).removeAttribute("aria-invalid");
  }
  if (ok) fee();
  else $("fee-hint").hidden = true;
}
function fee() {
  const hint = $("fee-hint");
  if (!covered() || document.activeElement !== $("amount")) {
    hint.hidden = true;
    return;
  }
  try {
    const wei = parseAmount($("amount").value),
      after = wei - (wei * 25n) / 10000n,
      unit = UNIT[token()] || "ETH";
    hint.textContent =
      action() === "shield"
        ? `Pool records ${formatWei(after)} ${unit} after the 0.25% fee.`
        : `Recipient gets ${formatWei(after)} ${unit} after the 0.25% fee.`;
    hint.hidden = false;
  } catch {
    hint.hidden = true;
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
      parseAmount(text);
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
function submit(event) {
  event?.preventDefault();
  if (!covered()) return;
  const verb = action() === "shield" ? "shield" : "unshield",
    amount = field("amount", false, `Enter the amount that you will ${verb}.`);
  if (amount === null) return;
  const message = { type: "plan", action: action(), amount, constraint: constraint() };
  if (message.action === "unshield") {
    const answers = {};
    for (const q of ["q1", "q2", "q3"]) {
      answers[q] = value(q);
      $(q + "-error").hidden = !!answers[q];
    }
    const missing = ["q1", "q2", "q3"].find((q) => !answers[q]);
    if (missing) return form.querySelector(`input[name=${missing}]`).focus();
    const balance = field("balance", true);
    if (balance === null) return;
    if (balance && parseAmount(balance) < parseAmount(amount)) {
      const input = $("balance"),
        error = $("balance-error");
      error.textContent = "The balance is less than the amount.";
      error.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
    message.context = {
      addressReuse: ANSWER[answers.q1],
      pastTransfer: ANSWER[answers.q2],
      restOfDeposit: ANSWER[answers.q3],
    };
    message.balance = balance;
  }
  if (!ready)
    return notice("The pool data did not load. Check your connection, then try again.");
  request++;
  last = message;
  $("check-button").setAttribute("aria-busy", "true");
  start = performance.now();
  panel.hidden = false;
  panel.setAttribute("aria-busy", "true");
  $("readout").hidden = true;
  $("band").textContent = "";
  $("result-copy").replaceChildren();
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
function animate() {
  draw([], ((performance.now() - start) % 600) / 600);
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

const QUESTION = { addressReuse: "same address", pastTransfer: "past transfers", restOfDeposit: "rest of shield" };
// First-level verdict: 10 words or fewer (UI-3). Numbers are not counted in the budget.
function headline(a) {
  const codes = a.findings.map((f) => f.code),
    link = a.findings.find((f) => f.code === "address-link");
  if (a.action === "shield")
    return a.status === "clear" ? "This shield blends in." : "This shield stands out.";
  if (link)
    return link.reason === "address-reuse"
      ? "Same address as the shield."
      : "Addresses have a transfer history.";
  if (codes.includes("rest-of-deposit")) return "This is the rest of a shield.";
  if (codes.includes("amount-stands-out")) return "This amount points to shields.";
  if (a.status === "incomplete") return "Some answers are not sure.";
  return "No issue found.";
}
// First level: the verdict and what to do. Everything that explains it waits
// in "What does this mean?".
function render({ result: r, sets, lit, count, manifest }) {
  const a = r.assessment,
    parts = [],
    notes = [];
  if (a.status === "not-checked") {
    panel.dataset.band = "Medium";
    $("readout").hidden = true;
    $("scan-label").hidden = true;
    matches([]);
    draw([]);
    return show("Not checked", [
      el("p", a.findings[0].code === "stale-data" ? "The pool data is too old. Reload later." : "The pool data does not cover 180 days.", "verdict"),
    ]);
  }
  const band = a.status === "incomplete" ? "Incomplete" : a.band;
  panel.dataset.band = band === "Incomplete" ? "Medium" : a.band;
  lastSets = sets || [];
  lastLit = lit || [];
  readout(a.score, band);
  matches(lastSets);
  draw(lastLit);
  parts.push(el("p", headline(a), "verdict"));
  if (a.findings.some((f) => f.code === "address-link")) parts.push(el("p", "Use a new address."));
  if (a.status === "attention" && !a.findings.some((f) => f.code === "address-link")) {
    if (r.constraint !== "flexible") notes.push(el("p", "Your amount is fixed, so no alternative is shown."));
    else if (r.alternatives.length)
      for (const alt of r.alternatives) {
        const amount = a.action === "shield" ? alt.amounts.shieldInput : alt.amounts.unshieldAmount,
          use = el("button", `Use ${eth(amount)} ETH · scores ${alt.score}`, "secondary");
        use.type = "button";
        use.onclick = () => choose(amount);
        parts.push(use);
      }
    else parts.push(el("p", "No Low amount in range."));
  }
  // Fee, balance, and explanations wait in the fold (UI-R5).
  notes.push(
    el(
      "p",
      a.action === "shield"
        ? `The pool records ${eth(a.amounts.poolCredit)} ETH.`
        : `The recipient gets ${eth(a.amounts.recipientAmount)} ETH.`,
      "hint",
    ),
  );
  if (a.action === "unshield" && r.remainingBalance !== null)
    notes.push(el("p", `Balance left: ${eth(r.remainingBalance)} ETH.`, "hint"));
  if (a.status === "attention" && a.unknown?.length) notes.push(el("p", "Some answers are not sure."));
  // The table comes first, so its explanation leads the fold.
  if (lastSets.length)
    notes.unshift(
      el(
        "p",
        lastSets.some((set) => set.deposits.length > 1)
          ? "An observer can link your unshield to one of the shields above, or to a set of them that adds up to it."
          : "An observer can link your unshield to one of the shields above.",
      ),
    );
  if (a.action === "shield") notes.push(el("p", "Check again when you unshield."));
  // What was checked, in one line, unknown answers included.
  const answers =
    a.action === "unshield"
      ? Object.entries(QUESTION).map(([q, label]) => {
          const v = last.context[q];
          return `${label} ${v === undefined ? "unknown" : v ? "yes" : "no"}`;
        })
      : [];
  const details = el("details");
  details.append(el("summary", "What does this mean?"), ...notes);
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
  details.append(el("p", `Checked: amount${answers.length ? ", " + answers.join(", ") : ""}. Not covered: timing, IP addresses.`, "hint"));
  details.append(el("p", `${count.toLocaleString("en")} shields, last 180 days, data of ${date(manifest.dataTime)}.`, "hint"));
  parts.push(details);
  show(band, parts);
}
// The shields an unshield of this amount could be linked to, open right under
// the score and its pixel crowd: they are the reason for the score, so they
// never hide in the fold.
function matches(sets) {
  const box = $("matches");
  box.hidden = !sets.length;
  if (!sets.length) return box.replaceChildren();
  const heading = el("h3", "Shields that match this amount");
  heading.id = "matches-heading";
  box.replaceChildren(heading, matchTable(sets));
}
function matchTable(sets) {
  const table = el("table"),
    head = table.createTHead().insertRow(),
    body = table.createTBody(),
    sent = (nano) => {
      const gross = (BigInt(nano) * 10n ** 9n * 10000n) / 9975n;
      return formatWei(((gross + 500000000000n) / 1000000000000n) * 1000000000000n);
    };
  for (const name of ["Matching shields sent", "Dates (UTC)"]) {
    const th = el("th", name);
    th.scope = "col";
    head.append(th);
  }
  // One line per shield in a set, so amounts and dates line up.
  for (const set of sets) {
    const row = body.insertRow(),
      amounts = row.insertCell(),
      dates = row.insertCell();
    set.deposits.forEach((d, i) => {
      const leg = el("span", undefined, "match-leg");
      if (i) leg.append(el("span", "+ ", "match-plus"));
      leg.append(`${sent(d.amount)} ETH`);
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
  $("result-heading").focus({ preventScroll: true });
  panel.scrollIntoView({ block: "start", behavior: reduced.matches ? "instant" : "smooth" });
}
window.addEventListener("resize", () => {
  if (!panel.hidden && !$("readout").hidden) draw(lastLit);
});
// Choosing an alternative updates the same result. A smaller unshield amount is
// not the rest of a deposit, so a "yes" there becomes "no"; other answers stay.
function choose(amount) {
  $("amount").value = formatWei(BigInt(amount));
  if (action() === "unshield" && value("q3") === "yes")
    form.querySelector("input[name=q3][value=no]").checked = true;
  fee();
  submit();
}
// A changed input makes the old result stale and clears its own error.
form.addEventListener("input", (e) => {
  if (e.target.id === "amount") fee();
  const error = $(e.target.id + "-error");
  if (error) {
    error.hidden = true;
    e.target.removeAttribute("aria-invalid");
  }
  $("result").hidden = true;
});
$("amount").addEventListener("focus", fee);
$("amount").addEventListener("blur", () => {
  $("fee-hint").hidden = true;
});
form.addEventListener("change", (e) => {
  if (e.target.name === "action" || e.target.name === "token") sync();
  if (/^q[123]$/.test(e.target.name)) $(e.target.name + "-error").hidden = true;
  $("result").hidden = true;
});
form.addEventListener("submit", submit);
sync();
load();
