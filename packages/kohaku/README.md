# @railcheck/kohaku (preview)

railcheck privacy advice for wallets implementing the [Kohaku](https://github.com/ethereum/kohaku) plugin interface. Checks run locally before the wallet prepares a shield or unshield.

## Install

```sh
npm install @railcheck/kohaku@0.3.0-preview.1 @railcheck/core@0.3.0-preview.1
```

Pin the exact preview versions when installing.

Requires prepared pools from [`@railcheck/core`](../../lib/): WETH, USDT, and USDC on Ethereum mainnet, or WETH on Sepolia.

## Example

```js
import { guard } from "@railcheck/kohaku";

const safe = guard(plugin, {
  pools: [wethPool, usdtPool, usdcPool], // or pool: one pool
  constraint: "fixed",
  getContext: async (assetAmount, to) => ({ addressReuse: to === shieldAddress }),
  balance: async (assetAmount) => null, // The private balance of this asset, or null.
  onAdvice: async (advice) => null, // Show the advice. Return a new amount, or null.
});

await safe.prepareUnshield({ asset: { __type: "erc20", contract: USDT }, amount }, to);
```

- The plugin prepares the transaction once, with the amount from `onAdvice`.
- Each call uses the pool of its asset, and native ETH uses the WETH pool. `poolFor(pools, asset)` returns that pool, or `null`.
- Pass `pool` or `pools`, not both. Two pools for the same asset throw.
- `balance` is a `bigint`, or a function that receives the asset amount of the call and returns a `bigint` or `null`. It can be async.
- Amounts are base units of the asset: wei for WETH, and 0.000001 token for USDT and USDC.
- `onAdvice` receives advice with `bigint` values. `JSON.stringify` throws on them; use `toJSON(advice)` from `@railcheck/core`.
- `adviseShield` and `adviseUnshield` return the advice without a wrapper. They take a pool or a list of pools.
- An asset that no pool covers produces `not-checked`. It never blocks `prepareShield` or `prepareUnshield`: the plugin gets the original amount.
- Supports single-asset calls only; `prepare*Multi` calls pass through unchanged.
- Targets compatibility with the official `@kohaku-eth/railgun` plugin (not yet tested against it).

## Context

`getContext(assetAmount, to)` runs before each unshield and returns any of the fields below. Fields that are `undefined`, `null`, or omitted are treated as unknown—never `"no"`. Any other value throws an error, and unknown keys are dropped.

| Field | Values |
| --- | --- |
| `addressReuse` | `true`, `false`. True if the recipient is the shielding address. |
| `pastTransfer` | `true`, `false`. True if the shielding and recipient addresses have transacted before. |
| `restOfDeposit` | `true`, `false`. True if this unshield spends the remainder of a previously split shield or swap output. |
| `swapGasPayer` | `"broadcaster"`, `"public-wallet"`. Who paid gas for the private swap behind this output. `null` is unknown; any other value throws. |

Returning `undefined` or `null` from `getContext` marks every field as unknown.

## Result

Advice uses result format v2 (`format: "railcheck.advice/2"`), adding three fields to each assessment:

- `amountExposure`: `{ score, band }` for the amount alone, or `null` when not checked.
- `addressLinks`: `{ state, reasons, unknown }` (`state` is `found`, `none-reported`, `unknown`, or `not-applicable` for shields).
- `coverage`: `{ state, missing }` (`state` is `complete` or `limited`; `missing` lists unavailable signals such as `rest-of-deposit` or `unsupported-asset`).

v1 fields (`score`, `band`, `status`, `findings`, `unknown`) remain available for one more minor version.

Full API options: [railcheck.xyz/docs](https://railcheck.xyz/docs/#guard-options).

MIT license. Independent project, not affiliated with RAILGUN ([disclaimer](https://railcheck.xyz/how-it-works/#disclaimer)).
