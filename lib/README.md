# @railcheck/core (preview)

Local privacy advice for RAILGUN shields and unshields. The engine runs on your device. It makes no network calls and never asks for an address.

This preview covers RAILGUN WETH on Ethereum.

## Quickstart

```sh
npm install @railcheck/core
```

Download a pool snapshot from <https://railcheck.xyz/data/manifest.json> and the pool file that it names. Then:

```js
import { readFileSync } from "node:fs";
import { decode, prepare, score, parseAmount } from "@railcheck/core";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const bytes = readFileSync(manifest.file);
const deposits = decode(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  manifest,
);

const pool = prepare(deposits, { now: manifest.dataTime + 1 }); // one time per snapshot
console.log(score(pool, parseAmount("1.234567")));
// → { score, band, crowd, matches }
```

- `prepare()` keeps the last 180 days of deposits and sorts them one time.
- `score()` gives the amount score from 0 to 100. Results are cached per pool.
- Amounts are `bigint` values in wei. Enter the amount before the 0.25% unshield fee.

## Assess and plan

One assessment function serves shield and unshield. Planning runs candidate amounts through the same assessment.

```js
import { assess, plan, toJSON } from "@railcheck/core";

// Before a shield: the amount that leaves the wallet.
const shield = plan(pool, { action: "shield", amount: parseAmount("1.0731"), constraint: "flexible" });

// Before an unshield: the amount that leaves the private balance, before the 0.25% fee.
const unshield = plan(pool, {
  action: "unshield",
  amount: parseAmount("2.5"),
  constraint: "flexible",          // "fixed" (default) never offers another amount
  context: { addressReuse: false, pastTransfer: undefined, restOfDeposit: false },
  balance: parseAmount("5"),       // optional
});
console.log(toJSON(unshield));
```

- `plan()` returns `{ assessment, alternatives, searched, remainingBalance }`. Each alternative is an assessment that scores Low.
- `assessment.status`:
    - `clear`: the available checks found no issue.
    - `incomplete`: an answer is not sure (`undefined`).
    - `attention`: a finding needs action.
    - `not-checked`: the pool is stale or does not cover the window.
- `assessment.findings`, most important first: `address-link`, `rest-of-deposit`, `amount-stands-out`, `unknown-context`.
- An unknown answer is never treated as `false`, and never as a link.
- An address link gives no alternatives, because a different amount does not remove it.
- A smaller unshield amount is not the rest of a deposit, so a `true` there becomes `false` for alternatives.
- Shield: `score` scores a later withdrawal of the whole deposit, with your deposit added to the pool. Alternatives are within ±10%.
- Shield: `deposits` counts deposit transactions with the same pool amount. `senders` counts different transaction senders (`tx.from`), or is `null` when the pool has no sender groups. It is not a count of people.
- Unshield: alternatives are between 70% and 100% of the request, largest first, with at most `budget` (default 6) amounts scored.

## Pool data

The engine takes a prepared pool. You can load railcheck's pool file, or build a pool with your own RPC and storage. Every pool states its chain, token, window, last confirmed block and grouping rule (`tx-sender` or `none`). Pass them as `snapshot` to `prepare()` so that advice can check freshness and coverage. Pool files hold amounts, times and group numbers, never addresses.

## Limits

- A score is a model output. It is not a measured chance of identification.
- The score covers amounts only. It does not cover timing, IP addresses or off-chain data.
- A match applies only if the matched deposit is yours.

MIT license. railcheck is not affiliated with RAILGUN.
