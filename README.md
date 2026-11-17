# railcheck

Local privacy checks for RAILGUN shields and unshields.

railcheck checks whether a shield or unshield (deposit or withdrawal) amount could link back to you before you send. Everything runs locally on your device without asking for an address.

- **Web check:** [railcheck.xyz](https://railcheck.xyz/)
- **Wallet SDK:** embed the same check in a wallet via [For wallets](https://railcheck.xyz/docs/).

The web checker supports RAILGUN WETH, USDT, and USDC on Ethereum mainnet; the wallet SDK preview supports WETH, USDT, and USDC on mainnet plus WETH on Sepolia.

## Packages

| Package | Function |
| --- | --- |
| [`@railcheck/core`](lib/) | The advice engine. It makes no network calls. |
| [`@railcheck/builder`](packages/builder/) | Builds the pool of shields from your own RPC. |
| [`@railcheck/kohaku`](packages/kohaku/) | Gets advice before `prepareShield` and `prepareUnshield` in a Kohaku-style plugin. |

## Privacy

Your amount and answers stay on your device. The check has no server, no analytics and no wallet connection. For the method, the data and the limits, see [How it works](https://railcheck.xyz/how-it-works/).

A Low score does not guarantee privacy: see the [limits](https://railcheck.xyz/how-it-works/#limits).

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

`npm run data:update` refreshes the WETH, USDT, and USDC pools at a single confirmed block (64 confirmations) in one log scan using `RPC_URL`. Any pool without cached history runs a full 180-day sync on its first pass; if one token fails, the remaining pools still publish. The site loads all published pools.

## License

MIT. The Geist fonts use the [SIL Open Font License](public/fonts/LICENSE.txt).

railcheck is an independent project and is not affiliated with RAILGUN—see the [disclaimer](https://railcheck.xyz/how-it-works/#disclaimer).
