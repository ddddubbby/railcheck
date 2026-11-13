# @railcheck/kohaku (preview)

railcheck advice for wallets on the [Kohaku](https://github.com/ethereum/kohaku) plugin interface. The advice runs on the device, before the wallet prepares a shield or an unshield.

## Install

```sh
npm install @railcheck/kohaku @railcheck/core
```

You need pools from `prepare` in [`@railcheck/core`](../../lib/): WETH, USDT and USDC on Ethereum mainnet, or WETH on Sepolia.

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

- The plugin prepares the transaction one time, with the amount from `onAdvice`.
- Each call uses the pool of its asset. Native ETH uses the WETH pool. `poolFor(pools, asset)` gives that pool, or `null`.
- Give `pool` or `pools`, not both. Two pools for the same asset give an error.
- `balance` is a `bigint`, or a function that gets the asset amount of the call and gives a `bigint` or `null`. It can be async.
- Amounts are base units of the asset: wei for WETH, and 0.000001 token for USDT and USDC.
- `adviseShield` and `adviseUnshield` give the advice without a wrapper. They take a pool or a list of pools.
- An asset that no pool covers gives `not-checked`. It never blocks `prepareShield` or `prepareUnshield`: the plugin gets the original amount.
- One asset for each call. `prepare*Multi` calls pass through with no advice.
- Compatibility with the official `@kohaku-eth/railgun` plugin is a target. It is not tested.

## Context

`getContext(assetAmount, to)` runs before each unshield. It can return these fields. A field that is not returned is unknown, never "no". Other keys are dropped.

| Field | Values |
| --- | --- |
| `addressReuse` | `true`, `false`. The recipient is the address that shielded. |
| `pastTransfer` | `true`, `false`. The recipient sent to, or received from, the address that shielded. |
| `restOfDeposit` | `true`, `false`. The unshield removes the rest of a shield or swap output that was partly unshielded before. |
| `swapGasPayer` | `"broadcaster"`, `"public-wallet"`. Who paid the gas of the swap that made the unshielded swap output. `null` is unknown. Any other value throws. |

`undefined` or `null` from `getContext` means every field is unknown.

## Result

The advice is result v2 (`format: "railcheck.advice/2"`). Each assessment adds three parts:

- `amountExposure`: `{ score, band }` of the amount alone, or `null` when not checked.
- `addressLinks`: `{ state, reasons, unknown }`. `state` is `found`, `none-reported`, `unknown` or `not-applicable` (shields).
- `coverage`: `{ state, missing }`. `state` is `complete` or `limited`; `missing` names what the check could not use, for example `rest-of-deposit` or `unsupported-asset`.

The v1 fields (`status`, `score`, `band`, `findings`, `unknown`, `amounts`, `notes`) stay for one minor version.

All options: [railcheck.xyz/docs](https://railcheck.xyz/docs/#kohaku-adapter).

MIT license. railcheck is not related to RAILGUN.
