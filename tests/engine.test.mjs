import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  countSets,
  matchSets,
  parseAmount,
  formatWei,
  check,
  amountScore,
  NANO,
  afterUnshieldFee,
} from "../lib/engine/index.mjs";
import { decode } from "../lib/pool/index.mjs";
let seed = 61956;
const rand = () =>
  (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
function brute(a, wei) {
  const counts = [a.map(() => 0), a.map(() => 0), a.map(() => 0)],
    totals = [0, 0, 0];
  const visit = (ids) => {
    const diff = BigInt(ids.reduce((s, i) => s + a[i], 0)) * NANO - wei;
    if (diff >= -5000n * NANO && diff <= 5000n * NANO) {
      totals[ids.length - 1]++;
      ids.forEach((i) => counts[ids.length - 1][i]++);
    }
  };
  for (let i = 0; i < a.length; i++) {
    visit([i]);
    for (let j = i + 1; j < a.length; j++) {
      visit([i, j]);
      for (let k = j + 1; k < a.length; k++) visit([i, j, k]);
    }
  }
  return { counts, totals };
}
test("400 randomized pools agree with brute force, including duplicate amounts and tolerance edges", () => {
  for (let x = 0; x < 400; x++) {
    const a = Array.from({ length: 1 + Math.floor(rand() * 40) }, () =>
      Math.floor(rand() * 100000),
    ).sort((a, b) => a - b);
    const wei =
      BigInt(Math.floor(rand() * 300000)) * NANO +
      BigInt(Math.floor(rand() * 1e9));
    const fast = countSets(a, wei),
      slow = brute(a, wei);
    assert.deepEqual(fast.totals, slow.totals);
    assert.deepEqual(
      fast.counts.map((x) => Array.from(x)),
      slow.counts,
    );
  }
});
test("amount parsing and fees preserve 18 decimals", () => {
  assert.equal(parseAmount(".000000000000000001"), 1n);
  assert.equal(
    formatWei(afterUnshieldFee(parseAmount("1.234567890123456789"))),
    "1.231481470398148148",
  );
  for (const v of ["", "0", "-1", "1e3", "1,2", "NaN", "1.1234567890123456789"])
    assert.throws(() => parseAmount(v));
});
test("20,000 synthetic exact pairs and triples have no misses", () => {
  const a = Array.from({ length: 32 }, () => Math.floor(rand() * 1e9) + 1).sort(
    (a, b) => a - b,
  );
  for (let x = 0; x < 20000; x++) {
    const ids = new Set();
    while (ids.size < (x % 2 ? 2 : 3)) ids.add(Math.floor(rand() * a.length));
    const target = BigInt([...ids].reduce((s, i) => s + a[i], 0)) * NANO;
    const r = countSets(a, target);
    assert.ok(r.totals[ids.size - 1] > 0);
    for (const i of ids) assert.ok(r.counts[ids.size - 1][i] > 0);
  }
});
const raw = readFileSync("tests/fixtures/pool.bin"),
  manifest = JSON.parse(readFileSync("tests/fixtures/manifest.json")),
  buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
  pool = decode(buffer, manifest);
test("binary format, hash and corruption handling", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), manifest.sha256);
  assert.equal(pool.length, 960);
  const broken = buffer.slice(0);
  new DataView(broken).setUint32(8, 1, true);
  assert.throws(() => decode(broken, manifest));
});
test("fixture match, safer amount and conservative floors", () => {
  const now = manifest.dataTime + 1,
    amount = parseAmount("3.502749352");
  const r = check(pool, amount, "no", "no", "no", now);
  assert.equal(r.band, "Critical");
  assert.ok(r.points.length);
  assert.ok(r.sets.length);
  assert.ok(r.safer);
  assert.ok(check(pool, parseAmount(r.safer), "no", "no", "no", now).score <= 5);
  for (const q of ["yes", "unsure"]) {
    assert.equal(check(pool, amount, q, "no", "no", now).score, 100);
    assert.equal(
      check(pool, parseAmount("0.123456"), "no", q, "no", now).score,
      90,
    );
    assert.equal(
      check(pool, parseAmount("0.123456"), "no", "no", q, now).score,
      90,
    );
  }
  const unchanged = check(pool, parseAmount("0.123456"), "no", "no", "no", now);
  assert.equal(unchanged.score, unchanged.amountScore);
  assert.ok(Number.isInteger(r.crowd) && r.crowd <= r.n);
  console.log("Fixture match:", r.score, "Safer amount:", r.safer);
});
test("match table lists sets that sum to the withdrawal, not lone tiny legs", () => {
  const now = 1_000_000;
  const deposits = [
    { id: 1, amount: 50_000_000, time: now - 10 },
    { id: 2, amount: 19_950_000_000, time: now - 9 },
    { id: 3, amount: 50_000_000, time: now - 8 },
    { id: 4, amount: 19_950_000_000, time: now - 7 },
    { id: 5, amount: 3_500_000_000, time: now - 6 },
    { id: 6, amount: 1_000_000_000, time: now - 5 },
    { id: 7, amount: 3_500_000_000, time: now - 4 },
    { id: 8, amount: 1_000_000_000, time: now - 3 },
  ];
  const twenty = amountScore(deposits, parseAmount("20"));
  assert.equal(twenty.totals[0], 0);
  assert.ok(twenty.totals[1] >= 2);
  assert.ok(twenty.sets.length);
  for (const set of twenty.sets) {
    assert.equal(set.deposits.length, 2);
    const sum = set.deposits.reduce((s, d) => s + d.amount, 0);
    assert.ok(Math.abs(sum - 20_000_000_000) <= 5000);
    assert.ok(set.deposits.some((d) => d.amount === 19_950_000_000));
  }
  const fourFive = amountScore(deposits, parseAmount("4.5"));
  assert.ok(fourFive.sets.length);
  for (const set of fourFive.sets) {
    assert.equal(set.deposits.length, 2);
    const sum = set.deposits.reduce((s, d) => s + d.amount, 0);
    assert.ok(Math.abs(sum - 4_500_000_000) <= 5000);
    const nets = set.deposits.map((d) => d.amount).sort((a, b) => a - b);
    assert.deepEqual(nets, [1_000_000_000, 3_500_000_000]);
  }
  const scoreById = new Map(deposits.map((d) => [d.id, 0.1]));
  const listed = matchSets(
    deposits.slice().sort((a, b) => a.amount - b.amount),
    parseAmount("20"),
    scoreById,
  );
  assert.ok(listed.every((s) => s.deposits.length === 2));
});
test("180-day cutoff and stale empty pools are explicit", () => {
  assert.throws(
    () =>
      check(
        pool,
        parseAmount("1"),
        "no",
        "no",
        "no",
        manifest.dataTime + 181 * 86400,
      ),
    /No deposits/,
  );
});
test("fixture check timing", () => {
  const times = [];
  for (let i = 0; i < 30; i++) {
    const t = performance.now();
    check(
      pool,
      parseAmount(String(0.1 + rand() * 5)),
      "no",
      "no",
      "no",
      manifest.dataTime + 1,
    );
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  console.log(
    "Fixture-pool check p95:",
    times[28].toFixed(1),
    "ms (this computer, not a phone)",
  );
});
