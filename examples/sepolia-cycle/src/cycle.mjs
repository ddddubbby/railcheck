/**
 * One Sepolia cycle: shield → scan balance → unshield proof → submit.
 *
 * Requires .env from create-wallet and APPROVE_TRANSACTIONS=1.
 */
import {
  calculateGasPrice,
  EVMGasType,
  getEVMGasTypeForTransaction,
  NETWORK_CONFIG,
  TXIDVersion,
} from '@railgun-community/shared-models';
import fs from 'node:fs';
import path from 'node:path';
import {
  balanceForERC20Token,
  gasEstimateForShieldBaseToken,
  gasEstimateForUnprovenUnshield,
  generateUnshieldProof,
  getProver,
  getShieldPrivateKeySignatureMessage,
  getTXOsReceivedPOIStatusInfoForWallet,
  loadWalletByID,
  populateProvedUnshield,
  populateShieldBaseToken,
  refreshBalances,
  setOnBalanceUpdateCallback,
  setOnTXIDMerkletreeScanCallback,
  setOnUTXOMerkletreeScanCallback,
  setOnWalletPOIProofProgressCallback,
  stopRailgunEngine,
  walletForID,
} from '@railgun-community/wallet';
import { groth16 } from 'snarkjs';
import {
  JsonRpcProvider,
  Wallet,
  parseEther,
  formatEther,
  keccak256,
  Interface,
} from 'ethers';
import {
  NETWORK,
  NETWORK_INFO,
  IS_MAINNET,
  RPC_URL,
  ETHERSCAN_TX_BASE,
  SHIELD_ETH,
  UNSHIELD_ETH,
  WETH_ADDRESS,
  ARTIFACTS_PATH,
  ROOT_DIR,
} from './load-env.mjs';
import { startEngine, stopEngine } from './engine.mjs';
import { writeResultMarkdown } from './write-result.mjs';

const TXID = TXIDVersion.V2_PoseidonMerkle;

process.on('uncaughtException', (e) => console.warn('[uncaught]', e?.message));
process.on('unhandledRejection', (e) =>
  console.warn('[unhandled]', e?.message ?? e),
);

function circuitDirFromPublicInputs(publicInputs) {
  const n = publicInputs?.nullifiers?.length ?? 0;
  const c = publicInputs?.commitmentsOut?.length ?? 0;
  return `${String(n).padStart(2, '0')}x${String(c).padStart(2, '0')}`;
}

function installProofCapture() {
  const prover = getProver();
  const captured = { proof: null, publicInputs: null };
  const orig = prover.verifyRailgunProof.bind(prover);
  prover.verifyRailgunProof = async (publicInputs, proof, artifacts) => {
    captured.proof = proof;
    captured.publicInputs = publicInputs;
    return orig(publicInputs, proof, artifacts);
  };
  return captured;
}

function toSnarkjsProof(proof) {
  if (proof.pi_a) return proof;
  const a = proof.a;
  const b = proof.b;
  const c = proof.c;
  const ax = a.x ?? a[0];
  const ay = a.y ?? a[1];
  const cx = c.x ?? c[0];
  const cy = c.y ?? c[1];
  const bx = b.x ?? b[0];
  const by = b.y ?? b[1];
  return {
    pi_a: [ax.toString(), ay.toString(), '1'],
    pi_b: [
      [bx[1].toString(), bx[0].toString()],
      [by[1].toString(), by[0].toString()],
      ['1', '0'],
    ],
    pi_c: [cx.toString(), cy.toString(), '1'],
    protocol: 'groth16',
    curve: 'bn128',
  };
}

function publicSignalsFromInputs(publicInputs) {
  return [
    publicInputs.merkleRoot,
    publicInputs.boundParamsHash,
    ...publicInputs.nullifiers,
    ...publicInputs.commitmentsOut,
  ].map((x) => (typeof x === 'bigint' ? x.toString() : BigInt(x).toString()));
}

async function getShieldPrivateKey(wallet) {
  const message = getShieldPrivateKeySignatureMessage();
  const signature = await wallet.signMessage(message);
  return keccak256(signature);
}

async function gasDetailsForEstimate(network, gasEstimate, sendWithPublicWallet) {
  const evmGasType = getEVMGasTypeForTransaction(network, sendWithPublicWallet);
  const provider = new JsonRpcProvider(RPC_URL);
  const fee = await provider.getFeeData();

  // Pad fees for reliability (mainnet fees already low; keep modest pad)
  const pad = IS_MAINNET ? 130n : 150n;
  if (evmGasType === EVMGasType.Type2) {
    const maxFeePerGas =
      ((fee.maxFeePerGas ?? fee.gasPrice ?? 2_000_000_000n) * pad) / 100n;
    const maxPriorityFeePerGas =
      ((fee.maxPriorityFeePerGas ?? 100_000_000n) * pad) / 100n;
    return {
      evmGasType,
      gasEstimate,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };
  }

  return {
    evmGasType,
    gasEstimate,
    gasPrice: ((fee.gasPrice ?? 2_000_000_000n) * pad) / 100n,
  };
}

async function waitForShieldedBalance({
  railgunWalletId,
  tokenAddress,
  minAmount,
  timeoutMs = 30 * 60 * 1000,
  pollMs = 15_000,
}) {
  const chain = NETWORK_CONFIG[NETWORK].chain;
  const start = Date.now();
  let lastPpoi = null;
  const wallet = walletForID(railgunWalletId);

  setOnUTXOMerkletreeScanCallback((scanData) => {
    console.log('[utxo-scan]', JSON.stringify(scanData));
  });
  setOnTXIDMerkletreeScanCallback((scanData) => {
    console.log('[txid-scan]', JSON.stringify(scanData));
  });
  setOnBalanceUpdateCallback((balances) => {
    console.log(
      '[balance-update]',
      JSON.stringify(balances, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    );
  });
  setOnWalletPOIProofProgressCallback((...args) => {
    console.log('[ppoi-progress]', args);
  });

  while (Date.now() - start < timeoutMs) {
    try {
      await refreshBalances(chain, [railgunWalletId]);
    } catch (err) {
      console.warn('refreshBalances:', err?.message ?? err);
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
      const poiInfo = await getTXOsReceivedPOIStatusInfoForWallet(
        TXID,
        NETWORK,
        railgunWalletId,
      );
      lastPpoi = poiInfo;
      console.log(
        'PPOI received status:',
        JSON.stringify(poiInfo, (_k, v) =>
          typeof v === 'bigint' ? v.toString() : v,
        ),
      );
    } catch (err) {
      console.warn('PPOI status:', err?.message ?? err);
    }

    console.log(
      `Shielded WETH total=${formatEther(total)} spendable=${formatEther(spendable)} (need ≥ ${formatEther(minAmount)} spendable)`,
    );

    if (spendable >= minAmount) {
      return { total, spendable, ppoi: lastPpoi };
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error(
    `Timed out waiting for spendable ≥ ${formatEther(minAmount)}. lastPpoi=${JSON.stringify(lastPpoi, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
  );
}

async function main() {
  if (process.env.APPROVE_TRANSACTIONS !== '1') {
    console.error(
      'Refusing to send txs. Set APPROVE_TRANSACTIONS=1 after explicit human approval.',
    );
    process.exit(1);
  }

  const mnemonic = process.env.MNEMONIC;
  const encryptionKey = process.env.ENCRYPTION_KEY;
  const railgunWalletId = process.env.RAILGUN_WALLET_ID;
  const railgunAddress = process.env.RAILGUN_ADDRESS;

  if (!mnemonic || !encryptionKey || !railgunWalletId || !railgunAddress) {
    throw new Error(
      'Missing MNEMONIC / ENCRYPTION_KEY / RAILGUN_WALLET_ID / RAILGUN_ADDRESS in .env',
    );
  }
  if (!WETH_ADDRESS) throw new Error('WETH address missing from NETWORK_CONFIG');

  const result = {
    network: NETWORK,
    proxy: NETWORK_INFO.proxyContract,
    deploymentBlock: NETWORK_INFO.deploymentBlock,
    weth: WETH_ADDRESS,
    publicAddress: process.env.PUBLIC_ADDRESS,
    steps: {},
    issue120: null,
    overall: 'incomplete',
  };

  console.log('Starting engine…');
  await startEngine({ debug: true });
  const proofCapture = installProofCapture();

  // Reload wallet into engine memory
  await loadWalletByID(encryptionKey, railgunWalletId, false);

  const provider = new JsonRpcProvider(RPC_URL);
  const wallet = Wallet.fromPhrase(mnemonic, provider);
  const pubBal = await provider.getBalance(wallet.address);
  console.log(`Network: ${NETWORK} mainnet=${IS_MAINNET} rpc=${RPC_URL}`);
  console.log(`Public wallet: ${wallet.address}`);
  console.log(`Public ETH: ${formatEther(pubBal)}`);
  result.publicBalanceEth = formatEther(pubBal);
  result.isMainnet = IS_MAINNET;

  // --- Shield ---
  const shieldAmount = parseEther(SHIELD_ETH);
  const wrappedERC20Amount = {
    tokenAddress: WETH_ADDRESS,
    amount: shieldAmount,
  };

  console.log(`\n=== SHIELD ${SHIELD_ETH} ETH (via wrap) → ${railgunAddress} ===`);
  try {
    const shieldPrivateKey = await getShieldPrivateKey(wallet);
    const { gasEstimate } = await gasEstimateForShieldBaseToken(
      TXID,
      NETWORK,
      railgunAddress,
      shieldPrivateKey,
      wrappedERC20Amount,
      wallet.address,
    );
    console.log('Shield gasEstimate:', gasEstimate.toString());

    const gasDetails = await gasDetailsForEstimate(NETWORK, gasEstimate, true);
    const { transaction } = await populateShieldBaseToken(
      TXID,
      NETWORK,
      railgunAddress,
      shieldPrivateKey,
      wrappedERC20Amount,
      gasDetails,
    );

    const tx = await wallet.sendTransaction(transaction);
    console.log('Shield tx:', tx.hash);
    const receipt = await tx.wait();
    console.log('Shield confirmed in block', receipt.blockNumber);
    result.steps.shield = {
      status: 'pass',
      txHash: tx.hash,
      etherscan: `${ETHERSCAN_TX_BASE}${tx.hash}`,
      amountEth: SHIELD_ETH,
      blockNumber: receipt.blockNumber,
    };
  } catch (err) {
    result.steps.shield = {
      status: 'fail',
      error: String(err?.message ?? err),
      stack: String(err?.stack ?? ''),
    };
    result.overall = 'fail';
    await writeResultMarkdown(result);
    throw err;
  }

  // --- Scan ---
  console.log('\n=== SCAN shielded balance ===');
  try {
    const minForUnshield = parseEther(UNSHIELD_ETH);
    const { total, spendable, ppoi } = await waitForShieldedBalance({
      railgunWalletId,
      tokenAddress: WETH_ADDRESS,
      minAmount: minForUnshield,
    });
    result.steps.scan = {
      status: 'pass',
      shieldedWethTotal: formatEther(total),
      shieldedWethSpendable: formatEther(spendable),
      shieldedWeth: formatEther(spendable),
      ppoi: ppoi ?? 'none observed',
    };
  } catch (err) {
    result.steps.scan = {
      status: 'fail',
      error: String(err?.message ?? err),
    };
    result.overall = 'fail';
    await writeResultMarkdown(result);
    throw err;
  }

  // --- Unshield proof + submit ---
  console.log(`\n=== UNSHIELD ${UNSHIELD_ETH} WETH → ${wallet.address} ===`);
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
    console.log(`Proof generated in ${(proofMs / 1000).toFixed(1)}s`);

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

    // Pre-send check: snarkjs.verify + eth_call
    console.log('\n=== PRE-SEND: snarkjs.groth16.verify ===');
    if (!proofCapture.proof || !proofCapture.publicInputs) {
      throw new Error('Proof capture empty');
    }
    const circuitDir = circuitDirFromPublicInputs(proofCapture.publicInputs);
    const vkeyPath = path.join(ARTIFACTS_PATH, `artifacts-v2.1/${circuitDir}/vkey.json`);
    const vkey = JSON.parse(fs.readFileSync(vkeyPath, 'utf8'));
    const proof = toSnarkjsProof(proofCapture.proof);
    const signals = publicSignalsFromInputs(proofCapture.publicInputs);
    fs.writeFileSync(
      path.join(ROOT_DIR, 'last-proved-unshield.json'),
      JSON.stringify({ proof, signals, publicInputs: proofCapture.publicInputs, circuitDir }, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v, 2),
    );
    const verifyOk = await groth16.verify(vkey, signals, proof);
    console.log(`circuit ${circuitDir} snarkjs.verify =>`, verifyOk);
    result.steps.preSendSnarkjs = { status: verifyOk ? 'pass' : 'fail', verifyOk, circuitDir };
    if (!verifyOk) {
      result.overall = 'fail-presend-snarkjs';
      await writeResultMarkdown(result);
      throw new Error('STOP: snarkjs verify failed — not sending');
    }

    console.log('\n=== PRE-SEND: eth_call simulate ===');
    try {
      await provider.call({
        to: populated.transaction.to,
        from: wallet.address,
        data: populated.transaction.data,
        value: populated.transaction.value ?? 0n,
      });
      console.log('eth_call => success');
      result.steps.preSendEthCall = { status: 'pass' };
    } catch (e) {
      let decoded = e.reason || e.shortMessage || e.message;
      const data = e.data || e.info?.error?.data;
      if (typeof data === 'string' && data.startsWith('0x08c379a0')) {
        try {
          decoded = Interface.from(['error Error(string)']).parseError(data).args[0];
        } catch { /* ignore */ }
      }
      result.steps.preSendEthCall = { status: 'fail', reason: String(decoded) };
      result.overall = 'fail-presend-ethcall';
      await writeResultMarkdown(result);
      throw new Error(`STOP: eth_call reverted — ${decoded}`);
    }

    const tx = await wallet.sendTransaction(populated.transaction);
    console.log('Unshield tx:', tx.hash);
    const receipt = await tx.wait();
    console.log('Unshield confirmed in block', receipt.blockNumber);

    result.steps.unshieldSubmit = {
      status: receipt.status === 1 ? 'pass' : 'fail',
      txHash: tx.hash,
      etherscan: `${ETHERSCAN_TX_BASE}${tx.hash}`,
      amountEth: UNSHIELD_ETH,
      blockNumber: receipt.blockNumber,
    };
    result.issue120 = false;
    result.overall = receipt.status === 1 ? 'pass' : 'fail-onchain';
  } catch (err) {
    const msg = String(err?.message ?? err);
    const stack = String(err?.stack ?? '');
    const looks120 =
      /artifact|proof|circuit|snark|verification key|zkey|wasm|nullifier|Prover|groth16/i.test(
        msg + stack,
      );

    if (!result.steps.unshieldProof) {
      result.steps.unshieldProof = {
        status: 'fail',
        error: msg,
        stack,
      };
    } else {
      result.steps.unshieldSubmit = {
        status: 'fail',
        error: msg,
        stack,
      };
    }
    result.issue120 = looks120
      ? 'possible — see error; https://github.com/Railgun-Community/wallet/issues/120'
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
  console.error('\nCYCLE FAILED:', err);
  try {
    await stopRailgunEngine();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
