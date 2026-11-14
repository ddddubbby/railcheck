import { plan } from "./advice.mjs";
export const WEI = 10n ** 18n,
  NANO = 10n ** 9n,
  EPS = 5000;
export const afterUnshieldFee = (wei) => wei - (wei * 25n) / 10000n;
// The word for amounts in messages: `unit` when the asset has one (ETH for the WETH
// pool, which also covers native ETH), else the symbol.
const unitName = (asset) => asset.unit ?? asset.symbol;
// Amounts are at most 9 * 10^15 pool units, so pool amounts stay exact as Numbers
// (2^53 is about 9.007 * 10^15): 9,000,000 ETH in nano-ETH, 9,000,000,000 tokens
// for a 6-decimal asset in base units.
const MAX_POOL_UNITS = 9n * 10n ** 15n;
const grouped = (n) => n.toString().replace(/\B(?=(\d{3})+$)/g, ",");
/** A decimal string in whole tokens to base units (wei for WETH), with the asset's decimals. */
export function parseAmount(value, asset = ETH_ASSET) {
  asset = assetOf(asset);
  const { decimals } = asset,
    one = 10n ** BigInt(decimals);
  if (!value.trim()) throw Error("Enter an amount.");
  const pattern = decimals
    ? new RegExp(`^(?:\\d+(?:\\.\\d{0,${decimals}})?|\\.\\d{1,${decimals}})$`)
    : /^\d+$/;
  if (!pattern.test(value))
    throw Error(`Use numbers, up to ${decimals} decimals, for example 2.4137.`);
  const [whole, frac = ""] = value.split(".");
  const wei = BigInt(whole || "0") * one + BigInt(frac.padEnd(decimals, "0") || "0");
  if (wei === 0n) throw Error("Enter an amount greater than 0.");
  const max = MAX_POOL_UNITS / 10n ** BigInt(asset.unitDecimals);
  if (wei > max * one)
    throw Error(`Enter an amount of ${grouped(max)} ${unitName(asset)} or less.`);
  return wei;
}
/** Base units (wei for WETH) as a decimal string in whole tokens, cut to `places` decimals. */
export function formatWei(wei, places, asset = ETH_ASSET) {
  const { decimals } = asset,
    one = 10n ** BigInt(decimals);
  places ??= decimals;
  if (wei < 0n) return "-" + formatWei(-wei, places, asset);
  const s = (wei % one)
    .toString()
    .padStart(decimals, "0")
    .slice(0, places)
    .replace(/0+$/, "");
  return (wei / one).toString() + (s ? "." + s : "");
}
const ceilDiv = (a, b) => (a >= 0n ? (a + b - 1n) / b : a / b);
// Stored amounts (pool units) within `eps` of `wei`: [low, high].
const range = (wei, eps, scale) => [
  Number(ceilDiv(wei - BigInt(eps) * scale, scale)),
  Number((wei + BigInt(eps) * scale) / scale),
];
export function countSets(amounts, wei, eps = EPS, scale = NANO) {
  const n = amounts.length,
    [low, high] = range(wei, eps, scale);
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
export function matchSets(sorted, wei, scoreById, limit = 5, { eps = EPS, scale = NANO } = {}) {
  const n = sorted.length,
    amounts = sorted.map((d) => d.amount),
    [low, high] = range(wei, eps, scale),
    score = (d) => scoreById.get(d.id) || 0,
    sets = [];
  const push = (deposits, rank) => {
    // A part within the match tolerance only restates a smaller set.
    if (deposits.length > 1 && deposits.some((d) => d.amount <= 2 * eps))
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
      // ENG-4: a reshield in a match set keeps its kind, so the table can tag it.
      deposits: deposits.map(({ id, amount, time, kind }) =>
        kind === "reshield" ? { id, amount, time, kind } : { id, amount, time },
      ),
    }));
}
const WINDOW = 180 * 86400;
// ENG-8: the amount constants of an asset. Pools store amounts in pool units of
// 10^-unitDecimals token; `tolerance` is in pool units, `saferStep` in base units.
// `noMatch` is the weight of "no deposit in the pool made this amount".
export const AMOUNT_FIELDS = ["decimals", "unitDecimals", "tolerance", "noMatch", "saferStep"];
const WETH_AMOUNTS = {
  decimals: 18,
  unitDecimals: 9, // nano-ETH, as in the pool file
  tolerance: EPS, // ±0.000005 ETH
  noMatch: 0.6,
  saferStep: 10n ** 14n, // 0.0001 ETH
};
export const ETH_ASSET = {
  chainId: 1,
  address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  symbol: "WETH",
  unit: "ETH", // the word in messages: the pool also covers native ETH
  ...WETH_AMOUNTS,
};
// The amount constants of USDT and USDC (OD-7). Both have 6 decimals, and their
// pools store base units (unitDecimals 6), so a pool amount is the exact on-chain
// value and the tolerance is in base units.
//
// Tolerance: the largest difference between an unshield of an exact set of 1 to 3
// shields and the sum of their pool amounts, in base units (RAILGUN getFee, 25 bps,
// integer division rounds down):
//   shield leg:   pool amount = input - floor(input * 25 / 10000), the value of the
//                 note as the Shield event records it. The pool keeps it exactly
//                 (toStored with scale 1 is the identity): error 0 per leg.
//   sum of legs:  integer addition of 1 to 3 notes: error 0.
//   unshield leg: the engine takes the amount before the fee, the value that leaves
//                 the private balance (the note sum). The fee floor(amount * 25 /
//                 10000) only changes what the recipient gets: error 0.
//   worst case:   0 + 0 + 0 = 0 base units. VAL-5 finds every set at tolerance 0.
// The match window is 2 * tolerance + 1 = 1 base unit (0.000001 token), so it never
// joins two distinct amounts. (The WETH pool rounds wei to nano-ETH, and WETH keeps
// its ±5000 nano window.) With a zero-width window the chance term of the score
// (noMatch * q, q proportional to 2 * tolerance) is 0, so noMatch has no effect
// for these assets: a set that adds up exactly is never put down to chance.
const STABLE_AMOUNTS = {
  decimals: 6,
  unitDecimals: 6, // base units, as in the pool file
  tolerance: 0,
  noMatch: 0.6,
  saferStep: 10000n, // 0.01 token
};
export const USDT_ASSET = {
  chainId: 1,
  address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  symbol: "USDT",
  ...STABLE_AMOUNTS,
};
export const USDC_ASSET = {
  chainId: 1,
  address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  symbol: "USDC",
  ...STABLE_AMOUNTS,
};
/** The supported assets: the one allow-list for clients and wallets. */
export const ASSETS = Object.freeze([ETH_ASSET, USDT_ASSET, USDC_ASSET]);
// The amount fields (and message word) for an asset that lacks them: WETH by its
// symbol and decimals (any chain, Sepolia too), else the entry of ASSETS with the
// same chainId, address (any letter case) and decimals. Null for an unknown asset.
function knownAmounts(asset) {
  if (asset.symbol === "WETH" && asset.decimals === 18) return { ...WETH_AMOUNTS, unit: "ETH" };
  const address = typeof asset.address === "string" ? asset.address.toLowerCase() : null;
  return (
    ASSETS.find((a) => a.chainId === asset.chainId && a.address === address && a.decimals === asset.decimals) ??
    null
  );
}
/**
 * The asset with every amount field, or a clear error. A known asset without the
 * fields (as the pool builder returns it: chainId, address, symbol, decimals) gets
 * the values of WETH, USDT or USDC.
 */
export function assetOf(asset = ETH_ASSET) {
  const fill = [...AMOUNT_FIELDS, "unit"].filter((f) => asset[f] === undefined);
  const known = fill.length ? knownAmounts(asset) : null;
  // Append only the missing fields, so the asset keeps its own key order in results.
  if (known) {
    const add = fill.filter((f) => known[f] !== undefined);
    if (add.length) asset = { ...asset, ...Object.fromEntries(add.map((f) => [f, known[f]])) };
  }
  const missing = AMOUNT_FIELDS.filter((f) => asset[f] === undefined);
  if (missing.length)
    throw Error(`The pool asset ${asset.symbol ?? "(no symbol)"} has no ${missing.join(", ")}. Pass a complete asset.`);
  const { decimals, unitDecimals, tolerance, noMatch, saferStep } = asset;
  if (
    !Number.isInteger(decimals) || decimals < 0 ||
    !Number.isInteger(unitDecimals) || unitDecimals < 0 || unitDecimals > decimals ||
    !Number.isSafeInteger(tolerance) || tolerance < 0 ||
    !(noMatch > 0) || !Number.isFinite(noMatch) ||
    typeof saferStep !== "bigint" || saferStep <= 0n
  )
    throw Error("The pool asset has an invalid amount field.");
  return asset;
}
/** Base units per pool unit: 10^(decimals - unitDecimals). */
export const unitOf = (asset) => 10n ** BigInt(asset.decimals - asset.unitDecimals);
/** Base units (wei for WETH) as a whole-token number. */
export const toWhole = (wei, asset) => Number(wei) / 10 ** asset.decimals;
// The identity of the asset in results: the amount fields and the message word stay
// out, except decimals.
export const publicAsset = ({ unit, unitDecimals, tolerance, noMatch, saferStep, ...rest }) => rest;
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
// Pool amounts between `low` and `high` whole tokens; `perWhole` pool units per token.
const between = (amounts, low, high, perWhole) =>
  edge(amounts, (x) => x / perWhole <= high) - edge(amounts, (x) => x / perWhole < low);
// The public pool holds public shields only: every advice rule and owner count
// uses it, as before swap outputs (reshields) were in the data. The unified pool
// adds reshields (ENG-1) and is used for the amount score only (ENG-2).
function index(deposits, options = {}, { withReshields = false } = {}) {
  const asset = assetOf(options.asset ?? ETH_ASSET),
    scale = options.scale ?? unitOf(asset);
  const sorted = deposits
    .filter((d) => withReshields || d.kind !== "reshield")
    .sort((a, b) => a.amount - b.amount);
  return {
    sorted,
    amounts: Float64Array.from(sorted, (d) => d.amount),
    // Sender group per deposit, only when every deposit has one (pool file v2).
    // Without groups the pool cannot count senders, and advice never guesses them.
    grouped: sorted.length > 0 && sorted.every((d) => Number.isInteger(d.group)),
    groups: sorted.every((d) => Number.isInteger(d.group))
      ? Uint32Array.from(sorted, (d) => d.group)
      : null,
    // Options take precedence over the asset.
    eps: options.eps ?? asset.tolerance,
    scale,
    // Pool units per whole token (1e9 for WETH).
    perWhole: Number(10n ** BigInt(asset.decimals) / scale),
    asset,
    fees: options.fees ?? FEES,
    snapshot: options.snapshot ?? null,
    cache: new Map(),
  };
}
/** Sorts the 180-day window one time, for many score() calls. */
export function prepare(deposits, { now = Date.now() / 1000, ...options } = {}) {
  // A snapshot from another chain than the asset gives wrong advice: stop.
  const chainId = options.snapshot?.chainId;
  const asset = options.asset ?? ETH_ASSET;
  if (chainId !== undefined && chainId !== asset.chainId)
    throw Error("The pool asset and the snapshot are on different chains. Pass the asset.");
  // Several assets share a chain: a pool of another token gives wrong advice too.
  const token = options.snapshot?.token;
  if (token && asset.address && String(token).toLowerCase() !== String(asset.address).toLowerCase())
    throw Error("The pool token and the asset are different. Pass the asset of the pool.");
  const windowed = deposits.filter((d) => d.time >= now - WINDOW && d.time < now);
  const pool = index(windowed, options);
  // Pools without reshields get no unified pool, so they score exactly as before.
  if (windowed.some((d) => d.kind === "reshield"))
    pool.unified = index(windowed, options, { withReshields: true });
  return Object.assign(pool, { now, start: now - WINDOW });
}
// ENG-2: the higher of the public-pool score and the unified-pool score. It is
// never lower than the public-pool score, so reshields cannot hide a match. At
// a tie the public result stays, so outputs without a reshield effect do not change.
// `fromSwapOutputs` marks a unified result: swap outputs set the score (ENG-6).
function higher(pool, wei, full) {
  const pub = evaluate(pool, wei, full);
  if (!pool.unified) return pub;
  const unified = evaluate(pool.unified, wei, full);
  return unified.score > pub.score ? Object.assign(unified, { fromSwapOutputs: true }) : pub;
}
function evaluate(pool, wei, full) {
  const { sorted, amounts, eps, scale, perWhole, asset } = pool,
    total = amounts.length,
    a = toWhole(wei, asset),
    max = range(wei, eps, scale)[1],
    n = edge(amounts, (x) => x <= max);
  const { counts, totals } = countSets(amounts.subarray(0, n), wei, eps, scale);
  const m = Math.max(0, between(amounts, 0.8 * a, 1.25 * a, perWhole));
  // The chance that no deposit made the amount: the pool density near the amount
  // times the match window (2 * eps), in whole tokens (0.00001 ETH for WETH).
  const width = (2 * eps) / perWhole;
  const q = total
    ? Math.min(1, (((1 + m) / total) * width) / (0.45 * a))
    : 1;
  const choose = [n, (n * (n - 1)) / 2, (n * (n - 1) * (n - 2)) / 6],
    weights = [0.25, 0.1, 0.05].map((p, i) => (choose[i] ? p / choose[i] : 0));
  const denominator =
    asset.noMatch * q + totals.reduce((sum, v, i) => sum + v * weights[i], 0);
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
  const sets = points.length ? matchSets(window, wei, scoreById, 5, { eps, scale }) : [];
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
  if (!pool.cache.has(key)) pool.cache.set(key, higher(pool, wei, false));
  return pool.cache.get(key);
}
export function amountScore(deposits, wei, asset = ETH_ASSET) {
  const pool = index(deposits, { asset });
  if (deposits.some((d) => d.kind === "reshield"))
    pool.unified = index(deposits, { asset }, { withReshields: true });
  return higher(pool, wei, true);
}
// "yes" and "no" are answers; "unsure" is unknown, never the worse answer.
const ANSWER = { yes: true, no: false, unsure: undefined };
/**
 * Compatibility wrapper for the web checker: the same plan() and assess() rules,
 * plus the match table. It keeps no rules of its own. `asset` is the pool asset
 * (WETH when left out); `safer` is in its decimals.
 */
export function check(deposits, wei, q1, q2, q3, now = Date.now() / 1000, asset = ETH_ASSET) {
  if (![q1, q2, q3].every((q) => q in ANSWER)) throw Error("Select an answer.");
  const pool = prepare(deposits, { now, asset });
  if (!pool.amounts.length)
    throw Error(
      "No deposits are available in the last 180 days. Load a current pool file.",
    );
  const amount = higher(pool, wei, true),
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
    safer: alternative ? formatWei(alternative.amounts.unshieldAmount, undefined, pool.asset) : null,
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
export const inspect = (pool, wei) => higher(pool, wei, true);
