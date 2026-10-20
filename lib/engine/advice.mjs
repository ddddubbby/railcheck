import { score, toBase, toStored, bandOf, prepare } from "./index.mjs";
import { FORMAT } from "../format.mjs";
export const LOW = 5,
  MIN_CROWD = 20,
  MIN_SHARED = 10,
  BUDGET = 6,
  MAX_AGE_HOURS = 48;
// The three withdrawal questions. Each answer is true, false or undefined
// (not sure). Undefined is never turned into false, and never into a link.
export const QUESTIONS = ["addressReuse", "pastTransfer", "restOfDeposit"];
// Candidate filters count senders when the pool knows them, else deposits. They
// only pick amounts to score; they never claim how many people share an amount.
const owner = (pool, i) => (pool.grouped ? pool.groups[i] : i);
/** Why advice cannot run on this pool, or null. Pools without a snapshot skip the check. */
export function unready(pool, maxAgeHours = MAX_AGE_HOURS) {
  const s = pool.snapshot;
  if (!s) return null;
  if (pool.now - s.time > maxAgeHours * 3600) return "stale-data";
  if (s.windowStart !== undefined && s.windowStart > pool.start + 86400)
    return "incomplete-window";
  return null;
}
const PERCENTS = [
  90, 85, 80, 75, 70, 89, 88, 87, 86, 84, 83, 82, 81, 79, 78, 77, 76, 74, 73,
  72, 71,
];
/** Stored amounts that MIN_CROWD or more owners (see `owner`) share exactly, largest first. */
export function crowded(pool) {
  if (!pool.crowded) {
    const owners = new Map();
    pool.amounts.forEach((x, i) => {
      if (!owners.has(x)) owners.set(x, new Set());
      owners.get(x).add(owner(pool, i));
    });
    pool.crowded = [...owners]
      .map(([x, set]) => [x, set.size])
      .filter(([, c]) => c >= MIN_CROWD)
      .sort((a, b) => b[0] - a[0]);
  }
  return pool.crowded;
}
// Owners (see `owner`) with an amount in [s, s / 0.9] ETH.
const near = (pool, s) => {
  const owners = new Set();
  pool.amounts.forEach((x, i) => {
    if (x / 1e9 >= s && x / 1e9 <= s / 0.9) owners.add(owner(pool, i));
  });
  return owners.size;
};
/**
 * Smaller unshield amounts to try: below `max` and at least 70% of it, largest
 * first. Crowded pool amounts, and percentage steps with MIN_CROWD owners nearby.
 */
function unshieldCandidates(pool, max) {
  const floor = (max * 70n) / 100n,
    found = new Set();
  for (const [stored] of crowded(pool)) {
    const wei = toBase(stored, pool.scale);
    if (wei < max && wei >= floor) found.add(wei);
  }
  for (const pct of PERCENTS) {
    const wei = ((max * BigInt(pct)) / 100n / 10n ** 14n) * 10n ** 14n;
    if (wei > 0n && !found.has(wei) && near(pool, Number(wei) / 1e18) >= MIN_CROWD)
      found.add(wei);
  }
  return [...found].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}
// Deposits and senders within `eps` of `stored`. `senders` is null without groups.
function countNear(pool, stored) {
  const { amounts } = pool,
    eps = BigInt(pool.eps),
    lo = Number(stored - eps),
    hi = Number(stored + eps);
  const first = (x) => {
    let a = 0,
      b = amounts.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (amounts[m] < x) a = m + 1;
      else b = m;
    }
    return a;
  };
  const start = first(lo),
    end = first(hi + 1);
  return {
    deposits: end - start,
    senders: pool.grouped ? new Set(pool.groups.subarray(start, end)).size : null,
  };
}
// Score of a later withdrawal of the whole deposit, with the user's own deposit
// added to the pool. Without it, a rare amount looks safe (it matches nothing yet).
function exitScore(pool, poolCredit) {
  const own = {
    id: -1,
    amount: Number(toStored(poolCredit, pool.scale)),
    time: pool.now - 1,
  };
  const { eps, scale, asset, fees } = pool;
  const withOwn = prepare([...pool.sorted, own], { now: pool.now, eps, scale, asset, fees });
  return score(withOwn, poolCredit).score;
}
const afterFee = (wei, bps) => wei - (wei * BigInt(bps)) / 10000n;
function assessShield(pool, shieldInput) {
  const poolCredit = afterFee(shieldInput, pool.fees.shieldBps),
    exit = exitScore(pool, poolCredit);
  return {
    amounts: { shieldInput, poolCredit },
    ...countNear(pool, toStored(poolCredit, pool.scale)),
    score: exit,
    findings: exit > LOW ? [{ code: "amount-stands-out" }] : [],
    unknown: [],
  };
}
function assessUnshield(pool, unshieldAmount, context) {
  const amount = score(pool, unshieldAmount).score,
    findings = [],
    unknown = QUESTIONS.filter((q) => context[q] === undefined);
  let floor = 0;
  // An address link comes first: a different amount does not remove it.
  if (context.addressReuse) {
    findings.push({ code: "address-link", reason: "address-reuse" });
    floor = 100;
  } else if (context.pastTransfer) {
    findings.push({ code: "address-link", reason: "past-transfer" });
    floor = 90;
  }
  if (context.restOfDeposit) {
    findings.push({ code: "rest-of-deposit" });
    floor = Math.max(floor, 90);
  }
  if (amount > LOW) findings.push({ code: "amount-stands-out" });
  if (unknown.length) findings.push({ code: "unknown-context", checks: unknown });
  return {
    amounts: {
      unshieldAmount,
      recipientAmount: afterFee(unshieldAmount, pool.fees.unshieldBps),
    },
    modelScore: amount,
    score: Math.max(floor, amount),
    findings,
    unknown,
  };
}
/**
 * One assessment: one amount and its context give findings. `action` is
 * "shield" (amount = what leaves the wallet) or "unshield" (amount = what leaves
 * the private balance, before the unshield fee). Status: "attention" when a
 * finding needs action, "incomplete" when an answer is not sure, "clear" when
 * the available checks find no issue, "not-checked" when the pool is unusable.
 */
export function assess(pool, { action, amount, context = {}, maxAgeHours }) {
  const base = { format: FORMAT, action, asset: pool.asset, snapshot: pool.snapshot ?? null };
  const blocked = unready(pool, maxAgeHours);
  if (blocked) return { ...base, status: "not-checked", findings: [{ code: blocked }], notes: [] };
  const a = action === "shield" ? assessShield(pool, amount) : assessUnshield(pool, amount, context);
  const attention = a.findings.some((f) => f.code !== "unknown-context");
  const notes = ["timing-not-covered"];
  if (action === "shield" && !pool.grouped) notes.push("senders-unknown");
  return {
    ...base,
    status: attention ? "attention" : a.unknown.length ? "incomplete" : "clear",
    ...a,
    band: bandOf(a.score),
    notes,
  };
}
const changeable = (a) =>
  a.findings.some((f) => f.code === "amount-stands-out" || f.code === "rest-of-deposit") &&
  !a.findings.some((f) => f.code === "address-link");
/**
 * Planning: allowed candidate amounts go through the same assess(). `constraint`
 * is "fixed" (never replace the amount) or "flexible" (shield: within ±10%;
 * unshield: 70–100% of the request). Alternatives must score Low.
 */
export function plan(
  pool,
  { action, amount, constraint = "fixed", context = {}, balance = null, budget = BUDGET, maxAgeHours },
) {
  const assessment = assess(pool, { action, amount, context, maxAgeHours });
  const result = { format: FORMAT, action, constraint, assessment, alternatives: [], searched: null };
  if (assessment.status === "not-checked") return result;
  if (constraint === "flexible" && changeable(assessment)) {
    if (action === "shield") Object.assign(result, shieldSearch(pool, assessment));
    else Object.assign(result, unshieldSearch(pool, amount, context, budget, maxAgeHours));
  }
  if (action === "unshield") {
    // Remaining balance and the split note use the checked amount. Picking an
    // alternative re-runs plan() with that amount as the request. A balance below
    // the amount cannot leave a remainder, so do not return a negative number.
    result.remainingBalance =
      balance === null || balance < amount ? null : balance - amount;
    if (balance === null || balance > amount) assessment.notes.push("split-completes-total");
    if (balance !== null && balance < amount) assessment.notes.push("balance-below-amount");
  }
  return result;
}
// Shield: shared pool amounts within ±10%, nearest first on each side, whose later
// full withdrawal scores Low. A 4-decimal shield amount must land on the pool amount.
function shieldSearch(pool, assessment) {
  const bps = BigInt(pool.fees.shieldBps),
    eps = BigInt(pool.eps),
    step = 10n ** BigInt(Math.max(0, pool.asset.decimals - 4)),
    stored = toStored(assessment.amounts.poolCredit, pool.scale),
    lo = (stored * 90n) / 100n,
    hi = (stored * 110n) / 100n,
    owners = new Map(),
    alternatives = [];
  pool.amounts.forEach((x, i) => {
    const v = BigInt(x);
    if (v < lo || v > hi || (v >= stored - eps && v <= stored + eps)) return;
    if (!owners.has(v)) owners.set(v, new Set());
    owners.get(v).add(owner(pool, i));
  });
  const shared = [...owners].filter(([, set]) => set.size >= MIN_SHARED).map(([v]) => v),
    gap = (v) => (v > stored ? v - stored : stored - v);
  let tried = 0;
  for (const side of [shared.filter((v) => v < stored), shared.filter((v) => v > stored)]) {
    let scored = 0;
    for (const value of side.sort((a, b) => (gap(a) < gap(b) ? -1 : 1))) {
      const exact = (toBase(value, pool.scale) * 10000n) / (10000n - bps),
        input = ((exact + step / 2n) / step) * step,
        off = toStored(afterFee(input, bps), pool.scale) - value;
      if ((off < 0n ? -off : off) > eps) continue;
      if (scored++ === 3) break;
      tried++;
      const alt = assess(pool, { action: "shield", amount: input });
      if (alt.score <= LOW) {
        alternatives.push(alt);
        break;
      }
    }
  }
  const shieldInput = assessment.amounts.shieldInput;
  return {
    alternatives,
    searched: { from: (shieldInput * 90n) / 100n, to: (shieldInput * 110n) / 100n, candidates: tried, limited: false },
  };
}
// Unshield: the largest Low amount between 70% and 100% of the request, within the
// budget. A smaller amount is not the rest of a deposit: a "yes" becomes "no".
function unshieldSearch(pool, max, context, budget, maxAgeHours) {
  const smaller = { ...context, restOfDeposit: context.restOfDeposit === true ? false : context.restOfDeposit },
    list = unshieldCandidates(pool, max),
    range = { from: (max * 70n) / 100n, to: max };
  let tried = 0;
  for (const wei of list) {
    if (tried === budget) break;
    tried++;
    const alt = assess(pool, { action: "unshield", amount: wei, context: smaller, maxAgeHours });
    if (alt.score <= LOW) return { alternatives: [alt], searched: { ...range, candidates: tried, limited: false } };
  }
  return { alternatives: [], searched: { ...range, candidates: tried, limited: tried < list.length } };
}
