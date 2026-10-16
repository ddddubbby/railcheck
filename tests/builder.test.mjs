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
