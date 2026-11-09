import { test } from "node:test";
import assert from "node:assert/strict";
import { prepare, score, assess, plan, assetOf, ETH_ASSET, AMOUNT_FIELDS } from "../lib/index.mjs";
// ENG-8: a made-up 6-decimal asset. Not a supported asset: it only shows that the
// engine takes its amount constants from the asset, not from ETH literals.
const TEST_USD = {
  chainId: 1,
  address: "0x0000000000000000000000000000000000000006",
  symbol: "TESTUSD",
  decimals: 6,
  unitDecimals: 6, // pool unit = base unit (1e-6)
  tolerance: 5000, // ±0.005
  noMatch: 0.6,
  saferStep: 10000n, // 0.01
};
const now = 1_800_000_000;
const usd = (x) => BigInt(Math.round(x * 1e6));
const at = (amounts) =>
  prepare(
    amounts.map((amount, id) => ({ id, amount, time: now - 1000 - id })),
    { now, asset: TEST_USD },
  );
const no = { addressReuse: false, pastTransfer: false, restOfDeposit: false };
test("6-decimal asset: a match inside the asset's tolerance counts, outside does not", () => {
  const pool = at([100_000_000, 7_123_457, 250_987_654]);
  assert.equal(pool.scale, 1n);
  assert.equal(pool.eps, 5000);
  assert.equal(score(pool, usd(100)).matches, 1);
  assert.equal(score(pool, usd(100.005)).matches, 1);
  assert.equal(score(pool, usd(99.995)).matches, 1);
  assert.equal(score(pool, usd(100.006)).matches, 0);
  assert.ok(score(pool, usd(100)).score > 50);
  // An eps option still takes precedence over the asset.
  const strict = prepare(pool.sorted, { now, asset: TEST_USD, eps: 0 });
  assert.equal(score(strict, usd(100.004)).matches, 0);
  assert.equal(score(strict, usd(100)).matches, 1);
});
test("6-decimal asset: safer unshield and shield amounts follow the asset's step", () => {
  // A rare request and 40 spread deposits just below it: 90% of the request,
  // rounded down to 0.01, is the largest Low amount.
  const spread = Array.from({ length: 40 }, (_, i) => 111_200_000 + i * 300_007);
  const unshield = plan(at([...spread, 123_456_789]), {
    action: "unshield", amount: usd(123.456789), constraint: "flexible", context: no,
  });
  assert.equal(unshield.assessment.status, "attention");
  assert.equal(unshield.alternatives[0].amounts.unshieldAmount, 111_110_000n);
  // Shield: 30 senders at 50.00 in the pool. The input that lands on it is a
  // whole number of 0.01 steps, and lands within the tolerance after the fee.
  const shield = plan(at(Array(30).fill(50_000_000)), {
    action: "shield", amount: usd(52.5), constraint: "flexible",
  });
  assert.equal(shield.assessment.status, "attention");
  const alt = shield.alternatives[0];
  assert.equal(alt.amounts.shieldInput, 50_130_000n);
  assert.equal(alt.amounts.shieldInput % TEST_USD.saferStep, 0n);
  assert.ok(alt.amounts.poolCredit - 50_000_000n <= 5000n);
  // Results name the asset, without its amount constants.
  assert.deepEqual(alt.asset, { chainId: 1, address: TEST_USD.address, symbol: "TESTUSD", decimals: 6 });
});
test("an asset without an amount field is refused; ETH_ASSET has every field", () => {
  for (const field of AMOUNT_FIELDS) {
    const { [field]: _, ...partial } = TEST_USD;
    assert.throws(
      () => prepare([], { now, asset: partial }),
      new RegExp(`pool asset TESTUSD has no ${field}\\.`),
    );
  }
  assert.throws(() => prepare([], { now, asset: { ...TEST_USD, saferStep: 100 } }), /invalid amount field/);
  for (const field of AMOUNT_FIELDS) assert.notEqual(ETH_ASSET[field], undefined);
  assert.equal(assetOf(ETH_ASSET), ETH_ASSET);
  // A WETH asset with identity fields only (as the pool builder returns it) gets the WETH values.
  const { chainId, address, symbol, decimals } = ETH_ASSET;
  const filled = prepare([], { now, asset: { chainId, address, symbol, decimals } }).asset;
  for (const field of AMOUNT_FIELDS) assert.equal(filled[field], ETH_ASSET[field]);
  assert.deepEqual(
    assess(prepare([], { now }), { action: "shield", amount: 10n ** 18n }).asset,
    { chainId, address, symbol, decimals },
  );
});
