/**
 * Sepolia flow demo (Brief v2): build pool → advice → shield → scan → advice → unshield.
 * Harness only — does not modify @railcheck product packages. Sepolia only.
 *
 * Usage:
 *   npm run flow-demo -- --shield          # dry-run shield (eth_call)
 *   APPROVE_TRANSACTIONS=1 node src/flow-demo.mjs --shield --send
 *   APPROVE_TRANSACTIONS=1 node src/flow-demo.mjs --send   # unshield-only (after shield)
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  calculateGasPrice,
  EVMGasType,
  getEVMGasTypeForTransaction,
  NETWORK_CONFIG,
  TXIDVersion,
} from '@railgun-community/shared-models';
import {
  balanceForERC20Token,
  createRailgunWallet,
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
  DEPLOYMENT_BLOCK,
  ARTIFACTS_PATH,
  ROOT_DIR,
} from './load-env.mjs';
import { startEngine, stopEngine } from './engine.mjs';

process.on('uncaughtException', (e) => console.warn('[uncaught]', e?.message));
process.on('unhandledRejection', (e) =>
  console.warn('[unhandled]', e?.message ?? e),
);

const TXID = TXIDVersion.V2_PoseidonMerkle;
const WANT_SEND = process.argv.includes('--send');
const WANT_SHIELD = process.argv.includes('--shield');
/** Lost-key wallet from Brief v1 — never use. */
const FORBIDDEN_PUBLIC = '0x964c83d1c403Fdd4FDb8FA084b47701E3ef281e8';
const REPO_ROOT = path.resolve(ROOT_DIR, '../..');
const POOL_STATE_PATH = path.join(ROOT_DIR, 'pool-state.json');
const REPORT_PATH = path.join(ROOT_DIR, 'flow-demo-report.json');

async function loadLocal(pkgSubpath) {
  const abs = path.join(REPO_ROOT, pkgSubpath);
  return import(pathToFileURL(abs).href);
}

function writeReport(report) {
  fs.writeFileSync(
    REPORT_PATH,
    JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );
  console.log('Wrote', REPORT_PATH);
}

function fileStore(filePath) {
  return {
    get: async () => {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    },
    set: async (state) => {
      fs.writeFileSync(filePath, JSON.stringify(state));
    },
  };
}

async function ensureWalletLoaded() {
  const mnemonic = process.env.MNEMONIC;
  const encryptionKey = process.env.ENCRYPTION_KEY;
  let railgunWalletId = process.env.RAILGUN_WALLET_ID;
  const railgunAddress = process.env.RAILGUN_ADDRESS;
  if (!mnemonic || !encryptionKey || !railgunWalletId || !railgunAddress) {
    throw new Error(
      'Missing MNEMONIC / ENCRYPTION_KEY / RAILGUN_WALLET_ID / RAILGUN_ADDRESS in .env',
    );
  }
  try {
    await loadWalletByID(encryptionKey, railgunWalletId, false);
  } catch (err) {
    console.warn('loadWalletByID failed; recreating:', err?.message);
    const created = await createRailgunWallet(encryptionKey, mnemonic, {
      [NETWORK]: DEPLOYMENT_BLOCK,
    });
    railgunWalletId = created.id;
    await loadWalletByID(encryptionKey, railgunWalletId, false);
  }
  return { mnemonic, encryptionKey, railgunWalletId, railgunAddress };
}

async function getShieldPrivateKey(wallet) {
  const message = getShieldPrivateKeySignatureMessage();
  const signature = await wallet.signMessage(message);
  return keccak256(signature);
}

async function gasDetails(network, gasEstimate) {
  const evmGasType = getEVMGasTypeForTransaction(network, true);
  const provider = new JsonRpcProvider(RPC_URL);
  const fee = await provider.getFeeData();
  const pad = 150n;
  if (evmGasType === EVMGasType.Type2) {
    return {
      evmGasType,
      gasEstimate,
      maxFeePerGas: ((fee.maxFeePerGas ?? fee.gasPrice ?? 2_000_000_000n) * pad) / 100n,
      maxPriorityFeePerGas: ((fee.maxPriorityFeePerGas ?? 100_000_000n) * pad) / 100n,
    };
  }
  return {
    evmGasType,
    gasEstimate,
    gasPrice: ((fee.gasPrice ?? 2_000_000_000n) * pad) / 100n,
  };
}

async function waitSpendable(railgunWalletId, minAmount, timeoutMs = 90 * 60 * 1000) {
  const chain = NETWORK_CONFIG[NETWORK].chain;
  const wallet = walletForID(railgunWalletId);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await refreshBalances(chain, [railgunWalletId]);
    } catch (e) {
      console.warn('refresh:', e?.message);
    }
    let spendable = 0n;
    let total = 0n;
    try {
      spendable = await balanceForERC20Token(TXID, wallet, NETWORK, WETH_ADDRESS, true);
      total = await balanceForERC20Token(TXID, wallet, NETWORK, WETH_ADDRESS, false);
    } catch (e) {
      console.warn('balance:', e?.message);
    }
    try {
      const ppoi = await getTXOsReceivedPOIStatusInfoForWallet(TXID, NETWORK, railgunWalletId);
      console.log(
        'PPOI',
        JSON.stringify(ppoi, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      );
    } catch {
      /* ignore */
    }
    console.log(
      `WETH total=${formatEther(total)} spendable=${formatEther(spendable)} need≥${formatEther(minAmount)}`,
    );
    if (spendable >= minAmount) return { spendable, total };
    await new Promise((r) => setTimeout(r, 20_000));
  }
  throw new Error('Timed out waiting for spendable balance');
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

function circuitDirFromPublicInputs(publicInputs) {
  const n = publicInputs?.nullifiers?.length ?? 0;
  const c = publicInputs?.commitmentsOut?.length ?? 0;
  return `${String(n).padStart(2, '0')}x${String(c).padStart(2, '0')}`;
}

async function ethCallOrThrow(provider, populated, from, report, stepKey) {
  try {
    await provider.call({
      to: populated.transaction.to,
      from,
      data: populated.transaction.data,
      value: populated.transaction.value ?? 0n,
    });
    console.log('eth_call: pass');
    report.steps[stepKey] = { ...(report.steps[stepKey] || {}), ethCall: 'pass' };
  } catch (e) {
    let decoded = e.reason || e.shortMessage || e.message;
    const data = e.data || e.info?.error?.data;
    if (typeof data === 'string' && data.startsWith('0x08c379a0')) {
      try {
        decoded = Interface.from(['error Error(string)']).parseError(data).args[0];
      } catch {
        /* ignore */
      }
    }
    console.error('eth_call REVERT:', decoded);
    report.steps[stepKey] = {
      ...(report.steps[stepKey] || {}),
      ethCall: 'fail',
      reason: String(decoded),
    };
    report.overall = `fail-presend-${stepKey}`;
    writeReport(report);
    throw new Error(`eth_call failed (${stepKey}): ${decoded}`);
  }
}

async function main() {
  if (IS_MAINNET) throw new Error('flow-demo is Sepolia only (set RAILGUN_NETWORK=EthereumSepolia)');
  if (!WANT_SHIELD && !WANT_SEND) {
    console.error('Usage: --shield (dry-run) or --shield --send or --send (unshield-only)');
    process.exit(1);
  }

  const shieldAmount = parseEther(process.env.SHIELD_ETH || SHIELD_ETH || '0.01');
  const unshieldAmount = parseEther(process.env.UNSHIELD_ETH || UNSHIELD_ETH || '0.005');
  const report = {
    brief: 'sepolia-flow-demo-v2',
    network: NETWORK,
    proxy: NETWORK_INFO.proxyContract,
    versions: {
      wallet: '11.2.0',
      engine: '9.9.1',
      sharedModels: '8.2.1',
      ethers: '6.14.3',
    },
    publicAddress: null,
    steps: {},
    overall: 'incomplete',
  };

  const { buildPool } = await loadLocal('packages/builder/index.mjs');
  const { prepare } = await loadLocal('lib/index.mjs');
  const { adviseShield, adviseUnshield } = await loadLocal('packages/kohaku/index.mjs');

  // --- BUILD POOL ---
  console.log('\n=== BUILD POOL ===');
  const buildT0 = Date.now();
  const store = fileStore(POOL_STATE_PATH);
  const { deposits, snapshot } = await buildPool({
    chain: 'sepolia',
    urls: [RPC_URL],
    store,
    onProgress: (msg) => console.log('[pool]', msg),
  });
  const pool = prepare(deposits, { snapshot });
  const buildMs = Date.now() - buildT0;
  console.log(`BUILD POOL: ${deposits.length} deposits in ${(buildMs / 1000).toFixed(1)}s`);
  report.steps.build = {
    status: 'pass',
    poolSize: deposits.length,
    buildTimeMs: buildMs,
    buildTimeSec: Number((buildMs / 1000).toFixed(1)),
  };

  console.log('\n=== WALLET LOAD ===');
  await startEngine({ debug: true });
  const capture = installProofCapture();
  const { mnemonic, encryptionKey, railgunWalletId, railgunAddress } =
    await ensureWalletLoaded();
  const provider = new JsonRpcProvider(RPC_URL);
  const wallet = Wallet.fromPhrase(mnemonic, provider);
  report.publicAddress = wallet.address;

  if (wallet.address.toLowerCase() === FORBIDDEN_PUBLIC.toLowerCase()) {
    report.overall = 'fail-forbidden-wallet';
    writeReport(report);
    await stopEngine();
    throw new Error(
      `Refusing lost-key wallet ${FORBIDDEN_PUBLIC}. Create a new wallet with npm run create-wallet.`,
    );
  }

  const ethBal = await provider.getBalance(wallet.address);
  console.log('Public', wallet.address, 'ETH', formatEther(ethBal));

  const minEth = WANT_SHIELD ? parseEther('0.015') : parseEther('0.002');
  if (ethBal < minEth) {
    report.steps.funding = {
      status: 'fail',
      error: `Sepolia ETH ${formatEther(ethBal)} < ${formatEther(minEth)}`,
    };
    report.overall = 'fail-gas';
    writeReport(report);
    await stopEngine();
    console.error(
      `STOP: need at least ${formatEther(minEth)} Sepolia ETH. Public: ${wallet.address}`,
    );
    process.exit(4);
  }
  report.steps.funding = { status: 'pass', publicEth: formatEther(ethBal) };

  // ========== SHIELD PATH ==========
  if (WANT_SHIELD) {
    console.log('\n=== ADVICE BEFORE prepareShield ===');
    const shieldAsset = {
      asset: { __type: 'native' },
      amount: shieldAmount,
    };
    const shieldAdvice = adviseShield(pool, shieldAsset, { constraint: 'fixed' });
    const sa = shieldAdvice.assessment;
    console.log(
      'ADVICE (shield):',
      JSON.stringify(
        { status: sa.status, findings: sa.findings, score: sa.score, band: sa.band },
        null,
        2,
      ),
    );
    report.steps.shieldAdvice = {
      status: 'pass',
      adviceStatus: sa.status,
      findings: sa.findings?.map((f) => f.code) ?? [],
      score: sa.score,
      band: sa.band,
      amount: formatEther(shieldAmount),
    };

    console.log(`\n=== SHIELD ${formatEther(shieldAmount)} ETH → ${railgunAddress.slice(0, 18)}… ===`);
    const shieldPrivateKey = await getShieldPrivateKey(wallet);
    const wrappedERC20Amount = {
      tokenAddress: WETH_ADDRESS,
      amount: shieldAmount,
    };
    const { gasEstimate } = await gasEstimateForShieldBaseToken(
      TXID,
      NETWORK,
      railgunAddress,
      shieldPrivateKey,
      wrappedERC20Amount,
      wallet.address,
    );
    const shieldGas = await gasDetails(NETWORK, gasEstimate);
    const { transaction: shieldTx } = await populateShieldBaseToken(
      TXID,
      NETWORK,
      railgunAddress,
      shieldPrivateKey,
      wrappedERC20Amount,
      shieldGas,
    );

    console.log('\n=== SIMULATE shield eth_call ===');
    try {
      await provider.call({
        to: shieldTx.to,
        from: wallet.address,
        data: shieldTx.data,
        value: shieldTx.value ?? 0n,
      });
      console.log('eth_call: pass');
      report.steps.shield = { status: 'presend-pass', ethCall: 'pass' };
    } catch (e) {
      const decoded = e.reason || e.shortMessage || e.message;
      console.error('eth_call REVERT:', decoded);
      report.steps.shield = { status: 'fail', ethCall: 'fail', reason: String(decoded) };
      report.overall = 'fail-presend-shield';
      writeReport(report);
      await stopEngine();
      process.exit(3);
    }

    if (!WANT_SEND || process.env.APPROVE_TRANSACTIONS !== '1') {
      console.log('Shield not sent (no --send or APPROVE_TRANSACTIONS!=1).');
      report.overall = 'presend-shield-pass';
      writeReport(report);
      await stopEngine();
      process.exit(0);
    }

    console.log('\n=== SEND shield ===');
    const sentShield = await wallet.sendTransaction(shieldTx);
    console.log('shield tx', sentShield.hash);
    const shieldReceipt = await sentShield.wait();
    report.steps.shield = {
      status: shieldReceipt.status === 1 ? 'pass' : 'fail',
      ethCall: 'pass',
      txHash: sentShield.hash,
      etherscan: `${ETHERSCAN_TX_BASE}${sentShield.hash}`,
      blockNumber: shieldReceipt.blockNumber,
      amountEth: formatEther(shieldAmount),
    };
    if (shieldReceipt.status !== 1) {
      report.overall = 'fail-shield-onchain';
      writeReport(report);
      await stopEngine();
      process.exit(5);
    }
    writeReport(report);
  }

  // ========== UNSHIELD PATH (after shield send, or --send alone) ==========
  if (!WANT_SEND || process.env.APPROVE_TRANSACTIONS !== '1') {
    await stopEngine();
    process.exit(0);
  }

  console.log('\n=== WALLET SCAN ===');
  const bal = await waitSpendable(railgunWalletId, unshieldAmount);
  console.log(
    `WALLET: spendable WETH ${formatEther(bal.spendable)} (total ${formatEther(bal.total)})`,
  );
  report.steps.scan = {
    status: 'pass',
    spendable: formatEther(bal.spendable),
    total: formatEther(bal.total),
  };

  console.log('\n=== ADVICE BEFORE prepareUnshield ===');
  const assetAmount = {
    asset: { __type: 'erc20', contract: WETH_ADDRESS },
    amount: unshieldAmount,
  };
  const advice = adviseUnshield(pool, assetAmount, {
    constraint: 'fixed',
    context: {
      addressReuse: true,
      pastTransfer: false,
      restOfDeposit: undefined,
    },
    balance: bal.spendable,
  });
  const assessment = advice.assessment;
  console.log(
    'ADVICE (unshield):',
    JSON.stringify(
      {
        status: assessment.status,
        findings: assessment.findings,
        score: assessment.score,
        band: assessment.band,
      },
      null,
      2,
    ),
  );
  report.steps.unshieldAdvice = {
    status: 'pass',
    adviceStatus: assessment.status,
    findings: assessment.findings?.map((f) => f.code) ?? [],
    score: assessment.score,
    band: assessment.band,
    keptAmount: formatEther(unshieldAmount),
  };

  const unshieldRecipient = {
    tokenAddress: WETH_ADDRESS,
    amount: unshieldAmount,
    recipientAddress: wallet.address,
  };

  console.log(`\n=== PROVE unshield ${formatEther(unshieldAmount)} ===`);
  const originalGas = await gasDetails(NETWORK, 3_000_000n);
  const { gasEstimate } = await gasEstimateForUnprovenUnshield(
    TXID,
    NETWORK,
    railgunWalletId,
    encryptionKey,
    [unshieldRecipient],
    [],
    originalGas,
    undefined,
    true,
  );
  const txGas = await gasDetails(NETWORK, gasEstimate);
  const overallBatchMinGasPrice = calculateGasPrice(txGas);

  const t0 = Date.now();
  await generateUnshieldProof(
    TXID,
    NETWORK,
    railgunWalletId,
    encryptionKey,
    [unshieldRecipient],
    [],
    undefined,
    true,
    overallBatchMinGasPrice,
    (p) => console.log('Proof progress', p),
  );
  const proofMs = Date.now() - t0;
  console.log('proof ms', proofMs);
  report.steps.prove = { status: 'pass', proofTimeMs: proofMs };

  const populated = await populateProvedUnshield(
    TXID,
    NETWORK,
    railgunWalletId,
    [unshieldRecipient],
    [],
    undefined,
    true,
    overallBatchMinGasPrice,
    txGas,
  );

  console.log('\n=== SIMULATE unshield eth_call ===');
  try {
    if (capture.proof && capture.publicInputs) {
      const circuitDir = circuitDirFromPublicInputs(capture.publicInputs);
      const vkeyPath = path.join(ARTIFACTS_PATH, `artifacts-v2.1/${circuitDir}/vkey.json`);
      if (fs.existsSync(vkeyPath)) {
        const vkey = JSON.parse(fs.readFileSync(vkeyPath, 'utf8'));
        const proof = toSnarkjsProof(capture.proof);
        const signals = publicSignalsFromInputs(capture.publicInputs);
        const verifyOk = await groth16.verify(vkey, signals, proof);
        console.log(`snarkjs.verify (${circuitDir}) =>`, verifyOk);
        report.steps.snarkjsVerify = {
          status: verifyOk ? 'pass' : 'fail',
          circuitDir,
          verifyOk,
        };
        if (!verifyOk) {
          report.overall = 'fail-presend-snarkjs';
          writeReport(report);
          console.error('STOP: snarkjs verify failed — not sending.');
          await stopEngine();
          process.exit(2);
        }
      }
    }
    await ethCallOrThrow(provider, populated, wallet.address, report, 'unshield');
  } catch (e) {
    console.error(e.message);
    await stopEngine();
    process.exit(3);
  }

  console.log('\n=== SEND unshield ===');
  const tx = await wallet.sendTransaction(populated.transaction);
  console.log('unshield tx', tx.hash);
  const receipt = await tx.wait();
  report.steps.unshield = {
    status: receipt.status === 1 ? 'pass' : 'fail',
    ethCall: 'pass',
    txHash: tx.hash,
    etherscan: `${ETHERSCAN_TX_BASE}${tx.hash}`,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed?.toString?.() ?? String(receipt.gasUsed),
    amount: formatEther(unshieldAmount),
  };
  report.overall = receipt.status === 1 ? 'pass' : 'fail-unshield-onchain';
  writeReport(report);
  await stopEngine();
  if (receipt.status !== 1) process.exit(5);
  console.log('\n=== FLOW DEMO PASS ===');
}

main().catch(async (err) => {
  console.error('FAIL', err);
  try {
    await stopRailgunEngine();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
