import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { amountScore, check, parseAmount, NANO } from "../lib/engine/index.mjs";
import { validatePools } from "./lib/validate.mjs";
// Every pool in the manifest: provenance, hash, size, decode, activity hash and
// the CSV files that reproduce it (scripts/lib/validate.mjs).
const { manifest, pools } = validatePools();
const pool = pools.weth;
const ageHours = (Date.now() / 1000 - manifest.dataTime) / 3600;
// The scoring checks below use the WETH engine amounts, so they run on the
// WETH pool only.
// Full-withdrawal checks sample public shields, the deposits a withdrawal can match.
const publicPool = pool.filter((d) => d.kind !== "reshield");
let seed = 0x4558434b;
const random = () =>
  (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
let low = 0,
  critical = 0,
  risky = 0,
  safer = 0;
const timing = [];
for (let i = 0; i < 400; i++) {
  const a = parseAmount((0.05 + random() * 4.95).toFixed(6));
  const start = performance.now();
  const result = amountScore(pool, a);
  timing.push(performance.now() - start);
  if (result.score <= 5) low++;
  const deposit = publicPool[Math.floor(random() * publicPool.length)];
  if (deposit.amount === 0) continue;
  const r = check(
    pool,
    BigInt(deposit.amount) * NANO,
    "no",
    "no",
    "no",
    manifest.dataTime + 1,
  );
  if (r.score >= 51) critical++;
  if (r.amountScore >= 6) {
    risky++;
    if (r.safer) safer++;
  }
}
timing.sort((a, b) => a - b);
const report = {
  testedAt: new Date().toISOString(),
  poolSha256: manifest.sha256,
  count: pool.length,
  dataTime: manifest.dataTime,
  ageHours: Number(ageHours.toFixed(2)),
  randomLowPercent: low / 4,
  fullWithdrawalCriticalPercent: critical / 4,
  saferAmountPercent: risky ? (safer / risky) * 100 : 100,
  riskyFullWithdrawals: risky,
  amountCheckP95Ms: timing[379],
  pools: Object.fromEntries(
    Object.entries(pools).map(([id, deposits]) => [
      id,
      { count: deposits.length, sha256: id === "weth" ? manifest.sha256 : manifest.pools[id].sha256 },
    ]),
  ),
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
