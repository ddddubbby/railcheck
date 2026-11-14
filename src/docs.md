---
title: railcheck for wallets: RAILGUN privacy advice SDK
description: Add local privacy advice to your RAILGUN wallet. Build the pool from your own RPC. No data goes to railcheck. MIT license.
updated: 2026-11-14
---
# Add privacy advice to your RAILGUN wallet

railcheck tells a user if an amount can link a shield to an unshield. The user gets this advice before they send.

## For wallet teams {#for-wallet-teams}

- **It runs in your wallet.** The amount and the answers stay on the user's device, and railcheck receives no data.
- **You keep the data path.** Your wallet reads the shields from your own RPC, so no railcheck server sits between your wallet and the data.
- **It never asks for an address.** The wallet answers four questions with yes, no or not sure.
- **It is free.** The license is MIT. You can use, change and fork the code.
- **It has run end to end.** See the [verified Sepolia run](https://github.com/ddddubbby/railcheck/tree/main/examples/sepolia-cycle#verified-run).

This preview covers RAILGUN WETH, USDT and USDC on Ethereum mainnet, and RAILGUN WETH on Sepolia.

## Add advice to your wallet {#integrate}

### How the pieces fit {#overview}

1. `buildPool` or `buildPools` (`@railcheck/builder`) reads the shield events from your RPC and returns `{ deposits, snapshot, asset }` for each token.
2. `prepare` (`@railcheck/core`) turns that into a prepared pool.
3. `plan` returns the advice for one amount. Or `guard` (`@railcheck/kohaku`) wraps a Kohaku-style plugin and calls `plan` before each shield and unshield.

### Install

| Package | Version | Function |
| --- | --- | --- |
| `@railcheck/core` | `0.3.0-preview.1` | The advice engine. It makes no network calls. |
| `@railcheck/builder` | `0.2.0-preview.1` | Builds the pool of shields from your RPC. |
| `@railcheck/kohaku` | `0.3.0-preview.1` | Gets advice before `prepareShield` and `prepareUnshield` in a Kohaku-style plugin. |

```sh
npm install @railcheck/core@0.3.0-preview.1 @railcheck/builder@0.2.0-preview.1 @railcheck/kohaku@0.3.0-preview.1
```

These are preview releases, so install the exact versions above.

The packages need Node.js 22 or later, or a modern browser. `@railcheck/core` has no runtime dependencies, and the other two depend only on `@railcheck/core`.

### Step 1: Build the pool {#build-the-pool}

The builder reads RAILGUN shield events from your RPC. The first run reads 180 days. Each later run reads only the new blocks.

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

For more than one token, use `buildPools`. It reads the shield events once for all the tokens and returns one pool for each token.

```js
import { buildPools, makeRpc } from "@railcheck/builder";
import { prepare } from "@railcheck/core";

const built = await buildPools({
  chain: "mainnet",
  tokens: ["weth", "usdt", "usdc"],
  rpc: makeRpc({ urls: [YOUR_RPC_URL] }),
  store,
});
const pools = Object.values(built).map(({ deposits, snapshot, asset }) => prepare(deposits, { snapshot, asset }));
```

**Important:** Always pass `snapshot` and `asset` to `prepare`. Without them, the engine cannot verify that the data is recent and belongs to the correct chain and token.

#### Where the builder runs

| | On the device | On your server |
| --- | --- | --- |
| Procedure | The app runs `buildPool` and keeps the state in its own storage. | Your server runs `buildPool` at a fixed interval and sends `{ deposits, snapshot, asset }` to the app. |
| Time for the user | For WETH, the first run takes approximately 10–60 seconds. Each update takes approximately 2 seconds. More tokens take longer, because the builder looks up the senders of more shields. | The user does not wait. |
| Data that moves | None | The pool only: amounts, times and group numbers. No addresses. |
| Use it for | A wallet with no backend | A wallet with a backend |

In both cases the advice runs in the app, and the amount and the user's answers stay on the device.

On the device, start the build when the app starts, not when the user opens the send screen.

#### `buildPool` and `buildPools` options

| Option | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `chain` | `"mainnet"`, `"sepolia"` or object | No | `"mainnet"` | The network and its RAILGUN contract. Mainnet has WETH, USDT and USDC. Sepolia has WETH only. A custom chain object for a chain or token that the SDK does not know (for example, a local fork) must have `chain.asset`, or `buildPool` throws. |
| `token` | `"weth"`, `"usdt"` or `"usdc"` | No | `"weth"` | `buildPool` only. The token of the pool. |
| `tokens` | string[] | No | `["weth"]` | `buildPools` only. The tokens of the pools. A token that the chain does not have throws. |
| `rpc` | `(method, params) => Promise` | One of `rpc` or `urls` | — | Your JSON-RPC function. Add `rpc.batch(calls)` for batches. `makeRpc` returns a function with both. |
| `urls` | `string[]` | One of `rpc` or `urls` | — | RPC addresses. The builder makes the `rpc` function from them. |
| `store` | `{ get, set }` | No | in memory | Keeps the state between runs. The state contains the sender addresses, so keep it on the device or on your server. A state from an older builder version, or for other tokens, is rebuilt once from the full 180 days. |
| `concurrency` | number | No | `4` | The number of requests at the same time. A free RPC can refuse more. |
| `rangeSize` | number, blocks | No | `200000` | The first block range for `eth_getLogs`. The builder decreases it if the RPC refuses it. |
| `batchSize` | number | No | `100` | Sender lookups in one JSON-RPC batch. `1` sends single calls. |
| `senders` | `(hashes) => Promise<string[]>` | No | RPC lookup | Returns the sender of each transaction, in order. Use it to get senders from your own indexer. |
| `onProgress` | `(message) => void` | No | none | Receives progress messages. |

`buildPool` returns `{ deposits, snapshot, asset }`. `buildPools` returns one of these per token, keyed by token: `{ weth: { deposits, snapshot, asset }, usdt: { ... } }`. `asset` is `{ chainId, address, symbol, decimals }`. The result is valid JSON, so a server can send each pool to the app, and `prepare` adds the amount settings of the token.

Use one store for one set of tokens. If the tokens change, the next run reads the full 180 days again, once.

Sender lookups go to your RPC for the shield transactions of the tokens that you choose, so the RPC can see which tokens the wallet builds pools for. It does not see the user's amounts or addresses.

**Note:** The first run needs `eth_getLogs` for 180 days. Many free RPCs refuse this on mainnet. Use a paid RPC.

### Step 2: Get advice {#get-advice}

```js
import { plan, parseAmount, toJSON } from "@railcheck/core";

const advice = plan(pool, {
  action: "unshield",
  amount: parseAmount("1.0731"),
  constraint: "flexible",
  context: { addressReuse: false, pastTransfer: undefined, restOfDeposit: false, swapGasPayer: "broadcaster" },
  balance: parseAmount("5"),
});
const json = toJSON(advice); // JSON.stringify(advice) throws: the advice contains bigint values.
```

The advice contains `bigint` values (amounts, `searched.from` and `searched.to`, `remainingBalance`). `JSON.stringify` throws on a `bigint`. `toJSON(advice)` returns a copy with each `bigint` converted to a decimal string.

#### `plan` options

| Option | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `action` | `"shield"` or `"unshield"` | Yes | — | The transaction that the user plans. |
| `amount` | `bigint`, base units | Yes | — | Shield: the amount that leaves the public wallet. Unshield: the amount that leaves the private balance, before the 0.25% fee and after the broadcaster cost. |
| `constraint` | `"fixed"` or `"flexible"` | No | `"fixed"` | `"fixed"` keeps the amount and suggests no other. `"flexible"` suggests alternatives. |
| `context` | object | No | `{}` | The four answers. Unshield only. See [Context](#context). |
| `balance` | `bigint`, base units | No | `null` | The private balance of the token. Unshield only. `plan` computes `remainingBalance` from it. |
| `budget` | number | No | `6` | Unshield only. Up to this many alternative amounts are scored. |
| `maxAgeHours` | number | No | `48` | Pool data older than this produces `not-checked`. |

Amounts are base units of the token: wei for WETH, and 0.000001 token for USDT and USDC. `parseAmount(value, asset)` parses a decimal string into base units. `formatWei(amount, places, asset)` formats base units as a decimal string, cut to `places` decimals. Without `asset`, both use WETH.

```js
import { parseAmount, formatWei, USDT_ASSET } from "@railcheck/core";

parseAmount("1250.5", USDT_ASSET); // 1250500000n
formatWei(1250500000n, 2, USDT_ASSET); // "1250.5"
```

`ASSETS` lists the supported assets: `ETH_ASSET` (WETH), `USDT_ASSET` and `USDC_ASSET`. Pass `prepare` the asset of the pool.

#### Context {#context}

The context applies to an unshield only. Pass the answers that the wallet knows, and leave the others `undefined`.

| Key | Type | Question |
| --- | --- | --- |
| `addressReuse` | `boolean`, `null` or `undefined` | Is the recipient address the same as the address that shielded? |
| `pastTransfer` | `boolean`, `null` or `undefined` | Did the recipient address send to, or receive from, the address that shielded? |
| `restOfDeposit` | `boolean`, `null` or `undefined` | Does this unshield remove the remaining part of a shield that the user partly unshielded before? |
| `swapGasPayer` | `"broadcaster"`, `"public-wallet"`, `null` or `undefined` | Who paid the gas for the private swap that made this amount? `"public-wallet"` links the swap to that wallet. `null` is unknown. Any other value throws. |

`undefined`, `null` or leaving a field out all mean "not sure". railcheck does not treat "not sure" as "no", and does not treat it as a link. Any other value throws.

### Step 3: Use the Kohaku adapter {#kohaku-adapter}

The function `guard()` wraps a Kohaku-style plugin. It gets advice before the plugin prepares the transaction.

```js
import { guard } from "@railcheck/kohaku";

const safe = guard(plugin, {
  pools, // from Step 1: one pool for each token
  constraint: "fixed",
  getContext: async (assetAmount, to) => ({ addressReuse: to === shieldAddress }),
  balance: async (assetAmount) => privateBalanceOf(assetAmount.asset), // or null
  onAdvice: async (advice) => null, // Show the advice. Return a new amount, or null.
});

await safe.prepareUnshield({ asset: { __type: "erc20", contract: USDT }, amount }, to);
```

`onAdvice` receives the same advice as `plan` returns, with `bigint` values. Use `toJSON(advice)` before you log or send it as JSON.

For each call, the adapter uses the pool of the asset. Native ETH uses the WETH pool. `poolFor(pools, asset)` returns that pool, or `null`.

#### `guard` options

| Option | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `pool` | prepared pool | One of `pool` or `pools` | — | The result of `prepare`. |
| `pools` | prepared pool[] | One of `pool` or `pools` | — | One pool for each asset. Two pools for the same asset throw. |
| `onAdvice` | `(advice) => Promise<bigint or null>` | Yes | — | Shows the advice. Returns a new amount in base units, or `null` to keep the amount. |
| `getContext` | `(assetAmount, to) => Promise<object>` | No | none | Returns the context answers for an unshield. Other keys are dropped. |
| `constraint` | `"fixed"` or `"flexible"` | No | `"fixed"` | As in `plan`. |
| `balance` | `bigint`, or `(assetAmount) => bigint or null` | No | `null` | As in `plan`. The balance is per token, so a function receives the asset and amount of the call. It can be async. |
| `budget` | number | No | `6` | As in `plan`. |

`guard` makes the plugin prepare each transaction once, with the amount from `onAdvice`, and passes every other plugin function through unchanged. An asset that no pool covers produces `not-checked` and does not stop the call: the plugin gets the original amount. To get advice without a wrapper, call `adviseShield` or `adviseUnshield`. They take a pool or a list of pools.

## What the result contains {#reference}

### Example advice

`plan` returns this advice for a shield of 1.0731 ETH with `constraint: "flexible"`, after `toJSON`. It was generated from the WETH pool file of railcheck.xyz.

```json
{
  "format": "railcheck.advice/2",
  "action": "shield",
  "constraint": "flexible",
  "assessment": {
    "format": "railcheck.advice/2",
    "action": "shield",
    "asset": { "chainId": 1, "address": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "symbol": "WETH", "decimals": 18 },
    "snapshot": {
      "pool": "railgun-ethereum",
      "chainId": 1,
      "token": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      "block": 26405107,
      "time": 1794561647,
      "windowStart": 1779009647,
      "grouping": "none",
      "reshieldHistoryComplete": true
    },
    "status": "attention",
    "amounts": { "shieldInput": "1073100000000000000", "poolCredit": "1070417250000000000" },
    "deposits": 0,
    "senders": null,
    "score": 97,
    "findings": [{ "code": "amount-stands-out" }],
    "unknown": [],
    "band": "Critical",
    "notes": ["timing-not-covered", "senders-unknown"],
    "amountExposure": { "score": 97, "band": "Critical" },
    "addressLinks": { "state": "not-applicable", "reasons": [], "unknown": [] },
    "coverage": { "state": "complete", "missing": [] }
  },
  "alternatives": [
    {
      "format": "railcheck.advice/2",
      "action": "shield",
      "asset": { "chainId": 1, "address": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "symbol": "WETH", "decimals": 18 },
      "snapshot": {
        "pool": "railgun-ethereum",
        "chainId": 1,
        "token": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        "block": 26405107,
        "time": 1794561647,
        "windowStart": 1779009647,
        "grouping": "none",
        "reshieldHistoryComplete": true
      },
      "status": "clear",
      "amounts": { "shieldInput": "1000000000000000000", "poolCredit": "997500000000000000" },
      "deposits": 72,
      "senders": null,
      "score": 1,
      "findings": [],
      "unknown": [],
      "band": "Low",
      "notes": ["timing-not-covered", "senders-unknown"],
      "amountExposure": { "score": 1, "band": "Low" },
      "addressLinks": { "state": "not-applicable", "reasons": [], "unknown": [] },
      "coverage": { "state": "complete", "missing": [] }
    }
  ],
  "searched": { "from": "965790000000000000", "to": "1180410000000000000", "candidates": 1, "limited": false }
}
```

An unshield differs as follows: `amounts` has `unshieldAmount` and `recipientAmount`, the assessment has `modelScore` and no `deposits` or `senders`, `addressLinks` reports the address answers, and the advice adds `remainingBalance`.

### Field reference {#types}

The types below are the advice before `toJSON`. After `toJSON`, each `bigint` is a decimal string. A field marked `?` can be absent.

```ts
type Band = "Low" | "Medium" | "High" | "Critical";
type Question = "addressReuse" | "pastTransfer" | "restOfDeposit";

type Advice = {
  format: "railcheck.advice/2";
  action: "shield" | "unshield";
  constraint: "fixed" | "flexible";
  assessment: Assessment;
  alternatives: Assessment[]; // each one scores Low; empty unless constraint is "flexible"
  searched: { from: bigint; to: bigint; candidates: number; limited: boolean } | null;
  remainingBalance?: bigint | null; // unshield only; absent when not-checked
};

type Assessment = {
  format: "railcheck.advice/2";
  action: "shield" | "unshield";
  asset?: { chainId: number; address: string; symbol: string; decimals: number }; // absent in the Kohaku unsupported-asset result
  snapshot?: Snapshot | null; // as passed to prepare; absent in the Kohaku unsupported-asset result
  status: "clear" | "incomplete" | "attention" | "not-checked";
  amounts?: // absent when not-checked
    | { shieldInput: bigint; poolCredit: bigint } // shield
    | { unshieldAmount: bigint; recipientAmount: bigint }; // unshield
  deposits?: number; // shield only
  senders?: number | null; // shield only; null when the pool has no sender groups
  modelScore?: number; // unshield only: the amount score before the answers
  score?: number; // 0–100; absent when not-checked
  band?: Band; // absent when not-checked
  findings: Finding[];
  unknown?: Question[]; // absent when not-checked
  notes: string[]; // note codes
  amountExposure: { score: number; band: Band } | null; // null when not-checked
  addressLinks: {
    state: "found" | "none-reported" | "unknown" | "not-applicable";
    reasons: ("address-reuse" | "past-transfer" | "swap-gas-payer")[];
    unknown: ("addressReuse" | "pastTransfer" | "swapGasPayer")[];
  };
  coverage: { state: "complete" | "limited"; missing: string[] };
};

type Finding = {
  code: string; // see Finding codes
  reason?: "address-reuse" | "past-transfer" | "swap-gas-payer"; // address-link only
  checks?: Question[]; // unknown-context only: the questions with no answer
};

type Context = {
  addressReuse?: boolean | null; // undefined or null: not sure
  pastTransfer?: boolean | null;
  restOfDeposit?: boolean | null;
  swapGasPayer?: "broadcaster" | "public-wallet" | null; // undefined or null: not sure
};

type Snapshot = { // what the builder returns
  pool: string;
  chainId: number;
  token: string; // lowercase token address
  block: number;
  time: number; // Unix seconds of the block
  windowStart: number; // Unix seconds
  grouping: "tx-sender" | "none";
  reshieldHistoryComplete?: boolean;
};

// prepare(deposits, { snapshot, asset, now? }) returns a prepared pool. Treat it as
// opaque and pass it to plan, assess or guard. Its readable fields:
type PreparedPool = {
  asset: object; // the asset with its amount settings
  snapshot: Snapshot | null;
  now: number; // Unix seconds; defaults to the current time
  start: number; // now minus 180 days
  grouped: boolean; // true when every public shield has an integer group
};

type Deposit = { // the input to prepare, as the builder returns it
  id: number;
  amount: number; // pool units: nano-ETH for WETH, base units for USDT and USDC
  time: number; // Unix seconds
  group?: number; // sender group of a public shield; leave it out for no group (the builder sets 0xFFFFFFFF on swap outputs only)
  kind?: "public" | "reshield";
};
```

### Advice fields

| Field | Type | Meaning |
| --- | --- | --- |
| `format` | string | `"railcheck.advice/2"`. A draft format. |
| `action` | string | `"shield"` or `"unshield"`. |
| `constraint` | string | `"fixed"` or `"flexible"`. |
| `assessment` | object | The assessment of the requested amount. |
| `alternatives` | object[] | Assessments of other amounts. Each one has a Low score. Empty when `constraint` is `"fixed"`. |
| `searched` | object or `null` | The range that the search tried: `from`, `to` (base units), `candidates` (number) and `limited` (`true` if the budget stopped the search). `null` when no search ran. |
| `remainingBalance` | `bigint` or `null` | Unshield only. `balance` minus `amount`. `null` when no balance is passed or the balance is less than the amount. |

### Assessment fields

| Field | Type | Meaning |
| --- | --- | --- |
| `format`, `action` | string | As in the advice. |
| `status` | string | `clear`, `incomplete`, `attention` or `not-checked`. See [Status values](#status). |
| `score` | number, 0–100 | The final score. A Low score does not guarantee privacy. |
| `band` | string | `Low` (0–5), `Medium` (6–20), `High` (21–50) or `Critical` (51–100). |
| `modelScore` | number, 0–100 | Unshield only. The amount score before the answers. |
| `amounts` | object, base units | Shield: `shieldInput`, `poolCredit`. Unshield: `unshieldAmount`, `recipientAmount`. |
| `deposits` | number | Shield only. Shields in the pool with the same pool amount. |
| `senders` | number or `null` | Shield only. Different transaction senders for those shields. `null` when the pool has no sender groups. It is not a count of people. |
| `findings` | object[] | Problems, most important first. Each has a `code`. An `address-link` finding has a `reason`; an `unknown-context` finding has `checks`. |
| `unknown` | string[] | The yes/no questions (`addressReuse`, `pastTransfer`, `restOfDeposit`) with no answer. |
| `notes` | string[] | Information that does not change the score. |
| `asset` | object | `chainId`, `address`, `symbol`, `decimals`. |
| `snapshot` | object or `null` | The snapshot passed to `prepare`. From the builder: `pool`, `chainId`, `token`, `block`, `time`, `windowStart`, `grouping` and `reshieldHistoryComplete`. |
| `amountExposure` | object or `null` | How much the amount alone stands out: `score` (0–100) and `band`. `null` when `not-checked`. |
| `addressLinks` | object | `state`: `"found"`, `"none-reported"`, `"unknown"` or `"not-applicable"`. A shield is always `"not-applicable"`. A `not-checked` unshield is `"unknown"`. `reasons`: the links found. `unknown`: the address questions with no answer, plus `swapGasPayer` when a swap output sets a score above Low and the gas payer is unknown. |
| `coverage` | object | `state`: `"complete"` or `"limited"`. `missing`: what the check could not use. `"rest-of-deposit"`: the rest-of-shield answer is not sure. `"swap-output-history"`: the pool lacks the full swap-output history. In a `not-checked` result, `missing` holds its finding code: `"stale-data"`, `"incomplete-window"` or, from the Kohaku adapter, `"unsupported-asset"`. |

A `not-checked` assessment has no `score`, `band`, `amounts` or `unknown`.

Format 2 adds `amountExposure`, `addressLinks` and `coverage`. The format 1 fields (`score`, `band`, `status`, `findings`, `unknown`) stay for one more minor version.

### Status values {#status}

| Status | Meaning | Show to the user |
| --- | --- | --- |
| `clear` | The checks found no problem. | The user can continue. A Low score does not guarantee privacy. |
| `incomplete` | An answer is "not sure", or `coverage` is `"limited"`. | The result and the open questions. Never "clear", and never a green color, even when the band is `Low`. |
| `attention` | A finding needs an action. | The finding, and the alternatives if there are any. |
| `not-checked` | railcheck cannot check this amount. | "Not checked". Never "clear", and never a green color. |

### Finding codes

| Code | Meaning |
| --- | --- |
| `address-link` | The answers show a link between the addresses. `reason` is `"address-reuse"`, `"past-transfer"` or `"swap-gas-payer"`. A different amount does not remove this link, so there are no alternatives. |
| `rest-of-deposit` | The user's unshields add up to one shield. |
| `amount-stands-out` | Few shields have this amount. |
| `unknown-context` | One or more yes/no questions have no answer. `checks` lists them: `"addressReuse"`, `"pastTransfer"`, `"restOfDeposit"`. |
| `stale-data` | `not-checked`: the pool data is older than `maxAgeHours`. |
| `incomplete-window` | `not-checked`: the pool data does not cover 180 days. |
| `unsupported-asset` | `not-checked`: no pool covers this asset (Kohaku adapter). |

### Note codes

| Code | Meaning |
| --- | --- |
| `timing-not-covered` | The check does not include the time between the shield and the unshield. |
| `split-completes-total` | If the user unshields the rest later, the unshields add up to the shield. |
| `balance-below-amount` | The private balance is less than the amount, so `remainingBalance` is `null`. |
| `senders-unknown` | The pool has no sender groups, so `senders` is `null`. |

### How alternatives are chosen

`plan` suggests alternatives only with `constraint: "flexible"`, and only when the amount causes the finding. An address link results in no alternatives.

- Shield: common pool amounts within ±10% of the request, nearest first.
- Unshield: common amounts from 70% to 100% of the request, largest first. The engine scores up to `budget` amounts.

### All exports {#exports}

`@railcheck/core`:

- `prepare(deposits, { snapshot, asset, now })`: returns a prepared pool of the last 180 days.
- `plan(pool, options)`: returns the advice for one amount.
- `assess(pool, { action, amount, context, maxAgeHours })`: returns one assessment, with no alternatives.
- `toJSON(advice)`: returns a copy with each `bigint` as a decimal string.
- `parseAmount(value, asset)`: parses a decimal string into base units. Throws on invalid input.
- `formatWei(amount, places, asset)`: formats base units as a decimal string, cut to `places` decimals.
- `ETH_ASSET`, `USDT_ASSET`, `USDC_ASSET`, `ASSETS`: the supported assets.
- `FORMAT`, `STATUS`: the format name and the four status values.
- `decode(buffer, manifest)`: reads a railcheck pool file (`.bin`) into deposits.

`@railcheck/core/format`: `FORMAT`, `STATUS` and `toJSON` only, without the engine.

`@railcheck/builder`:

- `buildPool(options)`, `buildPools(options)`: see [Step 1](#build-the-pool).
- `makeRpc({ urls, fetchImpl, timeoutMs, retries })`: returns an `rpc` function with `rpc.batch`. Without `urls`, it uses `RPC_URL` and two public RPCs.
- `CHAINS`: the supported chains, their RAILGUN contracts and their tokens.
- `memoryStore(state)`: returns a store that keeps the state in memory (the default).
- `rpcSenders(rpc, { batchSize, concurrency })`: returns the default `senders` function.
- `STORE_VERSION`: the version of the stored state.

`@railcheck/builder/reader` (low-level log reading):

- `readDeposits(rpc, fromBlock, toBlock, onProgress, options)`: reads shield events into rows.
- `readWithdrawals(rpc, fromBlock, toBlock, onProgress, options)`: reads unshield events into rows.
- `decodeShield(data)`, `foldShieldLogs(logs, options)`, `foldUnshieldLogs(logs, options)`: decode raw logs.
- `blockAtTime(rpc, timestamp, head)`: returns the first block at or after a time.
- `makeRpc`: as in `@railcheck/builder`.
- `RAILGUN_PROXY`, `WETH`, `SHIELD_TOPIC`, `NULLIFIED_TOPIC`, `UNSHIELD_TOPIC`, `CONFIRMATIONS`: mainnet addresses, event topics and the confirmation count (64).

`@railcheck/kohaku`:

- `guard(plugin, options)`: see [Step 3](#kohaku-adapter).
- `adviseShield(pools, assetAmount, { constraint })`: returns the advice for a shield, without a wrapper.
- `adviseUnshield(pools, assetAmount, { context, balance, budget, constraint })`: returns the advice for an unshield, without a wrapper.
- `poolFor(pools, asset)`: returns the pool that covers a Kohaku asset, or `null`.
- `supports(pool, asset)`: returns `true` when the pool covers a Kohaku asset.
- `pickContext(raw)`: returns only the known context fields.
- `CONTEXT_FIELDS`: the four context keys.

#### Other exports

Low-level parts of `@railcheck/core`. Most wallets do not need them.

- `score(pool, amount)`: returns `{ score, band, crowd, matches }` for the amount alone (no answers, no match table), plus `fromSwapOutputs: true` when swap outputs set the score. Cached per pool.
- `inspect(pool, amount)`: returns the full model output: score, top shields and match table.
- `check(deposits, amount, q1, q2, q3, now, asset)`: the legacy web-check wrapper. Its answers are `"yes"`, `"no"` or `"unsure"` (not sure).
- `bandOf(score)`: returns the band of a score.
- `afterUnshieldFee(amount)`: returns the amount after the 0.25% unshield fee.
- `toStored(amount, scale)`, `toBase(stored, scale)`: convert between base units and pool units.
- `assetOf(asset)`: returns a known asset with its amount settings, or throws.
- `unitOf(asset)`: returns the base units per pool unit.
- `toWhole(amount, asset)`: returns base units as a whole-token number.
- `AMOUNT_FIELDS`: the names of the amount settings of an asset.
- `FEES`: the shield and unshield fees, 25 bps each.
- `EPS`, `NANO`, `WEI`: the WETH match tolerance in nano-ETH (5000), 10^9 and 10^18.
- `unready(pool, maxAgeHours)`: returns `"stale-data"`, `"incomplete-window"` or `null`.
- `crowded(pool)`: returns `[amount, owners]` pairs, largest amount first: each pool amount (in pool units) that 20 or more owners share, with that owner count. Owners are sender groups when the pool has them, else shields.
- `notCheckedParts(code, action)`: returns the format 2 parts of a `not-checked` assessment.
- `QUESTIONS`, `SWAP_GAS_PAYERS`: the yes/no context keys and the `swapGasPayer` values.
- `SWAP_GAS_PAYER_FLOOR`, `LOW`, `MIN_CROWD`, `BUDGET`, `MAX_AGE_HOURS`: the engine constants (90, 5, 20, 6, 48).

## How to show the result {#rules}

1. Never show `not-checked` or `incomplete` as "clear", safe or green: an `incomplete` result can have a Low band, and a `not-checked` result has no score.
2. Do not answer for the user. If the wallet does not know an answer, leave it `undefined`.
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

The server has one tool, `check_amount`. It returns the same advice as `plan`, plus the data source, the block and the age of the pool. The tool reads data only. It holds no keys, signs nothing and never takes an address.

If `RPC_URL` is set, the server builds the pool from your RPC. If not, it downloads the pool file that railcheck.xyz uses, and the result shows "railcheck.xyz" as the data source.

Rules for agents:

1. Ask the user the four context questions. Do not guess the answers. If the user does not know, send `not-sure`.
2. Never show `not-checked` or `incomplete` as "clear", safe or green: an `incomplete` result can have a Low band, and a `not-checked` result has no score.
3. Do not change the amount without the user's approval.
<!-- end:mcp -->

## What the check does not cover {#limits}

- The score is the output of a model. It is not a measured probability of identification.
- The check covers amounts and the four context questions only. It does not cover time, IP addresses or data that is not on the chain.
- The check covers 180 days, and sets of up to 3 shields.

For the method and all limits, see [How it works](/how-it-works/).
