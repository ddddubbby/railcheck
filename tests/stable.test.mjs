import { test } from "node:test";
import assert from "node:assert/strict";
import {
  prepare,
  score,
  assess,
  plan,
  check,
  parseAmount,
  formatWei,
  assetOf,
  unitOf,
  ASSETS,
  ETH_ASSET,
  USDT_ASSET,
  USDC_ASSET,
  FEES,
  LOW,
} from "../lib/index.mjs";
import { countSets } from "../lib/engine/index.mjs";

const now = 1_800_000_000;
// RAILGUN getFee: the fee is rounded down, on the value of each leg.
const afterFee = (x, bps) => x - (x * BigInt(bps)) / 10000n;
const usd = (s, asset) => parseAmount(s, asset);

test("ASSETS lists WETH, USDT and USDC with complete amount fields", () => {
  assert.deepEqual(ASSETS.map((a) => a.symbol), ["WETH", "USDT", "USDC"]);
  assert.equal(ASSETS[0], ETH_ASSET);
  assert.deepEqual(
    [USDT_ASSET, USDC_ASSET].map(({ chainId, address, decimals, unitDecimals, saferStep }) => [
      chainId, address, decimals, unitDecimals, saferStep,
    ]),
    [
      [1, "0xdac17f958d2ee523a2206206994597c13d831ec7", 6, 6, 10000n],
      [1, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6, 6, 10000n],
    ],
  );
  for (const asset of ASSETS) assert.equal(assetOf(asset), asset);
  for (const asset of [USDT_ASSET, USDC_ASSET]) assert.equal(unitOf(asset), 1n);
});

// VAL-5: realistic shield inputs in base units. Round amounts, odd cents, odd base
// units and a few large ones up to 10,000,000.
function inputs(rand) {
  const round = ["1000", "250.5", "100", "50", "5000", "20000", "10.25", "999.99", "1"];
  const out = [];
  for (let i = 0; i < 64; i++) {
    const r = rand();
    if (i < 3) out.push(BigInt(Math.floor(1_000_000 + rand() * 9_000_000)) * 1_000_000n); // up to 10M, whole tokens
    else if (i === 3) out.push(10_000_000_000_000n); // 10,000,000.00
    else if (r < 0.35) out.push(BigInt(Math.round(Number(round[Math.floor(rand() * round.length)]) * 1e6)));
    else if (r < 0.7) out.push(BigInt(Math.floor(rand() * 5_000_000)) * 10_000n); // odd cents up to 50,000
    else out.push(BigInt(Math.floor(rand() * 2_000_000_000)) + 1n); // any base unit up to 2,000
  }
  return out;
}

for (const asset of [USDT_ASSET, USDC_ASSET]) {
  test(`VAL-5 ${asset.symbol}: synthetic exact sets of 1 to 3 shields at 6 decimals have no misses`, () => {
    let seed = asset.symbol === "USDT" ? 7_016 : 7_017;
    const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const shielded = inputs(rand);
    // The pool amount is the note value after the shield fee, rounded down on-chain.
    const credits = shielded.map((x) => afterFee(x, FEES.shieldBps));
    const deposits = credits.map((c, id) => ({ id, amount: Number(c), time: now - 1000 - id }));
    const pool = prepare(deposits, { now, asset });
    assert.equal(pool.scale, 1n);
    // The engine's shield fee model gives the same pool amounts.
    for (let i = 0; i < shielded.length; i += 7)
      assert.equal(assess(pool, { action: "shield", amount: shielded[i] }).amounts.poolCredit, credits[i]);
    // Every sum of 1 to 3 pool amounts, by set size: the reference for the counts.
    const sums = [new Map(), new Map(), new Map()],
      add = (k, s) => sums[k - 1].set(s, (sums[k - 1].get(s) ?? 0) + 1),
      n = deposits.length;
    for (let i = 0; i < n; i++) {
      add(1, credits[i]);
      for (let j = i + 1; j < n; j++) {
        add(2, credits[i] + credits[j]);
        for (let k = j + 1; k < n; k++) add(3, credits[i] + credits[j] + credits[k]);
      }
    }
    const reference = (wei) => {
      const t = BigInt(pool.eps);
      return sums.map((m) => {
        let c = 0;
        for (let d = -t; d <= t; d++) c += m.get(wei + d) ?? 0;
        return c;
      });
    };
    const sorted = pool.sorted.map((d) => d.amount),
      at = new Map(pool.sorted.map((d, i) => [d.id, i]));
    let sets = 0, misses = 0, negatives = 0, falseMatches = 0, coincident = 0;
    for (let x = 0; x < 20000; x++) {
      const size = 1 + (x % 3),
        ids = new Set();
      while (ids.size < size) ids.add(Math.floor(rand() * n));
      // The unshield of the exact set: the note sum leaves the private balance,
      // before the unshield fee, as the engine expects.
      const unshield = [...ids].reduce((s, i) => s + credits[i], 0n);
      const r = countSets(Float64Array.from(sorted), unshield, pool.eps, pool.scale);
      sets++;
      const found =
        r.totals[size - 1] > 0 && [...ids].every((i) => r.counts[size - 1][at.get(i)] > 0);
      if (!found) misses++;
      assert.deepEqual(r.totals, reference(unshield));
      // It scores as a match, and the recipient gets the note sum less the fee.
      const s = score(pool, unshield);
      if (!(s.matches > 0 && s.score > 0)) misses++;
      if (x % 20 === 0) {
        const a = assess(pool, { action: "unshield", amount: unshield, context: {} });
        assert.equal(a.amounts.recipientAmount, afterFee(unshield, FEES.unshieldBps));
        assert.equal(a.modelScore, s.score);
      }
      // Negative control: just outside the tolerance, and one cent off.
      for (const off of [BigInt(pool.eps) + 1n, -(BigInt(pool.eps) + 1n), 10_000n]) {
        const wei = unshield + off,
          want = reference(wei);
        negatives++;
        const got = countSets(Float64Array.from(sorted), wei, pool.eps, pool.scale);
        assert.deepEqual(got.totals, want);
        // The exact set itself is never counted off the tolerance.
        assert.ok(wei - unshield > BigInt(pool.eps) || unshield - wei > BigInt(pool.eps));
        if (want.every((c) => c === 0)) {
          if (score(pool, wei).matches !== 0) falseMatches++;
        } else coincident++;
      }
    }
    assert.equal(misses, 0);
    assert.equal(falseMatches, 0);
    console.log(
      `VAL-5 ${asset.symbol}: ${sets} exact sets, ${misses} misses; ${negatives} off-tolerance amounts, ` +
        `${falseMatches} false matches (${coincident} equal another set's sum)`,
    );
  });
}

test("6-decimal amounts parse and format with the asset's decimals and symbol", () => {
  assert.equal(usd("1000.5", USDT_ASSET), 1_000_500_000n);
  assert.equal(usd(".000001", USDC_ASSET), 1n);
  assert.equal(usd("10000000", USDC_ASSET), 10_000_000_000_000n);
  assert.throws(() => usd("1.0000001", USDT_ASSET), /Use numbers/);
  assert.throws(() => usd("9000000000.000001", USDC_ASSET), { message: "Enter an amount of 9,000,000,000 USDC or less." });
  assert.equal(usd("9000000000", USDT_ASSET), 9_000_000_000_000_000n);
  assert.equal(formatWei(1_000_500_000n, undefined, USDT_ASSET), "1000.5");
  assert.equal(formatWei(1_234_567n, 2, USDC_ASSET), "1.23");
  assert.equal(formatWei(-1n, undefined, USDC_ASSET), "-0.000001");
  // WETH defaults are unchanged.
  assert.throws(() => parseAmount("9000000.000000000000000001"), { message: "Enter an amount of 9,000,000 ETH or less." });
  assert.equal(formatWei(10n ** 18n + 5n), "1.000000000000000005");
});

test("USDT plan offers round-cent alternatives that score Low", () => {
  const no = { addressReuse: false, pastTransfer: false, restOfDeposit: false };
  let seed = 99;
  const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  // 30 shields of 1000.00 (pool amount 997.50), 60 spread amounts from 700 to 1300,
  // and the user's own odd shield.
  const credits = [
    ...Array(30).fill(afterFee(1_000_000_000n, FEES.shieldBps)),
    ...Array.from({ length: 60 }, () => afterFee(BigInt(Math.floor(700e6 + rand() * 600e6)), FEES.shieldBps)),
    1_234_567_891n,
  ];
  const pool = prepare(
    credits.map((c, id) => ({ id, amount: Number(c), time: now - 1000 - id, group: id < 30 ? id : 100 + id })),
    { now, asset: USDT_ASSET },
  );
  const unshield = plan(pool, { action: "unshield", amount: 1_234_567_891n, constraint: "flexible", context: no });
  assert.equal(unshield.assessment.status, "attention");
  const alt = unshield.alternatives[0].amounts.unshieldAmount;
  assert.equal(alt % USDT_ASSET.saferStep, 0n);
  assert.ok(alt < 1_234_567_891n && alt >= (1_234_567_891n * 70n) / 100n);
  assert.ok(unshield.alternatives[0].score <= LOW);
  assert.deepEqual(unshield.alternatives[0].asset, { chainId: 1, address: USDT_ASSET.address, symbol: "USDT", decimals: 6 });
  // Shield: an odd input near 1000; the alternative is a whole-cent input that lands
  // on the shared 997.50 pool amount.
  const shield = plan(pool, { action: "shield", amount: 1_043_210_000n, constraint: "flexible" });
  assert.equal(shield.assessment.status, "attention");
  assert.equal(shield.alternatives[0].amounts.shieldInput, 1_000_000_000n);
  assert.equal(shield.alternatives[0].amounts.poolCredit, 997_500_000n);
  // check() formats the safer amount in the asset's decimals.
  const r = check(pool.sorted, 1_234_567_891n, "no", "no", "no", now, USDT_ASSET);
  assert.equal(r.safer, formatWei(alt, undefined, USDT_ASSET));
  assert.match(r.safer, /^\d+(\.\d{1,2})?$/);
});
