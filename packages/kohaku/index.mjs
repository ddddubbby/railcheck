// Advice for wallets on the Kohaku plugin interface (@kohaku-eth/plugins).
// It uses only the shape of Kohaku's AssetAmount, so it has no runtime import from Kohaku.
import { plan, FORMAT } from "@railcheck/core";

/** True when a Kohaku AssetId is the pool's asset: native ETH or the pool's ERC-20. */
export function supports(pool, asset) {
  if (asset?.__type === "native") return pool.asset.symbol === "WETH";
  return (
    asset?.__type === "erc20" &&
    asset.contract?.toLowerCase() === pool.asset.address.toLowerCase()
  );
}
const notChecked = (pool, action) => ({
  format: FORMAT,
  action,
  constraint: "fixed",
  assessment: { format: FORMAT, action, status: "not-checked", findings: [{ code: "unsupported-asset" }], notes: [] },
  alternatives: [],
  searched: null,
});

/**
 * Advice before prepareShield. `assetAmount.amount` is what leaves the wallet.
 * Options: { constraint } — "fixed" (default) never offers another amount.
 */
export function adviseShield(pool, assetAmount, { constraint = "fixed" } = {}) {
  return supports(pool, assetAmount.asset)
    ? plan(pool, { action: "shield", amount: assetAmount.amount, constraint })
    : notChecked(pool, "shield");
}

/**
 * Advice before prepareUnshield. `assetAmount.amount` is the final amount after the
 * wallet takes broadcaster costs. Options: { context, balance, budget, constraint }.
 * Context answers the wallet cannot establish stay undefined (not sure).
 */
export function adviseUnshield(pool, assetAmount, options = {}) {
  return supports(pool, assetAmount.asset)
    ? plan(pool, { constraint: "fixed", ...options, action: "unshield", amount: assetAmount.amount })
    : notChecked(pool, "unshield");
}

/**
 * Wraps a Kohaku PluginInstance. prepareShield and prepareUnshield get advice first;
 * `onAdvice(advice)` returns the amount to use, or null to keep the request. The plugin
 * then prepares one time. Every other member passes through unchanged.
 */
export function guard(plugin, { pool, onAdvice, getContext, balance, budget, constraint }) {
  const decide = async (assetAmount, advice) => {
    const amount = await onAdvice(advice);
    return amount == null ? assetAmount : { ...assetAmount, amount };
  };
  const wrapped = {
    async prepareShield(assetAmount, to) {
      const chosen = await decide(assetAmount, adviseShield(pool, assetAmount, { constraint }));
      return plugin.prepareShield(chosen, to);
    },
    async prepareUnshield(assetAmount, to, options) {
      const context = getContext ? await getContext(assetAmount, to) : undefined;
      const advice = adviseUnshield(pool, assetAmount, { context, balance, budget, constraint });
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
