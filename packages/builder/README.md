# @railcheck/builder

Builds the railcheck pool from your own Ethereum RPC. Preview release.

- The first run reads 180 days of RAILGUN WETH shields.
- Later runs read only the new blocks.
- After a reorganisation, the next run rebuilds the pool.
- Deposits are grouped by transaction sender. The sender addresses stay in your
  store. The returned deposits hold only group numbers.

railcheck runs no server for you. You decide where the builder runs.

```js
import { buildPool } from "@railcheck/builder";
import { prepare, plan } from "@railcheck/core";

const { deposits, snapshot, asset } = await buildPool({
  chain: "mainnet", // or "sepolia"
  urls: ["https://your-rpc.example"], // or rpc: (method, params) => result
  store, // { get: async () => state, set: async (state) => {} }
});
const pool = prepare(deposits, { snapshot, asset });
const advice = plan(pool, { action: "unshield", amount, constraint: "fixed" });
```

## Where to run it

You can use either option, or both.

**A. On the device.** The app runs `buildPool` and keeps the state in its own
storage. Start the build when the app starts, not when the user opens the
unshield screen. Until the pool is ready, give no advice, or show "not
checked". Never show "clear" without a pool.

**B. On your own server.** Your server runs `buildPool` on a schedule, for
example every 10 minutes. It sends the result to your apps. The app only
downloads it and calls `prepare`. The user does not wait for the build.

```js
// Server
const result = await buildPool({ chain: "mainnet", urls: [process.env.RPC_URL], store });
response.json(result); // { deposits, snapshot, asset }

// App
const { deposits, snapshot, asset } = await (await fetch(POOL_URL)).json();
const pool = prepare(deposits, { snapshot, asset });
```

The result holds amounts, times and group numbers only. It holds no addresses,
so it is safe to send. The store holds the sender addresses: keep it on the
server. The advice still runs in the app, so the user's amount and answers do
not go to your server.

## Speed

Measured on Sepolia, first build, free public RPC, 1,091 deposits:

| Settings | Time |
| --- | --- |
| Defaults | 13 s |
| `concurrency: 8` | 10 s |
| `batchSize: 1, concurrency: 1` (one call at a time) | 205 s |

Later runs read only new blocks. They take about 2 s. Mainnet has about 9
times more deposits, so its first build is longer. Use a paid RPC for it.

## Options

All have defaults. Change them to suit your RPC.

| Option | Default | What it does |
| --- | --- | --- |
| `rpc` | from `urls` | `(method, params) => result`. Add `rpc.batch(calls)` to allow batches. `makeRpc({ urls })` gives both. |
| `concurrency` | 4 | Log ranges and sender batches that run at the same time. A free RPC can refuse more. |
| `rangeSize` | 200000 | First `eth_getLogs` block range. If the RPC refuses it, the builder splits it and uses the smaller size after that. |
| `batchSize` | 100 | Sender lookups in one JSON-RPC batch. 1 means single calls. A failed batch falls back to single calls. |
| `senders` | RPC lookup | `async (hashes) => addresses`, one per hash, in order. Use it to get senders from your own indexer or database. |
| `store` | in memory | Where the state is kept. `memoryStore()` is for tests. |
| `onProgress` | none | Receives progress messages. |

If the RPC refuses a range of 1,000 blocks or less, the build stops with the
RPC error. It does not split further, because more calls make a rate limit
worse.

## Store

The store keeps one JSON-safe object: the last block, its hash, and one row per
deposit (`block`, `time`, `amountWei`, `sender`).
