# @railcheck/kohaku (preview)

railcheck privacy advice for wallets built on the [Kohaku](https://github.com/ethereum/kohaku) plugin interface. The advice runs on the device, before the wallet prepares a shield or an unshield.

```js
import { guard } from "@railcheck/kohaku";

const safe = guard(plugin, {
  pool,                              // from @railcheck/core prepare()
  constraint: "flexible", // only when the user allows a smaller amount; default "fixed"
  onAdvice: async (advice) => {
    // Show advice.assessment (status, findings). Return a new amount, or null to keep the request.
    return advice.alternatives[0]?.amounts.unshieldAmount ?? null;
  },
  // Only facts the wallet can establish; leave the others undefined (not sure).
  getContext: async (assetAmount, to) => ({ addressReuse: false, pastTransfer: false }),
});

await safe.prepareUnshield({ asset: { __type: "native" }, amount }, to); // prepares one time
```

- `adviseShield(pool, assetAmount)` and `adviseUnshield(pool, assetAmount, options)` return the advice without wrapping.
- The wallet passes the final unshield amount, after broadcaster costs.
- One asset per call. `prepare*Multi` calls pass through with no advice.
- An unsupported asset gives an assessment with `status: "not-checked"` and never blocks the call.

This preview covers RAILGUN WETH on Ethereum. Compatibility with the restored official `@kohaku-eth/railgun` plugin is a design target and is not yet tested.
