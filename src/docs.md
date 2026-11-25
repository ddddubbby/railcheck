---
title: railcheck for wallets: RAILGUN privacy advice SDK
description: Add local privacy checks to your RAILGUN wallet using your own RPC. Zero telemetry, no address inputs, MIT licensed.
updated: 2026-11-25
---
# Add privacy advice to your RAILGUN wallet

railcheck warns users when a shield or unshield amount could link back to them—locally, before they send.

## For wallet teams {#for-wallet-teams}

- **Runs locally:** Amounts and context answers stay on the user's device; nothing is sent to railcheck.
- **Bring your own RPC:** Your wallet pulls shield logs directly from your RPC, with no railcheck server in the middle.
- **No address inputs:** The wallet answers four boolean/enum context questions instead of passing addresses.
- **MIT licensed:** Free to use, modify, and fork.
- **Sepolia-verified:** Tested end-to-end in the [Sepolia run](https://github.com/ddddubbby/railcheck/tree/main/examples/sepolia-cycle#verified-run).

This preview covers RAILGUN WETH, USDT, and USDC on Ethereum mainnet, plus WETH on Sepolia.

## Integration requirements {#rules}

Your wallet must follow these rules. They stop a result that railcheck could not complete from looking safe to the user.

1. Never present `not-checked` or `incomplete` as "clear", safe, or green: an `incomplete` result can still carry a `Low` band, and `not-checked` has no score. See [Status values](#status).
2. Never guess context answers on the user's behalf—leave unknown fields `undefined`.
3. When `constraint` is `"fixed"`, show the advice without altering the user's amount.
4. If the user selects a different amount after the plugin has prepared a transaction, prepare the transaction again.
5. Always pass `snapshot` and `asset` to `prepare`. Without them, the engine can't verify that the pool is recent or matches the right chain and token.

## Add advice to your wallet {#integrate}

### Before you start {#prerequisites}

- **An RPC that serves 180 days of logs.** The initial 180-day `eth_getLogs` scan is rejected by most free mainnet RPCs; use a paid provider.
- **Node.js 22+ or a modern browser.**

### Overview {#overview}

1. `buildPool` or `buildPools` (`@railcheck/builder`) fetches shield events from your RPC and returns `{ deposits, snapshot, asset }` per token.
2. `prepare` (`@railcheck/core`) indexes that data into an in-memory pool.
3. `plan` scores an amount and finds safer alternatives.

Instead of calling `plan` yourself, you can [wrap a Kohaku-style plugin](#kohaku-adapter) with `guard` (`@railcheck/kohaku`), which calls `plan` before each shield and unshield.

### Install

| Package | Version | Function |
| --- | --- | --- |
| `@railcheck/core` | `0.3.0-preview.1` | The advice engine. It makes no network calls. |
| `@railcheck/builder` | `0.2.0-preview.1` | Builds the pool of shields from your RPC. |
| `@railcheck/kohaku` | `0.3.0-preview.1` | Gets advice before `prepareShield` and `prepareUnshield` in a Kohaku-style plugin. |

```sh
npm install @railcheck/core@0.3.0-preview.1 @railcheck/builder@0.2.0-preview.1 @railcheck/kohaku@0.3.0-preview.1
```

Pin the exact preview versions above when installing.

`@railcheck/core` has zero runtime dependencies; `@railcheck/builder` and `@railcheck/kohaku` depend only on `@railcheck/core`.

### Step 1: Build the pool {#build-the-pool}

The builder reads RAILGUN shield events from your RPC. The initial sync scans 180 days of logs; subsequent runs fetch only new blocks.

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

To cover multiple tokens in a single log scan, use `buildPools`—it returns one pool object per token.

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

Always pass `snapshot` and `asset` to `prepare` ([requirement 5](#rules)).

Most wallets set only `chain`, `token` or `tokens`, `rpc` or `urls`, and `store`. See [all builder options](#builder-options).

#### Where the builder runs

| | On the device | On your server |
| --- | --- | --- |
| Setup | The app runs `buildPool` and persists state locally. | Your server runs `buildPool` on a schedule and serves `{ deposits, snapshot, asset }` to the app. |
| Wait time | For WETH, initial sync takes ~10–60 seconds; updates take ~2 seconds. Adding tokens increases sender lookups. | Instant for the user. |
| Network payload | None | Pool data only: amounts, timestamps, and group IDs. No addresses. |
| Best for | Wallets without a backend | Wallets with a backend |

In both setups, scoring runs in the app—amounts and user answers never leave the device.

When running on-device, start syncing at app startup rather than waiting until the user opens the send screen.

Keep one store per token set—changing the token list triggers a one-time 180-day resync.

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

Because advice objects contain `bigint` values (`searched.from`, `searched.to`, `remainingBalance`, and amounts)—which `JSON.stringify` rejects—pass them through `toJSON(advice)` to serialize every `bigint` as a decimal string.

Only `action` and `amount` are required. See [all `plan` options](#plan-options).

Amounts are in base units of the token: wei for WETH, and `0.000001` token for USDT and USDC. `parseAmount(value, asset)` converts a decimal string to base units, and `formatWei(amount, places, asset)` formats base units back into a decimal string truncated to `places` decimal places. Without `asset`, both default to WETH.

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
| `addressReuse` | `boolean`, `null` or `undefined` | Is the recipient the same address that shielded? |
| `pastTransfer` | `boolean`, `null` or `undefined` | Have the shielding and recipient addresses transacted before? |
| `restOfDeposit` | `boolean`, `null` or `undefined` | Is this unshielding the remainder of a previously split shield? |
| `swapGasPayer` | `"broadcaster"`, `"public-wallet"`, `null` or `undefined` | Who paid gas for the private swap behind this output? `"public-wallet"` links the swap to that wallet; `null` is unknown. Any other value throws. |

Passing `undefined`, `null`, or omitting a field marks it as unknown—railcheck never assumes "no" or treats unknown answers as links. Any other value throws.

### Or: wrap a Kohaku plugin {#kohaku-adapter}

Use this instead of calling `plan` in Step 2. `guard()` wraps a Kohaku-style plugin to run a privacy check before the plugin prepares a transaction.

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

Only `onAdvice`, and `pool` or `pools`, are required. See [all `guard` options](#guard-options).

`guard` prepares each transaction once using the amount returned by `onAdvice`, and passes every other plugin method through unchanged. Unsupported assets produce `not-checked` without blocking the transaction—the plugin simply receives the original amount. To request advice without wrapping the plugin, call `adviseShield` or `adviseUnshield` with a pool or list of pools.

## Options {#options}

### `buildPool` and `buildPools` {#builder-options}

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

### `plan` {#plan-options}

| Option | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `action` | `"shield"` or `"unshield"` | Yes | — | The transaction that the user plans. |
| `amount` | `bigint`, base units | Yes | — | Shield: the amount that leaves the public wallet. Unshield: the amount that leaves the private balance, before the 0.25% fee and after the broadcaster cost. |
| `constraint` | `"fixed"` or `"flexible"` | No | `"fixed"` | `"fixed"` keeps the amount and suggests no other. `"flexible"` suggests alternatives. |
| `context` | object | No | `{}` | The four answers. Unshield only. See [Context](#context). |
| `balance` | `bigint`, base units | No | `null` | The private balance of the token. Unshield only. `plan` computes `remainingBalance` from it. |
| `budget` | number | No | `6` | Unshield only. Up to this many alternative amounts are scored. |
| `maxAgeHours` | number | No | `48` | Pool data older than this produces `not-checked`. |

### `guard` {#guard-options}

| Option | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `pool` | prepared pool | One of `pool` or `pools` | — | The result of `prepare`. |
| `pools` | prepared pool[] | One of `pool` or `pools` | — | One pool for each asset. Two pools for the same asset throw. |
| `onAdvice` | `(advice) => Promise<bigint or null>` | Yes | — | Shows the advice. Returns a new amount in base units, or `null` to keep the amount. |
| `getContext` | `(assetAmount, to) => Promise<object>` | No | none | Returns the context answers for an unshield. Other keys are dropped. |
| `constraint` | `"fixed"` or `"flexible"` | No | `"fixed"` | As in `plan`. |
| `balance` | `bigint`, or `(assetAmount) => bigint or null` | No | `null` | As in `plan`. The balance is per token, so a function receives the asset and amount of the call. It can be async. |
| `budget` | number | No | `6` | As in `plan`. |

## What the result contains {#reference}

### Status values {#status}

| Status | Meaning | Show to the user |
| --- | --- | --- |
| `clear` | All checks passed with no issues. | The user can proceed. A low score still doesn't guarantee privacy. |
| `incomplete` | At least one question is unknown, or `coverage` is `"limited"`. | Show the result and open questions—never "clear" or green, even if `band` is `Low`. |
| `attention` | A finding needs attention. | Show the finding and any suggested alternatives. |
| `not-checked` | railcheck couldn't check this amount. | Show "Not checked"—never "clear" or green. |

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

Unshield advice differs in four ways: `amounts` uses `unshieldAmount` and `recipientAmount`, the assessment adds `modelScore` (with no `deposits` or `senders`), `addressLinks` reflects the context answers, and the advice object includes `remainingBalance`.

### Advice fields

The fields of the advice before `toJSON`. After `toJSON`, each `bigint` is a decimal string.

| Field | Type | Meaning |
| --- | --- | --- |
| `format` | string | `"railcheck.advice/2"`. A draft format. |
| `action` | string | `"shield"` or `"unshield"`. |
| `constraint` | string | `"fixed"` or `"flexible"`. |
| `assessment` | object | The assessment of the requested amount. See [Assessment fields](#assessment-fields). |
| `alternatives` | object[] | Assessments of other amounts. Each one has a Low score. Empty when `constraint` is `"fixed"`. |
| `searched` | object or `null` | The range that the search tried: `from`, `to` (base units), `candidates` (number) and `limited` (`true` if the budget stopped the search). `null` when no search ran. |
| `remainingBalance` | `bigint` or `null` | Unshield only. `balance` minus `amount`. `null` when no balance is passed or the balance is less than the amount. Absent when `not-checked`. |

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
| `findings` | object[] | Detected issues, sorted by severity. Each entry has a `code`; `address-link` adds `reason`, and `unknown-context` adds `checks`. |
| `unknown` | string[] | Yes/no context keys (`addressReuse`, `pastTransfer`, `restOfDeposit`) left unknown. |
| `notes` | string[] | Informational flags that don't affect the score. See [Note codes](#note-codes). |
| `asset` | object | `chainId`, `address`, `symbol`, `decimals`. Absent in the Kohaku `unsupported-asset` result. |
| `snapshot` | object or `null` | The snapshot passed to `prepare`. From the builder: `pool`, `chainId`, `token`, `block`, `time`, `windowStart`, `grouping` and `reshieldHistoryComplete`. Absent in the Kohaku `unsupported-asset` result. |
| `amountExposure` | object or `null` | How much the amount alone stands out: `score` (0–100) and `band`. `null` when `not-checked`. |
| `addressLinks` | object | `state`: `"found"`, `"none-reported"`, `"unknown"` or `"not-applicable"`. A shield is always `"not-applicable"`. A `not-checked` unshield is `"unknown"`. `reasons`: the links found (`"address-reuse"`, `"past-transfer"`, `"swap-gas-payer"`). `unknown`: the address questions with no answer (`addressReuse`, `pastTransfer`), plus `swapGasPayer` when a swap output sets a score above Low and the gas payer is unknown. |
| `coverage` | object | `state`: `"complete"` or `"limited"`. `missing`: what the check could not use. `"rest-of-deposit"`: the rest-of-shield answer is not sure. `"swap-output-history"`: the pool lacks the full swap-output history. In a `not-checked` result, `missing` holds its finding code: `"stale-data"`, `"incomplete-window"` or, from the Kohaku adapter, `"unsupported-asset"`. |

A `not-checked` assessment has no `score`, `band`, `amounts` or `unknown`.

Format 2 adds `amountExposure`, `addressLinks` and `coverage`. The format 1 fields (`score`, `band`, `status`, `findings`, `unknown`) stay for one more minor version.

### Finding codes

| Code | Meaning |
| --- | --- |
| `address-link` | Context answers indicate a link between addresses (`reason`: `"address-reuse"`, `"past-transfer"`, or `"swap-gas-payer"`). Changing the amount won't remove this link, so no alternatives are offered. |
| `rest-of-deposit` | Unshielding this amount completes a previously split shield. |
| `amount-stands-out` | Few shields in the pool share this amount. |
| `unknown-context` | One or more yes/no questions were left unknown (`checks` lists `"addressReuse"`, `"pastTransfer"`, `"restOfDeposit"`). |
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

### Other types {#types}

The types that the fields above use, before `toJSON`. A field marked `?` can be absent.

```ts
type Band = "Low" | "Medium" | "High" | "Critical";
type Question = "addressReuse" | "pastTransfer" | "restOfDeposit";

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

### How alternatives are chosen

`plan` suggests alternatives only with `constraint: "flexible"`, and only when the amount causes the finding. An address link results in no alternatives.

- Shield: common pool amounts within ±10% of the request, nearest first.
- Unshield: common amounts from 70% to 100% of the request, largest first. The engine scores up to `budget` amounts.

## Errors {#errors}

Wrong input throws an `Error`. Old, short or missing pool data does not throw: the assessment is `not-checked`, and `guard` does not block the transaction.

| Situation | Result |
| --- | --- |
| A custom `chain` object without `chain.asset` | `buildPool` throws. |
| A token in `tokens` that the chain does not have | `buildPools` throws. |
| The RPC serves another chain than `chain` | `buildPool` and `buildPools` throw. |
| The `snapshot` and `asset` passed to `prepare` are for different chains or tokens | `prepare` throws. |
| In an unshield, a context answer other than `true`, `false`, `null` or `undefined` | `plan` throws, and so does `guard`. |
| A `swapGasPayer` other than `"broadcaster"`, `"public-wallet"`, `null` or `undefined` | `plan` throws, and so does `guard`. |
| `guard` gets both `pool` and `pools`, or two pools for the same asset | `guard` throws. |
| An invalid amount string | `parseAmount` throws. |
| An asset that railcheck does not know | `assetOf` throws. |
| `JSON.stringify(advice)` | Throws, because the advice contains `bigint` values. Use `toJSON(advice)`. |
| Pool data older than `maxAgeHours` | `not-checked` with `stale-data`. |
| Pool data that does not cover 180 days | `not-checked` with `incomplete-window`. |
| `guard` with no pool for the asset | `not-checked` with `unsupported-asset`. The plugin receives the original amount. |

## What each party can see {#privacy}

| Party | Sees | Does not see |
| --- | --- | --- |
| The user's device | The amount, the context answers and the balance. Scoring runs here in both builder setups. | — |
| Your RPC provider | The log and sender queries for the tokens you configure, so it can infer which pools you build. | User amounts, context answers or target addresses. |
| Your server, if it runs the builder | The builder state, which contains the sender addresses. Keep it on your server. It sends the app pool data only: amounts, timestamps and group IDs. | User amounts, context answers or target addresses. |
| railcheck | Nothing. No railcheck server is involved. | Everything. |

## All exports {#exports}

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

- `guard(plugin, options)`: see [Or: wrap a Kohaku plugin](#kohaku-adapter).
- `adviseShield(pools, assetAmount, { constraint })`: returns the advice for a shield, without a wrapper.
- `adviseUnshield(pools, assetAmount, { context, balance, budget, constraint })`: returns the advice for an unshield, without a wrapper.
- `poolFor(pools, asset)`: returns the pool that covers a Kohaku asset, or `null`.
- `supports(pool, asset)`: returns `true` when the pool covers a Kohaku asset.
- `pickContext(raw)`: returns only the known context fields.
- `CONTEXT_FIELDS`: the four context keys.

### Other exports

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

<!-- if:mcp -->
## For AI agents {#agents}

railcheck includes a local MCP server so AI agents can run privacy checks before helping a user shield or unshield.

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

The server exposes one tool, `check_amount`, returning the same output as `plan` alongside the data source, block height, and pool age. It is read-only—it holds no keys, signs nothing, and never accepts an address.

If `RPC_URL` is set, the server builds the pool from your RPC; otherwise it fetches the public pool snapshot used by railcheck.xyz and sets the data source to `"railcheck.xyz"`.

Rules for agents:

1. Ask the user the four context questions—never guess the answers. If the user isn't sure, pass `not-sure`.
2. Never present `not-checked` or `incomplete` as "clear", safe, or green: an `incomplete` result can still carry a `Low` band, and `not-checked` has no score.
3. Never change the amount without the user's approval.
<!-- end:mcp -->

## Limitations {#limits}

- The score is a heuristic model output, not a measured probability of identification.
- Checks evaluate only on-chain amounts and the four context answers—not timing, IP addresses, or off-chain data.
- Coverage spans the last 180 days and combinations of up to 3 shields.

For full methodology and caveats, see [How it works](/how-it-works/).
