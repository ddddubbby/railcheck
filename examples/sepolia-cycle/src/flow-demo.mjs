/**
 * The real wallet flow on Sepolia:
 * 1. Build the pool from the wallet's own RPC (@railcheck/builder).
 * 2. With --shield: get advice before prepareShield, then shield SHIELD_ETH.
 * 3. Get advice before prepareUnshield (@railcheck/kohaku guard).
 * 4. Prove and simulate the unshield.
 * Transactions go out only with --send and APPROVE_TRANSACTIONS=1.
 * Run: node src/flow-demo.mjs [--shield] [--send]
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
  gasEstimateForShieldBaseToken,
  gasEstimateForUnprovenUnshield,
  getShieldPrivateKeySignatureMessage,
  generateUnshieldProof,
  loadWalletByID,
  populateProvedUnshield,
  populateShieldBaseToken,
  refreshBalances,
  walletForID,
} from '@railgun-community/wallet';
import { JsonRpcProvider, Wallet, parseEther, formatEther, keccak256 } from 'ethers';
import { buildPool } from '@railcheck/builder';
import { prepare, toJSON } from '@railcheck/core';
import { guard } from '@railcheck/kohaku';
import {
  NETWORK,
  RPC_URL,
  ETHERSCAN_TX_BASE,
  SHIELD_ETH,
  UNSHIELD_ETH,
  WETH_ADDRESS,
  ROOT_DIR,
} from './load-env.mjs';
import { startEngine, stopEngine } from './engine.mjs';

const TXID = TXIDVersion.V2_PoseidonMerkle;
const SEND = process.argv.includes('--send') && process.env.APPROVE_TRANSACTIONS === '1';
const SHIELD = process.argv.includes('--shield');
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
  if (!MNEMONIC || !ENCRYPTION_KEY || !RAILGUN_WALLET_ID || !process.env.RAILGUN_ADDRESS)
    throw Error('Missing wallet values in .env. Run npm run create-wallet.');
  await startEngine({ debug: false });
  await loadWalletByID(ENCRYPTION_KEY, RAILGUN_WALLET_ID, false);
  const provider = new JsonRpcProvider(RPC_URL);
  const signer = Wallet.fromPhrase(MNEMONIC, provider);
  const report = { network: NETWORK, pool: { deposits: built.deposits.length, snapshot: built.snapshot } };
  const ask = (label) => async (a) => {
    report[label] = toJSON(a);
    console.log(json(report[label]));
    // The demo proves real advice: stop before any transaction if the pool did not check.
    if (a.assessment.status === 'not-checked') throw Error(`${label}: not-checked. Nothing sent.`);
    return null; // keep the requested amount
  };

  // A minimal Kohaku-style plugin: prepare* returns a populated transaction.
  const plugin = {
    async prepareShield(assetAmount, to) {
      const key = keccak256(await signer.signMessage(getShieldPrivateKeySignatureMessage()));
      const erc20 = { tokenAddress: WETH_ADDRESS, amount: assetAmount.amount };
      const { gasEstimate } = await gasEstimateForShieldBaseToken(TXID, NETWORK, to, key, erc20, signer.address);
      return populateShieldBaseToken(TXID, NETWORK, to, key, erc20, await gasDetails(gasEstimate));
    },
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
  const simulateAndSend = async (label, populated) => {
    const { to, data, value } = populated.transaction;
    await provider.call({ to, data, value, from: signer.address });
    console.log('eth_call: pass');
    report[label] = { simulate: 'pass' };
    if (!SEND) return false;
    const tx = await signer.sendTransaction(populated.transaction);
    const receipt = await tx.wait();
    Object.assign(report[label], { status: receipt.status === 1 ? 'pass' : 'fail', hash: tx.hash, block: receipt.blockNumber, link: ETHERSCAN_TX_BASE + tx.hash });
    console.log(json(report[label]));
    if (receipt.status !== 1) throw Error(`${label} failed on-chain.`);
    return true;
  };

  if (SHIELD) {
    console.log('\n=== 3. ADVICE BEFORE prepareShield ===');
    const safe = guard(plugin, { pool, constraint: 'fixed', onAdvice: ask('shieldAdvice') });
    const populated = await safe.prepareShield({ asset: { __type: 'native' }, amount: parseEther(SHIELD_ETH) }, process.env.RAILGUN_ADDRESS);
    console.log('\n=== 4. SHIELD ===');
    if (!(await simulateAndSend('shield', populated))) return finish('Shield not sent. To send: add --send and APPROVE_TRANSACTIONS=1.');
  }

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

  console.log('\n=== 5. ADVICE BEFORE prepareUnshield ===');
  const safe = guard(plugin, {
    pool,
    constraint: 'fixed',
    // The recipient is the address that shielded, so the wallet knows this is an address link.
    getContext: async (_a, to) => ({ addressReuse: to.toLowerCase() === signer.address.toLowerCase() }),
    onAdvice: ask('unshieldAdvice'),
  });
  const populated = await safe.prepareUnshield(
    { asset: { __type: 'erc20', contract: WETH_ADDRESS }, amount },
    signer.address,
  );

  console.log('\n=== 6. UNSHIELD ===');
  if (!(await simulateAndSend('unshield', populated))) return finish('Unshield not sent. To send: add --send and APPROVE_TRANSACTIONS=1.');
  return finish('Done.');

  async function finish(message) {
    console.log(`\n${message}`);
    fs.writeFileSync(path.join(ROOT_DIR, 'flow-demo-report.json'), json(report));
    await stopEngine();
    process.exit(0);
  }
}
main().catch(async (err) => {
  console.error('FAIL', err?.message ?? err);
  await stopEngine();
  process.exit(1);
});
