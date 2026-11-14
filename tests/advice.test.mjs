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
  assert.deepEqual(a.addressLinks, { state: "unknown", reasons: [], unknown: [] });
  // A shield has no address-link questions, checked or not.
  const s = assess(stale, { action: "shield", amount: eth("1") });
  assert.equal(s.status, "not-checked");
  assert.deepEqual(s.addressLinks, { state: "not-applicable", reasons: [], unknown: [] });
  assert.deepEqual(s.coverage, { state: "limited", missing: ["stale-data"] });
});
test("notCheckedParts: shield is not-applicable; unshield and the one-argument call stay unknown", async () => {
  const { notCheckedParts } = await import("../lib/index.mjs");
  assert.equal(notCheckedParts("x", "shield").addressLinks.state, "not-applicable");
  assert.equal(notCheckedParts("x", "unshield").addressLinks.state, "unknown");
  assert.deepEqual(notCheckedParts("x"), notCheckedParts("x", "unshield"));
});
// ENG-6: two swap outputs (reshields) of 1.5 ETH, next to the public shields above.
const swapOuts = [0, 1].map((i) => ({ id: 2000 + i, amount: 1_500_000_000, time: now - 60 - i, kind: "reshield" }));
const swapPool = prepare([...deposits, ...swapOuts].sort((a, b) => a.time - b.time), { now });
test("swap gas payer: a public wallet is an address link with a minimum score of 90", async () => {
  const { SWAP_GAS_PAYER_FLOOR } = await import("../lib/index.mjs");
  assert.equal(SWAP_GAS_PAYER_FLOOR, 90);
  const r = plan(pool, {
    action: "unshield", amount: eth("0.9975"), constraint: "flexible", context: { ...no, swapGasPayer: "public-wallet" },
  });
  const a = r.assessment;
  assert.ok(a.modelScore <= 5);
  assert.equal(a.score, 90);
  assert.equal(a.band, "Critical");
  assert.deepEqual(a.findings[0], { code: "address-link", reason: "swap-gas-payer" });
  assert.deepEqual(a.addressLinks, { state: "found", reasons: ["swap-gas-payer"], unknown: [] });
  assert.equal(a.amountExposure.band, "Low");
  assert.equal(a.status, "attention");
  assert.deepEqual(r.alternatives, [], "an address link comes first: no amount is offered");
  // A higher floor stays: address reuse is still 100.
  const both = assess(pool, { action: "unshield", amount: eth("0.9975"), context: { ...no, addressReuse: true, swapGasPayer: "public-wallet" } });
  assert.equal(both.score, 100);
  assert.deepEqual(both.addressLinks.reasons, ["address-reuse", "swap-gas-payer"]);
});
test("swap gas payer: a broadcaster adds nothing", () => {
  for (const [p, amount] of [[pool, "0.9975"], [pool, "1.23456789"], [swapPool, "1.5"]]) {
    const base = assess(p, { action: "unshield", amount: eth(amount), context: { ...no, swapGasPayer: "broadcaster" } });
    const known = assess(p, { action: "unshield", amount: eth(amount), context: no });
    assert.equal(base.score, known.score, amount);
    assert.deepEqual(base.findings, known.findings, amount);
    assert.deepEqual(base.addressLinks, { state: "none-reported", reasons: [], unknown: [] }, amount);
  }
});
test("swap gas payer: unknown is flagged only when swap outputs set the amount score", () => {
  // The 1.5 ETH unshield matches the swap output.
  const swap = assess(swapPool, { action: "unshield", amount: eth("1.5"), context: no });
  assert.ok(swap.modelScore > 5);
  assert.deepEqual(swap.addressLinks, { state: "unknown", reasons: [], unknown: ["swapGasPayer"] });
  assert.equal(swap.status, "attention", "the amount still stands out");
  // v1 fields keep the three questions only.
  assert.deepEqual(swap.unknown, []);
  assert.ok(!swap.findings.some((f) => f.code === "unknown-context"));
  // A public shield match in the same pool, and a Low amount: not flagged.
  for (const amount of ["1.23456789", "0.9975"]) {
    const r = assess(swapPool, { action: "unshield", amount: eth(amount), context: no });
    assert.deepEqual(r.addressLinks, { state: "none-reported", reasons: [], unknown: [] }, amount);
  }
  assert.equal(assess(swapPool, { action: "unshield", amount: eth("0.9975"), context: no }).status, "clear");
  // A pool without swap outputs is never flagged; shields do not apply.
  assert.equal(assess(pool, { action: "unshield", amount: eth("1.23456789"), context: no }).addressLinks.state, "none-reported");
  assert.equal(assess(swapPool, { action: "shield", amount: eth("1.5") }).addressLinks.state, "not-applicable");
  // null (a JSON context) is unknown too, not invalid.
  const fromJSON = assess(swapPool, { action: "unshield", amount: eth("1.5"), context: { ...no, swapGasPayer: null } });
  assert.deepEqual(fromJSON.addressLinks, swap.addressLinks);
  assert.equal(fromJSON.score, swap.score);
  assert.equal(assess(swapPool, { action: "unshield", amount: eth("0.9975"), context: { ...no, swapGasPayer: null } }).status, "clear");
  // A known answer clears the unknown, and does not change the score.
  const known = assess(swapPool, { action: "unshield", amount: eth("1.5"), context: { ...no, swapGasPayer: "broadcaster" } });
  assert.equal(known.addressLinks.state, "none-reported");
  assert.equal(known.score, swap.score);
});
test("swap gas payer: a swap output that raises the score is flagged even when its match set is not the first", async () => {
  const { inspect, score } = await import("../lib/index.mjs");
  // A large public shield pairs with four small rows, one a swap output; two
  // public pairs compete. The swap output adds a pair, so the score rises.
  const rows = [
    [999_800_000], [199_000], [200_000], [201_000], [202_000, "reshield"],
    [400_000_000], [600_000_000], [300_000_000], [700_000_000],
  ].map(([amount, kind], i) => ({ id: i, amount, time: now - 100 - i, ...(kind ? { kind } : {}) }));
  const mixed = prepare(rows.slice().sort((a, b) => a.time - b.time), { now });
  const publicOnly = prepare(rows.filter((d) => !d.kind).sort((a, b) => a.time - b.time), { now });
  const wei = eth("1");
  assert.ok(score(mixed, wei).score > score(publicOnly, wei).score);
  const sets = inspect(mixed, wei).sets;
  assert.ok(!sets[0].deposits.some((d) => d.kind === "reshield"), "the swap-output pair is not first");
  assert.ok(sets.some((s) => s.deposits.some((d) => d.kind === "reshield")));
  const r = assess(mixed, { action: "unshield", amount: wei, context: no });
  assert.deepEqual(r.addressLinks, { state: "unknown", reasons: [], unknown: ["swapGasPayer"] });
  // The public pool alone gives the same check with no flag.
  assert.equal(assess(publicOnly, { action: "unshield", amount: wei, context: no }).addressLinks.state, "none-reported");
});
test("swap gas payer: a Low score is never flagged, even when swap outputs set it", async () => {
  const { score } = await import("../lib/index.mjs");
  // One small row pairs a large public shield with a swap output; 31 public pairs compete.
  const rows = [{ amount: 999_800_000 }, { amount: 199_000 }, { amount: 202_000, kind: "reshield" }];
  for (let i = 0; i < 31; i++) rows.push({ amount: 100_000_000 + i * 10_000_000 }, { amount: 900_000_000 - i * 10_000_000 });
  const deposits = rows.map((r, i) => ({ id: i, time: now - 100 - i, ...r }));
  const mixed = prepare(deposits, { now }),
    publicOnly = prepare(deposits.filter((d) => !d.kind), { now }),
    wei = eth("1");
  const s = score(mixed, wei);
  assert.equal(s.fromSwapOutputs, true);
  assert.ok(s.score > score(publicOnly, wei).score && s.score <= 5);
  const r = assess(mixed, { action: "unshield", amount: wei, context: no });
  assert.deepEqual(r.addressLinks, { state: "none-reported", reasons: [], unknown: [] });
  assert.equal(r.status, "clear");
});
test("swap gas payer: the rest of a swap output has the rest-of-deposit minimum of 90", async () => {
  const { inspect } = await import("../lib/index.mjs");
  // The unshield matches the swap output only.
  assert.deepEqual(inspect(swapPool, eth("1.5")).sets[0].deposits.map((d) => d.kind), ["reshield"]);
  const r = assess(swapPool, { action: "unshield", amount: eth("1.5"), context: { ...no, restOfDeposit: true, swapGasPayer: "broadcaster" } });
  assert.ok(r.modelScore < 90);
  assert.equal(r.score, 90);
  assert.ok(r.findings.some((f) => f.code === "rest-of-deposit"));
});
test("swap gas payer: an invalid value is rejected", () => {
  for (const swapGasPayer of ["unsure", "public", "", false, true, 1, {}])
    for (const action of ["unshield", "shield"])
      assert.throws(
        () => plan(pool, { action, amount: eth("1"), context: { ...no, swapGasPayer } }),
        /Invalid swapGasPayer/,
        String(swapGasPayer),
      );
});
// A null answer is "not sure", as undefined. It is never "no".
test("context: null is unknown, as undefined, never no", () => {
  const amount = eth("0.9975");
  assert.equal(assess(pool, { action: "unshield", amount, context: no }).status, "clear");
  const keep = ({ status, unknown, addressLinks, coverage, findings, score }) =>
    ({ status, unknown, addressLinks, coverage, findings, score });
  for (const q of ["addressReuse", "pastTransfer", "restOfDeposit"]) {
    const withNull = assess(pool, { action: "unshield", amount, context: { ...no, [q]: null } }),
      withUndefined = assess(pool, { action: "unshield", amount, context: { ...no, [q]: undefined } }),
      withNo = assess(pool, { action: "unshield", amount, context: no });
    assert.deepEqual(keep(withNull), keep(withUndefined), q);
    assert.notDeepEqual(keep(withNull), keep(withNo), q);
    assert.equal(withNull.status, "incomplete", q);
    assert.deepEqual(withNull.unknown, [q]);
    const planned = plan(pool, { action: "unshield", amount, constraint: "flexible", context: { ...no, [q]: null } });
    assert.deepEqual(keep(planned.assessment), keep(withUndefined), q);
  }
  const allNull = assess(pool, {
    action: "unshield", amount, context: { addressReuse: null, pastTransfer: null, restOfDeposit: null },
  });
  assert.deepEqual(allNull.unknown, ["addressReuse", "pastTransfer", "restOfDeposit"]);
  assert.equal(allNull.addressLinks.state, "unknown");
  assert.deepEqual(allNull.coverage, { state: "limited", missing: ["rest-of-deposit"] });
});
test("context: answers from getters or a prototype count as in a plain object", () => {
  const plain = { addressReuse: true, pastTransfer: false, restOfDeposit: null, swapGasPayer: "public-wallet" };
  class Answers {
    get addressReuse() { return true; }
    get pastTransfer() { return false; }
    get restOfDeposit() { return null; }
    get swapGasPayer() { return "public-wallet"; }
  }
  const run = (context) => plan(pool, { action: "unshield", amount: eth("0.9975"), constraint: "flexible", context });
  const expected = run(plain);
  assert.equal(expected.assessment.score, 100);
  assert.deepEqual(expected.assessment.addressLinks.reasons, ["address-reuse", "swap-gas-payer"]);
  assert.deepEqual(expected.assessment.unknown, ["restOfDeposit"]);
  for (const context of [new Answers(), Object.create(plain)]) assert.deepEqual(run(context), expected);
});
test("context: an answer that is not true, false, null or undefined is rejected", () => {
  for (const q of ["addressReuse", "pastTransfer", "restOfDeposit"])
    for (const bad of ["no", "yes", "", "false", 0, 1, {}])
      for (const run of [assess, plan])
        for (const action of ["unshield", "shield"])
          assert.throws(
            () => run(pool, { action, amount: eth("0.9975"), context: { ...no, [q]: bad } }),
            { message: `${q} must be true, false, or left out.` },
            `${q} ${JSON.stringify(bad)}`,
          );
});
