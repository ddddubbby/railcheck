# @railcheck/kohaku (preview)

railcheck advice for wallets on the [Kohaku](https://github.com/ethereum/kohaku) plugin interface. The advice runs on the device, before the wallet prepares a shield or an unshield.

## Install

```sh
npm install @railcheck/kohaku @railcheck/core
```

You need a pool from `prepare` in [`@railcheck/core`](../../lib/).

## Example

```js
import { guard } from "@railcheck/kohaku";

const safe = guard(plugin, {
  pool,
  constraint: "fixed",
  getContext: async (assetAmount, to) => ({ addressReuse: to === shieldAddress }),
  onAdvice: async (advice) => null, // Show the advice. Return a new amount, or null.
});

await safe.prepareUnshield({ asset: { __type: "erc20", contract: WETH }, amount }, to);
```

- The plugin prepares the transaction one time, with the amount from `onAdvice`.
- `adviseShield` and `adviseUnshield` give the advice without a wrapper.
- An asset that the pool does not cover gives `not-checked`. It never blocks `prepareShield` or `prepareUnshield`: the plugin gets the original amount.
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
