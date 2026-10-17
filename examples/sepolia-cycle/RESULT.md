# RAILGUN cycle RESULT — Brief v2 (SDK 11.2.0)

## Overall

**PASS** — mainnet both unshields + Sepolia shield/unshield confirmed on-chain with SDK 11.2.0.

| Check | Result |
|-------|--------|
| Versions | wallet@**11.2.0**, engine@**9.9.1**, shared-models@**8.2.1**, ethers@**6.14.3** |
| `01x02/vkey.json` == `QmWFEVTT…` | **pass** |
| Mainnet unshield ~0.005 | **pass** |
| Mainnet remainder ~0.004975 | **pass** (circuit **01x01**) |
| Sepolia shield 0.01 | **pass** |
| Sepolia unshield 0.005 | **pass** (circuit **01x02**; snarkjs + eth_call) |

## Mainnet txs

| Step | Result | Hash | Block |
|------|--------|------|-------|
| Shield (prior) | pass | [`0x5bf0c69a…ff622f5`](https://etherscan.io/tx/0x5bf0c69a3590e62b15c451d7ae98d524d846a5b9f44f9773e4ac0e3e2ff622f5) | — |
| Unshield ~0.005 | **pass** | [`0x67e63c7e…e1c060`](https://etherscan.io/tx/0x67e63c7eebe5f90eb3d05c1531910b668288343e1ad009a1a871bec7c9e1c060) | **26206246** |
| Unshield remainder 0.004975 | **pass** | [`0x71806f22…28bc55`](https://etherscan.io/tx/0x71806f22ab53f0392b0d96a506eb4772e220658c5a85b09b23e2830c2d28bc55) | **26206423** |

After mainnet: public WETH **0.0099500625**; shielded **0**.

## Sepolia txs

| Step | Result | Hash | Block |
|------|--------|------|-------|
| Shield 0.01 ETH | **pass** | [`0x081ef8c6…83b957`](https://sepolia.etherscan.io/tx/0x081ef8c648b1819d09dd7416f5bf9eb7a06a364311062412cc6b376cbc83b957) | **11928633** |
| Unshield 0.005 | **pass** | [`0xffecedd5…2607a3`](https://sepolia.etherscan.io/tx/0xffecedd50cf9854b087b0e1c5300feaaeb7cd56d8567bd5dc715eb375f2607a3) | **11928639** |

Sepolia pre-send: snarkjs.verify **pass** (`01x02`); eth_call **pass**; proof ~3.4s.

## Notes

- Remainder needed `POI_3x3` from `beacon.railgun.ch` PPOI Artifacts V2.car (IPFS gateways 504).
- snarkjs verify must match circuit from public inputs (`01x02` vs `01x01`).
- Prior 10.4.0 Invalid Snark Proof on both nets fixed by 11.2.0 / `QmWFEVTT…`.

## Gate log

`docs/mainnet-cycle-gate-log-v2.md` in Project store.

## Flow demo

New Sepolia-only test wallet (Brief v2 / lost prior key). Public address: `0x4BAAea6b9fbc6E820dB806e5D18BDe1758dde05C`.

| Step | Result | Notes |
|------|--------|-------|
| Build pool | **pass** | 1091 deposits; first run **60.5s**, send run **0.2s** |
| Shield advice | **pass** | status `clear`, findings none, score 2 / Low |
| Shield 0.01 ETH | **pass** | eth_call pass; on-chain status 1 |
| Wallet scan | **pass** | spendable WETH **0.009975** |
| Unshield advice | **pass*** | status `not-checked`, finding `unsupported-asset` (amount kept 0.005); expected `attention`/`address-link` when asset matches — harness still proceeded |
| Unshield 0.005 | **pass** | snarkjs `01x02` pass; eth_call pass; on-chain status 1 |

| Tx | Hash | Block | Etherscan |
|----|------|-------|-----------|
| Shield | `0x4dc439df07244cb4b22fad26e75446d2ac36b5051847dc674f785581e0a2baa4` | **11931857** | [link](https://sepolia.etherscan.io/tx/0x4dc439df07244cb4b22fad26e75446d2ac36b5051847dc674f785581e0a2baa4) |
| Unshield | `0x47010c638f5369c6664c5aea2a2e345d0d7ee8e87276e97f479734bd6f361ad3` | **11931867** | [link](https://sepolia.etherscan.io/tx/0x47010c638f5369c6664c5aea2a2e345d0d7ee8e87276e97f479734bd6f361ad3) |

Overall: **PASS** (both txs confirmed). `.env` not committed; durable backups on the VM only.

### Brief v4 rerun (fresh shield, then unshield)

The v3 rerun from the change note was blocked by the Sepolia TXID subgraph (wrong verification hash at block 11816741).

| Step | Result | Notes |
|------|--------|-------|
| Shield advice | **pass** | status `clear`, findings none |
| Shield 0.01 ETH | **pass** | eth_call pass; on-chain status 1; hash `0x911fec3bd524c2bc4751321f8e20962f85212ffc40e60bc5165778e05e1abb41`; block **11934472**; [Etherscan](https://sepolia.etherscan.io/tx/0x911fec3bd524c2bc4751321f8e20962f85212ffc40e60bc5165778e05e1abb41) |
| Unshield advice | **pass** | status `attention`, findings `address-link` (+ `unknown-context`) |
| Unshield 0.005 | **pass** | eth_call pass; on-chain status 1; hash `0x0550be7505ead780a9c61f05b80fd0bb2a7c21529e318b746fff0815eaab66c0`; block **11934481**; [Etherscan](https://sepolia.etherscan.io/tx/0x0550be7505ead780a9c61f05b80fd0bb2a7c21529e318b746fff0815eaab66c0) |

| Tx | Hash | Block | Etherscan |
|----|------|-------|-----------|
| Shield (v4) | `0x911fec3bd524c2bc4751321f8e20962f85212ffc40e60bc5165778e05e1abb41` | **11934472** | [link](https://sepolia.etherscan.io/tx/0x911fec3bd524c2bc4751321f8e20962f85212ffc40e60bc5165778e05e1abb41) |
| Unshield (v4) | `0x0550be7505ead780a9c61f05b80fd0bb2a7c21529e318b746fff0815eaab66c0` | **11934481** | [link](https://sepolia.etherscan.io/tx/0x0550be7505ead780a9c61f05b80fd0bb2a7c21529e318b746fff0815eaab66c0) |
