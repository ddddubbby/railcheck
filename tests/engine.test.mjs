import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  countSets,
  listMatchingSets,
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
  assert.equal(r.sets[0].size, 1);
  assert.equal(r.sets[0].legs.length, 1);
  assert.ok(r.setCount >= 1);
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
test("matching sets prefer smallest size and show partners", () => {
  const now = 1_800_000_000;
  const deposits = [
    { id: 0, amount: 50_000_000, time: now - 10 }, // 0.05
    { id: 1, amount: 50_000_000, time: now - 20 },
    { id: 2, amount: 19_950_000_000, time: now - 30 }, // 19.95
    { id: 3, amount: 19_950_000_000, time: now - 40 },
    { id: 4, amount: 3_500_000_000, time: now - 50 }, // 3.5
    { id: 5, amount: 1_000_000_000, time: now - 60 }, // 1.0
    { id: 6, amount: 4_500_000_000, time: now - 70 }, // exact 4.5 single
  ];
  const twenty = amountScore(deposits, parseAmount("20"));
  assert.equal(twenty.score, amountScore(deposits, parseAmount("20")).score);
  assert.ok(twenty.totals[0] === 0 && twenty.totals[1] > 0);
  assert.ok(twenty.sets.length >= 1);
  assert.ok(twenty.sets.every((s) => s.size === 2 && s.legs.length === 2));
  assert.ok(
    twenty.sets.every(
      (s) =>
        s.legs[0].amount + s.legs[1].amount >= 19_999_995_000 &&
        s.legs[0].amount + s.legs[1].amount <= 20_000_005_000,
    ),
  );
  assert.ok(twenty.sets[0].legs[0].amount < twenty.sets[0].legs[1].amount);
  assert.ok(twenty.setCount >= twenty.sets.length);

  const split = amountScore(deposits, parseAmount("4.5"));
  assert.ok(split.totals[0] >= 1);
  assert.equal(split.sets[0].size, 1);
  assert.equal(split.sets[0].legs[0].amount, 4_500_000_000);
  assert.ok(split.sets.every((s) => s.size === 1));

  const pairOnly = amountScore(
    deposits.filter((d) => d.amount !== 4_500_000_000),
    parseAmount("4.5"),
  );
  assert.equal(pairOnly.totals[0], 0);
  assert.ok(pairOnly.sets.every((s) => s.size === 2));
  assert.ok(
    pairOnly.sets.some(
      (s) =>
        s.legs.some((l) => l.amount === 3_500_000_000) &&
        s.legs.some((l) => l.amount === 1_000_000_000),
    ),
  );
});
test("listMatchingSets ranks by posterior without changing counts", () => {
  const deposits = [
    { id: 0, amount: 100_000_000, time: 1 },
    { id: 1, amount: 200_000_000, time: 2 },
    { id: 2, amount: 300_000_000, time: 3 },
  ];
  const wei = 300_000_000n * NANO;
  const sorted = deposits.slice().sort((a, b) => a.amount - b.amount);
  const { counts, totals } = countSets(
    sorted.map((d) => d.amount),
    wei,
  );
  assert.deepEqual(totals, [1, 1, 0]);
  const pByIndex = [0.1, 0.2, 0.9];
  const { sets, setCount } = listMatchingSets(
    sorted,
    wei,
    pByIndex,
    counts,
    totals,
    5,
  );
  assert.equal(setCount, 1);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].size, 1);
  assert.equal(sets[0].legs[0].amount, 300_000_000);
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
