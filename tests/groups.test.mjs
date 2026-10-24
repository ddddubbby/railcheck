import { test } from "node:test";
import assert from "node:assert/strict";
import { encodePool } from "../scripts/lib/data.mjs";
import { sendersOf, assignGroups, matchHashes } from "../scripts/lib/groups.mjs";
import { decode, prepare, assess, crowded, parseAmount } from "../lib/index.mjs";
const now = 1_800_000_000;
test("pool file v2 stores one group number per deposit and decodes it", () => {
  const rows = [
    { block: 1, time: 100, amountWei: 10n ** 18n, group: 0 },
    { block: 2, time: 101, amountWei: 2n * 10n ** 18n, group: 1 },
    { block: 3, time: 102, amountWei: 10n ** 18n, group: 0 },
  ];
  const { bytes, manifest } = encodePool(rows, { dataTime: 103, lastBlock: 3, firstBlock: 1, lastBlockHash: "0x" + "0".repeat(64) });
  assert.equal(manifest.version, 2);
  assert.equal(manifest.grouping, "tx-sender");
  assert.equal(manifest.windowStart, 103 - 180 * 86400);
  assert.equal(bytes.length, 16 + 3 * 16);
  const deposits = decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), manifest);
  assert.deepEqual(deposits.map((d) => d.group), [0, 1, 0]);
  // The only address in the manifest is the public WETH token contract. No depositor addresses.
  const { lastBlockHash, token, ...rest } = manifest;
  assert.equal(token, "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
  assert.ok(lastBlockHash && !JSON.stringify(rest).match(/0x[0-9a-f]{40}/i), "no address in the manifest");
});
test("stored rows get their transaction; groups follow each sender's first appearance", () => {
  const fresh = [
    { block: 1, amountWei: 1n, hash: "a" },
    { block: 2, amountWei: 9n, hash: "internal" }, // an internal reshield, not stored
    { block: 2, amountWei: 2n, hash: "b" },
    { block: 3, amountWei: 3n, hash: "c" },
  ];
  const stored = [
    { block: 1, amountWei: 1n },
    { block: 2, amountWei: 2n },
    { block: 3, amountWei: 3n },
  ];
  const hashed = matchHashes(stored, fresh);
  assert.deepEqual(hashed.map((r) => r.hash), ["a", "b", "c"]);
  const from = new Map([["a", "0x1"], ["b", "0x2"], ["c", "0x1"]]);
  assert.deepEqual(assignGroups(hashed, from), [0, 1, 0]);
  assert.throws(() => matchHashes([{ block: 4, amountWei: 4n }], fresh), /do not match/);
});
test("deposits and different transaction senders are counted apart", () => {
  // 30 deposits of 1 ETH (0.9975 in the pool), but from only 5 addresses.
  const deposits = Array.from({ length: 30 }, (_, i) => ({ id: i, amount: 997_500_000, time: now - 100 - i, group: i % 5 })).sort((a, b) => a.time - b.time);
  const pool = prepare(deposits, { now });
  const r = assess(pool, { action: "shield", amount: parseAmount("1") });
  assert.equal(r.deposits, 30);
  assert.equal(r.senders, 5);
  assert.ok(!r.notes.includes("senders-unknown"));
  assert.equal(crowded(pool).length, 0);
});
test("senders come from one batched request per chunk", async () => {
  const sender = "0x" + "ab".repeat(20);
  let requests = 0;
  const fetchImpl = async (_, { body }) => {
    requests++;
    const calls = JSON.parse(body);
    return { json: async () => calls.map((c) => ({ id: c.id, result: { from: sender } })) };
  };
  const from = await sendersOf(["h1", "h2", "h3"], { urls: ["https://rpc.invalid"], rpc: null, fetchImpl, size: 2 });
  assert.equal(requests, 2);
  assert.equal(from.get("h3"), sender);
});
test("pool file v3 marks reshields, gives them no group, and puts public shields first at a tie", () => {
  const hash = "0x" + "0".repeat(64);
  const rows = [
    { block: 1, time: 100, amountWei: 10n ** 18n, group: 0 },
    { block: 1, time: 100, amountWei: 7n * 10n ** 17n, kind: "reshield" },
    { block: 2, time: 101, amountWei: 2n * 10n ** 18n, group: 1 },
  ].reverse();
  const { bytes, manifest } = encodePool(rows, { dataTime: 103, lastBlock: 2, firstBlock: 1, lastBlockHash: hash });
  assert.equal(manifest.version, 3);
  assert.equal(manifest.grouping, "tx-sender");
  assert.deepEqual([manifest.count, manifest.publicCount, manifest.reshieldCount], [3, 2, 1]);
  assert.equal(bytes.length, 16 + 3 * 16 + 3 + 1);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const deposits = decode(buffer, manifest);
  assert.deepEqual(deposits.map((d) => d.kind), ["public", "reshield", "public"]);
  assert.deepEqual(deposits.map((d) => d.group), [0, undefined, 1]);
  // The engine scores public shields only, and still counts their senders.
  const pool = prepare(deposits, { now: 200 });
  assert.equal(pool.amounts.length, 2);
  assert.equal(pool.grouped, true);
  // An unknown kind byte or a size that does not fit the version is refused.
  const broken = new Uint8Array(buffer.slice(0));
  broken[16 + 3 * 16 + 1] = 2;
  assert.throws(() => decode(broken.buffer, manifest), /kind/);
  assert.throws(() => decode(buffer, { ...manifest, version: 2 }), /format/);
});
test("pool file v3 without sender groups (the published pool) decodes with no groups", () => {
  const rows = [
    { block: 1, time: 100, amountWei: 10n ** 18n },
    { block: 2, time: 101, amountWei: 7n * 10n ** 17n, kind: "reshield" },
  ];
  const { bytes, manifest } = encodePool(rows, { dataTime: 103, lastBlock: 2, firstBlock: 1, lastBlockHash: "0x" + "0".repeat(64) });
  assert.equal(manifest.version, 3);
  assert.equal(manifest.grouping, "none");
  const deposits = decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), manifest);
  assert.ok(deposits.every((d) => d.group === undefined));
  assert.equal(prepare(deposits, { now: 200 }).grouped, false);
});
