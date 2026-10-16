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
