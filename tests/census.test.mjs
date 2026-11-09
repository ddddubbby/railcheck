import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { censusOfRange, censusInChunks, addToTotals } from "../scripts/lib/census.mjs";
import { RAILGUN_PROXY, WETH, SHIELD_TOPIC, NULLIFIED_TOPIC, UNSHIELD_TOPIC } from "../scripts/lib/reader.mjs";

const fixture = JSON.parse(readFileSync("tests/fixtures/ethereum-logs.json", "utf8"));
const hex = (n) => `0x${n.toString(16)}`;
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const RECIPIENT = "0x" + "be".repeat(20);
// The recorded public WETH shield at block 110 and the recorded swap at 120.
const at = (hash, block) =>
  fixture.logs
    .filter((l) => l.transactionHash === hash)
    .map((l) => ({ ...l, blockNumber: hex(block), blockTimestamp: undefined }));
const shield = (hash, block, notes, index = 0) => ({
  address: RAILGUN_PROXY,
  transactionHash: hash,
  blockNumber: hex(block),
  logIndex: hex(index),
  topics: [SHIELD_TOPIC],
  data:
    "0x" +
    [
      word(0), word(0), word(160),
      word(192 + 160 * notes.length), word(224 + 160 * notes.length),
      word(notes.length),
      ...notes.flatMap(([address, value, type = 0]) => [word(1), word(type), word(address), word(0), word(value)]),
      word(0), word(0),
    ].join(""),
});
const unshield = (hash, block, token, amount, index = 0) => ({
  address: RAILGUN_PROXY,
  transactionHash: hash,
  blockNumber: hex(block),
  logIndex: hex(index),
  topics: [UNSHIELD_TOPIC],
  data: "0x" + [RECIPIENT, 0, token, 0, amount, 1].map(word).join(""),
});
const tx = (n) => "0x" + n.repeat(64);
const logs = [
  ...at(fixture.externalTransaction, 110),
  ...at(fixture.internalTransaction, 120),
  // One public shield of two tokens: one WETH row and one USDC row (notes summed).
  shield(tx("1"), 130, [[USDC, 5], [USDC, 7], [WETH, 3], [USDC, 9, 1]]),
  // A swap into USDC: two reshield notes.
  { ...shield(tx("2"), 140, [[USDC, 11], [USDC, 13]], 1), topics: [SHIELD_TOPIC] },
  { ...shield(tx("2"), 140, [], 0), topics: [NULLIFIED_TOPIC] },
  unshield(tx("3"), 150, USDC, 20),
  unshield(tx("3"), 150, USDC, 30, 1),
  unshield(tx("4"), 155, WETH, 40),
];
const rpc = async (method, [p]) => {
  if (method === "eth_getBlockByNumber") return { timestamp: hex(12 * Number(p)) };
  const from = Number(p.fromBlock), to = Number(p.toBlock);
  return logs.filter(
    (l) => p.topics[0].includes(l.topics[0]) && Number(l.blockNumber) >= from && Number(l.blockNumber) <= to,
  );
};
const ext = BigInt(fixture.expectedExternalWei), int = BigInt(fixture.expectedInternalWei);
const expected = {
  [USDC]: {
    public: { count: 1, valueWei: "12" },
    reshield: { count: 2, valueWei: "24" },
    unshield: { count: 1, valueWei: "50" },
  },
  [WETH]: {
    public: { count: 2, valueWei: String(ext + 3n) },
    reshield: { count: 1, valueWei: String(int) },
    unshield: { count: 1, valueWei: "40" },
  },
};

test("census splits every token into public shields, reshields and unshields with summed values", async () => {
  assert.deepEqual(await censusOfRange(rpc, 100, 159), expected);
  assert.deepEqual(await censusOfRange(rpc, 10, 5), {});
  await assert.rejects(censusOfRange(rpc, undefined, 5), /block range/);
  assert.throws(() => addToTotals({}, [{ token: "0x01", kind: "public", amountWei: 1n }]), /Invalid census row/);
});

test("chunked census reads newest first, saves after each chunk and resumes without counting twice", async () => {
  const saved = [];
  const full = await censusInChunks(rpc, {
    fromBlock: 100,
    toBlock: 159,
    chunk: 20,
    onChunk: (tokens, low) => saved.push([low, structuredClone(tokens)]),
  });
  assert.deepEqual(full, expected);
  assert.deepEqual(saved.map(([low]) => low), [140, 120, 100]);
  // Stop after the first chunk, then resume from what was saved.
  const [low, tokens] = saved[0];
  assert.deepEqual(Object.keys(tokens[USDC]).map((k) => tokens[USDC][k].count), [0, 2, 1]);
  const resumed = await censusInChunks(rpc, {
    fromBlock: 100,
    toBlock: 159,
    chunk: 20,
    existing: { tokens, readFromBlock: low },
  });
  assert.deepEqual(resumed, expected);
  // A finished census resumed again reads nothing and adds nothing.
  const done = await censusInChunks(rpc, { fromBlock: 100, toBlock: 159, existing: { tokens: full, readFromBlock: 100 } });
  assert.deepEqual(done, expected);
  await assert.rejects(censusInChunks(rpc, { fromBlock: 1, toBlock: 2, chunk: 0 }), /Chunk size/);
});

test("census output holds token contract addresses only, no hashes or recipients", async () => {
  const json = JSON.stringify(await censusInChunks(rpc, { fromBlock: 100, toBlock: 159, chunk: 7 }));
  assert.deepEqual(json.match(/0x[a-f0-9]{40,}/gi).sort(), [USDC, WETH]);
  assert.ok(!json.includes(RECIPIENT.slice(2)));
  for (const hash of [fixture.externalTransaction, fixture.internalTransaction, tx("1"), tx("3")])
    assert.ok(!json.includes(hash.slice(2)));
});
