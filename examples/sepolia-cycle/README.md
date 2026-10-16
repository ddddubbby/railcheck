# Sepolia cycle (proof check)

Minimal check: does RAILGUN wallet SDK complete one real Sepolia cycle
(shield → scan → unshield proof → submit)?

Official setup: https://docs.railgun.org/developer-guide/wallet/getting-started  
Risk: https://github.com/Railgun-Community/wallet/issues/120

## Versions

- `@railgun-community/wallet@10.4.0`
- `@railgun-community/shared-models@7.6.1`
- `ethers@6.13.1`
- `snarkjs`

## Setup

```bash
cd examples/sepolia-cycle
npm install
cp .env.example .env   # optional; create-wallet writes .env
npm run create-wallet
```

Fund the printed **public 0x** on Sepolia. Do not run the cycle until funded and approved.

## Run cycle (after human approval)

```bash
APPROVE_TRANSACTIONS=1 npm run cycle
```

If artifact download from the default IPFS gateway fails (502/timeout), retry with:

```bash
APPROVE_TRANSACTIONS=1 RAILGUN_IPFS_GATEWAY=https://ipfs.filebase.io npm run cycle
# or after a successful shield:
APPROVE_TRANSACTIONS=1 RAILGUN_IPFS_GATEWAY=https://ipfs.filebase.io npm run resume
```

Writes `RESULT.md`. Never commits `.env`. See `RESULT.md` for the 2026-10-16 Sepolia outcome (shield/scan/proof OK; unshield tx reverted — likely issue #120).
