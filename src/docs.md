---
title: railcheck for wallets: RAILGUN privacy advice SDK
description: Add local privacy advice to your RAILGUN wallet. Build the pool from your own RPC. No data goes to railcheck. MIT license.
updated: 2026-10-17
---
# Add privacy advice to your RAILGUN wallet

railcheck tells a user if an amount can link a shield to an unshield. The user gets this advice before they send.

## For wallet teams {#for-wallet-teams}

- **It runs in your wallet.** The amount and the answers stay on the device of the user. railcheck receives no data.
- **It needs no server from us.** Your wallet reads the shields from your own RPC. railcheck runs no server for you.
- **It never asks for an address.** The wallet gives three answers: yes, no or not sure.
- **It is free.** The license is MIT. You can use, change and fork the code.
- **It works in a real flow.** On 17 October 2026, a wallet built its own pool, got advice, and sent a shield and an unshield on Sepolia. Both transactions are confirmed.

This preview covers RAILGUN WETH on Ethereum mainnet and on Sepolia.

## Integrate {#integrate}

### Install

| Package | Function |
| --- | --- |
| `@railcheck/core` | The advice engine. It makes no network calls. |
| `@railcheck/builder` | Builds the pool of shields from your RPC. |
| `@railcheck/kohaku` | Gets advice before `prepareShield` and `prepareUnshield` in a Kohaku-style plugin. |

```sh
npm install @railcheck/core @railcheck/builder @railcheck/kohaku
```

The packages need Node.js 22 or later, or a modern browser. They have no runtime dependencies.

### Step 1: Build the pool {#build-the-pool}

The builder reads RAILGUN shield events from your RPC. The first run reads 180 days. Each subsequent run reads only the new blocks.

```js
import { buildPool, makeRpc } from "@railcheck/builder";
import { prepare } from "@railcheck/core";

const { deposits, snapshot, asset } = await buildPool({
  chain: "mainnet",
  rpc: makeRpc({ urls: [YOUR_RPC_URL] }),
  store, // { get: async () => state, set: async (state) => {} }
});
const pool = prepare(deposits, { snapshot, asset });
```

**Important:** Always give `snapshot` and `asset` to `prepare`. Without them, the engine cannot make sure that the data is recent and on the correct chain.

#### Where the builder runs

| | On the device | On your server |
| --- | --- | --- |
| Procedure | The app runs `buildPool` and keeps the state in its own storage. | Your server runs `buildPool` at a fixed interval and sends `{ deposits, snapshot, asset }` to the app. |
| Time for the user | The first run takes approximately 10–60 seconds. Each update takes approximately 2 seconds. | The user does not wait. |
| Data that moves | None | The pool only: amounts, times and group numbers. No addresses. |
| Use it for | A wallet with no backend | A wallet with a backend |

With the two options, the advice runs in the app. The amount and the answers of the user stay on the device.

On the device, start the build when the app starts. Do not start it when the user opens the send screen.

#### `buildPool` options

| Option | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `chain` | `"mainnet"` or `"sepolia"` | No | `"mainnet"` | The network and its RAILGUN contract and WETH address. |
| `rpc` | `(method, params) => Promise` | One of `rpc` or `urls` | — | Your JSON-RPC function. Add `rpc.batch(calls)` for batches. `makeRpc` gives both. |
| `urls` | `string[]` | One of `rpc` or `urls` | — | RPC addresses. The builder makes the `rpc` function from them. |
| `store` | `{ get, set }` | No | in memory | Keeps the state between runs. The state contains the sender addresses. Keep it on the device or on your server. |
| `concurrency` | number | No | `4` | The number of requests at the same time. A free RPC can refuse more. |
| `rangeSize` | number, blocks | No | `200000` | The first block range for `eth_getLogs`. The builder decreases it if the RPC refuses it. |
| `batchSize` | number | No | `100` | Sender lookups in one JSON-RPC batch. `1` sends single calls. |
| `senders` | `(hashes) => Promise<string[]>` | No | RPC lookup | Gives the sender of each transaction, in order. Use it to get senders from your own indexer. |
| `onProgress` | `(message) => void` | No | none | Receives progress messages. |

`buildPool` gives `{ deposits, snapshot, asset }`.

**Note:** The first run needs `eth_getLogs` for 180 days. Many free RPCs refuse this on mainnet. Use a paid RPC.

### Step 2: Get advice {#get-advice}

```js
import { plan, parseAmount } from "@railcheck/core";

const advice = plan(pool, {
  action: "unshield",
  amount: parseAmount("1.0731"),
  constraint: "flexible",
  context: { addressReuse: false, pastTransfer: undefined, restOfDeposit: false },
  balance: parseAmount("5"),
});
```

#### `plan` options

| Option | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `action` | `"shield"` or `"unshield"` | Yes | — | The transaction that the user plans. |
| `amount` | `bigint`, wei | Yes | — | Shield: the amount that leaves the public wallet. Unshield: the amount that leaves the private balance, before the 0.25% fee and after the broadcaster cost. |
| `constraint` | `"fixed"` or `"flexible"` | No | `"fixed"` | `"fixed"` gives no other amount. `"flexible"` gives alternatives. |
| `context` | object | No | `{}` | The three answers. Unshield only. See the next table. |
| `balance` | `bigint`, wei | No | `null` | The private balance. Unshield only. It gives `remainingBalance`. |
| `budget` | number | No | `6` | The maximum number of unshield amounts to score. |
| `maxAgeHours` | number | No | `48` | Older pool data gives `not-checked`. |

`parseAmount("1.0731")` changes an ETH string to wei. `formatWei(wei)` changes it back.

#### Context

The context applies to an unshield only. Give the answers that the wallet knows. Set the other answers to `undefined`.

| Key | Type | Question |
| --- | --- | --- |
| `addressReuse` | `boolean` or `undefined` | Is the recipient address the same as the address that shielded? |
| `pastTransfer` | `boolean` or `undefined` | Did the recipient address send to, or receive from, the address that shielded? |
| `restOfDeposit` | `boolean` or `undefined` | Does this unshield remove the remaining part of a shield that the user partly unshielded before? |

The value `undefined` means "not sure". railcheck does not use it as "no". railcheck does not use it as a link.

### Step 3: Use the Kohaku adapter {#kohaku-adapter}

The function `guard()` wraps a Kohaku-style plugin. It gets advice before the plugin prepares the transaction.

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

#### `guard` options

| Option | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `pool` | prepared pool | Yes | — | The result of `prepare`. |
| `onAdvice` | `(advice) => Promise<bigint or null>` | Yes | — | Shows the advice. Gives a new amount in wei, or `null` to keep the amount. |
| `getContext` | `(assetAmount, to) => Promise<object>` | No | none | Gives the context answers for an unshield. |
| `constraint` | `"fixed"` or `"flexible"` | No | `"fixed"` | As in `plan`. |
| `balance` | `bigint`, wei | No | `null` | As in `plan`. |
| `budget` | number | No | `6` | As in `plan`. |

The plugin prepares the transaction one time, with the amount from `onAdvice`. The adapter does not change the other plugin functions. An asset that the pool does not cover gives `not-checked`. It does not stop the call.

## Reference {#reference}

### Result

`plan` gives this result. This example is a shield of 1.0731 ETH with `constraint: "flexible"`. Some fields are not shown.

```json
{
  "format": "railcheck.advice/1",
  "action": "shield",
  "constraint": "flexible",
  "assessment": {
    "status": "attention",
    "amounts": { "shieldInput": "1073100000000000000", "poolCredit": "1070417250000000000" },
    "deposits": 0,
    "senders": null,
    "score": 97,
    "band": "Critical",
    "findings": [{ "code": "amount-stands-out" }],
    "unknown": [],
    "notes": ["timing-not-covered", "senders-unknown"],
    "snapshot": { "chainId": 1, "block": 26210554, "time": 1792219379, "grouping": "none" }
  },
  "alternatives": [
    { "status": "clear", "amounts": { "shieldInput": "1000000000000000000" }, "deposits": 71, "score": 1, "band": "Low" }
  ],
  "searched": { "from": "965790000000000000", "to": "1180410000000000000", "candidates": 1, "limited": false }
}
```

Amounts are `bigint` values in wei. `toJSON(advice)` changes them to strings.

### Result fields

| Field | Type | Meaning |
| --- | --- | --- |
| `format` | string | `"railcheck.advice/1"`. A draft format. |
| `action` | string | `"shield"` or `"unshield"`. |
| `constraint` | string | `"fixed"` or `"flexible"`. |
| `assessment` | object | The assessment of the requested amount. |
| `alternatives` | object[] | Assessments of other amounts. Each one has a Low score. Empty when `constraint` is `"fixed"`. |
| `searched` | object or `null` | The range that the search tried: `from`, `to` (wei), `candidates` (number) and `limited` (`true` if the budget stopped the search). |
| `remainingBalance` | `bigint` or `null` | Unshield only. `balance` minus `amount`. |

### Assessment fields

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | string | `clear`, `incomplete`, `attention` or `not-checked`. |
| `score` | number, 0–100 | The final score. |
| `band` | string | `Low` (0–5), `Medium` (6–20), `High` (21–50) or `Critical` (51–100). |
| `modelScore` | number, 0–100 | Unshield only. The amount score before the answers. |
| `amounts` | object, wei | Shield: `shieldInput`, `poolCredit`. Unshield: `unshieldAmount`, `recipientAmount`. |
| `deposits` | number | Shield only. Shields in the pool with the same pool amount. |
| `senders` | number or `null` | Shield only. Different transaction senders for those shields. `null` when the pool has no sender groups. It is not a count of people. |
| `findings` | object[] | Problems, most important first. Each has a `code`. |
| `unknown` | string[] | Context questions with no answer. |
| `notes` | string[] | Information that does not change the score. |
| `asset` | object | `chainId`, `address`, `symbol`, `decimals`. |
| `snapshot` | object or `null` | `chainId`, `token`, `block`, `time`, `windowStart`, `grouping`. |

A `not-checked` assessment has no `score`, `band` or `amounts`.

### Status

| Status | Meaning | Show to the user |
| --- | --- | --- |
| `clear` | The checks found no problem. | The user can continue. A Low score does not guarantee privacy. |
| `incomplete` | One or more answers are "not sure". | The result and the open questions. |
| `attention` | A finding needs an action. | The finding, and the alternatives if there are alternatives. |
| `not-checked` | railcheck cannot check this amount. | "Not checked". Never "clear". |

### Findings

| Code | Meaning |
| --- | --- |
| `address-link` | The answers show a link between the addresses. A different amount does not remove this link, so there are no alternatives. |
| `rest-of-deposit` | The unshields of the user add up to one shield. |
| `amount-stands-out` | Few shields have this amount. |
| `unknown-context` | One or more questions have no answer. The field `checks` gives these questions. |
| `stale-data` | `not-checked`: the pool data is older than `maxAgeHours`. |
| `incomplete-window` | `not-checked`: the pool data does not cover 180 days. |
| `unsupported-asset` | `not-checked`: the pool does not cover this asset (Kohaku adapter). |

### Notes

| Code | Meaning |
| --- | --- |
| `timing-not-covered` | The check does not include the time between the shield and the unshield. |
| `split-completes-total` | If the user unshields the rest later, the unshields add up to the shield. |
| `senders-unknown` | The pool has no sender groups, so `senders` is `null`. |

### Alternatives

You get alternatives only with `constraint: "flexible"`, and only when the amount causes the finding. An address link gives no alternatives.

- Shield: common pool amounts within ±10% of the request, nearest first.
- Unshield: common amounts from 70% to 100% of the request, largest first. The engine scores a maximum of `budget` amounts.

## Rules for wallets {#rules}

1. Do not show "clear" or a green color when the status is `not-checked`.
2. Do not give an answer for the user. If the wallet does not know the answer, set it to `undefined`.
3. If the constraint is `"fixed"`, show the advice. Do not change the amount.
4. If the user selects a new amount after the plugin prepared the transaction, prepare the transaction again.

<!-- if:mcp -->
## For AI agents {#agents}

railcheck has a local MCP server. An AI agent can use it to check an amount before it helps a user shield or unshield.

```json
{
  "mcpServers": {
    "railcheck": {
      "command": "npx",
      "args": ["-y", "@railcheck/mcp"],
      "env": { "RPC_URL": "https://your-rpc.example" }
    }
  }
}
```

The server has one tool, `check_amount`. It gives the same result as `plan`, plus the data source, the block and the age of the pool. The tool reads data only. It holds no keys, signs nothing and never takes an address.

If `RPC_URL` is set, the server builds the pool from your RPC. If not, it downloads the pool file that railcheck.xyz uses, and the result shows "railcheck.xyz" as the data source.

Rules for agents:

1. Ask the user the three questions. Do not guess the answers. If the user does not know, send `not-sure`.
2. Do not show "clear" when the status is `not-checked`.
3. Do not change the amount without the approval of the user.
<!-- end:mcp -->

## Limits {#limits}

- The score is the output of a model. It is not a measured probability of identification.
- The check covers amounts and the three questions only. It does not cover time, IP addresses or data that is not on the chain.
- The check covers 180 days, and sets of a maximum of 3 shields.

For the method and all limits, see [How it works](/how-it-works/).
