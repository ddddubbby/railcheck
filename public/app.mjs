// Page decoration: the assurance icons and the pool activity chart. The
// shield and unshield flow lives in flow.mjs.
const $ = (id) => document.getElementById(id);
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
      `${b.deposits} shield${b.deposits === 1 ? "" : "s"}`;
    $("activity-withdrawals").textContent =
      `${b.withdrawals} unshield${b.withdrawals === 1 ? "" : "s"}`;
    $("activity-deposit-eth").textContent = `${eth(b.depositWei)} ETH`;
    $("activity-withdrawal-eth").textContent = `${eth(b.withdrawalWei)} ETH`;
    slider.setAttribute(
      "aria-valuetext",
      `${shortDate(b.start)}, ${clock(b.start)} to ${clock(b.end)} UTC: ${b.deposits} shields, ${eth(b.depositWei)} ETH; ${b.withdrawals} unshields, ${eth(b.withdrawalWei)} ETH`,
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
reveal();
heartbeat();
