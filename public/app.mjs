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
// Only the decorative pixels animate; the assurance text is always readable.
function reveal() {
  const icons = [
    [
      "..###..",
      ".#...#.",
      ".#...#.",
      "#######",
      "###.###",
      "###.###",
      "#######",
    ],
    [
      "....#..",
      ".#..##.",
      "#..#..#",
      "#..#..#",
      "#..#..#",
      ".##..#.",
      "..#....",
    ],
  ];
  const color = getComputedStyle(document.documentElement)
    .getPropertyValue("--signal")
    .trim();
  document.querySelectorAll(".assure .pix").forEach((icon, index) => {
    const context = icon.getContext("2d");
    if (!context) return;
    const cells = icons[index].flatMap((row, y) =>
      [...row].flatMap((cell, x) => (cell === "#" ? [[x, y]] : [])),
    );
    // Fisher–Yates gives each pixel an independent place in the build.
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }
    context.fillStyle = color;
    const begin = performance.now() + index * 100;
    let drawn = 0;
    const build = (now) => {
      const progress = reduced.matches
        ? 1
        : Math.min(1, Math.max(0, (now - begin) / 350));
      const count = Math.floor(progress * cells.length);
      while (drawn < count) {
        const [x, y] = cells[drawn++];
        context.fillRect(x, y, 1, 1);
      }
      if (progress < 1) requestAnimationFrame(build);
    };
    build(performance.now());
  });
}
// A pixel timeline of real UTC-hour bins: each square is a fixed number of
// transactions, deposits stacked up from the baseline, withdrawals down. The
// motion is presentation only: the grid builds in, a playhead replays the
// window left to right, and busy hours twinkle more. Counts never animate
// beyond their real values.
function heartbeat() {
  const chart = $("activity-chart"),
    strip = $("pulse"),
    slider = $("activity-hour");
  const context = strip?.getContext("2d");
  if (!context || !chart?.dataset.activity) return;
  const { start, end, bins: hours } = JSON.parse(chart.dataset.activity);
  let bins = hours;
  const root = getComputedStyle(document.documentElement);
  const deposit = root.getPropertyValue("--deposit").trim();
  const withdrawal = root.getPropertyValue("--withdrawal").trim();
  const signal = root.getPropertyValue("--signal").trim();
  const muted = root.getPropertyValue("--muted").trim();
  const shortDate = (time) =>
    new Date(time * 1000).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  const clock = (time) =>
    new Date(time * 1000).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    });
  const eth = (wei) => {
    const value = Number(wei) / 1e18;
    return value > 0 && value < 0.001
      ? "<0.001"
      : value.toLocaleString("en", { maximumFractionDigits: 3 });
  };
  const LABEL = 22, // date labels under the grid
    INTRO_COLUMN = 9, // ms between columns as the grid builds in
    INTRO_ROW = 26, // ms between rows within a column
    SWEEP = 5200, // playhead crossing time
    REST = 1600, // pause at the newest hour before the next pass
    TRAIL = 9, // columns of afterglow behind the playhead
    IDLE = 2500; // quiet time after interaction before the replay resumes
  let width = 0,
    height = 0,
    pitch = 4,
    cell = 3,
    columnWidth = 1,
    baseline = 0,
    rowsUp = 1,
    rowsDown = 1,
    unit = 1,
    jitter = [],
    weights = [],
    sparkles = [],
    selected = Number(slider.value),
    selectedAt = -Infinity,
    begin = performance.now(),
    sweepFrom = 0,
    touched = -Infinity,
    visible = true,
    running = false;
  const cellsFor = (count) => Math.ceil(count / unit);
  const columnX = (index) =>
    Math.round(index * columnWidth + (columnWidth - cell) / 2);
  const update = (index, quiet) => {
    const next = Math.max(0, Math.min(bins.length - 1, index));
    if (next !== selected) selectedAt = performance.now();
    selected = next;
    slider.value = String(selected);
    const b = bins[selected];
    $("activity-day").textContent = shortDate(b.start);
    $("activity-time").textContent = `${clock(b.start)}–${clock(b.end)} UTC`;
    $("activity-deposits").textContent =
      `${b.deposits} deposit${b.deposits === 1 ? "" : "s"}`;
    $("activity-withdrawals").textContent =
      `${b.withdrawals} withdrawal${b.withdrawals === 1 ? "" : "s"}`;
    $("activity-deposit-eth").textContent = `${eth(b.depositWei)} ETH`;
    $("activity-withdrawal-eth").textContent = `${eth(b.withdrawalWei)} ETH`;
    slider.setAttribute(
      "aria-valuetext",
      `${shortDate(b.start)}, ${clock(b.start)} to ${clock(b.end)} UTC: ${b.deposits} deposits, ${eth(b.depositWei)} ETH; ${b.withdrawals} withdrawals, ${eth(b.withdrawalWei)} ETH`,
    );
    if (!quiet) touched = performance.now();
    start_();
  };
  const square = (index, row, side) =>
    context.fillRect(
      columnX(index),
      baseline - side * row * pitch,
      cell,
      cell,
    );
  const paint = (now) => {
    if (!width) return;
    const still = reduced.matches,
      elapsed = still ? Infinity : now - begin,
      introEnd =
        bins.length * INTRO_COLUMN + Math.max(rowsUp, rowsDown) * INTRO_ROW + 140,
      idle = now - touched > IDLE,
      // The replay starts after the build-in, and again after each interaction.
      from = Math.max(sweepFrom, begin + introEnd),
      phase =
        !still && idle && now > from ? (now - from) % (SWEEP + REST) : -1,
      head = phase >= 0 && phase < SWEEP ? (phase / SWEEP) * bins.length : -1;
    if (!idle) sweepFrom = now;
    context.clearRect(0, 0, width, height);
    // Day ticks: a dotted pixel column at each UTC midnight, then its label.
    const stride = ((end - start) / 86400) * 56 > width ? 2 : 1;
    context.font = "12px GeistMono, monospace";
    context.textAlign = "center";
    for (
      let t = Math.ceil(start / 86400) * 86400, i = 0;
      t < end;
      t += 86400, i++
    ) {
      if (i % stride) continue;
      const index = bins.findIndex((b) => t < b.end),
        b = bins[index],
        x = Math.round(
          (index + (t - b.start) / (b.end - b.start)) * columnWidth,
        );
      context.fillStyle = "rgba(255,255,255,.09)";
      for (let y = baseline % (pitch * 2); y < height - LABEL; y += pitch * 2)
        context.fillRect(x, y, 1, 1);
      context.fillStyle = muted;
      context.fillText(
        shortDate(t),
        Math.max(23, Math.min(width - 23, x)),
        height - 5,
      );
    }
    // The zero row.
    context.fillStyle = "rgba(255,255,255,.10)";
    for (let i = 0; i < bins.length; i++) square(i, 0, 1);
    // The selected hour: a faint full-height column behind its squares.
    context.fillStyle = "rgba(174,188,229,.07)";
    context.fillRect(
      columnX(selected) - 2,
      0,
      cell + 4,
      height - LABEL,
    );
    // The playhead: a faint full-height column ahead of the afterglow.
    if (head >= 0) {
      context.fillStyle = "rgba(174,188,229,.10)";
      context.fillRect(
        columnX(Math.floor(head)) - 2,
        0,
        cell + 4,
        height - LABEL,
      );
    }
    bins.forEach((b, index) => {
      const isSelected = index === selected,
        behind = head - index,
        glow =
          behind >= 0 && behind < TRAIL ? 1 - behind / TRAIL : 0,
        base = still ? 0.8 : 0.5;
      for (const [count, side, color] of [
        [b.deposits, 1, deposit],
        [b.withdrawals, -1, withdrawal],
      ]) {
        const n = cellsFor(count);
        for (let row = 1; row <= n; row++) {
          const born =
            index * INTRO_COLUMN + row * INTRO_ROW + (jitter[index]?.[row] || 0);
          if (elapsed < born) continue;
          // A rebuilt selection grows from the baseline, one square at a time.
          if (isSelected && !still && now - selectedAt < row * 16) continue;
          const partial = row === n && count % unit ? 0.55 : 1;
          let alpha = isSelected ? 1 : base + (1 - base) * glow;
          context.fillStyle = color;
          if (elapsed - born < 90 || (behind >= 0 && behind < 1)) {
            // New squares and the playhead burn white for a moment.
            context.fillStyle = "#fff";
            alpha = 0.9;
          }
          context.globalAlpha = alpha * partial;
          square(index, row, side);
        }
      }
    });
    // Twinkles: brief white squares, picked in proportion to activity.
    context.fillStyle = "#fff";
    sparkles = sparkles.filter((s) => now - s.at < 320);
    for (const s of sparkles) {
      context.globalAlpha = 0.85 * (1 - (now - s.at) / 320);
      square(s.index, s.row, s.side);
    }
    // The snapshot cursor on the newest hour blinks like a terminal caret.
    context.globalAlpha = still || Math.floor(now / 530) % 2 ? 1 : 0.15;
    context.fillStyle = signal;
    square(bins.length - 1, 0, 1);
    context.globalAlpha = 1;
    if (!still && elapsed > introEnd && weights.length && Math.random() < 0.1) {
      let pick = Math.random() * weights.at(-1).total;
      const w = weights.find((w) => (pick -= w.count) < 0) || weights.at(-1);
      sparkles.push({
        index: w.index,
        side: w.side,
        row: 1 + Math.floor(Math.random() * cellsFor(w.count)),
        at: now,
      });
    }
  };
  const loop = (now) => {
    paint(now);
    if (visible && !reduced.matches) requestAnimationFrame(loop);
    else running = false;
  };
  function start_() {
    if (running) return;
    running = true;
    requestAnimationFrame(loop);
  }
  const resize = () => {
    const time = (bins[selected].start + bins[selected].end) / 2;
    width = strip.clientWidth;
    height = strip.clientHeight;
    // Group into 3-hour bins only when hourly columns would be under 4 px.
    const grouped = hours.length * 4 > width;
    if (grouped) {
      const groups = new Map();
      for (const hour of hours) {
        const key = Math.floor(hour.start / 10800);
        const b = groups.get(key);
        if (!b) groups.set(key, { ...hour });
        else {
          b.end = hour.end;
          b.deposits += hour.deposits;
          b.withdrawals += hour.withdrawals;
          b.depositWei = (
            BigInt(b.depositWei) + BigInt(hour.depositWei)
          ).toString();
          b.withdrawalWei = (
            BigInt(b.withdrawalWei) + BigInt(hour.withdrawalWei)
          ).toString();
        }
      }
      bins = [...groups.values()];
    } else bins = hours;
    // Square pixels. The rows are shared between the busiest deposit hour and
    // the busiest withdrawal hour, so the baseline sits where both peaks fit.
    // Prefer the largest square that keeps one square at 2 transactions or
    // fewer; the column width caps the square size.
    columnWidth = width / bins.length;
    const up = Math.max(1, ...bins.map((b) => b.deposits)),
      down = Math.max(1, ...bins.map((b) => b.withdrawals)),
      unitAt = (p) =>
        Math.ceil((up + down) / Math.max(2, Math.floor((height - LABEL) / p) - 1));
    pitch = Math.max(4, Math.min(7, Math.floor(columnWidth)));
    while (pitch > 4 && unitAt(pitch) > 2) pitch--;
    cell = pitch - 1;
    unit = unitAt(pitch);
    rowsUp = Math.ceil(up / unit);
    rowsDown = Math.ceil(down / unit);
    const spare = Math.floor((height - LABEL) / pitch) - 1 - rowsUp - rowsDown;
    baseline = (rowsUp + Math.floor(spare / 2)) * pitch + (pitch - cell);
    jitter = bins.map(() =>
      Array.from({ length: Math.max(rowsUp, rowsDown) + 1 }, () =>
        Math.random() * 140,
      ),
    );
    let total = 0;
    weights = bins.flatMap((b, index) =>
      [
        [b.deposits, 1],
        [b.withdrawals, -1],
      ]
        .filter(([count]) => count)
        .map(([count, side]) => ({ index, side, count, total: (total += count) })),
    );
    slider.max = String(bins.length - 1);
    $("activity-resolution").textContent = grouped
      ? "Transactions per 3 hours"
      : "Transactions per hour";
    $("activity-unit").textContent =
      unit === 1
        ? "Each square is 1 transaction"
        : `Each square is ${unit} transactions`;
    const dpr = window.devicePixelRatio || 1;
    strip.width = Math.round(width * dpr);
    strip.height = Math.round(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const next = bins.findIndex((b) => time < b.end);
    update(next < 0 ? bins.length - 1 : next, true);
    paint(performance.now());
  };
  const point = (event) => {
    const bounds = strip.getBoundingClientRect();
    const index = Math.floor(
      ((event.clientX - bounds.left) / bounds.width) * bins.length,
    );
    update(index);
  };
  // Keep the native range for keyboard and assistive technology; pointer
  // selection maps straight to the column under the cursor.
  slider.addEventListener("input", () => update(Number(slider.value)));
  slider.addEventListener("pointermove", point);
  slider.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    slider.focus({ preventScroll: true });
    point(event);
  });
  // Off screen, the timeline stops drawing.
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) start_();
  }).observe(strip);
  new ResizeObserver(resize).observe(strip);
  document.fonts.ready.then(resize);
  resize();
}
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
    ? r.sets.flatMap((s) => s.deposits.map((d) => d.id))
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
  $("crowd-caption").hidden = true;
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
  $("result-heading").textContent = "RISK";
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
  $("crowd-caption").hidden = !r.points.length;
  const box = $("result-copy");
  box.replaceChildren();
  const verdict = (...lines) =>
    box.append(...lines.map((line, i) => text("p", line, i ? "" : "verdict")));
  if (r.q1 !== "no")
    verdict(
      r.q1 === "unsure"
        ? "Your destination may be your deposit address. If it is, anyone can link your withdrawal to your deposit."
        : "You will withdraw to your deposit address. Anyone can link your withdrawal to your deposit.",
      "Withdraw to a new address that has no link to your deposit address.",
    );
  else if (r.q2 !== "no")
    verdict(
      r.q2 === "unsure"
        ? "Your destination may have a transaction with your deposit address. If it does, anyone can follow that link."
        : "Your destination address has a transaction with your deposit address. Anyone can follow that link.",
      "Use a new address that has no link to your deposit address.",
    );
  else if (r.q3 !== "no")
    verdict(
      r.q3 === "unsure"
        ? "This may be the rest of a deposit you partly withdrew. If it is, anyone can add your withdrawals together and find that deposit."
        : "You will withdraw the rest of a deposit. Anyone can add your withdrawals together and find that deposit, unless its amount was round.",
      "Withdraw less than the rest, and leave the difference in the pool.",
    );
  else if (r.amountScore >= 6)
    verdict(
      r.sets.some((set) => set.deposits.length > 1)
        ? "Your amount matches public deposits."
        : `This amount points to ${r.pointCount} ${r.pointCount === 1 ? "deposit" : "deposits"}.`,
    );
  else if (r.matches)
    verdict("No strong amount match was found among the public deposits.");
  else
    verdict(
      "No deposit, and no set of 2 or 3 deposits, adds up to this amount.",
    );
  if (r.sets?.length) {
    const matches = text("section", "", "matches");
    matches.setAttribute("aria-labelledby", "matches-heading");
    const table = document.createElement("table");
    const head = table.createTHead().insertRow();
    for (const name of ["Amounts sent", "Dates (UTC)"]) {
      const th = text("th", name);
      th.scope = "col";
      head.append(th);
    }
    const body = table.createTBody();
    const amountSent = (nano) => {
      const gross = (BigInt(nano) * NANO * 10000n) / 9975n;
      const rounded = (gross + 500000000000n) / 1000000000000n;
      return `${rounded / 1000000n}.${(rounded % 1000000n).toString().padStart(6, "0")}`;
    };
    const shown = new Set();
    for (const set of r.sets) {
      const amounts =
          set.deposits.map((d) => amountSent(d.amount)).join(" + ") + " ETH",
        dates = set.deposits.map((d) => date(d.time)).join(" · ");
      // Different deposits can look the same once rounded; list them once.
      if (shown.has(amounts + dates)) continue;
      shown.add(amounts + dates);
      const row = body.insertRow();
      const amountCell = row.insertCell(),
        dateCell = row.insertCell();
      for (const [index, deposit] of set.deposits.entries()) {
        const leg = text("span", "", "match-leg");
        if (index) leg.append(text("span", "+ ", "match-plus"));
        leg.append(
          document.createTextNode(`${amountSent(deposit.amount)} ETH`),
        );
        amountCell.append(leg);
        dateCell.append(text("span", date(deposit.time), "match-leg"));
      }
    }
    const heading = text(
      "h3",
      `${shown.size} matching deposit ${shown.size === 1 ? "set" : "sets"}`,
    );
    heading.id = "matches-heading";
    table.setAttribute("aria-labelledby", heading.id);
    matches.append(
      heading,
      text(
        "p",
        "A match is relevant only if it includes your deposit.",
        "match-context",
      ),
      table,
      text(
        "p",
        "Amount sent is what left the depositing address, before the 0.25% shield fee. Matches use the amount after that fee.",
        "hint",
      ),
      text(
        "p",
        "A set can be 1 deposit, or 2–3 added together. A match alone does not prove a link.",
        "hint",
      ),
    );
    if (r.matches > r.sets.length)
      matches.append(
        text(
          "p",
          `Showing ${shown.size} distinct ${shown.size === 1 ? "set" : "sets"} from the ${r.sets.length} strongest matches. Similar-looking sets are listed once.`,
          "hint",
        ),
      );
    box.append(matches);
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
  if ([r.q1, r.q2, r.q3].includes("unsure"))
    box.append(
      text(
        "p",
        "You selected Not sure. The score uses the worse answer.",
        "uncertain",
      ),
    );
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
reveal();
heartbeat();
load();
