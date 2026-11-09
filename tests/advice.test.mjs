import { test } from "node:test";
import assert from "node:assert/strict";
import { prepare, assess, plan, parseAmount } from "../lib/index.mjs";
const now = 1_800_000_000;
// 30 deposits each of 1 ETH and 0.8 ETH (0.9975 and 0.798 in the pool),
// spread-out unique deposits, and one rare amount.
const deposits = [
  ...Array.from({ length: 30 }, (_, i) => ({ id: i, amount: 997_500_000, time: now - 1000 - i })),
  ...Array.from({ length: 30 }, (_, i) => ({ id: 50 + i, amount: 798_000_000, time: now - 1500 - i })),
  ...Array.from({ length: 200 }, (_, i) => ({ id: 100 + i, amount: 3_000_000 + i * 7_777_777, time: now - 2000 - i })),
  { id: 999, amount: 1_234_567_890, time: now - 50 },
].sort((a, b) => a.time - b.time);
const pool = prepare(deposits, { now });
const no = { addressReuse: false, pastTransfer: false, restOfDeposit: false };
const eth = parseAmount;
test("unshield: a Low amount with definite answers is clear, and is kept", () => {
  const r = plan(pool, { action: "unshield", amount: eth("0.9975"), constraint: "flexible", context: no });
  assert.equal(r.assessment.status, "clear");
  assert.deepEqual(r.alternatives, []);
});
test("unshield: a flexible amount gets the largest Low alternative; a fixed one gets none", () => {
  const flexible = plan(pool, {
    action: "unshield", amount: eth("1.23456789"), constraint: "flexible", context: no, balance: eth("2"),
  });
  assert.equal(flexible.assessment.status, "attention");
  assert.equal(flexible.alternatives[0].amounts.unshieldAmount, eth("0.9975"));
  assert.equal(flexible.alternatives[0].amounts.recipientAmount, eth("0.99500625"));
  assert.equal(flexible.remainingBalance, eth("2") - eth("1.23456789"));
  assert.ok(flexible.assessment.notes.includes("split-completes-total"));
  const used = plan(pool, {
    action: "unshield", amount: eth("0.9975"), constraint: "flexible", context: no, balance: eth("2"),
  });
  assert.equal(used.remainingBalance, eth("2") - eth("0.9975"));
  const fixed = plan(pool, { action: "unshield", amount: eth("1.23456789"), constraint: "fixed", context: no });
  assert.deepEqual(fixed.alternatives, []);
});
test("unshield: a balance below the amount gives no negative remainder", () => {
  const low = plan(pool, {
    action: "unshield", amount: eth("1.23456789"), context: no, balance: eth("0.5"),
  });
  assert.equal(low.remainingBalance, null);
  assert.ok(low.assessment.notes.includes("balance-below-amount"));
  assert.ok(!low.assessment.notes.includes("split-completes-total"));
  const exact = plan(pool, {
    action: "unshield", amount: eth("1.23456789"), context: no, balance: eth("1.23456789"),
  });
  assert.equal(exact.remainingBalance, 0n);
  assert.ok(!exact.assessment.notes.includes("split-completes-total"));
});
test("unshield: an address link comes first and no amount is offered", () => {
  const r = plan(pool, {
    action: "unshield", amount: eth("0.9975"), constraint: "flexible", context: { ...no, addressReuse: true },
  });
  assert.equal(r.assessment.findings[0].code, "address-link");
  assert.equal(r.assessment.score, 100);
  assert.deepEqual(r.alternatives, []);
});
test("unshield: 'rest of a deposit' applies to the request; a smaller amount is not the rest", () => {
  const r = plan(pool, {
    action: "unshield", amount: eth("0.9975"), constraint: "flexible", context: { ...no, restOfDeposit: true },
  });
  assert.equal(r.assessment.score, 90);
  const alt = r.alternatives[0];
  assert.equal(alt.amounts.unshieldAmount, eth("0.798"));
  assert.equal(alt.status, "clear");
});
test("unshield: 'not sure' is unknown, not no and not a link", () => {
  const r = assess(pool, { action: "unshield", amount: eth("0.9975"), context: { ...no, pastTransfer: undefined } });
  assert.equal(r.status, "incomplete");
  assert.equal(r.score, r.modelScore);
  assert.deepEqual(r.findings.at(-1), { code: "unknown-context", checks: ["pastTransfer"] });
});
test("unshield: a used-up budget says so", () => {
  const r = plan(pool, { action: "unshield", amount: eth("1.23456789"), constraint: "flexible", context: no, budget: 0 });
  assert.deepEqual(r.alternatives, []);
  assert.equal(r.searched.limited, true);
});
test("unshield: the largest eligible Low amount wins, crowded or not", () => {
  const deposits = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: i, amount: 798_000_000, time: now - 1000 - i })),
    ...Array.from({ length: 25 }, (_, i) => ({ id: 100 + i, amount: 901_300_000 + i * 3_100_000, time: now - 2000 - i })),
    { id: 999, amount: 1_000_000_000, time: now - 50 },
  ].sort((a, b) => a.time - b.time);
  const r = plan(prepare(deposits, { now }), { action: "unshield", amount: eth("1"), constraint: "flexible", context: no });
  assert.equal(r.alternatives[0].amounts.unshieldAmount, eth("0.9")); // not the crowded 0.798
});
test("shield: a common amount is clear, judged by its later full withdrawal", () => {
  const r = assess(pool, { action: "shield", amount: eth("1") });
  assert.equal(r.status, "clear");
  assert.equal(r.amounts.poolCredit, eth("0.9975"));
  assert.equal(r.deposits, 30);
  assert.equal(r.senders, null, "this pool has no sender groups");
  assert.ok(r.notes.includes("senders-unknown"));
});
test("shield: a rare amount gets a common amount within 10% only when it can change", () => {
  const flexible = plan(pool, { action: "shield", amount: eth("0.95"), constraint: "flexible" });
  assert.equal(flexible.assessment.status, "attention");
  assert.deepEqual(flexible.alternatives.map((a) => a.amounts.shieldInput), [eth("1")]);
  assert.deepEqual(plan(pool, { action: "shield", amount: eth("0.95") }).alternatives, []);
  // 0.9 ETH: 0.8 and 1 ETH are both more than 10% away.
  assert.deepEqual(plan(pool, { action: "shield", amount: eth("0.9"), constraint: "flexible" }).alternatives, []);
});
test("stale or incomplete pool data gives not-checked", () => {
  const snapshot = { pool: "test", block: 1, time: now - 49 * 3600, windowStart: now - 181 * 86400 };
  const stale = prepare(deposits, { now, snapshot });
  assert.equal(plan(stale, { action: "unshield", amount: eth("1"), context: no }).assessment.status, "not-checked");
  assert.deepEqual(assess(stale, { action: "shield", amount: eth("1") }).findings, [{ code: "stale-data" }]);
  const partial = prepare(deposits, { now, snapshot: { ...snapshot, time: now - 3600, windowStart: now - 90 * 86400 } });
  assert.deepEqual(assess(partial, { action: "shield", amount: eth("1") }).findings, [{ code: "incomplete-window" }]);
});

test("plan gives only the documented statuses", async () => {
  const { STATUS } = await import("../lib/format.mjs");
  assert.deepEqual(STATUS, ["clear", "incomplete", "attention", "not-checked"]);
  const seen = new Set();
  for (const action of ["shield", "unshield"])
    for (const amount of ["0.1", "1", "1.0731", "2.5", "10"])
      for (const context of [{}, { addressReuse: true }, { addressReuse: false, pastTransfer: false, restOfDeposit: false }])
        seen.add(plan(pool, { action, amount: eth(amount), constraint: "flexible", context }).assessment.status);
  for (const status of seen) assert.ok(STATUS.includes(status), status);
});
test("result v2: the three parts follow the answers, and the status keeps v1's rule", () => {
  const known = plan(pool, { action: "unshield", amount: eth("0.9975"), context: no }).assessment;
  assert.equal(known.format, "railcheck.advice/2");
  assert.deepEqual(known.amountExposure, { score: known.modelScore, band: "Low" });
  assert.deepEqual(known.addressLinks, { state: "none-reported", reasons: [], unknown: [] });
  assert.deepEqual(known.coverage, { state: "complete", missing: [] });
  assert.equal(known.status, "clear");
  // A link sets addressLinks to found and the status to attention; the amount part stays Low.
  const reuse = plan(pool, { action: "unshield", amount: eth("0.9975"), context: { ...no, addressReuse: true } }).assessment;
  assert.equal(reuse.addressLinks.state, "found");
  assert.deepEqual(reuse.addressLinks.reasons, ["address-reuse"]);
  assert.equal(reuse.amountExposure.band, "Low");
  assert.equal(reuse.status, "attention");
  // An unknown address answer: links unknown. An unknown rest-of answer: coverage limited.
  const unsureLink = plan(pool, { action: "unshield", amount: eth("0.9975"), context: { ...no, pastTransfer: undefined } }).assessment;
  assert.equal(unsureLink.addressLinks.state, "unknown");
  assert.deepEqual(unsureLink.addressLinks.unknown, ["pastTransfer"]);
  assert.equal(unsureLink.status, "incomplete");
  const unsureRest = plan(pool, { action: "unshield", amount: eth("0.9975"), context: { ...no, restOfDeposit: undefined } }).assessment;
  assert.deepEqual(unsureRest.coverage, { state: "limited", missing: ["rest-of-deposit"] });
  assert.equal(unsureRest.status, "incomplete");
  // A shield has no recipient, so address links do not apply.
  const shield = plan(pool, { action: "shield", amount: eth("1") }).assessment;
  assert.equal(shield.addressLinks.state, "not-applicable");
  assert.equal(shield.coverage.state, "complete");
});
test("result v2: partial swap-output history limits coverage, so a Low result is incomplete, never clear", () => {
  const snapshot = { chainId: 1, time: now - 60, windowStart: now - 180 * 86400, reshieldHistoryComplete: false };
  const partial = prepare(deposits, { now, snapshot });
  const unshield = plan(partial, { action: "unshield", amount: eth("0.9975"), context: no }).assessment;
  assert.deepEqual(unshield.coverage, { state: "limited", missing: ["swap-output-history"] });
  assert.equal(unshield.status, "incomplete");
  const shield = plan(partial, { action: "shield", amount: eth("1") }).assessment;
  assert.equal(shield.status, "incomplete");
  // With complete history the same check is clear again.
  const full = prepare(deposits, { now, snapshot: { ...snapshot, reshieldHistoryComplete: true } });
  assert.equal(plan(full, { action: "unshield", amount: eth("0.9975"), context: no }).assessment.status, "clear");
});
test("result v2: a check that cannot run says why in coverage and scores nothing", () => {
  const stale = prepare(deposits, { now, snapshot: { chainId: 1, time: now - 72 * 3600, windowStart: now - 180 * 86400 } });
  const a = assess(stale, { action: "unshield", amount: eth("1"), context: no });
  assert.equal(a.status, "not-checked");
  assert.equal(a.amountExposure, null);
  assert.deepEqual(a.coverage, { state: "limited", missing: ["stale-data"] });
});
