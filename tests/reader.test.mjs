import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decodeShield,
  decodeUnshield,
  foldShieldLogs,
  readPool,
  RAILGUN_PROXY,
  WETH,
  SHIELD_TOPIC,
  NULLIFIED_TOPIC,
  UNSHIELD_TOPIC,
  makeRpc,
} from "../scripts/lib/reader.mjs";
import { parseCsv, encodePool, POOL_FILE } from "../scripts/lib/data.mjs";
import { decode } from "../lib/pool/index.mjs";
const fixture = JSON.parse(
    readFileSync("tests/fixtures/ethereum-logs.json", "utf8"),
  ),
  unshields = JSON.parse(
    readFileSync("tests/fixtures/ethereum-unshield-logs.json", "utf8"),
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
  const result = await readPool(rpc, 1, 4);
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
  const { bytes, manifest } = encodePool(rows, [], {
    dataTime: 102,
    lastBlock: 2,
    firstBlock: 1,
    lastBlockHash: "0x" + "00".repeat(32),
  });
  const pool = decode(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    manifest,
  );
  assert.equal(pool.deposits[0].amount, 0);
  assert.equal(pool.deposits[1].amount, 1e9);
  assert.deepEqual(pool.withdrawals, []);
  assert.throws(() => parseCsv("block,time,amount_wei\n2,100,1\n1,101,2\n"));
});
test("recorded Unshield logs keep amount plus fee and drop a shield round trip", () => {
  const result = foldShieldLogs(unshields.logs);
  assert.equal(result.removedRoundTrip, 1);
  assert.equal(result.withdrawals.length, 1);
  assert.equal(
    result.withdrawals[0].amountWei,
    BigInt(unshields.expectedWithdrawalWei),
  );
  assert.deepEqual(Object.keys(result.withdrawals[0]).sort(), [
    "amountWei",
    "block",
  ]);
  const log = unshields.logs.find(
    (l) =>
      l.transactionHash === unshields.withdrawalTransaction &&
      l.topics[0] === UNSHIELD_TOPIC,
  );
  const words = log.data.slice(2).match(/.{64}/g);
  assert.equal(
    decodeUnshield(log.data).value,
    BigInt("0x" + words[4]) + BigInt("0x" + words[5]),
  );
  assert.equal(
    foldShieldLogs([...unshields.logs, ...unshields.logs]).withdrawals.length,
    1,
  );
});
test("Unshield decoding ignores other tokens and rejects malformed data", () => {
  const data = (type, address, amount, fee) =>
    "0x" + [1, type, address, 0, amount, fee].map(word).join("");
  const log = (d, hash) => ({
    address: RAILGUN_PROXY,
    transactionHash: "0x" + hash.repeat(32),
    blockNumber: "0x5",
    logIndex: "0x0",
    topics: [UNSHIELD_TOPIC],
    data: d,
  });
  const folded = foldShieldLogs([
    log(data(0, WETH, 9975n, 25n), "aa"),
    log(data(0, "0x01", 9975n, 25n), "bb"),
    log(data(1, WETH, 9975n, 25n), "cc"),
  ]);
  assert.deepEqual(folded.withdrawals, [{ block: 5, amountWei: 10000n }]);
  assert.throws(() => decodeUnshield("0x" + word(1).repeat(5)));
  assert.throws(() => decodeUnshield(data(3, WETH, 1n, 0n)));
});
test("EXCK v2 stores withdrawals and names the file after its hash", () => {
  const deposits = parseCsv("block,time,amount_wei\n1,100,2000000000000000000\n");
  const withdrawals = parseCsv(
    "block,time,amount_wei\n1,50,1\n2,101,1500000000000000000\n",
    "withdrawal",
  );
  const { bytes, manifest } = encodePool(deposits, withdrawals, {
    dataTime: 200,
    lastBlock: 2,
    firstBlock: 1,
    lastBlockHash: "0x" + "00".repeat(32),
  });
  assert.equal(manifest.version, 2);
  assert.match(manifest.file, POOL_FILE);
  assert.equal(manifest.file.slice(12, 28), manifest.sha256.slice(0, 16));
  const pool = decode(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    manifest,
  );
  assert.deepEqual(
    pool.withdrawals.map((w) => [w.amount, w.time]),
    [
      [0, 50],
      [1.5e9, 101],
    ],
  );
  assert.equal(pool.deposits[0].amount, 2e9);
  assert.throws(() => decode(bytes.buffer.slice(0), { ...manifest, version: 1 }));
  assert.throws(() =>
    decode(bytes.buffer.slice(0), { ...manifest, withdrawalCount: 1 }),
  );
});
