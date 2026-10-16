import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { decode } from "../lib/pool/index.mjs";
import { amountScore, check, parseAmount, NANO } from "../lib/engine/index.mjs";
import { parseCsv } from "./lib/data.mjs";
const manifest = JSON.parse(readFileSync("public/data/manifest.json"));
const raw = readFileSync("public/data/railgun-eth.bin");
if (
  manifest.demo ||
  manifest.chainId !== 1 ||
  manifest.token !== "WETH" ||
  manifest.confirmations < 64
)
  throw Error("Live data provenance is missing.");
if (
  createHash("sha256").update(raw).digest("hex") !== manifest.sha256 ||
  raw.length !== manifest.size
)
  throw Error("Pool hash or size differs from manifest.");
const pool = decode(
  raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
  manifest,
);
const ageHours = (Date.now() / 1000 - manifest.dataTime) / 3600;
const rows = parseCsv(readFileSync("data/deposits.csv", "utf8"));
const recent = rows
  .filter(
    (d) =>
      d.time >= manifest.dataTime - 180 * 86400 && d.time <= manifest.dataTime,
  )
  .sort((a, b) => a.time - b.time);
if (
  recent.length !== pool.length ||
  recent.some(
    (r, i) =>
      Number((r.amountWei + 500000000n) / NANO) !== pool[i].amount ||
      r.time !== pool[i].time,
  )
)
  throw Error("CSV does not reproduce the pool.");
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
  const deposit = pool[Math.floor(random() * pool.length)];
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
