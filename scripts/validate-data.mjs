import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { decode } from "../lib/pool/index.mjs";
import {
  amountScore,
  patternScore,
  windows,
  check,
  parseAmount,
  NANO,
  EPS,
} from "../lib/engine/index.mjs";
import { parseCsv, inWindow } from "./lib/data.mjs";
const manifest = JSON.parse(readFileSync("public/data/manifest.json"));
const raw = readFileSync(`public/data/${manifest.file}`);
if (
  manifest.demo ||
  manifest.chainId !== 1 ||
  manifest.token !== "WETH" ||
  manifest.confirmations < 64
)
  throw Error("Live data provenance is missing.");
if (
  createHash("sha256").update(raw).digest("hex") !== manifest.sha256 ||
  raw.length !== manifest.size ||
  manifest.file !== `railgun-eth-${manifest.sha256.slice(0, 16)}.bin`
)
  throw Error("Pool hash, size or file name differs from manifest.");
const pool = decode(
  raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
  manifest,
);
const ageHours = (Date.now() / 1000 - manifest.dataTime) / 3600;
for (const [path, label, entries] of [
  ["data/deposits.csv", "deposit", pool.deposits],
  ["data/withdrawals.csv", "withdrawal", pool.withdrawals],
]) {
  const recent = inWindow(
    parseCsv(readFileSync(path, "utf8"), label),
    manifest.dataTime,
  );
  if (
    recent.length !== entries.length ||
    recent.some(
      (r, i) =>
        Number((r.amountWei + 500000000n) / NANO) !== entries[i].amount ||
        r.time !== entries[i].time,
    )
  )
    throw Error(`The ${label} CSV does not reproduce the pool.`);
}
let seed = 0x4558434b;
const random = () =>
  (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const now = manifest.dataTime + 1,
  current = windows(pool, now);
let low = 0,
  patternLow = 0,
  critical = 0,
  risky = 0,
  safer = 0;
const timing = [],
  patternTiming = [];
for (let i = 0; i < 400; i++) {
  const a = parseAmount((0.05 + random() * 4.95).toFixed(6));
  let start = performance.now();
  const result = amountScore(pool.deposits, a);
  timing.push(performance.now() - start);
  if (result.score <= 5) low++;
  start = performance.now();
  if (patternScore(current.sorted, current.recent, a).score <= 5) patternLow++;
  patternTiming.push(performance.now() - start);
  const deposit = pool.deposits[Math.floor(random() * pool.deposits.length)];
  if (deposit.amount === 0) continue;
  const r = check(pool, BigInt(deposit.amount) * NANO, "no", "no", now);
  if (r.score >= 51) critical++;
  if (r.amountScore >= 6 || r.patternScore >= 6) {
    risky++;
    if (r.safer) safer++;
  }
}
timing.sort((a, b) => a - b);
patternTiming.sort((a, b) => a - b);

// Observed 1:1 leaks: a withdrawal with more than 4 decimals that equals exactly
// 1 earlier deposit of its 180-day window.
const byAmount = pool.deposits.slice().sort((a, b) => a.amount - b.amount);
const leaks = [];
for (const w of pool.withdrawals) {
  if (w.amount % 1e5 === 0) continue;
  let lo = 0,
    hi = byAmount.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (byAmount[mid].amount < w.amount - EPS) lo = mid + 1;
    else hi = mid;
  }
  const found = [];
  for (let i = lo; i < byAmount.length && byAmount[i].amount <= w.amount + EPS; i++)
    if (byAmount[i].time < w.time && byAmount[i].time >= w.time - 180 * 86400)
      found.push(byAmount[i]);
  if (found.length === 1) leaks.push({ withdrawal: w, deposit: found[0] });
}
// Amount scoring is the slow part, so only every k-th leak gets it unless --full.
const step = process.argv.includes("--full")
  ? 1
  : Math.max(1, Math.floor(leaks.length / 150));
const percent = (part, whole) =>
  whole ? Number(((part / whole) * 100).toFixed(1)) : 0;
let leakTested = 0,
  leakHigh = 0,
  leakCritical = 0,
  splitTested = 0,
  splitPatternHigh = 0,
  splitPatternMedium = 0,
  splitScored = 0,
  splitAmountMedium = 0,
  splitFinalMedium = 0;
leaks.forEach(({ withdrawal: w, deposit: d }, i) => {
  const at = windows(pool, w.time);
  // Simulate the same deposit taken out in 2 parts: a 4-decimal first part up to 7 days earlier.
  const gap = w.time - d.time;
  const part = Math.round((d.amount * (0.2 + random() * 0.6)) / 1e5) * 1e5;
  if (gap >= 2 && part > 0 && part < d.amount) {
    const first = { amount: part, time: w.time - Math.min(7 * 86400, Math.floor(gap / 2)) };
    const rest = BigInt(d.amount - part) * NANO;
    const p = patternScore(at.sorted, [...at.recent, first], rest).score;
    splitTested++;
    if (p >= 21) splitPatternHigh++;
    if (p >= 6) splitPatternMedium++;
    if (i % step === 0) {
      const a = amountScore(at.window, rest).score;
      splitScored++;
      if (a >= 6) splitAmountMedium++;
      if (Math.max(a, p) >= 6) splitFinalMedium++;
    }
  }
  if (i % step) return;
  const wei = BigInt(w.amount) * NANO;
  const score = Math.max(
    amountScore(at.window, wei).score,
    patternScore(at.sorted, at.recent, wei).score,
  );
  leakTested++;
  if (score >= 21) leakHigh++;
  if (score >= 51) leakCritical++;
});
const named = Object.fromEntries(
  ["4", "4.37", "4.3712", "0.1", "0.5", "1", "2", "10"].map((v) => {
    const r = patternScore(current.sorted, current.recent, parseAmount(v));
    return [v, { patternCount: r.count, patternScore: r.score }];
  }),
);
const report = {
  testedAt: new Date().toISOString(),
  poolSha256: manifest.sha256,
  count: pool.deposits.length,
  withdrawalCount: pool.withdrawals.length,
  recentWithdrawals: current.recent.length,
  dataTime: manifest.dataTime,
  ageHours: Number(ageHours.toFixed(2)),
  randomLowPercent: low / 4,
  randomPatternLowPercent: patternLow / 4,
  fullWithdrawalCriticalPercent: critical / 4,
  saferAmountPercent: risky ? (safer / risky) * 100 : 100,
  riskyFullWithdrawals: risky,
  observedLeaks: leaks.length,
  leaksScored: leakTested,
  leakHighPercent: percent(leakHigh, leakTested),
  leakCriticalPercent: percent(leakCritical, leakTested),
  simulatedSplits: splitTested,
  splitPatternHighPercent: percent(splitPatternHigh, splitTested),
  splitPatternMediumPercent: percent(splitPatternMedium, splitTested),
  splitsAmountScored: splitScored,
  splitAmountOnlyMediumPercent: percent(splitAmountMedium, splitScored),
  splitFinalMediumPercent: percent(splitFinalMedium, splitScored),
  namedAmounts: named,
  amountCheckP95Ms: timing[379],
  patternCheckP95Ms: Number(patternTiming[379].toFixed(2)),
  machine: process.platform,
};
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--report"))
  writeFileSync("data/validation.json", JSON.stringify(report, null, 2) + "\n");
if (
  process.argv.includes("--release") &&
  (ageHours > 26 ||
    ageHours < 0 ||
    report.randomLowPercent < 65 ||
    report.fullWithdrawalCriticalPercent < 55 ||
    report.saferAmountPercent < 90)
)
  throw Error("A release data target failed. See validation output.");
