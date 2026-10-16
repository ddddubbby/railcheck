import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decodeShield,
  foldShieldLogs,
  readDeposits,
  RAILGUN_PROXY,
  WETH,
  SHIELD_TOPIC,
  NULLIFIED_TOPIC,
  makeRpc,
} from "../scripts/lib/reader.mjs";
import { parseCsv, encodePool } from "../scripts/lib/data.mjs";
import { decode } from "../lib/pool/index.mjs";
const fixture = JSON.parse(
  readFileSync("tests/fixtures/ethereum-logs.json", "utf8"),
);
test("recorded Ethereum logs exclude an internal shield transaction", () => {
  const result = foldShieldLogs(fixture.logs);
  assert.equal(result.removedInternal, 1);
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].amountWei, BigInt(fixture.expectedExternalWei));
});
test("duplicate RPC logs cannot double the deposit value", () => {
  const single = foldShieldLogs(fixture.logs),
    duplicate = foldShieldLogs([...fixture.logs, ...fixture.logs]);
  assert.deepEqual(duplicate, single);
});
test("malformed event offsets and missing transaction identifiers fail closed", () => {
  assert.throws(() => decodeShield("0x"));
  const log = fixture.logs.find((l) => l.topics[0] === SHIELD_TOPIC);
  assert.throws(() => foldShieldLogs([{ ...log, transactionHash: undefined }]));
  const words = log.data.slice(2).match(/.{64}/g);
  words[2] = "1".padStart(64, "0");
  assert.throws(() => decodeShield("0x" + words.join("")));
});
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
function event(commitments) {
  return (
    "0x" +
    [
      word(0),
      word(0),
      word(160),
      word(192 + 160 * commitments.length),
      word(224 + 160 * commitments.length),
      word(commitments.length),
      ...commitments.flatMap((c) => [
        word(1),
        word(c.type),
        word(c.address),
        word(0),
        word(c.value),
      ]),
      word(0),
      word(0),
    ].join("")
  );
}
test("reader sums WETH notes and filters other token addresses/types", () => {
  const data = event([
    { type: 0, address: WETH, value: 1n * 10n ** 18n },
    { type: 0, address: WETH, value: 2n * 10n ** 18n },
    { type: 0, address: "0x01", value: 10n ** 18n },
    { type: 1, address: WETH, value: 1n },
  ]);
  const log = {
    address: RAILGUN_PROXY,
    transactionHash: "0x" + "ab".repeat(32),
    blockNumber: "0x1",
    logIndex: "0x0",
    topics: [SHIELD_TOPIC],
    data,
  };
  assert.equal(foldShieldLogs([log]).kept[0].amountWei, 3n * 10n ** 18n);
  assert.equal(
    foldShieldLogs([
      { ...log, topics: [NULLIFIED_TOPIC], logIndex: "0x1" },
      log,
    ]).kept.length,
    0,
  );
});
test("reader splits provider-limited ranges and falls back to block timestamps", async () => {
  const calls = [];
  const log = {
    ...fixture.logs.find(
      (l) => l.transactionHash === fixture.externalTransaction,
    ),
    blockNumber: "0x2",
    logIndex: "0x0",
  };
  delete log.blockTimestamp;
  const rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === "eth_getLogs") {
      const { fromBlock, toBlock } = params[0];
      if (Number(toBlock) - Number(fromBlock) > 1) throw Error("range limit");
      return Number(fromBlock) <= 2 && Number(toBlock) >= 2 ? [log] : [];
    }
    if (method === "eth_getBlockByNumber") return { timestamp: "0x64" };
    throw Error("Unexpected method");
  };
  const result = await readDeposits(rpc, 1, 4);
  assert.equal(result.deposits.length, 1);
  assert.equal(result.deposits[0].time, 100);
  assert.ok(calls.filter((c) => c[0] === "eth_getLogs").length > 1);
});
test("RPC errors never include access keys", async () => {
  const rpc = makeRpc({
    urls: ["https://rpc.invalid/secret-key"],
    retries: 0,
    fetchImpl: async () => {
      throw Error("secret-key");
    },
  });
  await assert.rejects(
    rpc("eth_chainId"),
    (e) =>
      e.message.includes("eth_chainId") && !e.message.includes("secret-key"),
  );
});
test("pool encoding retains dust, preserves exact CSV wei and rejects bad rows", () => {
  const rows = parseCsv(
    "block,time,amount_wei\n1,100,1\n2,101,1000000000000000000\n",
  );
  assert.equal(rows[0].amountWei, 1n);
  const { bytes, manifest } = encodePool(rows, {
    dataTime: 102,
    lastBlock: 2,
    firstBlock: 1,
    lastBlockHash: "0x" + "00".repeat(32),
  });
  const pool = decode(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    manifest,
  );
  assert.equal(pool[0].amount, 0);
  assert.equal(pool[1].amount, 1e9);
  assert.throws(() => parseCsv("block,time,amount_wei\n2,100,1\n1,101,2\n"));
});

test("Unshield decoder counts WETH transactions once, sums outputs and keeps received amount separate from fees", async () => {
  const { foldUnshieldLogs, UNSHIELD_TOPIC } = await import(
    "../scripts/lib/reader.mjs"
  );
  const log = {
    address: RAILGUN_PROXY,
    transactionHash: "0x" + "ab".repeat(32),
    blockNumber: "0x2",
    logIndex: "0x1",
    topics: [UNSHIELD_TOPIC],
    data: "0x" + [1, 0, WETH, 0, 9975, 25].map(word).join(""),
  };
  const next = { ...log, logIndex: "0x2" };
  assert.deepEqual(foldUnshieldLogs([log, next, log]).kept, [
    { block: 2, amountWei: 19950n },
  ]);
  assert.equal(
    foldUnshieldLogs([
      { ...log, data: "0x" + [1, 0, 1, 0, 9975, 25].map(word).join("") },
    ]).kept.length,
    0,
  );
  for (const change of [
    { removed: true },
    { address: WETH },
    { data: "0x" },
    { transactionHash: undefined },
    { topics: [NULLIFIED_TOPIC] },
  ])
    assert.throws(() => foldUnshieldLogs([{ ...log, ...change }]));
});
test("withdrawal reader splits ranges, uses real block timestamps, and rejects out-of-range logs", async () => {
  const { readWithdrawals, UNSHIELD_TOPIC } = await import(
    "../scripts/lib/reader.mjs"
  );
  const log = {
    address: RAILGUN_PROXY,
    transactionHash: "0x" + "aa".repeat(32),
    blockNumber: "0x2",
    logIndex: "0x1",
    topics: [UNSHIELD_TOPIC],
    data: "0x" + [1, 0, WETH, 0, 100, 1].map(word).join(""),
  };
  const rpc = async (method, [p]) => {
    if (method === "eth_getBlockByNumber") return { timestamp: "0x64" };
    assert.deepEqual(p.topics, [[UNSHIELD_TOPIC]]);
    if (Number(p.toBlock) - Number(p.fromBlock) > 1) throw Error("limit");
    return Number(p.fromBlock) <= 2 && Number(p.toBlock) >= 2 ? [log] : [];
  };
  assert.deepEqual(await readWithdrawals(rpc, 1, 4), [
    { block: 2, amountWei: 100n, time: 100 },
  ]);
  await assert.rejects(
    readWithdrawals(async () => [log], 3, 4),
    /outside/,
  );
});
