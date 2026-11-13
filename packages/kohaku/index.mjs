// Advice for wallets on the Kohaku plugin interface (@kohaku-eth/plugins).
// It uses only the shape of Kohaku's AssetAmount, so it has no runtime import from Kohaku.
import { plan, notCheckedParts, FORMAT } from "@railcheck/core";

/** True when a Kohaku AssetId is the pool's asset: native ETH or the pool's ERC-20. */
export function supports(pool, asset) {
  if (asset?.__type === "native") return pool.asset.symbol === "WETH";
  return (
    asset?.__type === "erc20" &&
    asset.contract?.toLowerCase() === pool.asset.address.toLowerCase()
  );
}
const notChecked = (action) => ({
  format: FORMAT,
  action,
  constraint: "fixed",
  assessment: {
    format: FORMAT,
    action,
    status: "not-checked",
    findings: [{ code: "unsupported-asset" }],
    notes: [],
    ...notCheckedParts("unsupported-asset", action),
  },
  alternatives: [],
  searched: null,
});

// One pool, or a list of pools with at most one pool per asset.
function poolsOf(pools) {
  const list = Array.isArray(pools) ? pools : [pools];
  if (!list.length || list.some((p) => !p?.asset)) throw Error("Pass a prepared pool, or a list of prepared pools.");
  const seen = new Set();
  for (const p of list) {
    // Native ETH is covered by every WETH pool.
    for (const key of [p.asset.address?.toLowerCase(), p.asset.symbol === "WETH" ? "native" : null]) {
      if (key && seen.has(key)) throw Error(`Two pools cover the same asset (${p.asset.symbol}). Pass one pool per asset.`);
      if (key) seen.add(key);
    }
  }
  return list;
}

/** The pool that covers a Kohaku AssetId (native ETH: the WETH pool), or null. */
export function poolFor(pools, asset) {
  return poolsOf(pools).find((p) => supports(p, asset)) ?? null;
}

/**
 * Advice before prepareShield. `assetAmount.amount` is what leaves the wallet.
 * `pools` is a prepared pool or a list of them. Options: { constraint } — "fixed"
 * (default) never offers another amount.
 */
export function adviseShield(pools, assetAmount, { constraint = "fixed" } = {}) {
  const pool = poolFor(pools, assetAmount.asset);
  return pool
    ? plan(pool, { action: "shield", amount: assetAmount.amount, constraint })
    : notChecked("shield");
}

/**
 * Advice before prepareUnshield. `assetAmount.amount` is the final amount after the
 * wallet takes broadcaster costs. `pools` is a prepared pool or a list of them.
 * Options: { context, balance, budget, constraint }. Context answers the wallet
 * cannot establish stay undefined (not sure).
 */
export function adviseUnshield(pools, assetAmount, options = {}) {
  const pool = poolFor(pools, assetAmount.asset);
  return pool
    ? plan(pool, { constraint: "fixed", ...options, action: "unshield", amount: assetAmount.amount })
    : notChecked("unshield");
}

/** The context fields that `getContext` can return (SDK-1). */
export const CONTEXT_FIELDS = ["addressReuse", "pastTransfer", "restOfDeposit", "swapGasPayer"];

/**
 * Keeps only the known context fields. A field that is not returned stays undefined
 * (unknown); other keys are dropped. Undefined or null gives {}.
 */
export function pickContext(raw) {
  const context = {};
  for (const key of CONTEXT_FIELDS) if (raw?.[key] !== undefined) context[key] = raw[key];
  return context;
}

/**
 * Wraps a Kohaku PluginInstance. prepareShield and prepareUnshield get advice first;
 * `onAdvice(advice)` returns the amount to use, or null to keep the request. The plugin
 * then prepares one time. Every other member passes through unchanged.
 * `pool` is one prepared pool; `pools` is a list, one per asset, and each call uses
 * the pool of its asset. `getContext(assetAmount, to)` may return the CONTEXT_FIELDS;
 * only those reach the advice. `balance` is a bigint, or a function
 * (assetAmount) => bigint or null (may be async), as the balance is per asset.
 */
export function guard(plugin, { pool, pools, onAdvice, getContext, balance, budget, constraint }) {
  if (pool && pools) throw Error("Pass pool or pools, not both.");
  pools = poolsOf(pools ?? pool);
  const balanceOf = async (assetAmount) =>
    typeof balance === "function" ? ((await balance(assetAmount)) ?? null) : balance;
  const decide = async (assetAmount, advice) => {
    const amount = await onAdvice(advice);
    return amount == null ? assetAmount : { ...assetAmount, amount };
  };
  const wrapped = {
    async prepareShield(assetAmount, to) {
      const chosen = await decide(assetAmount, adviseShield(pools, assetAmount, { constraint }));
      return plugin.prepareShield(chosen, to);
    },
    async prepareUnshield(assetAmount, to, options) {
      const context = pickContext(getContext ? await getContext(assetAmount, to) : undefined);
      const covered = poolFor(pools, assetAmount.asset) !== null;
      const advice = adviseUnshield(pools, assetAmount, {
        context,
        balance: covered ? await balanceOf(assetAmount) : undefined,
        budget,
        constraint,
      });
      return plugin.prepareUnshield(await decide(assetAmount, advice), to, options);
    },
  };
  return new Proxy(plugin, {
    get(target, key) {
      if (key in wrapped && typeof target[key] === "function") return wrapped[key];
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
