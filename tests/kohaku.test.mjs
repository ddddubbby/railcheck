import { test } from "node:test";
import assert from "node:assert/strict";
import { prepare, parseAmount } from "@railcheck/core";
import { guard, adviseUnshield } from "@railcheck/kohaku";
const now = 1_800_000_000;
const deposits = [
  ...Array.from({ length: 30 }, (_, i) => ({ id: i, amount: 997_500_000, time: now - 1000 - i })),
  ...Array.from({ length: 200 }, (_, i) => ({ id: 100 + i, amount: 3_000_000 + i * 7_777_777, time: now - 2000 - i })),
  { id: 999, amount: 1_234_567_890, time: now - 50 },
].sort((a, b) => a.time - b.time);
const pool = prepare(deposits, { now });
const eth = (amount) => ({ asset: { __type: "native" }, amount: parseAmount(amount) });
// A stub Kohaku PluginInstance that records every call.
const stub = () => {
  const calls = [];
  return {
    calls,
    instanceId: async () => "0zk-test",
    prepareUnshield: async (a, to) => (calls.push(["unshield", a.amount, to]), { __type: "privateOperation" }),
    prepareUnshieldMulti: async (as) => (calls.push(["multi", as.length]), { __type: "privateOperation" }),
  };
};
test("guard gets advice first, then prepares one time with the accepted amount", async () => {
  const plugin = stub(),
    seen = [];
  const safe = guard(plugin, {
    pool,
    constraint: "flexible",
    getContext: async () => ({ addressReuse: false, pastTransfer: false, restOfDeposit: false }),
    onAdvice: async (advice) => (seen.push(advice), advice.alternatives[0]?.amounts.unshieldAmount ?? null),
  });
  await safe.prepareUnshield(eth("1.23456789"), "0xabc");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].assessment.status, "attention");
  assert.deepEqual(plugin.calls, [["unshield", parseAmount("0.9975"), "0xabc"]]);
  assert.equal(await safe.instanceId(), "0zk-test");
  await safe.prepareUnshieldMulti([eth("1"), eth("2")], "0xabc");
  assert.deepEqual(plugin.calls.at(-1), ["multi", 2]);
});
test("an unsupported asset is not checked and does not block", async () => {
  const other = { asset: { __type: "erc20", contract: "0x0000000000000000000000000000000000000001" }, amount: 5n };
  assert.equal(adviseUnshield(pool, other).assessment.status, "not-checked");
  const plugin = stub();
  await guard(plugin, { pool, onAdvice: async () => null }).prepareUnshield(other, "0xabc");
  assert.deepEqual(plugin.calls, [["unshield", 5n, "0xabc"]]);
});
