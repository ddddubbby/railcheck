# Sepolia cycle and flow demo

A real RAILGUN wallet flow with the official SDK. It runs on Sepolia (test funds).

- **Flow demo** (`src/flow-demo.mjs`): builds the pool with `@railcheck/builder`, gets advice through the `@railcheck/kohaku` adapter before `prepareShield` and `prepareUnshield`, then simulates and sends the transactions.
- **Cycle** (`src/cycle.mjs`): shield, scan, unshield proof and unshield, with no railcheck advice.

A run writes its result to `RESULT.md`. Git ignores this file, because it contains your wallet address and transaction hashes.

## Versions

- `@railgun-community/wallet@11.2.0`
- `@railgun-community/engine@9.9.1`
- `@railgun-community/shared-models@8.2.1`
- `ethers@6.14.3`

**Important:** Do not use SDK 10.4.0. Its proof keys do not match the deployed contracts, and the unshield fails with "Invalid Snark Proof".

## Set up

```bash
cd examples/sepolia-cycle
npm install
npm run create-wallet
```

`create-wallet` writes `.env` and shows only the public address. Git ignores `.env`. Keep a copy of `.env` in a safe location. Never show or commit it.

Add `RAILGUN_NETWORK=EthereumSepolia` to `.env`. Send at least 0.015 Sepolia ETH to the public address.

## Run the flow demo

Check without a send:

```bash
npm run flow-demo -- --shield
```

Send the shield and the unshield:

```bash
APPROVE_TRANSACTIONS=1 node src/flow-demo.mjs --shield --send
```

- Without `--shield`, the demo does the unshield only.
- `UNSHIELD_ETH` sets the unshield amount (default 0.005). `SHIELD_ETH` sets the shield amount (default 0.01).
- If the advice status is `not-checked`, the demo stops before any transaction.

If the proof files do not download, add `RAILGUN_IPFS_GATEWAY=https://ipfs.filebase.io` to the command.

## Known problem on Sepolia

Change notes (the remainder after an unshield) cannot become spendable on Sepolia now. The Sepolia TXID subgraph has a wrong verification hash at block 11816741, so the TXID sync stops. Shield fresh funds for each test.
