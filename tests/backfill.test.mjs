import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { backfillReshields, backfillInChunks } from "../scripts/lib/backfill.mjs";

const fixture = JSON.parse(readFileSync("tests/fixtures/ethereum-logs.json", "utf8"));
const hex = (n) => `0x${n.toString(16)}`;
// The recorded swap (Nullified + Shield) at block 120, the public shield at 110.
const at = (hash, block) =>
  fixture.logs
    .filter((l) => l.transactionHash === hash)
    .map((l) => ({ ...l, blockNumber: hex(block), blockTimestamp: undefined }));
const logs = [...at(fixture.externalTransaction, 110), ...at(fixture.internalTransaction, 120)];
const swap = { block: 120, time: 1440, amountWei: BigInt(fixture.expectedInternalWei) };
const rpc = async (method, [p]) => {
  if (method === "eth_getBlockByNumber") return { timestamp: hex(12 * Number(p)) };
  const from = Number(p.fromBlock), to = Number(p.toBlock);
  return logs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to);
};

test("backfill keeps reshields only, merges with existing rows and sorts them", async () => {
  const existing = [{ block: 200, time: 2400, amountWei: 5n }];
  const { reshields, added } = await backfillReshields(rpc, { fromBlock: 100, toBlock: 150, existing });
  assert.equal(added, 1);
  assert.deepEqual(reshields, [swap, { block: 200, time: 2400, amountWei: 5n }]);
  // A second run over the same range adds nothing.
  const again = await backfillReshields(rpc, { fromBlock: 100, toBlock: 150, existing: reshields });
  assert.equal(again.added, 0);
  assert.deepEqual(again.reshields, reshields);
});

test("backfill with nothing to read keeps the rows and refuses a missing range", async () => {
  const existing = [{ block: 1, time: 12, amountWei: 1n }];
  const empty = await backfillReshields(rpc, { fromBlock: 10, toBlock: 5, existing });
  assert.deepEqual(empty, { reshields: existing, added: 0 });
  await assert.rejects(backfillReshields(rpc, { fromBlock: undefined, toBlock: 5 }), /block range/);
});

test("chunked backfill reads newest first and saves a contiguous history after each chunk", async () => {
  const saved = [];
  const { reshields, added } = await backfillInChunks(rpc, {
    fromBlock: 100,
    toBlock: 159,
    chunk: 20,
    onChunk: (rows, low) => saved.push([low, rows.length]),
  });
  assert.equal(added, 1);
  assert.deepEqual(reshields, [swap]);
  // Three chunks: 140–159 (nothing), 120–139 (the swap), 100–119 (nothing).
  assert.deepEqual(saved, [[140, 0], [120, 1], [100, 1]]);
  // A resumed run from the saved start adds nothing new.
  const resumed = await backfillInChunks(rpc, { fromBlock: 100, toBlock: 119, existing: reshields, chunk: 20 });
  assert.deepEqual(resumed, { reshields: [swap], added: 0 });
  await assert.rejects(backfillInChunks(rpc, { fromBlock: 1, toBlock: 2, chunk: 0 }), /Chunk size/);
});
