# @railcheck/builder (preview)

Builds railcheck pools from your own Ethereum RPC: RAILGUN WETH, USDT and USDC on Ethereum mainnet, and WETH on Sepolia. The first run reads 180 days of shields. Each subsequent run reads only the new blocks.

## Install

```sh
npm install @railcheck/builder @railcheck/core
```

You need Node.js 22 or later, or a modern browser, and an RPC that gives `eth_getLogs` for 180 days. Many free RPCs refuse this on mainnet. Use a paid RPC.

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

The store contains the sender addresses. Keep it on the device or on your server. The result contains no addresses. A store from an older builder version, or for another set of tokens, is rebuilt one time, from the full 180 days.

Sender lookups go to your RPC for the shield transactions of the tokens that you choose. So the RPC can see which tokens the wallet builds pools for. It does not see the amounts or the addresses of the user.

All options, where to run the builder, and timings: [railcheck.xyz/docs](https://railcheck.xyz/docs/#build-the-pool).

MIT license. railcheck is not related to RAILGUN.
