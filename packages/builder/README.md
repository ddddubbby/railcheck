# @railcheck/builder

Builds the railcheck pool from your own Ethereum RPC. Preview release.

- The first run reads 180 days of RAILGUN WETH shields.
- Later runs read only the new blocks.
- After a reorganisation, the next run rebuilds the pool.
- Deposits are grouped by transaction sender. The sender addresses stay in your
  store. The returned deposits hold only group numbers.

```js
import { buildPool } from "@railcheck/builder";
import { prepare, plan } from "@railcheck/core";

const { deposits, snapshot } = await buildPool({
  chain: "mainnet", // or "sepolia"
  urls: ["https://your-rpc.example"], // or rpc: (method, params) => result
  store, // { get: async () => state, set: async (state) => {} }
});
const pool = prepare(deposits, { snapshot });
const advice = plan(pool, { action: "unshield", amount, constraint: "fixed" });
```

## Store

The store keeps one JSON-safe object: the last block, its hash, and one row per
deposit (`block`, `time`, `amountWei`, `sender`). Keep it in the wallet's own
storage. `memoryStore()` keeps it in memory, for tests.

## RPC

The first run needs `eth_getLogs` over 180 days and one
`eth_getTransactionByHash` per deposit. Free public RPCs often refuse this. Use
a paid RPC for the first run. Later runs are small.
