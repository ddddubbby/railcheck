import {
  parseAmount,
  formatWei,
  NANO,
  afterUnshieldFee,
} from "./lib/engine/index.mjs";
const $ = (id) => document.getElementById(id),
  form = $("check-form"),
  input = $("amount"),
  button = $("check-button"),
  panel = $("result"),
  canvas = $("crowd"),
  ctx = canvas.getContext("2d");
let worker,
  ready = false,
  manifest,
  busy = false,
  request = 0,
  start = 0,
  timer,
  frame,
  lastResult;
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const date = (t) =>
  new Date(t * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
const text = (tag, content, cls) => {
  const el = document.createElement(tag);
  el.textContent = content;
  if (cls) el.className = cls;
  return el;
};
function load() {
  ready = false;
  $("progress").hidden = false;
  worker?.terminate();
  worker = new Worker("/worker.mjs", { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.type === "ready") {
      ready = true;
      manifest = data.manifest;
      $("progress").hidden = true;
      $("data-date").textContent = "Data updated " + date(manifest.dataTime);
      notice();
    }
    if (data.type === "result" && data.id === request) {
      const wait = reduced.matches
        ? 0
        : Math.max(0, 600 - (performance.now() - start));
      setTimeout(() => {
        if (data.id === request && busy) finish(data.result);
      }, wait);
    }
    if (
      data.type === "error" &&
      (data.id === undefined || data.id === request)
    ) {
      stop();
      $("progress").hidden = true;
      if (data.id === undefined) {
        notice(data.message);
      } else {
        $("amount-error").textContent = data.message;
        $("amount-error").hidden = false;
        panel.hidden = true;
        input.focus();
      }
    }
  };
  worker.onerror = () => {
    stop();
    ready = false;
    notice(
      "The pool data did not load. Check your connection, then try again.",
    );
  };
  worker.postMessage({ type: "load" });
}
function notice(error) {
  const box = $("notice");
  box.replaceChildren();
  if (error) {
    box.append(text("strong", "Pool data unavailable"), text("p", error));
    const retry = text("button", "Try Again");
    retry.type = "button";
    retry.onclick = load;
    box.append(retry);
    box.hidden = false;
    return;
  }
  box.hidden = false;
  if (Date.now() / 1000 - manifest.dataTime > 48 * 3600) {
    box.append(
      text(
        "p",
        `The pool data is from ${date(manifest.dataTime)}. Deposits after that date are not in the check.`,
      ),
    );
  } else box.hidden = true;
}
input.addEventListener("input", () => {
  $("recipient").hidden = !input.value;
  if (busy) {
    request++;
    stop();
  }
  panel.hidden = true;
  $("amount-error").hidden = true;
  input.removeAttribute("aria-invalid");
  try {
    $("recipient").textContent =
      `The recipient gets ${formatWei(afterUnshieldFee(parseAmount(input.value)))} ETH after the 0.25% fee.`;
  } catch {
    $("recipient").textContent = input.value
      ? "Use up to 18 decimal places."
      : "";
  }
  if (!busy) panel.hidden = true;
});
form.addEventListener("change", (e) => {
  if (e.target.name) {
    if (busy) {
      request++;
      stop();
    }
    panel.hidden = true;
    $(e.target.name + "-error").hidden = true;
    $(e.target.name + "-group").removeAttribute("aria-invalid");
    if (!busy) panel.hidden = true;
  }
});
function draw(r, scan = 0) {
  const width = canvas.clientWidth,
    height = 64,
    dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const count = r?.count || manifest?.count || 0,
    group = Math.ceil(count / 600),
    cells = Math.ceil(count / group),
    columns = Math.max(1, Math.floor(width / 7)),
    rows = Math.ceil(cells / columns),
    stepY = height / Math.max(rows, 1),
    stepX = width / columns;
  const litIds = r?.sets?.length
    ? r.sets.flatMap((s) => s.legs.map((d) => d.id))
    : r?.points?.map((p) => p.id) || [];
  const lit = new Set(litIds.map((id) => Math.floor(id / group)));
  const color = getComputedStyle(panel).getPropertyValue("--band").trim();
  for (let i = 0; i < cells; i++) {
    const x = i % columns,
      y = Math.floor(i / columns);
    ctx.fillStyle = lit.has(i)
      ? color
      : scan && Math.abs(x / columns - scan) < 0.07
        ? "rgba(174,188,229,.6)"
        : "rgba(255,255,255,.10)";
    ctx.fillRect(
      x * stepX,
      y * stepY,
      Math.max(1, stepX - 2),
      Math.max(1, stepY - 2),
    );
  }
}
function animate() {
  draw(null, ((performance.now() - start) % 600) / 600);
  frame = requestAnimationFrame(animate);
}
function stop() {
  busy = false;
  clearTimeout(timer);
  cancelAnimationFrame(frame);
  button.classList.remove("busy");
  button.removeAttribute("aria-busy");
  panel.setAttribute("aria-busy", "false");
}
function submit(event) {
  event?.preventDefault();
  if (busy) return;
  let invalid;
  try {
    parseAmount(input.value);
    $("amount-error").hidden = true;
    input.removeAttribute("aria-invalid");
  } catch (e) {
    $("amount-error").textContent = e.message;
    $("amount-error").hidden = false;
    input.setAttribute("aria-invalid", "true");
    invalid = input;
  }
  const answers = {};
  for (const q of ["q1", "q2", "q3"]) {
    answers[q] = form.querySelector(`input[name=${q}]:checked`)?.value;
    $(q + "-error").hidden = !!answers[q];
    if (!answers[q]) {
      $(q + "-group").setAttribute("aria-invalid", "true");
      invalid ||= form.querySelector(`input[name=${q}]`);
    }
  }
  if (invalid) {
    invalid.focus();
    return;
  }
  if (!ready) {
    notice(
      "The pool data did not load. Check your connection, then try again.",
    );
    return;
  }
  busy = true;
  start = performance.now();
  request++;
  timer = setTimeout(() => button.classList.add("busy"), 150);
  button.setAttribute("aria-busy", "true");
  panel.hidden = false;
  panel.setAttribute("aria-busy", "true");
  $("readout").hidden = true;
  $("band").textContent = "";
  $("result-copy").replaceChildren();
  $("scan-label").hidden = false;
  if (!reduced.matches) animate();
  worker.postMessage({
    type: "check",
    id: request,
    amount: input.value,
    ...answers,
  });
}
form.addEventListener("submit", submit);
function finish(r) {
  stop();
  lastResult = r;
  panel.dataset.band = r.band;
  $("result-heading").textContent = "Result";
  $("readout").hidden = false;
  $("scan-label").hidden = true;
  $("band").textContent = r.band;
  $("score").textContent = String(r.score);
  $("meter").setAttribute("aria-valuenow", r.score);
  $("meter").setAttribute(
    "aria-valuetext",
    `${r.score} out of 100. ${r.band}.`,
  );
  [...$("meter").children].forEach((e, i) =>
    e.classList.toggle("on", i < Math.ceil(r.score / 10)),
  );
  draw(r);
  const box = $("result-copy");
  box.replaceChildren();
  if (r.q1 !== "no") {
    box.append(
      text(
        "p",
        r.q1 === "unsure"
          ? "Your destination may be your deposit address. If it is, anyone can link your withdrawal to your deposit."
          : "You will withdraw to your deposit address. Anyone can link your withdrawal to your deposit.",
      ),
      text(
        "p",
        "Withdraw to a new address that has no link to your deposit address.",
      ),
    );
  } else if (r.q2 !== "no") {
    box.append(
      text(
        "p",
        r.q2 === "unsure"
          ? "Your destination may have a transaction with your deposit address. If it does, anyone can follow that link."
          : "Your destination address has a transaction with your deposit address. Anyone can follow that link.",
      ),
      text("p", "Use a new address that has no link to your deposit address."),
    );
  } else if (r.q3 !== "no") {
    box.append(
      text(
        "p",
        r.q3 === "unsure"
          ? "This may be the rest of a deposit you partly withdrew. If it is, anyone can add your withdrawals together and find that deposit."
          : "You will withdraw the rest of a deposit. Anyone can add your withdrawals together and find that deposit, unless its amount was round.",
      ),
      text("p", "Withdraw less than the rest, and leave the difference in the pool."),
    );
  }   else if (r.amountScore >= 6)
    box.append(
      text(
        "p",
        r.setCount === 1
          ? "A deposit set adds up to this amount."
          : "Deposit sets add up to this amount.",
      ),
    );
  else if (r.matches)
    box.append(
      text(
        "p",
        `This amount points to no deposit. It hides among about ${r.crowd} deposits.`,
      ),
    );
  else
    box.append(
      text(
        "p",
        "No deposit, and no set of 2 or 3 deposits, adds up to this amount.",
      ),
    );
  if (r.q1 === "unsure" || r.q2 === "unsure" || r.q3 === "unsure")
    box.append(
      text(
        "p",
        "You selected Not sure. The score uses the worse answer.",
        "uncertain",
      ),
    );
  if (r.sets?.length) {
    box.append(text("h3", "Matching deposit sets", "table-label"));
    const table = document.createElement("table");
    table.className = "match-sets";
    const head = table.createTHead().insertRow();
    for (const name of ["Amount sent", "Date (UTC)"]) {
      const th = text("th", name);
      th.scope = "col";
      head.append(th);
    }
    const body = table.createTBody();
    const sent = (amount) => {
      const gross = (BigInt(amount) * NANO * 10000n) / 9975n;
      const rounded = (gross + 500000000000n) / 1000000000000n;
      return `${rounded / 1000000n}.${(rounded % 1000000n).toString().padStart(6, "0")} ETH`;
    };
    for (const set of r.sets) {
      const row = body.insertRow();
      row.insertCell().textContent = set.legs.map((d) => sent(d.amount)).join(" + ");
      row.insertCell().textContent = set.legs.map((d) => date(d.time)).join(" · ");
    }
    box.append(table);
    box.append(
      text(
        "p",
        "Each row is 1, 2 or 3 deposits that sum to your amount. Amount sent is what left the depositing address, before the 0.25% shield fee.",
        "hint",
      ),
    );
    if (r.setCount > r.sets.length)
      box.append(
        text("p", "The list shows the 5 strongest matching sets.", "hint"),
      );
    if (!r.floor)
      box.append(
        text(
          "p",
          r.sets.length === 1 && r.sets[0].legs.length === 1
            ? "If this deposit is yours, an analyst can link your withdrawal to it. If not, your risk is low."
            : "If a deposit in these sets is yours, an analyst can link your withdrawal to it. If not, your risk is low.",
        ),
      );
  }
  if (r.amountScore >= 6) {
    const safe = text("div", "", "safer");
    if (r.safer) {
      safe.append(text("p", `Try ${r.safer} ETH. It points to no deposit.`));
      const retry = text("button", `Check ${r.safer} ETH`, "secondary");
      retry.type = "button";
      retry.onclick = () => {
        input.value = r.safer;
        input.dispatchEvent(new Event("input"));
        submit();
      };
      safe.append(
        retry,
        text(
          "p",
          "Leave the rest in the pool. Do not withdraw it soon after as 1 amount.",
          "hint",
        ),
      );
      if (r.floor)
        safe.append(
          text(
            "p",
            "A different amount does not remove an address link.",
            "hint",
          ),
        );
    } else safe.append(text("p", "Withdraw a different amount."));
    box.append(safe);
  }
  const note = text("div", "", "result-note");
  note.append(
    text(
      "p",
      `Checked against ${r.count.toLocaleString("en")} deposits, ${date(r.start)} to ${date(manifest.dataTime)}. Off-chain data can make the real risk higher.`,
    ),
  );
  box.append(note);
  $("announcement").textContent = `${r.band}. Score ${r.score} out of 100.`;
  $("result-heading").focus({ preventScroll: true });
  panel.scrollIntoView({
    behavior: reduced.matches ? "instant" : "smooth",
    block: "start",
  });
  if (!reduced.matches) {
    const begin = performance.now();
    const decode = () => {
      if (performance.now() - begin >= 280) {
        $("score").textContent = r.score;
        return;
      }
      $("score").textContent = String(Math.floor(Math.random() * 100)).padStart(
        2,
        "0",
      );
      requestAnimationFrame(decode);
    };
    decode();
  }
}
window.addEventListener("resize", () => {
  if (!panel.hidden && !busy) draw(lastResult);
});
load();
