# @railcheck/builder (preview)

Builds the railcheck pool from your own Ethereum RPC. The first run reads 180 days of RAILGUN WETH shields. Each subsequent run reads only the new blocks.

## Install

```sh
npm install @railcheck/builder @railcheck/core
```

You need Node.js 22 or later, or a modern browser, and an RPC that gives `eth_getLogs` for 180 days. Many free RPCs refuse this on mainnet. Use a paid RPC.

## Example

```js
import { buildPool, makeRpc } from "@railcheck/builder";
import { prepare } from "@railcheck/core";

const { deposits, snapshot, asset } = await buildPool({
  chain: "mainnet", // or "sepolia"
  rpc: makeRpc({ urls: [YOUR_RPC_URL] }),
  store, // { get: async () => state, set: async (state) => {} }
});
const pool = prepare(deposits, { snapshot, asset });
```

The store contains the sender addresses. Keep it on the device or on your server. The result contains no addresses.

All options, where to run the builder, and timings: [railcheck.xyz/docs](https://railcheck.xyz/docs/#build-the-pool).

MIT license. railcheck is not related to RAILGUN.
