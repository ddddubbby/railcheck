# @railcheck/core (preview)

The railcheck advice engine for RAILGUN shields and unshields. It runs on the device. It makes no network calls and never asks for an address. It covers WETH, USDT and USDC on Ethereum mainnet, and WETH on Sepolia.

## Install

```sh
npm install @railcheck/core@0.3.0-preview.1 @railcheck/builder@0.2.0-preview.1
```

These are preview releases, so install the exact versions.

You need Node.js 22 or later, or a modern browser. Get the pool with [`@railcheck/builder`](../packages/builder/).

## Example

```js
import { buildPool, makeRpc } from "@railcheck/builder";
import { prepare, plan, parseAmount, toJSON } from "@railcheck/core";

const { deposits, snapshot, asset } = await buildPool({
  chain: "mainnet",
  rpc: makeRpc({ urls: [YOUR_RPC_URL] }),
});
const pool = prepare(deposits, { snapshot, asset });

const advice = plan(pool, {
  action: "unshield",
  amount: parseAmount("1.0731"),
  context: { addressReuse: false, pastTransfer: undefined, restOfDeposit: false },
});
// The advice contains bigint values: use toJSON before JSON.stringify.
console.log(toJSON(advice).assessment.status); // clear, incomplete, attention or not-checked
```

Amounts are `bigint` values in base units of the asset: wei for WETH, and 0.000001 token for USDT and USDC. `parseAmount(value, asset)` parses a decimal string into base units, and `formatWei(amount, places, asset)` formats base units as a decimal string. Without `asset`, both use WETH.

```js
import { parseAmount, USDT_ASSET } from "@railcheck/core";

parseAmount("1250.5", USDT_ASSET); // 1250500000n
```

`ASSETS` lists the supported assets: `ETH_ASSET` (WETH), `USDT_ASSET` and `USDC_ASSET`. `prepare` also takes the asset as `{ chainId, address, symbol, decimals }` (as the builder returns it), and adds the amount settings of a supported asset.

All options, result fields and rules for wallets: [railcheck.xyz/docs](https://railcheck.xyz/docs/).

MIT license. Not related to RAILGUN: see the [disclaimer](https://railcheck.xyz/how-it-works/#disclaimer).
