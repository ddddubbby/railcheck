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
- An asset that the pool does not cover gives `not-checked`. It does not stop the call.
- One asset for each call. `prepare*Multi` calls pass through with no advice.
- Compatibility with the official `@kohaku-eth/railgun` plugin is a target. It is not tested.

All options: [railcheck.xyz/docs](https://railcheck.xyz/docs/#kohaku-adapter).

MIT license. railcheck is not related to RAILGUN.
