export const WEI = 10n ** 18n,
  NANO = 10n ** 9n,
  EPS = 5000;
export const afterUnshieldFee = (wei) => wei - (wei * 25n) / 10000n;
export function parseAmount(value) {
  if (!value.trim()) throw Error("Enter the amount that you will unshield.");
  if (!/^(?:\d+(?:\.\d{0,18})?|\.\d{1,18})$/.test(value))
    throw Error("Use numbers and 1 decimal point, for example 2.4137.");
  const [whole, frac = ""] = value.split(".");
  const wei = BigInt(whole || "0") * WEI + BigInt(frac.padEnd(18, "0"));
  if (wei === 0n) throw Error("Enter an amount more than 0.");
  if (wei > 9000000n * WEI)
    throw Error("Enter an amount of 9,000,000 ETH or less.");
  return wei;
}
export function formatWei(wei, places = 18) {
  const s = (wei % WEI)
    .toString()
    .padStart(18, "0")
    .slice(0, places)
    .replace(/0+$/, "");
  return (wei / WEI).toString() + (s ? "." + s : "");
}
const ceilDiv = (a, b) => (a >= 0n ? (a + b - 1n) / b : a / b);
export function countSets(amounts, wei) {
  const n = amounts.length,
    low = Number(ceilDiv(wei - BigInt(EPS) * NANO, NANO)),
    high = Number((wei + BigInt(EPS) * NANO) / NANO);
  const counts = [
      new Float64Array(n),
      new Float64Array(n),
      new Float64Array(n),
    ],
    totals = [0, 0, 0];
  for (let i = 0; i < n; i++)
    if (amounts[i] >= low && amounts[i] <= high) {
      counts[0][i]++;
      totals[0]++;
    }
  for (let k = 2; k <= 3; k++) {
    const diff = new Float64Array(n + 1),
      out = counts[k - 1];
    const outer = k === 2 ? 1 : n - 2;
    for (let p = 0; p < outer; p++) {
      if (k === 3 && amounts[p] + amounts[p + 1] + amounts[p + 2] > high) break;
      const base = k === 2 ? 0 : amounts[p];
      let lo = n,
        hi = n - 1;
      for (let j = k === 2 ? 0 : p + 1; j < n - 1; j++) {
        if (base + amounts[j] + amounts[j + 1] > high) break;
        const min = low - base - amounts[j],
          max = high - base - amounts[j];
        while (lo > 0 && amounts[lo - 1] >= min) lo--;
        while (hi >= 0 && amounts[hi] > max) hi--;
        const start = Math.max(j + 1, lo),
          count = Math.max(0, hi - start + 1);
        if (count) {
          totals[k - 1] += count;
          out[j] += count;
          if (k === 3) out[p] += count;
          diff[start]++;
          diff[hi + 1]--;
        }
      }
    }
    let running = 0;
    for (let i = 0; i < n; i++) {
      running += diff[i];
      out[i] += running;
    }
  }
  return { counts, totals };
}
const lowerBound = (amounts, x, from = 0) => {
  let lo = from,
    hi = amounts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (amounts[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};
/** Top matching 1/2/3-deposit sets for the result table (scoring still uses deposits). */
export function matchSets(sorted, wei, scoreById, limit = 5) {
  const n = sorted.length,
    amounts = sorted.map((d) => d.amount),
    low = Number(ceilDiv(wei - BigInt(EPS) * NANO, NANO)),
    high = Number((wei + BigInt(EPS) * NANO) / NANO),
    score = (d) => scoreById.get(d.id) || 0,
    sets = [];
  const push = (deposits, rank) => {
    sets.push({
      deposits,
      rank,
      max: Math.max(...deposits.map((d) => d.amount)),
    });
  };
  for (let i = 0; i < n; i++)
    if (amounts[i] >= low && amounts[i] <= high)
      push([sorted[i]], score(sorted[i]));
  const singles = sets.length;
  if (singles < limit) {
    for (let i = 0; i < n - 1; i++) {
      let j = lowerBound(amounts, low - amounts[i], i + 1);
      while (j < n && amounts[j] <= high - amounts[i]) {
        push([sorted[i], sorted[j]], score(sorted[i]) + score(sorted[j]));
        j++;
      }
    }
  }
  if (sets.length < limit) {
    const order = Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => score(sorted[b]) - score(sorted[a]),
    );
    outer: for (const i of order.slice(0, 40)) {
      for (let j = 0; j < n - 1; j++) {
        if (j === i) continue;
        const remLo = low - amounts[i] - amounts[j],
          remHi = high - amounts[i] - amounts[j];
        if (remHi < 0) continue;
        let k = lowerBound(amounts, remLo, j + 1);
        while (k < n && amounts[k] <= remHi) {
          if (k !== i) {
            const deps = [sorted[i], sorted[j], sorted[k]].sort(
              (a, b) => a.amount - b.amount || a.id - b.id,
            );
            push(deps, score(deps[0]) + score(deps[1]) + score(deps[2]));
            if (sets.length >= limit * 8) break outer;
          }
          k++;
        }
      }
    }
  }
  const seen = new Set();
  return sets
    .sort(
      (a, b) =>
        a.deposits.length - b.deposits.length ||
        b.rank - a.rank ||
        b.max - a.max,
    )
    .filter((s) => {
      const key = s.deposits
        .map((d) => d.id)
        .sort((a, b) => a - b)
        .join(",");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map(({ deposits }) => ({
      deposits: deposits.map(({ id, amount, time }) => ({ id, amount, time })),
    }));
}
export function amountScore(deposits, wei) {
  const a = Number(wei) / 1e18,
    max = Number((wei + BigInt(EPS) * NANO) / NANO);
  const sorted = deposits
      .filter((d) => d.amount <= max)
      .sort((a, b) => a.amount - b.amount),
    n = sorted.length;
  const { counts, totals } = countSets(
    sorted.map((d) => d.amount),
    wei,
  );
  const m = deposits.filter(
    (d) => d.amount / 1e9 >= 0.8 * a && d.amount / 1e9 <= 1.25 * a,
  ).length;
  const q = deposits.length
    ? Math.min(1, (((1 + m) / deposits.length) * 0.00001) / (0.45 * a))
    : 1;
  const choose = [n, (n * (n - 1)) / 2, (n * (n - 1) * (n - 2)) / 6],
    weights = [0.25, 0.1, 0.05].map((p, i) => (choose[i] ? p / choose[i] : 0));
  const denominator =
    0.6 * q + totals.reduce((sum, v, i) => sum + v * weights[i], 0);
  const byIndex = sorted.map((d, i) => ({
    ...d,
    p: denominator
      ? counts.reduce((sum, c, k) => sum + c[i] * weights[k], 0) / denominator
      : 0,
  }));
  const posterior = byIndex.slice().sort((a, b) => b.p - a.p);
  const highest = posterior[0]?.p || 0,
    score = Math.round(100 * highest),
    matches = totals.reduce((a, b) => a + b, 0);
  const points = posterior.filter((d) => Math.round(100 * d.p) >= 6);
  const scoreById = new Map(byIndex.map((d) => [d.id, d.p]));
  const sets = points.length ? matchSets(sorted, wei, scoreById) : [];
  return {
    score,
    points: points.slice(0, 5),
    pointCount: points.length,
    sets,
    totals,
    n,
    matches,
    crowd: matches ? Math.min(n, Math.round(1 / highest)) : n,
  };
}
export function check(deposits, wei, q1, q2, q3, now = Date.now() / 1000) {
  if (
    !["yes", "no", "unsure"].includes(q1) ||
    !["yes", "no", "unsure"].includes(q2) ||
    !["yes", "no", "unsure"].includes(q3)
  )
    throw Error("Select an answer.");
  const window = deposits.filter(
    (d) => d.time >= now - 180 * 86400 && d.time < now,
  );
  if (!window.length)
    throw Error(
      "No deposits are available in the last 180 days. Load a current pool file.",
    );
  const amount = amountScore(window, wei),
    floor = q1 !== "no" ? 100 : q2 !== "no" || q3 !== "no" ? 90 : 0,
    score = Math.max(floor, amount.score);
  let safer = null;
  if (amount.score >= 6) {
    for (const pct of [
      90, 85, 80, 75, 70, 89, 88, 87, 86, 84, 83, 82, 81, 79, 78, 77, 76, 74,
      73, 72, 71,
    ]) {
      const candidate = ((wei * BigInt(pct)) / 100n / 10n ** 14n) * 10n ** 14n;
      if (candidate <= 0n) continue;
      const s = Number(candidate) / 1e18;
      if (
        window.filter((d) => d.amount / 1e9 >= s && d.amount / 1e9 <= s / 0.9)
          .length >= 20 &&
        amountScore(window, candidate).score <= 5
      ) {
        safer = formatWei(candidate, 4);
        break;
      }
    }
  }
  return {
    ...amount,
    amountScore: amount.score,
    score,
    band:
      score <= 5
        ? "Low"
        : score <= 20
          ? "Medium"
          : score <= 50
            ? "High"
            : "Critical",
    floor,
    safer,
    q1,
    q2,
    q3,
    count: window.length,
    start: now - 180 * 86400,
  };
}
