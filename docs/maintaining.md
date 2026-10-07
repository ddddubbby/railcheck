# Maintaining railcheck

## Run locally

Use Node.js 22 or later. There are no npm dependencies.

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run dev
```

Open `http://127.0.0.1:4173`. To use another port: `PORT=4174 npm run dev`.

The repository includes a real Ethereum snapshot. `public/data/manifest.json` records its date, last confirmed block, file hash and count. Run `npm run data:update` to refresh it before deployment.

## Connect Vercel

Import the GitHub repository into Vercel. The included `vercel.json` selects static output and sets the security headers.

- Framework preset: **Other**.
- Build command: `npm run build`.
- Output directory: `dist`.
- Node.js: 22 or later.
- Web Analytics and Speed Insights: leave disabled.
- Set `SITE_URL` to your production HTTPS origin, such as your actual domain or Vercel production URL. No path, query or credentials.
- Optionally set `SOURCE_URL` to the GitHub repository URL. Without it, the site offers a source ZIP from its own origin.

If `SITE_URL` is not set, the build can use `VERCEL_PROJECT_PRODUCTION_URL` in Vercel's production environment. Local builds and previews remain unindexed when neither production origin is available. Canonical URLs, sitemap, Open Graph/X metadata and WebApplication structured data are generated once the production origin is configured.

The 1200 × 630 social preview is served from `public/og.png`.

## Optional GitHub secrets

- `RPC_URL`: Ethereum mainnet RPC endpoint with historical log access. When it is set, the updater uses only that endpoint. It does not fall back to a public endpoint if the call fails.
- `RPC_WITNESS_URL`: a second mainnet endpoint on a different host. The update is published only when this endpoint returns the same block hashes and the same deposits. When it is unset, the job uses a public endpoint (Tenderly or MEV Blocker) that is not the primary host. Without `RPC_URL`, those two public endpoints check each other.
- `VERCEL_DEPLOY_HOOK`: Vercel deploy hook for the production branch. Use this if data commits made by GitHub Actions do not trigger your Vercel Git integration. The hook URL is a secret; never commit it.

These secrets are used only by the repository's update job. They are not browser variables. `.env.example` documents the settings; `.env` is ignored and excluded from the public source download. Node scripts also support `node --env-file=.env scripts/data-update.mjs` when local settings are needed.

## Data pipeline

```sh
npm run data:update
npm run data:validate
npm run build
```

The updater verifies Ethereum chain ID 1 on two providers, waits for 64 confirmations, and reads the RAILGUN proxy's Shield and Nullified logs from the primary. A witness on a different host must return the same confirmed block hash, the same window boundary and the same deposits for every new range. A mismatch or an unreachable witness stops the update. One provider answering a call does not switch the rest of the run onto another provider. The reader keeps ERC-20 WETH commitments, sums them by transaction and excludes any transaction with a Nullified event. Failed log ranges split and retry; no range is silently skipped. Block times come from logs or a block lookup. Transaction hashes are used in memory for grouping but are not written to the deposit CSV or browser pool.

The bootstrap verifies the active window from Ethereum. Later runs append confirmed deposits from the block after the saved checkpoint. The last block hash is checked to catch a deep reorganization. A chain-history mismatch fails the update rather than publishing a potentially inconsistent snapshot.

- `data/deposits.csv`: append-only history with `block,time,amount_wei` and no addresses or transaction hashes.
- `public/data/railgun-eth.bin`: EXCK v1, amounts and times for the last 180 days.
- `public/data/manifest.json`: file hash, byte count, coverage, build time and confirmed checkpoint.

Pool amounts are integers in units of 0.000000001 ETH, rounded once when the pool is built. Dust deposits that round to zero remain in the pool. The engine sums those values before comparing against the 0.000005 ETH tolerance. It never rounds each amount to a larger match bucket. The CSV preserves the original integer wei values.

The worker validates the manifest, SHA-256 and binary structure before it accepts the pool. Its load requests are identical for every visitor. A check makes no network requests. Stale data produces one notice; missing or corrupt data cannot produce a reassuring zero score.

## Validation and release checks

```sh
npm test
npm run data:validate
SITE_URL=https://your-actual-domain.example npm run release:check
```

Replace the example origin with your real origin. `release:check` runs tests, validates real-pool targets, requires data no older than 26 hours, and builds the product. Ordinary `build` also verifies the pool's hash and format but allows an older snapshot for offline development.

Tests cover 400 randomized pools against brute force, 20,000 synthetic pair/triple checks, 18-decimal parsing, behavior floors, the safer-amount retry, pool integrity, no network calls during checks, and the reader's internal-shield exclusion. Recorded Ethereum fixtures are kept under `tests/fixtures/`; synthetic fixtures are used only in tests and never served as pool data.

`data:validate` deterministically samples 400 full withdrawals and 400 random amounts from 0.05 to 5 ETH. It reports the Critical/Low percentages, the proportion of risky full withdrawals with a safer amount, and desktop timing. `--release` enforces the model's 55%/65%/90% regression targets. Desktop timing does not establish the mid-range-phone budget. Use `--report` to save a local report to `data/validation.json`; this generated file is ignored by Git and excluded from the source download.

The GitHub Checks workflow runs tests, a static build and data validation on pushes and pull requests. The daily update workflow runs those checks itself before committing the 3 data files, because commits made with `GITHUB_TOKEN` do not trigger another Actions workflow.

## Architecture

The product remains a small static ES-module application with a single Web Worker and locally served fonts. This preserves the strict CSP without hydration scripts or inline styles. The browser and build scripts have no npm dependencies.

- `src/`: static page templates and stylesheet.
- `public/app.mjs`: form, validation, result rendering and motion.
- `public/worker.mjs`: data loading and checks.
- `lib/engine/`: exact input parsing, set counting, scoring and safer-amount search.
- `lib/pool/`: binary decoding.
- `scripts/lib/`: Ethereum reader and snapshot encoding.
- `scripts/`: data refresh, data validation, release/build commands and local server.
- `.github/workflows/`: checks and scheduled data refresh.

Inputs are never included in the URL, logs or persisted browser state. The two pages and FAQ answers are readable without JavaScript. The safer-amount search first tries reductions of 10%, 15%, 20%, 25% and 30%. If none passes, it tries intermediate 1% reductions within the same 10%–30% range. It retains the Low-score and 20-nearby-deposit requirements.

The recipient amount follows the contract fee calculation: subtract the fee rounded down in integer wei. This preserves the final wei correctly.

An amount score is a model output conditional on the source deposit; it is not an empirically calibrated probability of identification. The page always includes the off-chain-data limitation.

## Deployment verification

Before a public deployment, configure the production origin, refresh the pool snapshot, and check the deployed form, keyboard navigation, reduced-motion behavior and mobile performance. Verify that the daily data workflow publishes a fresh snapshot and triggers a deployment. Model changes need independent regression coverage and review of their assumptions.

## Reader references

The fixed event decoder follows the deployed Shield tuple described by the RAILGUN contracts:

- [RailgunLogic event definitions](https://github.com/Railgun-Privacy/contract/blob/main/contracts/logic/RailgunLogic.sol)
- [CommitmentPreimage and TokenData types](https://github.com/Railgun-Privacy/contract/blob/main/contracts/logic/Globals.sol)
- [Tenderly RPC reference](https://docs.tenderly.co/node-rpc/rpc-reference)

These links are development references and do not appear on the product pages.

