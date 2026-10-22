import { plan } from "./advice.mjs";
export const WEI = 10n ** 18n,
  NANO = 10n ** 9n,
  EPS = 5000;
export const afterUnshieldFee = (wei) => wei - (wei * 25n) / 10000n;
export function parseAmount(value) {
  if (!value.trim()) throw Error("Enter an amount.");
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
  if (wei < 0n) return "-" + formatWei(-wei, places);
  const s = (wei % WEI)
    .toString()
    .padStart(18, "0")
    .slice(0, places)
    .replace(/0+$/, "");
  return (wei / WEI).toString() + (s ? "." + s : "");
}
const ceilDiv = (a, b) => (a >= 0n ? (a + b - 1n) / b : a / b);
export function countSets(amounts, wei, eps = EPS) {
  const n = amounts.length,
    low = Number(ceilDiv(wei - BigInt(eps) * NANO, NANO)),
    high = Number((wei + BigInt(eps) * NANO) / NANO);
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
    // A part within the match tolerance only restates a smaller set.
    if (deposits.length > 1 && deposits.some((d) => d.amount <= 2 * EPS))
      return;
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
const WINDOW = 180 * 86400;
export const ETH_ASSET = {
  chainId: 1,
  address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  symbol: "WETH",
  decimals: 18,
};
export const FEES = { shieldBps: 25, unshieldBps: 25 };
// Public amounts are base units (wei); pools store amounts in `scale` units.
export const toStored = (wei, scale = NANO) => (wei + scale / 2n) / scale;
export const toBase = (stored, scale = NANO) => BigInt(stored) * scale;
export const bandOf = (score) =>
  score <= 5 ? "Low" : score <= 20 ? "Medium" : score <= 50 ? "High" : "Critical";
// First index where `keep` is false. `keep` must be true, then false, along `amounts`.
function edge(amounts, keep) {
  let lo = 0,
    hi = amounts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keep(amounts[mid])) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
const between = (amounts, low, high) =>
  edge(amounts, (x) => x / 1e9 <= high) - edge(amounts, (x) => x / 1e9 < low);
const NO_GROUP = 0xffffffff;
const hasSenderGroup = (d) =>
  Number.isInteger(d.group) && (d.group >>> 0) !== NO_GROUP;

function index(deposits, options = {}) {
  // Reshields (swap outputs) do not score until the engine can treat them apart
  // (R1.1): as plain shields they would lower scores for public-shield users.
  // Pool v3 still carries typed kind; scoring them belongs to R1, not R0.3.
  // Builder rows use "reshield"; EXCK v3 decode uses kind byte 1.
  const sorted = deposits
    .filter((d) => d.kind !== "reshield" && d.kind !== 1)
    .sort((a, b) => a.amount - b.amount);
  // Real sender groups only (not 0xFFFFFFFF "no group" from pool file v3).
  const grouped = sorted.length > 0 && sorted.every(hasSenderGroup);
  return {
    sorted,
    amounts: Float64Array.from(sorted, (d) => d.amount),
    // Sender group per deposit, only when every deposit has one (pool file v2+).
    // Without groups the pool cannot count senders, and advice never guesses them.
    grouped,
    groups: grouped ? Uint32Array.from(sorted, (d) => d.group) : null,
    eps: options.eps ?? EPS,
    scale: options.scale ?? NANO,
    asset: options.asset ?? ETH_ASSET,
    fees: options.fees ?? FEES,
    snapshot: options.snapshot ?? null,
    cache: new Map(),
  };
}
/** Sorts the 180-day window one time, for many score() calls. */
export function prepare(deposits, { now = Date.now() / 1000, ...options } = {}) {
  // A snapshot from another chain than the asset gives wrong advice: stop.
  const chainId = options.snapshot?.chainId;
  if (chainId !== undefined && chainId !== (options.asset ?? ETH_ASSET).chainId)
    throw Error("The pool asset and the snapshot are on different chains. Pass the asset.");
  const pool = index(
    deposits.filter((d) => d.time >= now - WINDOW && d.time < now),
    options,
  );
  return Object.assign(pool, { now, start: now - WINDOW });
}
function evaluate(pool, wei, full) {
  const { sorted, amounts, eps } = pool,
    total = amounts.length,
    a = Number(wei) / 1e18,
    max = Number((wei + BigInt(eps) * NANO) / NANO),
    n = edge(amounts, (x) => x <= max);
  const { counts, totals } = countSets(amounts.subarray(0, n), wei, eps);
  const m = Math.max(0, between(amounts, 0.8 * a, 1.25 * a));
  const q = total
    ? Math.min(1, (((1 + m) / total) * 0.00001) / (0.45 * a))
    : 1;
  const choose = [n, (n * (n - 1)) / 2, (n * (n - 1) * (n - 2)) / 6],
    weights = [0.25, 0.1, 0.05].map((p, i) => (choose[i] ? p / choose[i] : 0));
  const denominator =
    0.6 * q + totals.reduce((sum, v, i) => sum + v * weights[i], 0);
  const p = (i) =>
    denominator
      ? counts.reduce((sum, c, k) => sum + c[i] * weights[k], 0) / denominator
      : 0;
  const matches = totals.reduce((a, b) => a + b, 0);
  if (!full) {
    let highest = 0;
    for (let i = 0; i < n; i++) highest = Math.max(highest, p(i));
    const score = Math.round(100 * highest);
    return {
      score,
      band: bandOf(score),
      crowd: matches ? Math.min(n, Math.round(1 / highest)) : n,
      matches,
    };
  }
  const window = sorted.slice(0, n),
    byIndex = window.map((d, i) => ({ ...d, p: p(i) }));
  const posterior = byIndex.slice().sort((a, b) => b.p - a.p);
  const highest = posterior[0]?.p || 0,
    score = Math.round(100 * highest);
  const points = posterior.filter((d) => Math.round(100 * d.p) >= 6);
  const scoreById = new Map(byIndex.map((d) => [d.id, d.p]));
  const sets = points.length ? matchSets(window, wei, scoreById) : [];
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
/** Amount score only: no context floors, no match table. Cached per pool. */
export function score(pool, wei) {
  const key = wei.toString();
  if (!pool.cache.has(key)) pool.cache.set(key, evaluate(pool, wei, false));
  return pool.cache.get(key);
}
export function amountScore(deposits, wei) {
  return evaluate(index(deposits), wei, true);
}
// "yes" and "no" are answers; "unsure" is unknown, never the worse answer.
const ANSWER = { yes: true, no: false, unsure: undefined };
/**
 * Compatibility wrapper for the web checker: the same plan() and assess() rules,
 * plus the match table. It keeps no rules of its own.
 */
export function check(deposits, wei, q1, q2, q3, now = Date.now() / 1000) {
  if (![q1, q2, q3].every((q) => q in ANSWER)) throw Error("Select an answer.");
  const pool = prepare(deposits, { now });
  if (!pool.amounts.length)
    throw Error(
      "No deposits are available in the last 180 days. Load a current pool file.",
    );
  const amount = evaluate(pool, wei, true),
    context = { addressReuse: ANSWER[q1], pastTransfer: ANSWER[q2], restOfDeposit: ANSWER[q3] },
    planned = plan(pool, { action: "unshield", amount: wei, constraint: "flexible", context }),
    { assessment } = planned,
    alternative = planned.alternatives[0];
  return {
    ...amount,
    amountScore: amount.score,
    score: assessment.score,
    band: assessment.band,
    floor: assessment.score - assessment.modelScore,
    safer: alternative ? formatWei(alternative.amounts.unshieldAmount) : null,
    status: assessment.status,
    findings: assessment.findings,
    q1,
    q2,
    q3,
    count: pool.amounts.length,
    start: pool.start,
  };
}
/** The full model output for one amount: score, top deposits and match table. */
export const inspect = (pool, wei) => evaluate(pool, wei, true);
