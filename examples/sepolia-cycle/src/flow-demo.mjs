/**
 * The real wallet flow on Sepolia:
 * 1. Build the pool from the wallet's own RPC (@railcheck/builder).
 * 2. Get advice before prepareUnshield (@railcheck/kohaku guard).
 * 3. Prove and simulate the unshield. Send only with --send and APPROVE_TRANSACTIONS=1.
 * Run: node src/flow-demo.mjs [--send]
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  calculateGasPrice,
  EVMGasType,
  getEVMGasTypeForTransaction,
  NETWORK_CONFIG,
  NetworkName,
  TXIDVersion,
} from '@railgun-community/shared-models';
import {
  balanceForERC20Token,
  gasEstimateForUnprovenUnshield,
  generateUnshieldProof,
  loadWalletByID,
  populateProvedUnshield,
  refreshBalances,
  walletForID,
} from '@railgun-community/wallet';
import { JsonRpcProvider, Wallet, parseEther, formatEther } from 'ethers';
import { buildPool } from '@railcheck/builder';
import { prepare, toJSON } from '@railcheck/core';
import { guard } from '@railcheck/kohaku';
import {
  NETWORK,
  RPC_URL,
  ETHERSCAN_TX_BASE,
  UNSHIELD_ETH,
  WETH_ADDRESS,
  ROOT_DIR,
} from './load-env.mjs';
import { startEngine, stopEngine } from './engine.mjs';

const TXID = TXIDVersion.V2_PoseidonMerkle;
const SEND = process.argv.includes('--send') && process.env.APPROVE_TRANSACTIONS === '1';
const POOL_STATE = path.join(ROOT_DIR, 'pool-state.json');
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

if (NETWORK !== NetworkName.EthereumSepolia) throw Error('This demo runs on Sepolia only.');

// The wallet's own storage. Here: a local file that git ignores.
const store = {
  get: async () => (fs.existsSync(POOL_STATE) ? JSON.parse(fs.readFileSync(POOL_STATE, 'utf8')) : null),
  set: async (state) => fs.writeFileSync(POOL_STATE, JSON.stringify(state)),
};

async function gasDetails(gasEstimate) {
  const fee = await new JsonRpcProvider(RPC_URL).getFeeData();
  const pad = (x) => (x * 130n) / 100n;
  return getEVMGasTypeForTransaction(NETWORK, true) === EVMGasType.Type2
    ? {
        evmGasType: EVMGasType.Type2,
        gasEstimate,
        maxFeePerGas: pad(fee.maxFeePerGas ?? 2_000_000_000n),
        maxPriorityFeePerGas: pad(fee.maxPriorityFeePerGas ?? 100_000_000n),
      }
    : { evmGasType: getEVMGasTypeForTransaction(NETWORK, true), gasEstimate, gasPrice: pad(fee.gasPrice ?? 2_000_000_000n) };
}

async function main() {
  console.log('\n=== 1. BUILD POOL (own RPC) ===');
  const t0 = Date.now();
  const built = await buildPool({ chain: 'sepolia', urls: [RPC_URL], store, onProgress: console.log });
  const pool = prepare(built.deposits, { snapshot: built.snapshot, asset: built.asset });
  console.log(`Pool: ${built.deposits.length} deposits, block ${built.snapshot.block}, ${(Date.now() - t0) / 1000} s`);

  console.log('\n=== 2. WALLET ===');
  const { MNEMONIC, ENCRYPTION_KEY, RAILGUN_WALLET_ID } = process.env;
  if (!MNEMONIC || !ENCRYPTION_KEY || !RAILGUN_WALLET_ID) throw Error('Missing wallet values in .env.');
  await startEngine({ debug: false });
  await loadWalletByID(ENCRYPTION_KEY, RAILGUN_WALLET_ID, false);
  const provider = new JsonRpcProvider(RPC_URL);
  const signer = Wallet.fromPhrase(MNEMONIC, provider);
  const amount = parseEther(UNSHIELD_ETH);
  const chain = NETWORK_CONFIG[NETWORK].chain;
  let spendable = 0n;
  for (let i = 0; i < 90 && spendable < amount; i++) {
    await refreshBalances(chain, [RAILGUN_WALLET_ID]).catch(() => {});
    spendable = await balanceForERC20Token(TXID, walletForID(RAILGUN_WALLET_ID), NETWORK, WETH_ADDRESS, true).catch(() => 0n);
    console.log(`Spendable WETH: ${formatEther(spendable)}`);
    if (spendable < amount) await new Promise((r) => setTimeout(r, 20_000));
  }
  if (spendable < amount) throw Error('Not enough spendable WETH.');

  // A minimal Kohaku-style plugin: prepareUnshield proves and populates the transaction.
  const plugin = {
    async prepareUnshield(assetAmount, to) {
      const recipient = { tokenAddress: assetAmount.asset.contract, amount: assetAmount.amount, recipientAddress: to };
      const { gasEstimate } = await gasEstimateForUnprovenUnshield(
        TXID, NETWORK, RAILGUN_WALLET_ID, ENCRYPTION_KEY, [recipient], [], await gasDetails(3_000_000n), undefined, true,
      );
      const gas = await gasDetails(gasEstimate);
      const minGasPrice = calculateGasPrice(gas);
      await generateUnshieldProof(TXID, NETWORK, RAILGUN_WALLET_ID, ENCRYPTION_KEY, [recipient], [], undefined, true, minGasPrice, () => {});
      return populateProvedUnshield(TXID, NETWORK, RAILGUN_WALLET_ID, [recipient], [], undefined, true, minGasPrice, gas);
    },
  };

  console.log('\n=== 3. ADVICE BEFORE prepareUnshield ===');
  let advice;
  const safe = guard(plugin, {
    pool,
    constraint: 'fixed',
    // The recipient is the address that shielded, so the wallet knows this is an address link.
    getContext: async (_a, to) => ({ addressReuse: to.toLowerCase() === signer.address.toLowerCase() }),
    onAdvice: async (a) => {
      advice = a;
      console.log(json(toJSON(a)));
      return null; // keep the requested amount
    },
  });
  const populated = await safe.prepareUnshield(
    { asset: { __type: 'erc20', contract: WETH_ADDRESS }, amount },
    signer.address,
  );

  console.log('\n=== 4. SIMULATE ===');
  await provider.call({ to: populated.transaction.to, from: signer.address, data: populated.transaction.data });
  console.log('eth_call: pass');

  const report = {
    network: NETWORK,
    pool: { deposits: built.deposits.length, snapshot: built.snapshot },
    advice: toJSON(advice),
    simulate: 'pass',
  };
  if (SEND) {
    console.log('\n=== 5. SEND ===');
    const tx = await signer.sendTransaction(populated.transaction);
    const receipt = await tx.wait();
    report.send = { status: receipt.status === 1 ? 'pass' : 'fail', hash: tx.hash, block: receipt.blockNumber, link: ETHERSCAN_TX_BASE + tx.hash };
    console.log(json(report.send));
  } else console.log('\nNot sent. To send: APPROVE_TRANSACTIONS=1 node src/flow-demo.mjs --send');
  fs.writeFileSync(path.join(ROOT_DIR, 'flow-demo-report.json'), json(report));
  await stopEngine();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('FAIL', err?.message ?? err);
  await stopEngine();
  process.exit(1);
});
