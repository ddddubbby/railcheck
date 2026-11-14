// Builds railcheck pools from the wallet's own RPC. The first run reads the
// 180-day window; later runs read only new blocks. One log read serves every
// requested token. Sender addresses stay in the wallet's store: the returned
// deposits hold group numbers only.
import { toStored, unitOf, assetOf, ASSETS } from "@railcheck/core";
import { makeRpc, blockAtTime, readDeposits, CONFIRMATIONS } from "./reader.mjs";

export { makeRpc } from "./reader.mjs";

// The identity of an asset: what the builder returns, and what survives JSON.
// Core `prepare` fills the amount fields of a known asset from it.
const identity = ({ chainId, address, symbol, decimals }) => ({ chainId, address, symbol, decimals });
const known = (symbol) => identity(ASSETS.find((a) => a.symbol === symbol));

/** The supported chains and their pools, by token id. */
export const CHAINS = {
  mainnet: {
    chainId: 1,
    proxy: "0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9",
    confirmations: CONFIRMATIONS,
    tokens: {
      weth: { pool: "ethereum-weth", asset: known("WETH") },
      usdt: { pool: "ethereum-usdt", asset: known("USDT") },
      usdc: { pool: "ethereum-usdc", asset: known("USDC") },
    },
  },
  sepolia: {
    chainId: 11155111,
    proxy: "0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea",
    confirmations: CONFIRMATIONS,
    tokens: {
      weth: {
        pool: "sepolia-weth",
        asset: { chainId: 11155111, address: "0xfff9976782d46cc05630d1f6ebab18b2324d6b14", symbol: "WETH", decimals: 18 },
      },
    },
  },
};

const WINDOW = 180 * 86400;
// The version of the stored state. A store of another version (version 2 kept one
// token; earlier previews left out swap outputs) is rebuilt from the full window
// one time.
export const STORE_VERSION = 3;
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

// A chain with its pools by token id. A custom chain object ({ pool, chainId,
// proxy, token, confirmations, asset }) has one token. Its asset is `chain.asset`,
// else the known asset of that chainId and token; the builder never guesses one.
function chainOf(chain) {
  if (typeof chain === "string") {
    if (!Object.hasOwn(CHAINS, chain)) throw Error(`Unknown chain: ${chain}.`);
    return { name: chain, ...CHAINS[chain] };
  }
  if (!chain || typeof chain !== "object") throw Error(`Unknown chain: ${chain}.`);
  if (chain.tokens) return chain;
  const token = String(chain.token ?? chain.asset?.address ?? "").toLowerCase();
  if (!ADDRESS.test(token)) throw Error("The chain has no token address.");
  let asset;
  if (chain.asset) {
    if (String(chain.asset.address).toLowerCase() !== token || chain.asset.chainId !== chain.chainId)
      throw Error(
        `The chain asset (${chain.asset.address} on chain ${chain.asset.chainId}) is not the chain's token (${token} on chain ${chain.chainId}). Pass the asset of that token.`,
      );
    // A known asset returns its identity, so the pool survives JSON; any other
    // asset returns as given, and must have its amount fields.
    const match = knownAsset(chain.chainId, token);
    asset = match && match.decimals === chain.asset.decimals ? match : { ...chain.asset };
  } else {
    asset = knownAsset(chain.chainId, token);
    if (!asset)
      throw Error(
        `The token ${token} on chain ${chain.chainId} is not a known asset. Pass chain.asset with its amount fields.`,
      );
  }
  assetOf(asset); // An unknown asset without amount fields throws here.
  const id = knownId(asset) ?? String(asset.symbol).toLowerCase();
  return { ...chain, tokens: { [id]: { pool: chain.pool, asset } } };
}
const allTokens = () => Object.values(CHAINS).flatMap((c) => Object.entries(c.tokens));
function knownAsset(chainId, address) {
  const found = allTokens().find(([, t]) => t.asset.chainId === chainId && t.asset.address === address);
  return found ? found[1].asset : null;
}
const knownId = (asset) =>
  allTokens().find(([, t]) => t.asset.chainId === asset.chainId && t.asset.address === asset.address)?.[0];

// The pool of one token id on the chain, or a clear error.
function tokenOf(c, id) {
  if (typeof id === "string" && Object.hasOwn(c.tokens, id)) return c.tokens[id];
  const ids = Object.keys(c.tokens).join(", ");
  if (allTokens().some(([known]) => known === id))
    throw Error(`The chain ${c.name ?? c.chainId} has no ${id} pool. Use ${ids}.`);
  throw Error(`Unknown token: ${id}. Use ${ids}.`);
}

/**
 * Updates the stored pools and returns { [token id]: { deposits, snapshot, asset } },
 * one entry per token in `tokens`, for core `prepare`. One log read serves every
 * token. `rpc` is a function (method, params) => result, or pass `urls` instead.
 * Tuning: `concurrency` (parallel log ranges and sender batches), `rangeSize`
 * (first eth_getLogs block range; it shrinks if the RPC refuses it), `batchSize`
 * (senders per JSON-RPC batch; 1 means single calls), or your own
 * `senders(hashes) => addresses` (for example, from an indexer).
 */
export async function buildPools({ chain = "mainnet", tokens = ["weth"], ...options }) {
  if (!Array.isArray(tokens) || !tokens.length) throw Error("Pass tokens as a list of token ids, for example [\"weth\"].");
  return build(chainOf(chain), tokens, options);
}

/**
 * Updates the stored pool of one token and returns { deposits, snapshot, asset } for
 * core `prepare`. `token` is a token id ("weth" when left out, or the one token of a
 * custom chain). The other options are those of `buildPools`.
 */
export async function buildPool({ chain = "mainnet", token, ...options }) {
  const c = chainOf(chain),
    ids = Object.keys(c.tokens);
  token ??= ids.length === 1 ? ids[0] : "weth";
  return (await build(c, [token], options))[token];
}

async function build(
  c,
  ids,
  {
    rpc,
    urls,
    store = memoryStore(),
    onProgress = () => {},
    concurrency = 4,
    batchSize = 100,
    rangeSize = 200000,
    senders,
  },
) {
  const wanted = [...new Set(ids)].map((id) => [id, tokenOf(c, id)]);
  const addressOf = (t) => t.asset.address.toLowerCase();
  const addresses = wanted.map(([, t]) => addressOf(t));
  const tokenSet = [...addresses].sort();
  rpc ??= makeRpc({ urls });
  senders ??= rpcSenders(rpc, { batchSize, concurrency });
  const chainId = Number(await rpc("eth_chainId", []));
  if (chainId !== c.chainId) throw Error(`The RPC serves chain ${chainId}, not chain ${c.chainId}.`);

  let head = Number(await rpc("eth_blockNumber", [])) - c.confirmations;
  let top = await rpc("eth_getBlockByNumber", [hex(head), false]);
  if (!Number.isSafeInteger(Number(top?.timestamp))) throw Error("Missing block timestamp.");

  let state = await store.get();
  if (state && state.chainId !== c.chainId) state = null;
  if (state && (state.version !== STORE_VERSION || !Number.isSafeInteger(state.lastBlockTime))) {
    onProgress("The stored pool is from an older version. Rebuilding.");
    state = null;
  }
  if (state && String(state.tokens) !== String(tokenSet)) {
    // A new token needs its own 180 days.
    onProgress("The tokens changed since the last build. Rebuilding from the full window.");
    state = null;
  }
  let behind = false;
  if (state) {
    const anchor = await rpc("eth_getBlockByNumber", [hex(state.lastBlock), false]);
    if (state.lastBlock > head && (anchor == null || anchor.hash === state.lastBlockHash)) {
      // The RPC is behind the store (another node, for example), and may not have
      // the stored block yet. Serve the stored pool as it is: no log read and no
      // store write, so rows are never read twice and the stored block never
      // moves back.
      behind = true;
      head = state.lastBlock;
      top = { hash: state.lastBlockHash, timestamp: state.lastBlockTime };
    } else if (anchor?.hash !== state.lastBlockHash) {
      // A changed hash at the last read block means a reorganisation: rebuild.
      onProgress("The chain changed since the last build. Rebuilding.");
      state = null;
    }
  }
  const dataTime = Number(top.timestamp);
  const cutoff = dataTime - WINDOW;

  let rows = state?.rows ?? [];
  const from = state ? state.lastBlock + 1 : await blockAtTime(rpc, cutoff, head);
  if (from <= head) {
    const { deposits } = await readDeposits(rpc, from, head, onProgress, {
      ...c,
      token: addresses,
      concurrency,
      rangeSize,
    });
    const fresh = deposits.map((d) => ({
      block: d.block,
      time: d.time,
      amountWei: String(d.amountWei),
      hash: d.hash,
      kind: d.kind === "reshield" ? "reshield" : "public",
      token: d.token,
    }));
    // SDK-4 / ENG-3: no broadcaster lookup or group for reshields. A transaction
    // that shields several of the tokens is looked up one time.
    const hashes = [...new Set(fresh.filter((r) => r.kind === "public").map((r) => r.hash))];
    const found = hashes.length ? await senders(hashes) : [];
    const senderOf = new Map(hashes.map((h, i) => [h, found[i]]));
    for (const row of fresh) {
      if (row.kind === "reshield") continue;
      const fromAddr = senderOf.get(row.hash);
      if (!ADDRESS.test(fromAddr || "")) throw Error("Missing transaction sender.");
      row.sender = fromAddr.toLowerCase();
    }
    rows = rows.concat(fresh.map(({ hash, ...row }) => row));
    onProgress(`Read ${fresh.length} new deposits.`);
  }
  rows = rows.filter((r) => r.time >= cutoff);
  if (!behind)
    await store.set({
      version: STORE_VERSION,
      chainId: c.chainId,
      tokens: tokenSet,
      lastBlock: head,
      lastBlockHash: top.hash,
      lastBlockTime: dataTime,
      rows,
    });

  // One pool per token, each with its own sender groups. Amounts are in the
  // asset's pool units: nano-ETH for WETH, base units for USDT and USDC.
  // DATA-4: group 0xFFFFFFFF = no group; reshields always have no group.
  const NO_GROUP = 0xffffffff;
  const pools = {};
  for (const [id, t] of wanted) {
    const token = addressOf(t),
      unit = unitOf(assetOf(t.asset)),
      groups = new Map();
    const deposits = rows
      .filter((r) => r.token === token)
      .map((r, n) => {
        const kind = r.kind === "reshield" ? "reshield" : "public";
        let group = NO_GROUP;
        if (kind === "public") {
          if (!groups.has(r.sender)) groups.set(r.sender, groups.size);
          group = groups.get(r.sender);
        }
        return {
          id: n,
          amount: Number(toStored(BigInt(r.amountWei), unit)),
          time: r.time,
          group,
          kind,
        };
      });
    pools[id] = {
      deposits,
      asset: { ...t.asset },
      snapshot: {
        pool: t.pool,
        chainId: c.chainId,
        token,
        block: head,
        time: dataTime,
        windowStart: cutoff,
        grouping: "tx-sender",
        // Every build reads swap outputs for the whole window: a stored state
        // of another version or token set is rebuilt above.
        reshieldHistoryComplete: true,
      },
    };
  }
  return pools;
}
