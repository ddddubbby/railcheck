// Builds a railcheck pool from the wallet's own RPC. The first run reads the
// 180-day window; later runs read only new blocks. Sender addresses stay in the
// wallet's store: the returned deposits hold group numbers only.
import { toStored } from "@railcheck/core";
import { makeRpc, blockAtTime, readDeposits, CONFIRMATIONS } from "./reader.mjs";

export { makeRpc } from "./reader.mjs";

export const CHAINS = {
  mainnet: {
    pool: "ethereum-weth",
    chainId: 1,
    proxy: "0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9",
    token: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    confirmations: CONFIRMATIONS,
  },
  sepolia: {
    pool: "sepolia-weth",
    chainId: 11155111,
    proxy: "0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea",
    token: "0xfff9976782d46cc05630d1f6ebab18b2324d6b14",
    confirmations: CONFIRMATIONS,
  },
};

const WINDOW = 180 * 86400;
const hex = (n) => `0x${n.toString(16)}`;

/** A store that keeps the state in memory. Wallets pass their own { get, set }. */
export function memoryStore(state = null) {
  return { get: async () => state, set: async (next) => void (state = next) };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The default sender lookup: eth_getTransactionByHash, in JSON-RPC batches when the
 * RPC supports them (`rpc.batch`), else single calls. A failed batch falls back to
 * single calls. Returns one lowercase address per hash, in order.
 */
export function rpcSenders(rpc, { batchSize = 100, concurrency = 4 } = {}) {
  const one = async (hash) => {
    const tx = await rpc("eth_getTransactionByHash", [hash]);
    if (!ADDRESS.test(tx?.from || "")) throw Error("Missing transaction sender.");
    return tx.from.toLowerCase();
  };
  const chunk = async (hashes) => {
    if (rpc.batch && batchSize > 1)
      try {
        const txs = await rpc.batch(hashes.map((h) => ["eth_getTransactionByHash", [h]]));
        if (txs.every((tx) => ADDRESS.test(tx?.from || "")))
          return txs.map((tx) => tx.from.toLowerCase());
      } catch {
        // Fall back to single calls.
      }
    const out = [];
    for (let i = 0; i < hashes.length; i += 8)
      out.push(...(await Promise.all(hashes.slice(i, i + 8).map(one))));
    return out;
  };
  return async (hashes) => {
    const size = Math.max(1, batchSize),
      chunks = [];
    for (let i = 0; i < hashes.length; i += size) chunks.push(hashes.slice(i, i + size));
    const results = [];
    for (let i = 0; i < chunks.length; i += concurrency)
      results.push(...(await Promise.all(chunks.slice(i, i + concurrency).map(chunk))));
    return results.flat();
  };
}

/**
 * Updates the stored pool and returns { deposits, snapshot, asset } for core `prepare`.
 * `rpc` is a function (method, params) => result, or pass `urls` instead.
 * Tuning: `concurrency` (parallel log ranges and sender batches), `rangeSize`
 * (first eth_getLogs block range; it shrinks if the RPC refuses it), `batchSize`
 * (senders per JSON-RPC batch; 1 means single calls), or your own
 * `senders(hashes) => addresses` (for example, from an indexer).
 */
export async function buildPool({
  chain = "mainnet",
  rpc,
  urls,
  store = memoryStore(),
  onProgress = () => {},
  concurrency = 4,
  batchSize = 100,
  rangeSize = 200000,
  senders,
}) {
  const c = typeof chain === "string" ? CHAINS[chain] : chain;
  if (!c) throw Error(`Unknown chain: ${chain}.`);
  rpc ??= makeRpc({ urls });
  senders ??= rpcSenders(rpc, { batchSize, concurrency });
  const chainId = Number(await rpc("eth_chainId", []));
  if (chainId !== c.chainId) throw Error("The RPC serves another chain.");

  const head = Number(await rpc("eth_blockNumber", [])) - c.confirmations;
  const top = await rpc("eth_getBlockByNumber", [hex(head), false]);
  const dataTime = Number(top?.timestamp);
  if (!Number.isSafeInteger(dataTime)) throw Error("Missing block timestamp.");
  const cutoff = dataTime - WINDOW;

  let state = await store.get();
  if (state && (state.chainId !== c.chainId || state.token !== c.token)) state = null;
  if (state) {
    // A changed hash at the last read block means a reorganisation: rebuild.
    const anchor = await rpc("eth_getBlockByNumber", [hex(state.lastBlock), false]);
    if (anchor?.hash !== state.lastBlockHash) {
      onProgress("The chain changed since the last build. Rebuilding.");
      state = null;
    }
  }

  let rows = state?.rows ?? [];
  const from = state ? state.lastBlock + 1 : await blockAtTime(rpc, cutoff, head);
  if (from <= head) {
    const { deposits } = await readDeposits(rpc, from, head, onProgress, { ...c, concurrency, rangeSize });
    const fresh = deposits.map((d) => ({
      block: d.block,
      time: d.time,
      amountWei: String(d.amountWei),
      hash: d.hash,
    }));
    const addresses = await senders(fresh.map((r) => r.hash));
    fresh.forEach((row, i) => {
      if (!ADDRESS.test(addresses[i] || "")) throw Error("Missing transaction sender.");
      row.sender = addresses[i].toLowerCase();
    });
    rows = rows.concat(fresh.map(({ hash, ...row }) => row));
    onProgress(`Read ${fresh.length} new deposits.`);
  }
  rows = rows.filter((r) => r.time >= cutoff);
  await store.set({
    chainId: c.chainId,
    token: c.token,
    lastBlock: head,
    lastBlockHash: top.hash,
    rows,
  });

  const groups = new Map();
  const deposits = rows.map((r, id) => {
    if (!groups.has(r.sender)) groups.set(r.sender, groups.size);
    return {
      id,
      amount: Number(toStored(BigInt(r.amountWei))),
      time: r.time,
      group: groups.get(r.sender),
    };
  });
  return {
    deposits,
    asset: { chainId: c.chainId, address: c.token, symbol: "WETH", decimals: 18 },
    snapshot: {
      pool: c.pool,
      chainId: c.chainId,
      token: c.token,
      block: head,
      time: dataTime,
      windowStart: cutoff,
      grouping: "tx-sender",
    },
  };
}
