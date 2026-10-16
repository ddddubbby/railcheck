import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepare, plan } from "@railcheck/core";
import { buildPool, memoryStore } from "@railcheck/builder";

const fixture = JSON.parse(readFileSync("tests/fixtures/ethereum-logs.json", "utf8"));
const hex = (n) => `0x${n.toString(16)}`;
// The external shield, copied into three transactions: two from one sender.
const base = fixture.logs[2];
const logs = [
  [26131570, "0xaa", "0x" + "1".repeat(40)],
  [26131600, "0xbb", "0x" + "1".repeat(40)],
  [26131700, "0xcc", "0x" + "2".repeat(40)],
].map(([block, tx, from]) => ({
  ...base,
  blockNumber: hex(block),
  blockTimestamp: undefined,
  transactionHash: tx.padEnd(66, "0"),
  from,
}));

// A fake chain: block n has time 12n. `fork` changes every block hash.
function chain() {
  const c = { head: 26131700, fork: "a", ranges: [] };
  c.rpc = async (method, [arg]) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_blockNumber") return hex(c.head);
    if (method === "eth_getBlockByNumber") {
      const n = Number(arg);
      return { timestamp: hex(12 * n), hash: `0x${c.fork}${n}` };
    }
    if (method === "eth_getLogs") {
      const from = Number(arg.fromBlock), to = Number(arg.toBlock);
      c.ranges.push([from, to]);
      return logs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to);
    }
    if (method === "eth_getTransactionByHash")
      return { from: logs.find((l) => l.transactionHash === arg).from };
    throw Error(method);
  };
  return c;
}

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
