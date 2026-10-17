# @railcheck/core (preview)

The railcheck advice engine for RAILGUN shields and unshields. It runs on the device. It makes no network calls and never asks for an address.

## Install

```sh
npm install @railcheck/core @railcheck/builder
```

You need Node.js 22 or later, or a modern browser. Get the pool with [`@railcheck/builder`](../packages/builder/).

## Example

```js
import { buildPool, makeRpc } from "@railcheck/builder";
import { prepare, plan, parseAmount, toJSON } from "@railcheck/core";

const { deposits, snapshot, asset } = await buildPool({
  chain: "mainnet",
  rpc: makeRpc({ urls: [YOUR_RPC_URL] }),
});
const pool = prepare(deposits, { snapshot, asset });

const advice = plan(pool, {
  action: "unshield",
  amount: parseAmount("1.0731"),
  context: { addressReuse: false, pastTransfer: undefined, restOfDeposit: false },
});
console.log(toJSON(advice).assessment.status); // clear, incomplete, attention or not-checked
```

All options, result fields and rules for wallets: [railcheck.xyz/docs](https://railcheck.xyz/docs/).

MIT license. railcheck is not related to RAILGUN.
