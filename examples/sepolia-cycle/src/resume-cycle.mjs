/**
 * Resume after a successful shield: scan → unshield proof → submit.
 * Set SKIP_SHIELD=1 and SHIELD_TX_HASH to record prior shield.
 */
import {
  calculateGasPrice,
  EVMGasType,
  getEVMGasTypeForTransaction,
  NETWORK_CONFIG,
  TXIDVersion,
} from '@railgun-community/shared-models';
import {
  balanceForERC20Token,
  gasEstimateForUnprovenUnshield,
  generateUnshieldProof,
  getTXOsReceivedPOIStatusInfoForWallet,
  loadWalletByID,
  populateProvedUnshield,
  refreshBalances,
  setOnBalanceUpdateCallback,
  setOnTXIDMerkletreeScanCallback,
  setOnUTXOMerkletreeScanCallback,
  setOnWalletPOIProofProgressCallback,
  stopRailgunEngine,
  walletForID,
} from '@railgun-community/wallet';
import {
  JsonRpcProvider,
  Wallet,
  parseEther,
  formatEther,
} from 'ethers';
import {
  NETWORK,
  NETWORK_INFO,
  IS_MAINNET,
  RPC_URL,
  ETHERSCAN_TX_BASE,
  UNSHIELD_ETH,
  WETH_ADDRESS,
} from './load-env.mjs';
import { startEngine, stopEngine } from './engine.mjs';
import { writeResultMarkdown } from './write-result.mjs';

const TXID = TXIDVersion.V2_PoseidonMerkle;

// Keep process alive through engine PPOI refresh throws
process.on('uncaughtException', (err) => {
  console.warn('[uncaughtException]', err?.message ?? err);
});
process.on('unhandledRejection', (err) => {
  console.warn('[unhandledRejection]', err?.message ?? err);
});

async function gasDetailsForEstimate(network, gasEstimate, sendWithPublicWallet) {
  const evmGasType = getEVMGasTypeForTransaction(network, sendWithPublicWallet);
  const provider = new JsonRpcProvider(RPC_URL);
  const fee = await provider.getFeeData();
  if (evmGasType === EVMGasType.Type2) {
    return {
      evmGasType,
      gasEstimate,
      maxFeePerGas:
        ((fee.maxFeePerGas ?? fee.gasPrice ?? 2_000_000_000n) * 150n) / 100n,
      maxPriorityFeePerGas:
        ((fee.maxPriorityFeePerGas ?? 100_000_000n) * 150n) / 100n,
    };
  }
  return {
    evmGasType,
    gasEstimate,
    gasPrice: ((fee.gasPrice ?? 2_000_000_000n) * 150n) / 100n,
  };
}

async function waitForSpendable({
  railgunWalletId,
  tokenAddress,
  minAmount,
  timeoutMs = Number(process.env.SCAN_TIMEOUT_MS || (IS_MAINNET ? 120 : 45) * 60 * 1000),
  pollMs = 20_000,
}) {
  const chain = NETWORK_CONFIG[NETWORK].chain;
  const start = Date.now();
  let lastPpoi = null;
  let lastBuckets = null;
  const wallet = walletForID(railgunWalletId);

  setOnUTXOMerkletreeScanCallback((d) =>
    console.log('[utxo-scan]', JSON.stringify(d)),
  );
  setOnTXIDMerkletreeScanCallback((d) =>
    console.log('[txid-scan]', JSON.stringify(d)),
  );
  setOnBalanceUpdateCallback((balances) => {
    console.log(
      '[balance-update]',
      JSON.stringify(balances, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    );
    lastBuckets = balances;
  });
  setOnWalletPOIProofProgressCallback((info) => {
    console.log('[ppoi-progress]', JSON.stringify(info));
  });

  while (Date.now() - start < timeoutMs) {
    try {
      await refreshBalances(chain, [railgunWalletId]);
    } catch (err) {
      console.warn('refreshBalances (non-fatal):', err?.message ?? err);
    }

    let total = 0n;
    let spendable = 0n;
    try {
      total = await balanceForERC20Token(
        TXID,
        wallet,
        NETWORK,
        tokenAddress,
        false,
      );
      spendable = await balanceForERC20Token(
        TXID,
        wallet,
        NETWORK,
        tokenAddress,
        true,
      );
    } catch (err) {
      console.warn('balanceForERC20Token:', err?.message ?? err);
    }

    try {
      lastPpoi = await getTXOsReceivedPOIStatusInfoForWallet(
        TXID,
        NETWORK,
        railgunWalletId,
      );
      console.log(
        'PPOI:',
        JSON.stringify(lastPpoi, (_k, v) =>
          typeof v === 'bigint' ? v.toString() : v,
        ),
      );
    } catch (err) {
      console.warn('PPOI status:', err?.message ?? err);
    }

    console.log(
      `WETH total=${formatEther(total)} spendable=${formatEther(spendable)} need≥${formatEther(minAmount)}`,
    );

    if (spendable >= minAmount) {
      return { total, spendable, ppoi: lastPpoi, buckets: lastBuckets };
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error(
    `Timed out waiting for spendable ≥ ${formatEther(minAmount)}. lastPpoi=${JSON.stringify(lastPpoi)} lastBuckets=${JSON.stringify(lastBuckets)}`,
  );
}

async function main() {
  if (process.env.APPROVE_TRANSACTIONS !== '1') {
    console.error('Set APPROVE_TRANSACTIONS=1');
    process.exit(1);
  }

  const mnemonic = process.env.MNEMONIC;
  const encryptionKey = process.env.ENCRYPTION_KEY;
  const railgunWalletId = process.env.RAILGUN_WALLET_ID;
  const railgunAddress = process.env.RAILGUN_ADDRESS;
  const shieldTxHash =
    process.env.SHIELD_TX_HASH ||
    '0x24939920ae63b78a7a08daf161fcb8c7101a4862271adc8109292eb8982ef94d';

  const result = {
    network: NETWORK,
    proxy: NETWORK_INFO.proxyContract,
    deploymentBlock: NETWORK_INFO.deploymentBlock,
    weth: WETH_ADDRESS,
    publicAddress: process.env.PUBLIC_ADDRESS,
    steps: {
      shield: {
        status: 'pass',
        txHash: shieldTxHash,
        etherscan: `${ETHERSCAN_TX_BASE}${shieldTxHash}`,
        amountEth: '0.01',
        note: 'Completed in prior run; resumed from scan',
      },
    },
    issue120: null,
    overall: 'incomplete',
  };

  console.log('Starting engine (resume from scan)…');
  await startEngine({ debug: true });
  await loadWalletByID(encryptionKey, railgunWalletId, false);

  const provider = new JsonRpcProvider(RPC_URL);
  const wallet = Wallet.fromPhrase(mnemonic, provider);
  console.log(
    `Public ETH: ${formatEther(await provider.getBalance(wallet.address))}`,
  );

  console.log('\n=== SCAN ===');
  try {
    const { total, spendable, ppoi } = await waitForSpendable({
      railgunWalletId,
      tokenAddress: WETH_ADDRESS,
      minAmount: parseEther(UNSHIELD_ETH),
    });
    result.steps.scan = {
      status: 'pass',
      shieldedWethTotal: formatEther(total),
      shieldedWethSpendable: formatEther(spendable),
      shieldedWeth: formatEther(spendable),
      ppoi: ppoi ?? 'none',
    };
  } catch (err) {
    result.steps.scan = { status: 'fail', error: String(err?.message ?? err) };
    result.overall = 'fail';
    await writeResultMarkdown(result);
    throw err;
  }

  console.log(`\n=== UNSHIELD ${UNSHIELD_ETH} ===`);
  const unshieldRecipient = {
    tokenAddress: WETH_ADDRESS,
    amount: parseEther(UNSHIELD_ETH),
    recipientAddress: wallet.address,
  };

  try {
    const sendWithPublicWallet = true;
    const originalGasDetails = await gasDetailsForEstimate(
      NETWORK,
      3_000_000n,
      sendWithPublicWallet,
    );
    const { gasEstimate } = await gasEstimateForUnprovenUnshield(
      TXID,
      NETWORK,
      railgunWalletId,
      encryptionKey,
      [unshieldRecipient],
      [],
      originalGasDetails,
      undefined,
      sendWithPublicWallet,
    );
    console.log('Unshield gasEstimate:', gasEstimate.toString());

    const transactionGasDetails = await gasDetailsForEstimate(
      NETWORK,
      gasEstimate,
      sendWithPublicWallet,
    );
    const overallBatchMinGasPrice = calculateGasPrice(transactionGasDetails);

    const proofStarted = Date.now();
    console.log('Generating unshield proof…');
    await generateUnshieldProof(
      TXID,
      NETWORK,
      railgunWalletId,
      encryptionKey,
      [unshieldRecipient],
      [],
      undefined,
      sendWithPublicWallet,
      overallBatchMinGasPrice,
      (progress) => console.log(`Proof progress: ${progress}`),
    );
    const proofMs = Date.now() - proofStarted;
    console.log(`Proof in ${(proofMs / 1000).toFixed(1)}s`);
    result.steps.unshieldProof = {
      status: 'pass',
      proofTimeMs: proofMs,
      proofTimeSec: Number((proofMs / 1000).toFixed(1)),
    };

    const populated = await populateProvedUnshield(
      TXID,
      NETWORK,
      railgunWalletId,
      [unshieldRecipient],
      [],
      undefined,
      sendWithPublicWallet,
      overallBatchMinGasPrice,
      transactionGasDetails,
    );
    const tx = await wallet.sendTransaction(populated.transaction);
    console.log('Unshield tx:', tx.hash);
    const receipt = await tx.wait();
    result.steps.unshieldSubmit = {
      status: 'pass',
      txHash: tx.hash,
      etherscan: `${ETHERSCAN_TX_BASE}${tx.hash}`,
      amountEth: UNSHIELD_ETH,
      blockNumber: receipt.blockNumber,
    };
    result.issue120 = false;
    result.overall = 'pass';
  } catch (err) {
    const msg = String(err?.message ?? err);
    const stack = String(err?.stack ?? '');
    const looks120 =
      /artifact|proof|circuit|snark|verification key|zkey|wasm|Prover|groth16/i.test(
        msg + stack,
      );
    if (!result.steps.unshieldProof) {
      result.steps.unshieldProof = { status: 'fail', error: msg, stack };
    } else {
      result.steps.unshieldSubmit = { status: 'fail', error: msg, stack };
    }
    result.issue120 = looks120
      ? 'possible — https://github.com/Railgun-Community/wallet/issues/120'
      : false;
    result.overall = 'fail';
    await writeResultMarkdown(result);
    throw err;
  }

  await writeResultMarkdown(result);
  console.log('\n=== CYCLE COMPLETE ===');
  console.log(JSON.stringify(result, null, 2));
  await stopEngine();
}

main().catch(async (err) => {
  console.error('\nRESUME FAILED:', err);
  try {
    await stopRailgunEngine();
  } catch {
    /* ignore */
  }
  // Keep RESULT if written; exit non-zero
  process.exit(1);
});
