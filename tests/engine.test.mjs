import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  countSets,
  patternScore,
  parseAmount,
  formatWei,
  check,
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
  assert.equal(pool.deposits.length, 960);
  assert.equal(pool.withdrawals.length, 600);
  const broken = buffer.slice(0);
  new DataView(broken).setUint32(8, 1, true);
  assert.throws(() => decode(broken, manifest));
});
test("fixture match, safer amount and conservative floors", () => {
  const now = manifest.dataTime + 1,
    amount = parseAmount("3.502749352");
  const r = check(pool, amount, "no", "no", now);
  assert.equal(r.band, "Critical");
  assert.ok(r.points.length);
  assert.ok(r.safer);
  assert.ok(check(pool, parseAmount(r.safer), "no", "no", now).score <= 5);
  for (const q of ["yes", "unsure"]) {
    assert.equal(check(pool, amount, q, "no", now).score, 100);
    assert.equal(check(pool, parseAmount("0.123456"), "no", q, now).score, 90);
  }
  assert.ok(Number.isInteger(r.crowd) && r.crowd <= r.n);
  console.log("Fixture match:", r.score, "Safer amount:", r.safer);
});
test("180-day cutoff and stale empty pools are explicit", () => {
  assert.throws(
    () =>
      check(
        pool,
        parseAmount("1"),
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
const DAY = 86400;
function brutePattern(deposits, withdrawals, wei) {
  let count = 0;
  for (const w of withdrawals)
    for (const d of deposits) {
      const diff = BigInt(d.amount - w.amount) * NANO - wei;
      if (diff >= -5000n * NANO && diff <= 5000n * NANO && d.time < w.time)
        count++;
    }
  return count;
}
test("300 randomized pools agree with a brute-force withdrawal pattern count", () => {
  for (let x = 0; x < 300; x++) {
    const deposits = Array.from({ length: 1 + Math.floor(rand() * 60) }, () => ({
        amount: Math.floor(rand() * 200000),
        time: Math.floor(rand() * 100),
      })).sort((a, b) => a.amount - b.amount),
      withdrawals = Array.from({ length: Math.floor(rand() * 60) }, () => ({
        amount: Math.floor(rand() * 100000),
        time: Math.floor(rand() * 100),
      }));
    const wei =
      BigInt(Math.floor(rand() * 120000)) * NANO +
      BigInt(Math.floor(rand() * 1e9));
    const count = brutePattern(deposits, withdrawals, wei),
      r = patternScore(deposits, withdrawals, wei);
    assert.equal(r.count, count);
    assert.equal(r.score, count ? Math.round(100 / (1 + count)) : 0);
  }
});
function synthetic(extraDeposits = [], extraWithdrawals = []) {
  const now = 1_800_000_000,
    deposits = Array.from({ length: 400 }, (_, i) => ({
      id: i,
      amount: Math.floor(1e8 + rand() * 9e9),
      time: now - Math.floor(rand() * 170 * DAY),
    }));
  return {
    now,
    pool: {
      deposits: [...deposits, ...extraDeposits].sort((a, b) => a.time - b.time),
      withdrawals: extraWithdrawals,
    },
  };
}
test("amount plus 1 recent withdrawal that equals 1 earlier deposit raises the score", () => {
  const { now, pool } = synthetic(
    [{ id: 999, amount: 4371234567, time: 1_800_000_000 - 20 * DAY }],
    [{ id: 0, amount: 1200000000, time: 1_800_000_000 - 5 * DAY }],
  );
  const r = check(pool, parseAmount("3.171234567"), "no", "no", now);
  assert.equal(r.patternCount, 1);
  assert.equal(r.patternScore, 50);
  assert.equal(r.score, Math.max(r.amountScore, 50));
  assert.equal(r.patterns[0].deposit.amount, 4371234567);
  assert.equal(r.patterns[0].withdrawal.amount, 1200000000);
  for (const edge of ["3.171239567", "3.171229567"])
    assert.equal(check(pool, parseAmount(edge), "no", "no", now).patternCount, 1);
  for (const outside of ["3.171239568", "3.171229566"])
    assert.equal(check(pool, parseAmount(outside), "no", "no", now).patternCount, 0);
  assert.equal(check(pool, parseAmount("3.171234567"), "yes", "no", now).score, 100);
});
test("the pattern needs a deposit before the withdrawal and a withdrawal in the last 30 days", () => {
  const deposit = { id: 999, amount: 4371234567, time: 1_800_000_000 - 20 * DAY };
  const cases = [
    [deposit, { amount: 1200000000, time: deposit.time - 1 }],
    [
      { ...deposit, time: 1_800_000_000 - 60 * DAY },
      { amount: 1200000000, time: 1_800_000_000 - 31 * DAY },
    ],
    [deposit, { amount: 1200000000, time: 1_800_000_000 + DAY }],
  ];
  for (const [d, w] of cases) {
    const { now, pool } = synthetic([d], [w]);
    assert.equal(check(pool, parseAmount("3.171234567"), "no", "no", now).patternScore, 0);
  }
});
test("the safer amount also completes no recent withdrawal", () => {
  const now = manifest.dataTime + 1,
    copy = {
      deposits: [
        ...pool.deposits,
        { id: 960, amount: 2718281828, time: now - 20 * DAY },
      ].sort((a, b) => a.time - b.time),
      withdrawals: [
        ...pool.withdrawals,
        { id: 600, amount: 1000100000, time: now - 5 * DAY },
      ],
    };
  const r = check(copy, parseAmount("1.718181828"), "no", "no", now);
  assert.ok(r.patternScore >= 6);
  assert.ok(r.safer);
  const s = check(copy, parseAmount(r.safer), "no", "no", now);
  assert.ok(s.patternScore <= 5 && s.score <= 5);
});
