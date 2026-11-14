# @railcheck/builder (preview)

Builds railcheck pools from your own Ethereum RPC: RAILGUN WETH, USDT and USDC on Ethereum mainnet, and WETH on Sepolia. The first run reads 180 days of shields. Each later run reads only the new blocks.

## Install

```sh
npm install @railcheck/builder@0.2.0-preview.1 @railcheck/core@0.3.0-preview.1
```

These are preview releases, so install the exact versions.

You need Node.js 22 or later, or a modern browser, and an RPC that serves `eth_getLogs` for 180 days. Many free RPCs refuse this on mainnet. Use a paid RPC.

## Example

```js
import { buildPool, buildPools, makeRpc } from "@railcheck/builder";
import { prepare } from "@railcheck/core";

const { deposits, snapshot, asset } = await buildPool({
  chain: "mainnet", // or "sepolia"
  rpc: makeRpc({ urls: [YOUR_RPC_URL] }),
  store, // { get: async () => state, set: async (state) => {} }
});
const pool = prepare(deposits, { snapshot, asset });
```

`buildPool` builds one pool: `token` is `"weth"` (the default), `"usdt"` or `"usdc"`. `buildPools` builds a pool for each token in `tokens`, with one read of the shield events:

```js
const { weth, usdt, usdc } = await buildPools({
  chain: "mainnet",
  tokens: ["weth", "usdt", "usdc"],
  rpc: makeRpc({ urls: [YOUR_RPC_URL] }),
  store,
});
const pool = prepare(usdt.deposits, { snapshot: usdt.snapshot, asset: usdt.asset });
```

Each pool is `{ deposits, snapshot, asset }`. It is valid JSON, so a server can send it to the app. Amounts are in the pool units of the asset: 0.000000001 ETH for WETH, and the base unit (0.000001 token) for USDT and USDC.

The store contains the sender addresses. Keep it on the device or on your server. The result contains no addresses. A store from an older builder version, or for another set of tokens, is rebuilt once from the full 180 days.

A custom `chain` object for a chain or token that the SDK does not know (for example, a local fork) must have `chain.asset`, or `buildPool` throws.

The first run for WETH takes approximately 10–60 seconds. More tokens take longer, because the builder looks up the senders of more shields.

Sender lookups go to your RPC for the shield transactions of the tokens that you choose, so the RPC can see which tokens the wallet builds pools for. It does not see the user's amounts or addresses.

All options, where to run the builder, and timings: [railcheck.xyz/docs](https://railcheck.xyz/docs/#build-the-pool).

MIT license. Not related to RAILGUN: see the [disclaimer](https://railcheck.xyz/how-it-works/#disclaimer).
