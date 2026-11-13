import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepare, plan, assess, toStored, assetOf } from "@railcheck/core";
import { buildPool, buildPools, memoryStore, CHAINS, STORE_VERSION } from "@railcheck/builder";

import { chain, fixture, hex, wethLogs as logs, USDT, USDC, WETH } from "./fixtures/builder-chain.mjs";

test("builder reads the window, then only new blocks, with sender groups", async () => {
  const c = chain(), store = memoryStore();
  const first = await buildPool({ rpc: c.rpc, store });
  assert.equal(first.deposits.length, 2);
  assert.deepEqual(first.deposits.map((d) => d.group), [0, 0]);
  assert.equal(first.snapshot.block, 26131700 - 64);
  assert.equal(first.snapshot.grouping, "tx-sender");
  assert.equal(first.asset.address, "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");

  c.head = 26131800;
  c.ranges = [];
  const next = await buildPool({ rpc: c.rpc, store });
  assert.deepEqual(c.ranges, [[26131700 - 63, 26131800 - 64]]);
  assert.deepEqual(next.deposits.map((d) => d.group), [0, 0, 1]);
  assert.ok(!JSON.stringify(next).includes("1111"), "no sender addresses in the output");

  const pool = prepare(next.deposits, { now: next.snapshot.time + 1, snapshot: next.snapshot });
  assert.equal(pool.grouped, true);
  const advice = plan(pool, { action: "shield", amount: 10n ** 18n });
  assert.notEqual(advice.assessment.status, "not-checked");
});

test("builder rebuilds after a reorganisation", async () => {
  const c = chain(), store = memoryStore();
  await buildPool({ rpc: c.rpc, store });
  c.fork = "b";
  c.ranges = [];
  const again = await buildPool({ rpc: c.rpc, store });
  assert.ok(c.ranges[0][0] < 26131000, "reads the whole window again");
  assert.equal(again.deposits.length, 2);
});

test("builder refuses an RPC on another chain", async () => {
  const c = chain();
  await assert.rejects(buildPool({ rpc: c.rpc, chain: "sepolia" }), /another chain/);
});

test("builder uses RPC batches, and falls back to single calls", async () => {
  const c = chain();
  let batches = 0;
  c.rpc.batch = async (calls) => {
    batches++;
    return Promise.all(calls.map(([m, p]) => c.rpc(m, p)));
  };
  const built = await buildPool({ rpc: c.rpc });
  assert.equal(batches, 1);
  assert.deepEqual(built.deposits.map((d) => d.group), [0, 0]);

  c.rpc.batch = async () => { throw Error("no batch"); };
  const fallback = await buildPool({ rpc: c.rpc });
  assert.deepEqual(fallback.deposits.map((d) => d.group), [0, 0]);
});

test("builder accepts the integrator's own sender lookup", async () => {
  const c = chain();
  const asked = [];
  const built = await buildPool({
    rpc: c.rpc,
    senders: async (hashes) => (asked.push(...hashes), hashes.map((_, i) => "0x" + String(i).repeat(40))),
  });
  assert.equal(asked.length, 2);
  assert.deepEqual(built.deposits.map((d) => d.group), [0, 1]);
  assert.ok(built.deposits.every((d) => d.kind === "public"));
});

test("builder skips sender lookups for reshields and assigns no group", async () => {
  const { NULLIFIED_TOPIC } = await import("@railcheck/builder/reader");
  const c = chain();
  const publicLog = logs[0];
  const reshieldTx = "0xdd".padEnd(66, "0");
  // Must be within the confirmed window (head − confirmations).
  const reshieldBlock = 26131600;
  c.rpc = async (method, [arg]) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_blockNumber") return hex(c.head);
    if (method === "eth_getBlockByNumber") {
      const n = Number(arg);
      return { timestamp: hex(12 * n), hash: `0x${c.fork}${n}` };
    }
    if (method === "eth_getLogs") {
      const from = Number(arg.fromBlock),
        to = Number(arg.toBlock);
      const events = [
        {
          ...publicLog,
          topics: [NULLIFIED_TOPIC],
          transactionHash: reshieldTx,
          blockNumber: hex(reshieldBlock),
          logIndex: "0x0",
        },
        {
          ...publicLog,
          transactionHash: reshieldTx,
          blockNumber: hex(reshieldBlock),
          logIndex: "0x1",
        },
        publicLog,
      ];
      return events.filter(
        (l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to,
      );
    }
    throw Error(method);
  };
  const asked = [];
  const built = await buildPool({
    rpc: c.rpc,
    senders: async (hashes) => {
      asked.push(...hashes);
      return hashes.map(() => "0x" + "3".repeat(40));
    },
  });
  assert.deepEqual(asked, [publicLog.transactionHash]);
  const reshield = built.deposits.find((d) => d.kind === "reshield");
  const pub = built.deposits.find((d) => d.kind === "public");
  assert.ok(reshield);
  assert.ok(pub);
  assert.equal(reshield.group, 0xffffffff);
  assert.equal(pub.group, 0);
});

test("SDK-4: recorded logs give a reshield with kind, and senders is asked only for the public shield", async () => {
  // The recorded mainnet logs, unchanged: one internal transaction (Nullified + Shield)
  // and one external shield.
  const rpc = async (method, [arg]) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_blockNumber") return hex(26131700);
    if (method === "eth_getBlockByNumber") return { timestamp: hex(12 * Number(arg)), hash: `0xa${Number(arg)}` };
    if (method === "eth_getLogs") {
      const from = Number(arg.fromBlock), to = Number(arg.toBlock);
      return fixture.logs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to);
    }
    throw Error(`unexpected ${method}`);
  };
  const asked = [];
  const senders = async (hashes) => (asked.push(...hashes), hashes.map(() => "0x" + "4".repeat(40)));
  const store = memoryStore();
  const built = await buildPool({ rpc, store, senders });

  assert.deepEqual(asked, [fixture.externalTransaction]);
  assert.deepEqual(built.deposits.map((d) => d.kind).sort(), ["public", "reshield"]);
  const reshield = built.deposits.find((d) => d.kind === "reshield");
  const pub = built.deposits.find((d) => d.kind === "public");
  assert.equal(reshield.amount, Number(toStored(BigInt(fixture.expectedInternalWei))));
  assert.equal(pub.amount, Number(toStored(BigInt(fixture.expectedExternalWei))));
  assert.equal(reshield.group, 0xffffffff);
  assert.equal(pub.group, 0);
  // The stored rows keep the kind, and a reshield has no sender.
  const rows = (await store.get()).rows;
  assert.equal(rows.find((r) => r.kind === "reshield").sender, undefined);
  assert.equal(rows.find((r) => r.kind === "public").sender, "0x" + "4".repeat(40));
});

test("block search finds the first block at a time, with uneven block times", async () => {
  const { blockAtTime } = await import("@railcheck/builder/reader");
  const times = [0];
  for (let n = 1; n <= 50000; n++) times.push(times[n - 1] + 1 + ((n * 7919) % 23));
  const rpc = async (_m, [n]) => ({ timestamp: hex(times[Number(n)]) });
  for (const target of [0, 5, times[777], times[777] + 1, times[49999], times[50000]]) {
    const want = times.findIndex((t) => t >= target);
    assert.equal(await blockAtTime(rpc, target, 50000), want);
  }
});

test("builder stops soon when the RPC refuses every log request", async () => {
  const c = chain();
  const rpc = async (m, p) => {
    if (m === "eth_getLogs") {
      c.ranges.push(p);
      throw Error("rate limit");
    }
    return c.rpc(m, p);
  };
  await assert.rejects(buildPool({ rpc }), /rate limit/);
  assert.ok(c.ranges.length < 60, `${c.ranges.length} log calls`);
});

// The fake chain plus one swap output (Nullified + Shield in one transaction).
async function withReshield() {
  const { NULLIFIED_TOPIC } = await import("@railcheck/builder/reader");
  const c = chain(),
    tx = "0xdd".padEnd(66, "0"),
    block = hex(26131600);
  const extra = [
    { ...logs[0], topics: [NULLIFIED_TOPIC], transactionHash: tx, blockNumber: block, logIndex: "0x0" },
    { ...logs[0], transactionHash: tx, blockNumber: block, logIndex: "0x1" },
  ];
  const inner = c.rpc;
  c.rpc = async (method, params) => {
    if (method !== "eth_getLogs") return inner(method, params);
    const found = await inner(method, params),
      from = Number(params[0].fromBlock),
      to = Number(params[0].toBlock);
    return found.concat(extra.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to));
  };
  return c;
}
const sender = async (hashes) => hashes.map(() => "0x" + "5".repeat(40));

test("builder rebuilds a store of an older version, with the swap outputs of the whole window", async () => {
  const { STORE_VERSION } = await import("@railcheck/builder");
  const c = await withReshield();
  // The shape of the earlier preview: no version, no kind, no swap outputs.
  const head = c.head - 64;
  const old = {
    chainId: 1,
    token: WETH,
    lastBlock: head,
    lastBlockHash: `0x${c.fork}${head}`,
    rows: [{ block: 26131570, time: 12 * 26131570, amountWei: "1000000000000000000", sender: "0x" + "1".repeat(40) }],
  };
  const store = memoryStore(old),
    progress = [];
  c.head += 10;
  const built = await buildPool({ rpc: c.rpc, store, senders: sender, onProgress: (m) => progress.push(m) });
  assert.ok(progress.some((m) => /older version/.test(m)));
  assert.ok(c.ranges[0][0] < 26131000, "reads the whole window again");
  assert.deepEqual(built.deposits.map((d) => d.kind).sort(), ["public", "public", "reshield"]);
  const saved = await store.get();
  assert.equal(saved.version, STORE_VERSION);
  assert.ok(saved.rows.every((r) => r.kind === "public" || r.kind === "reshield"));
  assert.equal(built.snapshot.reshieldHistoryComplete, true);
});

test("builder updates a store of the current version from the next block, and its pool has complete coverage", async () => {
  const c = await withReshield(),
    store = memoryStore();
  const first = await buildPool({ rpc: c.rpc, store, senders: sender });
  assert.equal(first.snapshot.reshieldHistoryComplete, true);
  c.head = 26131800;
  c.ranges = [];
  const progress = [];
  const next = await buildPool({ rpc: c.rpc, store, senders: sender, onProgress: (m) => progress.push(m) });
  assert.deepEqual(c.ranges, [[26131700 - 63, 26131800 - 64]]);
  assert.ok(!progress.some((m) => /Rebuilding/.test(m)));
  assert.deepEqual(next.deposits.map((d) => d.kind).sort(), ["public", "public", "public", "reshield"]);
  assert.equal(next.snapshot.reshieldHistoryComplete, true);
  // After a reorganisation the snapshot still says complete: the window is read again.
  c.fork = "b";
  const again = await buildPool({ rpc: c.rpc, store, senders: sender });
  assert.equal(again.snapshot.reshieldHistoryComplete, true);
  assert.equal(again.deposits.length, next.deposits.length);

  const pool = prepare(next.deposits, { now: next.snapshot.time + 1, snapshot: next.snapshot, asset: next.asset });
  const no = { addressReuse: false, pastTransfer: false, restOfDeposit: false };
  for (const action of ["shield", "unshield"]) {
    const { coverage } = assess(pool, { action, amount: 10n ** 18n, context: no });
    assert.deepEqual(coverage, { state: "complete", missing: [] });
  }
});

test("prepare refuses a snapshot from another chain than the asset", async () => {
  const built = await buildPool({ rpc: chain().rpc });
  const sepolia = { ...built.snapshot, chainId: 11155111 };
  assert.throws(() => prepare(built.deposits, { snapshot: sepolia }), /different chains/);
  assert.equal(prepare(built.deposits, built).asset.chainId, 1);
});

// buildPool's WETH output on main (83023a6), recorded on the same fake chain:
// tests/fixtures/builder-weth-main.json. Other tokens in the logs change nothing.
const recorded = JSON.parse(readFileSync("tests/fixtures/builder-weth-main.json", "utf8"));
test("buildPool WETH output is the same as before stable support", async () => {
  for (const [name, opts] of [["plain", {}], ["mixed", { mixed: true }], ["reshield", { mixed: true, reshield: true }]]) {
    const c = chain(opts),
      store = memoryStore();
    const first = await buildPool({ rpc: c.rpc, store });
    c.head = 26131800;
    const next = await buildPool({ rpc: c.rpc, store });
    assert.equal(JSON.stringify({ first, next }), JSON.stringify(recorded[name]), name);
  }
});

const NO_GROUP = 0xffffffff;
const ALL = ["weth", "usdt", "usdc"];
test("buildPools reads the logs one time for three tokens, with amounts in each asset's pool units", async () => {
  const one = chain();
  await buildPools({ rpc: one.rpc, tokens: ["weth"] });
  const c = chain(),
    store = memoryStore();
  const pools = await buildPools({ rpc: c.rpc, store, tokens: ALL });
  assert.equal(c.ranges.length, one.ranges.length);
  assert.deepEqual(Object.keys(pools), ALL);
  assert.equal(JSON.stringify(pools.weth), JSON.stringify(recorded.plain.first));
  // Base units for the stables, nano-ETH for WETH; groups per pool.
  assert.deepEqual(
    pools.usdt.deposits.map(({ amount, group, kind }) => [amount, group, kind]),
    [[1_234_567_891, 0, "public"], [20_000_000, 1, "public"], [777_777, NO_GROUP, "reshield"]],
  );
  assert.deepEqual(pools.usdc.deposits.map(({ amount, group }) => [amount, group]), [[500_000_001, 0], [100_000_000, 1]]);
  assert.deepEqual(pools.weth.deposits.map(({ amount, group }) => [amount, group]), [[7_539_473, 0], [7_539_473, 0]]);
  assert.deepEqual(pools.usdt.deposits.map((d) => d.id), [0, 1, 2]);
  // Each pool has its own snapshot and the plain asset identity.
  assert.deepEqual(pools.usdt.asset, { chainId: 1, address: USDT, symbol: "USDT", decimals: 6 });
  assert.deepEqual(pools.usdc.snapshot, {
    pool: "ethereum-usdc",
    chainId: 1,
    token: USDC,
    block: 26131636,
    time: 12 * 26131636,
    windowStart: 12 * 26131636 - 180 * 86400,
    grouping: "tx-sender",
    reshieldHistoryComplete: true,
  });
  // Senders: public rows of the requested tokens only, one lookup per transaction.
  // Not the USDT swap output (0xe4) or the shield of another token (0xe5).
  const pad = (tx) => tx.padEnd(66, "0");
  assert.deepEqual(c.asked.sort(), ["0xaa", "0xbb", "0xe1", "0xe2", "0xe3"].map(pad));
  const usdtOnly = chain();
  await buildPools({ rpc: usdtOnly.rpc, tokens: ["usdt"] });
  assert.deepEqual(usdtOnly.asked.sort(), ["0xe1", "0xe3"].map(pad));

  // The store holds the rows of every token, and the next run reads new blocks only.
  const saved = await store.get();
  assert.deepEqual(Object.keys(saved), ["version", "chainId", "tokens", "lastBlock", "lastBlockHash", "rows"]);
  assert.equal(saved.version, STORE_VERSION);
  assert.deepEqual(saved.tokens, [WETH, USDC, USDT].sort());
  assert.deepEqual(saved.rows.map((r) => r.token), [WETH, USDT, USDC, WETH, USDT, USDC, USDT]);
  c.head = 26131800;
  c.ranges = [];
  const next = await buildPools({ rpc: c.rpc, store, tokens: ALL });
  assert.deepEqual(c.ranges, [[26131700 - 63, 26131800 - 64]]);
  assert.deepEqual(next.weth.deposits.map((d) => d.group), [0, 0, 1]);
  assert.deepEqual(next.usdt.deposits.map((d) => d.group), [0, 1, NO_GROUP, 2]);
  assert.deepEqual(next.usdc.deposits.map((d) => d.group), [0, 1, 0]);
  assert.ok(!JSON.stringify(next).match(/0x(1|3|4|6){40}/), "no sender addresses in the output");
});

test("a USDT pool from buildPools survives JSON, and prepare and plan give advice", async () => {
  const { usdt } = await buildPools({ rpc: chain().rpc, tokens: ["usdt"] });
  const sent = JSON.parse(JSON.stringify(usdt));
  const pool = prepare(sent.deposits, { now: sent.snapshot.time + 1, snapshot: sent.snapshot, asset: sent.asset });
  assert.equal(pool.asset.symbol, "USDT");
  assert.equal(pool.scale, 1n);
  const advice = plan(pool, { action: "unshield", amount: 1_234_567_891n, context: { addressReuse: false, pastTransfer: false, restOfDeposit: false } });
  assert.equal(advice.assessment.status, "attention");
  assert.ok(advice.assessment.findings.some((f) => f.code === "amount-stands-out"));
  assert.deepEqual(advice.assessment.asset, sent.asset);
});

test("a changed token set rebuilds the store from the full window", async () => {
  const c = chain(),
    store = memoryStore();
  await buildPool({ rpc: c.rpc, store });
  c.ranges = [];
  const progress = [];
  const pools = await buildPools({ rpc: c.rpc, store, tokens: ["weth", "usdt"], onProgress: (m) => progress.push(m) });
  assert.ok(progress.some((m) => /tokens changed/.test(m)));
  assert.ok(c.ranges[0][0] < 26131000, "reads the whole window again");
  assert.equal(pools.usdt.deposits.length, 3);
  // The same set in another order is not a change.
  c.ranges = [];
  await buildPools({ rpc: c.rpc, store, tokens: ["usdt", "weth"] });
  assert.deepEqual(c.ranges, []);
  // A store of version 2 (one token) is rebuilt too.
  const v2 = memoryStore({ version: 2, chainId: 1, token: WETH, lastBlock: 26131636, lastBlockHash: "0xa26131636", rows: [] });
  progress.length = 0;
  await buildPool({ rpc: c.rpc, store: v2, onProgress: (m) => progress.push(m) });
  assert.ok(progress.some((m) => /older version/.test(m)));
});

test("an unknown token, or a token the chain does not have, throws before any RPC call", async () => {
  let calls = 0;
  const rpc = async () => (calls++, "0x1");
  await assert.rejects(buildPools({ rpc, tokens: ["dai"] }), /Unknown token: dai\. Use weth, usdt, usdc\./);
  await assert.rejects(buildPool({ rpc, token: "usdt", chain: "sepolia" }), /chain sepolia has no usdt pool\. Use weth\./);
  await assert.rejects(buildPools({ rpc, tokens: ["weth", "usdc"], chain: "sepolia" }), /has no usdc pool/);
  await assert.rejects(buildPools({ rpc, tokens: "usdt" }), /list of token ids/);
  await assert.rejects(buildPool({ rpc, chain: "goerli" }), /Unknown chain: goerli/);
  assert.equal(calls, 0);
  assert.deepEqual(Object.keys(CHAINS.sepolia.tokens), ["weth"]);
  assert.deepEqual(Object.keys(CHAINS.mainnet.tokens), ALL);
});

test("a custom chain never labels an unknown token WETH", async () => {
  const { OTHER } = await import("./fixtures/builder-chain.mjs");
  const custom = { pool: "custom", chainId: 1, proxy: CHAINS.mainnet.proxy, confirmations: 64 };
  await assert.rejects(buildPool({ rpc: chain().rpc, chain: { ...custom, token: OTHER } }), /not a known asset\. Pass chain\.asset/);
  // An identity without amount fields is not enough for an unknown token.
  const dai = { chainId: 1, address: OTHER, symbol: "DAI", decimals: 18 };
  await assert.rejects(buildPool({ rpc: chain().rpc, chain: { ...custom, token: OTHER, asset: dai } }), /pool asset DAI has no unitDecimals/);
  // A known token resolves to its asset, in its pool units.
  const usdt = await buildPool({ rpc: chain().rpc, chain: { ...custom, token: USDT.toUpperCase().replace("0X", "0x") } });
  assert.deepEqual(usdt.asset, { chainId: 1, address: USDT, symbol: "USDT", decimals: 6 });
  assert.deepEqual(usdt.deposits.map((d) => d.amount), [1_234_567_891, 20_000_000, 777_777]);
  assert.equal(usdt.snapshot.pool, "custom");
  // A complete asset for an unknown token is used as given.
  const complete = { ...dai, unitDecimals: 9, tolerance: 5000, noMatch: 0.6, saferStep: 10n ** 14n };
  const other = await buildPool({ rpc: chain().rpc, chain: { ...custom, token: OTHER, asset: complete } });
  assert.deepEqual(other.asset, complete);
  assert.deepEqual(other.deposits.map((d) => d.amount), [3_000_000_000]);
  assert.equal(prepare(other.deposits, other).asset.symbol, "DAI");
  // An asset of another token than the chain's is refused.
  await assert.rejects(buildPool({ rpc: chain().rpc, chain: { ...custom, token: OTHER, asset: assetOf({ chainId: 1, address: USDT, symbol: "USDT", decimals: 6 }) } }), /not the chain's token/);
});

test("an RPC behind the store never adds rows twice and never moves the stored block back", async () => {
  const c = chain(),
    store = memoryStore();
  const first = await buildPools({ rpc: c.rpc, store, tokens: ALL });
  // Another node, 50 blocks behind: its confirmed head is before WETH 0xbb and USDT 0xe3.
  c.head = 26131650;
  const behind = await buildPools({ rpc: c.rpc, store, tokens: ALL });
  assert.deepEqual(behind, first);
  assert.equal((await store.get()).lastBlock, 26131636);
  c.head = 26131800;
  c.ranges = [];
  const next = await buildPools({ rpc: c.rpc, store, tokens: ALL });
  assert.deepEqual(c.ranges, [[26131637, 26131736]]);
  assert.deepEqual(next, await buildPools({ rpc: (() => { const f = chain(); f.head = 26131800; return f.rpc; })(), tokens: ALL }));
  assert.equal(next.weth.deposits.length, 3);
  assert.equal(next.usdt.deposits.length, 4);
});
