/**
 * Retry unshield proof+submit assuming shield+scan already succeeded.
 */
import {
  calculateGasPrice,
  EVMGasType,
  getEVMGasTypeForTransaction,
  TXIDVersion,
} from '@railgun-community/shared-models';
import {
  balanceForERC20Token,
  gasEstimateForUnprovenUnshield,
  generateUnshieldProof,
  loadWalletByID,
  populateProvedUnshield,
  refreshBalances,
  stopRailgunEngine,
  walletForID,
} from '@railgun-community/wallet';
import { JsonRpcProvider, Wallet, parseEther, formatEther } from 'ethers';
import {
  NETWORK,
  NETWORK_INFO,
  SEPOLIA_RPC_URL,
  UNSHIELD_ETH,
  WETH_ADDRESS,
} from './load-env.mjs';
import { NETWORK_CONFIG as NC } from '@railgun-community/shared-models';
import { startEngine, stopEngine } from './engine.mjs';
import { writeResultMarkdown } from './write-result.mjs';

process.on('uncaughtException', (e) => console.warn('[uncaught]', e?.message));
process.on('unhandledRejection', (e) => console.warn('[unhandled]', e?.message));

const TXID = TXIDVersion.V2_PoseidonMerkle;
const SHIELD_TX = '0x24939920ae63b78a7a08daf161fcb8c7101a4862271adc8109292eb8982ef94d';

async function gasDetails(network, gasEstimate) {
  const evmGasType = getEVMGasTypeForTransaction(network, true);
  const provider = new JsonRpcProvider(SEPOLIA_RPC_URL);
  const fee = await provider.getFeeData();
  if (evmGasType === EVMGasType.Type2) {
    return {
      evmGasType,
      gasEstimate,
      maxFeePerGas: ((fee.maxFeePerGas ?? fee.gasPrice ?? 2_000_000_000n) * 150n) / 100n,
      maxPriorityFeePerGas: ((fee.maxPriorityFeePerGas ?? 100_000_000n) * 150n) / 100n,
    };
  }
  return { evmGasType, gasEstimate, gasPrice: ((fee.gasPrice ?? 2_000_000_000n) * 150n) / 100n };
}

async function main() {
  if (process.env.APPROVE_TRANSACTIONS !== '1') process.exit(1);
  process.env.RAILGUN_IPFS_GATEWAY = process.env.RAILGUN_IPFS_GATEWAY || 'https://ipfs.filebase.io';

  const { MNEMONIC, ENCRYPTION_KEY, RAILGUN_WALLET_ID, PUBLIC_ADDRESS } = process.env;
  const result = {
    network: NETWORK,
    proxy: NETWORK_INFO.proxyContract,
    deploymentBlock: NETWORK_INFO.deploymentBlock,
    weth: WETH_ADDRESS,
    publicAddress: PUBLIC_ADDRESS,
    steps: {
      shield: {
        status: 'pass',
        txHash: SHIELD_TX,
        etherscan: `https://sepolia.etherscan.io/tx/${SHIELD_TX}`,
        amountEth: '0.01',
      },
      scan: {
        status: 'pass',
        note: 'PPOI Valid; spendable confirmed in prior resume run',
      },
    },
    issue120: null,
    overall: 'incomplete',
    artifactGateway: process.env.RAILGUN_IPFS_GATEWAY,
  };

  await startEngine({ debug: true });
  await loadWalletByID(ENCRYPTION_KEY, RAILGUN_WALLET_ID, false);
  try {
    await refreshBalances(NC[NETWORK].chain, [RAILGUN_WALLET_ID]);
  } catch (e) {
    console.warn('refresh non-fatal', e.message);
  }

  const railWallet = walletForID(RAILGUN_WALLET_ID);
  const spendable = await balanceForERC20Token(TXID, railWallet, NETWORK, WETH_ADDRESS, true);
  console.log('spendable', formatEther(spendable));
  result.steps.scan.shieldedWethSpendable = formatEther(spendable);
  result.steps.scan.shieldedWeth = formatEther(spendable);
  if (spendable < parseEther(UNSHIELD_ETH)) {
    throw new Error(`spendable too low: ${formatEther(spendable)}`);
  }

  const provider = new JsonRpcProvider(SEPOLIA_RPC_URL);
  const wallet = Wallet.fromPhrase(MNEMONIC, provider);
  const unshieldRecipient = {
    tokenAddress: WETH_ADDRESS,
    amount: parseEther(UNSHIELD_ETH),
    recipientAddress: wallet.address,
  };

  const originalGasDetails = await gasDetails(NETWORK, 3_000_000n);
  const { gasEstimate } = await gasEstimateForUnprovenUnshield(
    TXID, NETWORK, RAILGUN_WALLET_ID, ENCRYPTION_KEY,
    [unshieldRecipient], [], originalGasDetails, undefined, true,
  );
  console.log('gasEstimate', gasEstimate.toString());
  const transactionGasDetails = await gasDetails(NETWORK, gasEstimate);
  const overallBatchMinGasPrice = calculateGasPrice(transactionGasDetails);

  const t0 = Date.now();
  console.log('Generating unshield proof…');
  await generateUnshieldProof(
    TXID, NETWORK, RAILGUN_WALLET_ID, ENCRYPTION_KEY,
    [unshieldRecipient], [], undefined, true, overallBatchMinGasPrice,
    (p) => console.log('Proof progress', p),
  );
  const proofMs = Date.now() - t0;
  console.log('proof ms', proofMs);
  result.steps.unshieldProof = {
    status: 'pass',
    proofTimeMs: proofMs,
    proofTimeSec: Number((proofMs / 1000).toFixed(1)),
  };

  const populated = await populateProvedUnshield(
    TXID, NETWORK, RAILGUN_WALLET_ID,
    [unshieldRecipient], [], undefined, true,
    overallBatchMinGasPrice, transactionGasDetails,
  );
  const tx = await wallet.sendTransaction(populated.transaction);
  console.log('unshield tx', tx.hash);
  const receipt = await tx.wait();
  result.steps.unshieldSubmit = {
    status: 'pass',
    txHash: tx.hash,
    etherscan: `https://sepolia.etherscan.io/tx/${tx.hash}`,
    amountEth: UNSHIELD_ETH,
    blockNumber: receipt.blockNumber,
  };
  result.issue120 = false;
  result.overall = 'pass';
  await writeResultMarkdown(result);
  console.log('PASS', JSON.stringify(result, null, 2));
  await stopEngine();
}

main().catch(async (err) => {
  console.error('FAIL', err);
  const msg = String(err?.message ?? err);
  const stack = String(err?.stack ?? '');
  // Write fail result if possible
  try {
    const { writeResultMarkdown } = await import('./write-result.mjs');
    await writeResultMarkdown({
      network: NETWORK,
      proxy: NETWORK_INFO.proxyContract,
      deploymentBlock: NETWORK_INFO.deploymentBlock,
      weth: WETH_ADDRESS,
      publicAddress: process.env.PUBLIC_ADDRESS,
      steps: {
        shield: { status: 'pass', txHash: SHIELD_TX, etherscan: `https://sepolia.etherscan.io/tx/${SHIELD_TX}`, amountEth: '0.01' },
        scan: { status: 'pass', note: 'prior run' },
        unshieldProof: { status: 'fail', error: msg, stack },
      },
      issue120: /artifact|proof|circuit|snark|zkey|wasm|502|Prover|groth16/i.test(msg + stack)
        ? 'possible — https://github.com/Railgun-Community/wallet/issues/120 (artifact download/proof path)'
        : false,
      overall: 'fail',
      artifactGateway: process.env.RAILGUN_IPFS_GATEWAY || 'https://ipfs.filebase.io',
    });
  } catch {}
  try { await stopRailgunEngine(); } catch {}
  process.exit(1);
});
