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
  openRpc,
  rpcCandidates,
  witnessCandidates,
  agreeOnBlock,
  readConfirmedDeposits,
  PUBLIC_RPC_URLS,
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
test("a configured RPC_URL is the only primary endpoint", () => {
  assert.deepEqual(rpcCandidates({ RPC_URL: " https://private.example/key " }), [
    "https://private.example/key",
  ]);
  assert.deepEqual(rpcCandidates({}), PUBLIC_RPC_URLS);
});
test("the witness is a different host than the primary", () => {
  assert.deepEqual(
    witnessCandidates("https://gateway.tenderly.co/public/mainnet", {}),
    ["https://rpc.mevblocker.io"],
  );
  assert.deepEqual(
    witnessCandidates("https://private.example/key", {
      RPC_WITNESS_URL: "https://witness.example/other",
    }),
    [
      "https://witness.example/other",
      "https://gateway.tenderly.co/public/mainnet",
      "https://rpc.mevblocker.io",
    ],
  );
  assert.deepEqual(
    witnessCandidates("https://private.example/key", {
      RPC_WITNESS_URL: "https://private.example/another",
    }),
    PUBLIC_RPC_URLS,
  );
  assert.throws(
    () => witnessCandidates("secret-key is not a url", {}),
    (e) => e.message.includes("HTTP") && !e.message.includes("secret-key"),
  );
});
test("a client does not switch provider after the first answer", async () => {
  const calls = [];
  const rpc = makeRpc({
    urls: ["https://a.example/secret-key", "https://b.example/secret-key"],
    retries: 0,
    fetchImpl: async (url) => {
      calls.push(url);
      if (calls.length === 1)
        return { ok: true, json: async () => ({ result: "0x1" }) };
      throw Error("secret-key");
    },
  });
  assert.equal(await rpc("eth_chainId"), "0x1");
  await assert.rejects(
    rpc("eth_blockNumber"),
    (e) => !e.message.includes("secret-key"),
  );
  assert.ok(calls.every((url) => url.includes("a.example")));
});
test("openRpc stays on the first endpoint that answers", async () => {
  const calls = [];
  const opened = await openRpc({
    urls: ["https://down.example/secret-key", "https://up.example/secret-key"],
    retries: 0,
    fetchImpl: async (url, init) => {
      calls.push(url);
      if (url.includes("down.example")) throw Error("secret-key");
      const { method } = JSON.parse(init.body);
      if (method === "eth_getLogs") throw Error("range limit");
      return { ok: true, json: async () => ({ result: "0x1" }) };
    },
  });
  assert.equal(opened.url, "https://up.example/secret-key");
  const before = calls.length;
  await assert.rejects(opened.rpc("eth_getLogs"), (e) => {
    return e.message.includes("eth_getLogs") && !e.message.includes("secret-key");
  });
  assert.ok(calls.slice(before).every((url) => url.includes("up.example")));
});
test("providers must agree on a block before it is trusted", async () => {
  const block = { hash: "0x" + "ab".repeat(32), timestamp: "0x64" };
  const ok = async () => block;
  const other = async () => ({ ...block, hash: "0x" + "cd".repeat(32) });
  assert.equal((await agreeOnBlock(ok, ok, 10)).hash, block.hash);
  await assert.rejects(agreeOnBlock(ok, other, 10), /disagree/);
});
test("a witness that omits a log rejects the update", async () => {
  const from = Number(fixture.logs[0].blockNumber);
  const to = Number(fixture.logs.at(-1).blockNumber);
  const serve = (logs) => async (method, params) => {
    if (method !== "eth_getLogs") throw Error(method);
    const { fromBlock, toBlock } = params[0];
    return logs.filter((log) => {
      const block = Number(log.blockNumber);
      return block >= Number(fromBlock) && block <= Number(toBlock);
    });
  };
  const agreed = await readConfirmedDeposits(
    serve(fixture.logs),
    serve(fixture.logs),
    from,
    to,
  );
  assert.equal(agreed.deposits.length, 1);
  await assert.rejects(
    readConfirmedDeposits(
      serve(fixture.logs),
      serve(fixture.logs.slice(0, 2)),
      from,
      to,
    ),
    /disagree on blocks/,
  );
  await assert.rejects(
    readConfirmedDeposits(
      serve(fixture.logs),
      async () => {
        throw Error("secret-key");
      },
      from,
      to,
    ),
    (e) => e.message.includes("witness") && !e.message.includes("secret-key"),
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
