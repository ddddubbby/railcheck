# @railcheck/builder (preview)

Builds railcheck pool files from your own Ethereum RPC for RAILGUN WETH, USDT, and USDC on mainnet, plus WETH on Sepolia. Fetches 180 days of shield history on the first run, then syncs only new blocks on subsequent runs.

## Install

```sh
npm install @railcheck/builder@0.2.0-preview.1 @railcheck/core@0.3.0-preview.1
```

Pin the exact preview versions when installing.

Requires Node.js 22+ or a modern browser, plus an RPC that serves 180 days of `eth_getLogs`. Most free mainnet RPCs reject 180-day log queries; use a paid provider.

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

Each pool is `{ deposits, snapshot, asset }` in JSON-safe format, so a backend can serve it directly to your app. Amounts use the asset's pool units (`0.000000001` ETH for WETH, and base units `0.000001` token for USDT and USDC).

Keep the builder `store` on the user's device or on your server, as it holds sender addresses; the returned pool contains no addresses. Stores from an older builder version or a different token list trigger a one-time 180-day resync.

A custom `chain` object for a network or token the SDK doesn't recognize (such as a local fork) must include `chain.asset`, or `buildPool` will throw.

Initial WETH sync takes ~10–60 seconds; adding more tokens increases sender lookups.

Because the builder fetches sender addresses for the tokens you configure, your RPC provider can infer which pools you're building, though it never sees user amounts or target addresses.

All options, deployment architectures, and timings: [railcheck.xyz/docs](https://railcheck.xyz/docs/#build-the-pool).

MIT license. Independent project, not affiliated with RAILGUN ([disclaimer](https://railcheck.xyz/how-it-works/#disclaimer)).
