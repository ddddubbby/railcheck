# railcheck

Check your RAILGUN withdrawal privacy before you unshield.

railcheck is a free, open-source tool that helps you spot three ways a planned withdrawal can become linked to a deposit: a distinctive amount, an existing connection between addresses, and withdrawing the rest of a deposit you already partly withdrew. It runs the check on your device, without connecting a wallet or asking for an address.

## What it can do

- Compare a planned ETH withdrawal with public RAILGUN WETH deposits on Ethereum from the last 180 days.
- Look for matches to individual deposits and combinations of two or three deposits, accounting for the unshield fee.
- Flag address reuse and prior transfers between the deposit and destination addresses, based on your answers.
- Flag withdrawing the rest of a partly withdrawn deposit, based on your answer.
- Show a risk score with an explanation of the signals behind it.
- Suggest a smaller amount when an alternative meets the model's lower-risk criteria.
- Show when the public deposit snapshot was updated, and warn when it is stale.
- Explore seven days of confirmed deposits and withdrawals on an hourly timeline. Mint spikes rise for deposits; coral spikes fall for withdrawals. Hover, tap or use the arrow keys to inspect each UTC hour. The dashboard is built into the page and makes no extra requests.

## How to use it

1. Enter the amount you plan to unshield.
2. Answer two questions about the destination address and one about earlier withdrawals. You never enter an address.
3. Read the result and, when available, consider the suggested amount.

The check does not submit a transaction or move funds. Support currently covers RAILGUN ETH withdrawals on Ethereum.

## Privacy by design

Your amount and answers remain in memory in your browser. They are not sent to a server, stored, or included in a URL. There is no wallet connection, analytics, cookies or third-party page content.

The site loads the same public deposit snapshot for every visitor. Once that snapshot is loaded, running a check makes no network requests. Hosting providers still receive ordinary requests for site files.

## Understand the result

The score is a model-based indication of amount matching, address-link and split-withdrawal risk, not a measured probability of identification or a guarantee of anonymity. Address and split-withdrawal checks rely on your answers; railcheck does not inspect a wallet's history.

It does not cover every source of information an observer might have, including timing, IP addresses, exchange records and other off-chain data. A lower score means fewer signals under this model. The [About page](src/about.html) explains the assumptions and limitations.

railcheck is an independent project and is not an official RAILGUN product.

## Run locally

Requires Node.js 22 or later. There are no npm dependencies.

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run dev
```

Open <http://127.0.0.1:4173>. Verified Ethereum deposit and withdrawal snapshots are included.

`npm run data:update` refreshes both snapshots at the same block with 64 confirmations. Builds verify their hashes and reject mismatched checkpoints. The chart uses UTC-hour bins (three-hour bins on narrow screens), with a shared linear transaction-count scale. Deposits exclude internal reshields; withdrawals include DeFi unshields. Amounts are after protocol fees. The [RAILGUN contract](https://github.com/Railgun-Privacy/contract/blob/main/contracts/logic/RailgunLogic.sol) defines the Shield and Unshield events.

## License

MIT. The bundled Geist fonts retain their [SIL Open Font License](public/fonts/LICENSE.txt).
