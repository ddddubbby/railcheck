// A synthetic Ethereum mainnet for the daily-update tests: 12-second blocks,
// RAILGUN Shield, Nullified and Unshield logs of WETH, USDT and USDC, and a
// JSON-RPC handler that answers like a node. No network.
import {
  RAILGUN_PROXY,
  WETH,
  SHIELD_TOPIC,
  NULLIFIED_TOPIC,
  UNSHIELD_TOPIC,
} from "../../packages/builder/reader.mjs";

export const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
export const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const OTHER = "0x6b175474e89094c44da98b954eedeac495271d0f";
const hex = (n) => `0x${n.toString(16)}`;
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const RECIPIENT = "0x" + "be".repeat(20);

export const BASE_BLOCK = 26_000_000;
export const BASE_TIME = 1_790_000_000;
export const timeOf = (n) => BASE_TIME + 12 * (n - BASE_BLOCK);
export const hashOf = (n, fork = 0) => "0x" + word(BigInt(n) * 1000n + BigInt(fork));
// Raw heads (before the 64 confirmations) of two daily runs, one day apart.
export const HEAD1 = BASE_BLOCK + 64;
export const HEAD2 = HEAD1 + 7200;
export const nowOf = (rawHead) => (timeOf(rawHead - 64) + 800) * 1000;

function shield(hash, block, notes, index = 0) {
  return {
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
        ...notes.flatMap(([address, value]) => [word(1), word(0), word(address), word(0), word(value)]),
        word(0), word(0),
      ].join(""),
  };
}
const nullified = (hash, block, index) => ({
  address: RAILGUN_PROXY,
  transactionHash: hash,
  blockNumber: hex(block),
  logIndex: hex(index),
  topics: [NULLIFIED_TOPIC],
  data: "0x" + word(0) + word(64) + word(0),
});
const unshield = (hash, block, token, amount, index = 0) => ({
  address: RAILGUN_PROXY,
  transactionHash: hash,
  blockNumber: hex(block),
  logIndex: hex(index),
  topics: [UNSHIELD_TOPIC],
  data: "0x" + [RECIPIENT, 0, token, 0, amount, 1].map(word).join(""),
});

// Deterministic logs from before the 180-day window up to the second head.
export function makeLogs() {
  let seed = 7;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const weth = () => 10n ** 15n * BigInt(1 + Math.floor(random() * 3000)) + BigInt(Math.floor(random() * 1e9));
  const usd = () => 10n ** 6n * BigInt(1 + Math.floor(random() * 20000)) + BigInt(Math.floor(random() * 1e6));
  const logs = [];
  let n = 0;
  const tx = () => "0x" + word(++n).replace(/^0/, "a");
  for (let block = 24_600_000, i = 0; block <= HEAD2 - 64; block += block < BASE_BLOCK ? 6917 : 613, i++) {
    const h = tx();
    switch (i % 10) {
      case 0: logs.push(shield(h, block, [[WETH, weth()]])); break;
      case 1: logs.push(shield(h, block, [[WETH, weth()], [WETH, weth()]])); break; // multi-note WETH
      case 2: logs.push(shield(h, block, [[USDT, usd()]])); break;
      case 3: logs.push(shield(h, block, [[USDT, usd()], [USDT, usd()], [OTHER, 5n]])); break; // multi-note USDT
      case 4: logs.push(shield(h, block, [[USDC, usd()]])); break;
      case 5: logs.push(shield(h, block, [[WETH, weth()], [USDC, usd()]])); break; // one note each
      case 6: logs.push(nullified(h, block, 0), shield(h, block, [[WETH, weth()]], 1)); break; // swap to WETH
      case 7: logs.push(nullified(h, block, 0), shield(h, block, [[USDT, usd()], [USDT, usd()]], 1)); break;
      case 8: logs.push(shield(h, block, [[USDC, usd()], [USDC, usd()]])); break; // multi-note USDC
      case 9: logs.push(nullified(h, block, 0), shield(h, block, [[USDC, usd()]], 1)); break;
    }
  }
  // Unshields in the four days before the second head, for the activity snapshots.
  for (let block = HEAD2 - 64 - 4 * 7200, i = 0; block <= HEAD2 - 64; block += 331, i++) {
    const token = [WETH, USDT, USDC, OTHER][i % 4];
    logs.push(unshield(tx(), block, token, token === WETH ? weth() : usd()));
  }
  return logs;
}

// A JSON-RPC handler for one head. `calls` records every request.
export function makeChain({ rawHead, logs = makeLogs(), fork = () => 0, calls = [] }) {
  return async function rpc(method, params = []) {
    calls.push([method, params]);
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_blockNumber") return hex(rawHead);
    if (method === "eth_getBlockByNumber") {
      const n = Number(params[0]);
      if (n > rawHead) return null;
      return { number: hex(n), timestamp: hex(timeOf(n)), hash: hashOf(n, fork(n)) };
    }
    if (method === "eth_getLogs") {
      const [p] = params;
      const from = Number(p.fromBlock), to = Number(p.toBlock);
      return logs.filter(
        (l) =>
          l.address === p.address &&
          p.topics[0].includes(l.topics[0]) &&
          Number(l.blockNumber) >= from &&
          Number(l.blockNumber) <= to,
      );
    }
    throw Error(`Unexpected RPC method ${method}`);
  };
}

// The same chain behind fetch, for scripts that build their own RPC client.
export function makeFetch(rpc) {
  return async (_url, { body }) => {
    const request = JSON.parse(body);
    const one = async ({ id, method, params }) => ({ jsonrpc: "2.0", id, result: await rpc(method, params) });
    const result = Array.isArray(request) ? await Promise.all(request.map(one)) : await one(request);
    return { ok: true, json: async () => result };
  };
}
