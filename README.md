# railcheck

Check your RAILGUN withdrawal privacy before you unshield.

railcheck is a free, open-source tool that helps you spot two ways a planned withdrawal can become linked to a deposit: a distinctive amount and an existing connection between addresses. It runs the check on your device, without connecting a wallet or asking for an address.

## What it can do

- Compare a planned ETH withdrawal with public RAILGUN WETH deposits on Ethereum from the last 180 days.
- Look for matches to individual deposits and combinations of two or three deposits, accounting for the unshield fee.
- Check whether the amount plus one public withdrawal of the last 30 days adds up to one earlier deposit, which can link a deposit withdrawn in two parts.
- Flag address reuse and prior transfers between the deposit and destination addresses, based on your answers.
- Show a risk score with an explanation of the signals behind it.
- Suggest a smaller amount when an alternative meets the model's lower-risk criteria.
- Show when the public pool snapshot was updated, and warn when it is stale.

## How to use it

1. Enter the amount you plan to unshield.
2. Answer two questions about the destination address. You never enter the address itself.
3. Read the result and, when available, consider the suggested amount.

The check does not submit a transaction or move funds. Support currently covers RAILGUN ETH withdrawals on Ethereum.

## Privacy by design

Your amount and answers remain in memory in your browser. They are not sent to a server, stored, or included in a URL. There is no wallet connection, analytics, cookies or third-party page content.

The site loads the same public snapshot of deposit and withdrawal amounts for every visitor. It contains no addresses. Once that snapshot is loaded, running a check makes no network requests. Hosting providers still receive ordinary requests for site files.

## Understand the result

The score is a model-based indication of amount matching and address-link risk, not a measured probability of identification or a guarantee of anonymity. Address checks rely on your answers; railcheck does not inspect a wallet's history.

It does not cover every source of information an observer might have, including timing, IP addresses, exchange records and other off-chain data. Splits into more than two parts, broadcaster fees taken from the same funds and links between addresses can still connect withdrawals to a deposit. A lower score means fewer signals under this model. The [method page](src/how-it-works.html) explains the assumptions and limitations.

railcheck is an independent project and is not an official RAILGUN product.

## Run locally

Requires Node.js 22 or later. There are no npm dependencies.

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run dev
```

Open <http://127.0.0.1:4173>. A verified Ethereum deposit and withdrawal snapshot is included.

For deployment, data updates and implementation details, see [Maintaining railcheck](docs/maintaining.md). For changes, see [Contributing](CONTRIBUTING.md).

## License

MIT. The bundled Geist fonts retain their [SIL Open Font License](public/fonts/LICENSE.txt).
