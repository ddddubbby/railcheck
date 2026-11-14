import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepare, parseAmount, decode, ETH_ASSET, USDT_ASSET, USDC_ASSET } from "@railcheck/core";
import { guard, adviseShield, adviseUnshield, poolFor, pickContext, CONTEXT_FIELDS } from "@railcheck/kohaku";
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
  assert.deepEqual(adviseUnshield(pool, other).assessment.coverage, { state: "limited", missing: ["unsupported-asset"] });
  const plugin = stub();
  await guard(plugin, { pool, onAdvice: async () => null }).prepareUnshield(other, "0xabc");
  assert.deepEqual(plugin.calls, [["unshield", 5n, "0xabc"]]);
});

// SDK-1: the four context fields reach the result; a missing one is unknown.
const all = { addressReuse: false, pastTransfer: false, restOfDeposit: false };
const unshieldWith = async (context, amount = "0.9975") => {
  let seen;
  await guard(stub(), {
    pool,
    getContext: async () => context,
    onAdvice: async (advice) => ((seen = advice), null),
  }).prepareUnshield(eth(amount), "0xabc");
  return seen.assessment;
};
test("context: each of the four fields reaches the result", async () => {
  const known = await unshieldWith({ ...all, swapGasPayer: "broadcaster" });
  assert.equal(known.status, "clear");
  assert.deepEqual(known.addressLinks, { state: "none-reported", reasons: [], unknown: [] });

  const reuse = await unshieldWith({ ...all, addressReuse: true });
  assert.equal(reuse.score, 100);
  assert.deepEqual(reuse.addressLinks.reasons, ["address-reuse"]);

  const past = await unshieldWith({ ...all, pastTransfer: true });
  assert.ok(past.score >= 90);
  assert.deepEqual(past.addressLinks.reasons, ["past-transfer"]);

  const rest = await unshieldWith({ ...all, restOfDeposit: true });
  assert.ok(rest.score >= 90);
  assert.ok(rest.findings.some((f) => f.code === "rest-of-deposit"));

  const gas = await unshieldWith({ ...all, swapGasPayer: "public-wallet" });
  assert.ok(gas.score >= 90);
  assert.equal(gas.addressLinks.state, "found");
  assert.deepEqual(gas.addressLinks.reasons, ["swap-gas-payer"]);
});
test("context: a field that is not returned is unknown", async () => {
  const a = await unshieldWith({ addressReuse: false });
  assert.deepEqual(a.unknown, ["pastTransfer", "restOfDeposit"]);
  assert.equal(a.addressLinks.state, "unknown");
  assert.deepEqual(a.addressLinks.unknown, ["pastTransfer"]);
  assert.deepEqual(a.coverage.missing, ["rest-of-deposit"]);
  assert.equal(a.status, "incomplete");
  // undefined or null from getContext is {}: everything unknown, nothing found.
  for (const none of [undefined, null]) {
    const b = await unshieldWith(none);
    assert.deepEqual(b.addressLinks.unknown, ["addressReuse", "pastTransfer"]);
    assert.deepEqual(b.unknown, ["addressReuse", "pastTransfer", "restOfDeposit"]);
  }
});
test("context: extra keys are dropped", async () => {
  assert.deepEqual(CONTEXT_FIELDS, ["addressReuse", "pastTransfer", "restOfDeposit", "swapGasPayer"]);
  assert.deepEqual(pickContext({ addressReuse: true, extra: 1, swapGasPayer: null }), { addressReuse: true, swapGasPayer: null });
  assert.deepEqual(pickContext(null), {});
  // The adapter reads only the four fields; it never lists or spreads the wallet's object.
  const read = [];
  let listed = false;
  const raw = new Proxy({ ...all, extra: "x", balance: 5n }, {
    get: (t, k) => (read.push(k), t[k]),
    ownKeys: (t) => ((listed = true), Reflect.ownKeys(t)),
  });
  const a = await unshieldWith(raw);
  assert.equal(listed, false);
  assert.deepEqual([...new Set(read.filter((k) => typeof k === "string" && k !== "then"))], CONTEXT_FIELDS);
  assert.equal(a.status, "clear");
});

// SDK-2: an unsupported token is not checked and never blocks.
const otherToken = (amount) => ({ asset: { __type: "erc20", contract: "0x0000000000000000000000000000000000000001" }, amount });
test("an unsupported token gives not-checked for shield and unshield, and the plugin gets the original amount", async () => {
  const calls = [];
  const plugin = {
    prepareShield: async (a, to) => (calls.push(["shield", a.amount, to]), { __type: "publicOperation" }),
    prepareUnshield: async (a, to) => (calls.push(["unshield", a.amount, to]), { __type: "privateOperation" }),
  };
  const seen = [];
  const safe = guard(plugin, { pool, getContext: async () => all, onAdvice: async (advice) => (seen.push(advice), null) });
  await safe.prepareShield(otherToken(7n), "0zkabc");
  await safe.prepareUnshield(otherToken(5n), "0xabc");
  assert.deepEqual(calls, [["shield", 7n, "0zkabc"], ["unshield", 5n, "0xabc"]]);
  const [shield, unshield] = seen.map((s) => s.assessment);
  for (const a of [shield, unshield]) {
    assert.equal(a.status, "not-checked");
    assert.equal(a.amountExposure, null);
    assert.deepEqual(a.coverage, { state: "limited", missing: ["unsupported-asset"] });
  }
  assert.deepEqual(shield.addressLinks, { state: "not-applicable", reasons: [], unknown: [] });
  assert.deepEqual(unshield.addressLinks, { state: "unknown", reasons: [], unknown: [] });
  assert.equal(adviseShield(pool, otherToken(7n)).assessment.addressLinks.state, "not-applicable");
});

// SDK-3: result v2, with every v1 field still there.
test("adapter advice is result v2 and keeps the v1 fields", () => {
  const V1 = ["format", "action", "asset", "snapshot", "status", "amounts", "score", "band", "findings", "unknown", "notes"];
  const V2 = ["amountExposure", "addressLinks", "coverage"];
  const unshield = adviseUnshield(pool, eth("1.23456789"), { constraint: "flexible", context: all });
  const shield = adviseShield(pool, eth("0.95"), { constraint: "flexible" });
  for (const advice of [unshield, shield]) {
    assert.equal(advice.format, "railcheck.advice/2");
    assert.ok(advice.alternatives.length > 0, `${advice.action} has an alternative`);
    for (const a of [advice.assessment, ...advice.alternatives]) {
      assert.equal(a.format, "railcheck.advice/2");
      for (const key of [...V1, ...V2]) assert.ok(key in a, `${advice.action}: ${key}`);
      assert.equal(typeof a.score, "number");
      assert.equal(a.amountExposure.score, a.modelScore ?? a.score);
    }
  }
  assert.ok("modelScore" in unshield.assessment);
  assert.ok("remainingBalance" in unshield);
});

// Several pools: one per asset, and each call uses the pool of its asset.
const stable = (asset) =>
  prepare(
    Array.from({ length: 40 }, (_, i) => ({ id: i, amount: 100_000_000 + i * 1_234_567, time: now - 1000 - i })),
    { now, asset },
  );
const usdtPool = stable(USDT_ASSET),
  usdcPool = stable(USDC_ASSET),
  pools = [pool, usdtPool, usdcPool];
const erc20 = (contract, amount) => ({ asset: { __type: "erc20", contract }, amount });
const OTHER = "0x0000000000000000000000000000000000000001";
test("pools: each call gets advice from the pool of its asset", async () => {
  assert.equal(poolFor(pools, { __type: "native" }), pool);
  assert.equal(poolFor(pools, { __type: "erc20", contract: "0x" + ETH_ASSET.address.slice(2).toUpperCase() }), pool);
  assert.equal(poolFor(pools, { __type: "erc20", contract: USDT_ASSET.address }), usdtPool);
  assert.equal(poolFor(pools, { __type: "erc20", contract: USDC_ASSET.address }), usdcPool);
  assert.equal(poolFor(pools, { __type: "erc20", contract: OTHER }), null);
  assert.equal(poolFor(pool, { __type: "native" }), pool);

  const calls = [],
    seen = [];
  const plugin = {
    prepareShield: async (a, to) => (calls.push(["shield", a.amount, to]), { __type: "publicOperation" }),
    prepareUnshield: async (a, to) => (calls.push(["unshield", a.amount, to]), { __type: "privateOperation" }),
  };
  const safe = guard(plugin, { pools, getContext: async () => all, onAdvice: async (advice) => (seen.push(advice), null) });
  await safe.prepareUnshield(eth("1"), "0xabc");
  await safe.prepareUnshield(erc20(ETH_ASSET.address, parseAmount("1")), "0xabc");
  await safe.prepareUnshield(erc20(USDT_ASSET.address, 101_234_567n), "0xabc");
  await safe.prepareShield(erc20(USDC_ASSET.address, 250_000_000n), "0zkabc");
  const other = erc20(OTHER, 9n);
  await safe.prepareUnshield(other, "0xabc");
  await safe.prepareShield(other, "0zkabc");
  // One onAdvice call per prepare, and the plugin gets the original amounts.
  assert.equal(seen.length, 6);
  assert.deepEqual(seen.map((a) => a.assessment.asset?.symbol ?? null), ["WETH", "WETH", "USDT", "USDC", null, null]);
  assert.deepEqual(seen.slice(4).map((a) => a.assessment.status), ["not-checked", "not-checked"]);
  assert.deepEqual(calls.slice(4), [["unshield", 9n, "0xabc"], ["shield", 9n, "0zkabc"]]);
  // A USDT amount that only one deposit of the USDT pool has.
  assert.equal(seen[2].assessment.status, "attention");
  // adviseShield and adviseUnshield take a list too.
  assert.equal(adviseUnshield(pools, erc20(USDC_ASSET.address, 101_234_567n)).assessment.asset.symbol, "USDC");
  assert.equal(adviseShield(pools, eth("0.95")).assessment.asset.symbol, "WETH");
  assert.equal(adviseShield(pools, other).assessment.status, "not-checked");
});
test("pools: pool and pools together, or two pools of one asset, throw when the guard is made", () => {
  const onAdvice = async () => null;
  assert.throws(() => guard(stub(), { pool, pools, onAdvice }), /pool or pools, not both/);
  assert.throws(() => guard(stub(), { pools: [usdtPool, stable(USDT_ASSET)], onAdvice }), /Two pools cover the same asset \(USDT\)/);
  // A Sepolia WETH pool also covers native ETH.
  const sepolia = prepare([], {
    now,
    asset: { chainId: 11155111, address: "0xfff9976782d46cc05630d1f6ebab18b2324d6b14", symbol: "WETH", decimals: 18 },
  });
  assert.throws(() => guard(stub(), { pools: [pool, sepolia], onAdvice }), /same asset \(WETH\)/);
  assert.throws(() => guard(stub(), { pools: [], onAdvice }), /prepared pool/);
  assert.throws(() => guard(stub(), { onAdvice }), /prepared pool/);
  assert.throws(() => adviseShield([usdtPool, usdtPool], eth("1")), /same asset/);
});
test("balance: a function gets the asset amount of each unshield", async () => {
  const asked = [],
    seen = [];
  const safe = guard(stub(), {
    pools,
    balance: async (assetAmount) => (asked.push(assetAmount), assetAmount.asset.__type === "native" ? parseAmount("5") : null),
    onAdvice: async (advice) => (seen.push(advice), null),
  });
  const usdt = erc20(USDT_ASSET.address, 101_234_567n);
  await safe.prepareUnshield(eth("1"), "0xabc");
  await safe.prepareUnshield(usdt, "0xabc");
  assert.deepEqual(asked, [eth("1"), usdt]);
  assert.deepEqual(seen.map((a) => a.remainingBalance), [parseAmount("4"), null]);
  // A bigint balance works as before.
  let advice;
  await guard(stub(), { pool, balance: parseAmount("3"), onAdvice: async (a) => ((advice = a), null) }).prepareUnshield(eth("1"), "0xabc");
  assert.equal(advice.remainingBalance, parseAmount("2"));
});
test("end to end: the published USDT and USDC pools, prepared from their identity, give advice through guard", async () => {
  const manifest = JSON.parse(readFileSync("public/data/manifest.json", "utf8"));
  const load = (entry, asset) => {
    const bytes = readFileSync(`public/data/${entry.file}`);
    const deposits = decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), entry);
    const snapshot = { pool: entry.pool, chainId: entry.chainId, token: entry.token, block: entry.lastBlock, time: entry.dataTime };
    const { chainId, address, symbol, decimals } = asset;
    return prepare(deposits, { now: entry.dataTime + 1, snapshot, asset: { chainId, address, symbol, decimals } });
  };
  const real = [load(manifest, ETH_ASSET), load(manifest.pools.usdt, USDT_ASSET), load(manifest.pools.usdc, USDC_ASSET)];
  assert.equal(real[1].asset.saferStep, 10000n);
  assert.equal(real[2].asset.tolerance, 0);
  const seen = [];
  const safe = guard(stub(), {
    pools: real,
    constraint: "flexible",
    getContext: async () => all,
    onAdvice: async (advice) => (seen.push(advice), null),
  });
  await safe.prepareUnshield(eth("1.234567"), "0xabc");
  await safe.prepareUnshield(erc20(USDT_ASSET.address, parseAmount("1234.567891", USDT_ASSET)), "0xabc");
  await safe.prepareUnshield(erc20(USDC_ASSET.address, parseAmount("100", USDC_ASSET)), "0xabc");
  assert.deepEqual(seen.map((a) => a.assessment.asset.symbol), ["WETH", "USDT", "USDC"]);
  for (const advice of seen) {
    assert.notEqual(advice.assessment.status, "not-checked");
    assert.equal(typeof advice.assessment.score, "number");
    for (const alt of advice.alternatives) assert.equal(alt.band, "Low");
  }
});
test("context: null from getContext is unknown, never no; a bad value throws", async () => {
  const unsure = await unshieldWith({ addressReuse: null });
  assert.equal(unsure.status, "incomplete");
  assert.deepEqual(unsure.unknown, ["addressReuse", "pastTransfer", "restOfDeposit"]);
  assert.deepEqual(unsure.addressLinks.unknown, ["addressReuse", "pastTransfer"]);
  const one = await unshieldWith({ ...all, addressReuse: null });
  assert.equal(one.status, "incomplete");
  assert.deepEqual(one.unknown, ["addressReuse"]);
  assert.equal(one.addressLinks.state, "unknown");
  assert.equal((await unshieldWith(all)).status, "clear");
  for (const bad of ["no", 0, 1])
    await assert.rejects(unshieldWith({ ...all, restOfDeposit: bad }), /restOfDeposit must be true, false, or left out\./);
});
