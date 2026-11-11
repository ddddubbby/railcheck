import { WETH } from "./reader.mjs";

// The pools the daily job builds, one per token. WETH comes first: its pool is
// the top level of public/data/manifest.json, and every other pool is an entry
// of `manifest.pools`, keyed by id. A stored pool amount is an integer count of
// 10^-unitDecimals tokens: nano-ETH for WETH, the base unit (1e-6) for USDT and
// USDC.
export const TOKENS = [
  {
    id: "weth",
    symbol: "WETH",
    contract: WETH,
    decimals: 18,
    unitDecimals: 9,
    pool: "railgun-ethereum",
    file: "railgun-eth.bin",
    depositsCsv: "data/deposits.csv",
    reshieldsCsv: "data/reshields.csv",
  },
  {
    id: "usdt",
    symbol: "USDT",
    contract: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    decimals: 6,
    unitDecimals: 6,
    pool: "railgun-ethereum-usdt",
    file: "railgun-usdt.bin",
    depositsCsv: "data/deposits-usdt.csv",
    reshieldsCsv: "data/reshields-usdt.csv",
  },
  {
    id: "usdc",
    symbol: "USDC",
    contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    decimals: 6,
    unitDecimals: 6,
    pool: "railgun-ethereum-usdc",
    file: "railgun-usdc.bin",
    depositsCsv: "data/deposits-usdc.csv",
    reshieldsCsv: "data/reshields-usdc.csv",
  },
];

export const tokenById = (id) => TOKENS.find((t) => t.id === id);

/** Base units per stored pool unit: 10^(decimals - unitDecimals). */
export const unitOf = (t) => 10n ** BigInt(t.decimals - t.unitDecimals);

/** A base-unit amount rounded to the nearest stored pool unit (half up). */
export const toUnits = (amountWei, t) => {
  const unit = unitOf(t);
  return (amountWei + unit / 2n) / unit;
};

/** The manifest entry of a pool: the top level for WETH, `pools[id]` otherwise. */
export const poolEntry = (manifest, id) =>
  id === "weth" ? manifest : manifest?.pools?.[id];

// The keys of a `pools` entry, in order: today's top-level fields without
// buildTime, source and metrics, plus the token description and the
// reshield-history flag.
export const ENTRY_FIELDS = [
  "version", "pool", "chainId", "token", "symbol", "decimals", "unitDecimals",
  "file", "sha256", "size", "count", "publicCount", "reshieldCount",
  "firstDepositTime", "lastDepositTime", "dataTime", "firstBlock", "lastBlock",
  "lastBlockHash", "confirmations", "windowStart", "windowEnd", "grouping",
  "reshieldHistoryComplete", "activity", "activitySha256",
];
