# railcheck

Local privacy advice for RAILGUN shields and unshields.

railcheck tells you if a shield or unshield amount can link back to you, before you send. The check runs on your device. It never asks for an address.

- **Web check:** [railcheck.xyz](https://railcheck.xyz/)
- **Wallet SDK:** add the same check to a wallet. See [For wallets](https://railcheck.xyz/docs/).

This preview covers RAILGUN WETH on Ethereum mainnet and Sepolia.

## Packages

| Package | Function |
| --- | --- |
| [`@railcheck/core`](lib/) | The advice engine. It makes no network calls. |
| [`@railcheck/builder`](packages/builder/) | Builds the pool of shields from your own RPC. |
| [`@railcheck/kohaku`](packages/kohaku/) | Gets advice before `prepareShield` and `prepareUnshield` in a Kohaku-style plugin. |

## Privacy

Your amount and answers stay on your device. The check has no server, no analytics and no wallet connection. For the method, the data and the limits, see [How it works](https://railcheck.xyz/how-it-works/).

A score is the output of a model. A Low score does not guarantee privacy.

## Repository

| Folder | Content |
| --- | --- |
| `lib/` | `@railcheck/core` |
| `packages/` | `@railcheck/builder` and `@railcheck/kohaku` |
| `src/`, `public/` | The website. The text pages are Markdown in `src/`. |
| `scripts/` | The site build and the daily pool data update |
| `examples/sepolia-cycle/` | A real wallet flow on Sepolia: build the pool, get advice, shield and unshield |
| `tests/` | Tests |

## Run locally

You need Node.js 22 or later. There are no runtime dependencies. The build uses `marked`.

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run dev
```

Open <http://127.0.0.1:4173>.

`npm run data:update` updates the pool data at one block, with 64 confirmations. It needs an RPC in `RPC_URL`.

## License

MIT. The Geist fonts use the [SIL Open Font License](public/fonts/LICENSE.txt).

railcheck is an independent project. It is not related to RAILGUN.
