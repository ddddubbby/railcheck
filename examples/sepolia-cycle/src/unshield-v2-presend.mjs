/**
 * Brief v2: mainnet unshield ~0.005 with SDK 11.2.0.
 * Pre-send: snarkjs.verify (contract vkey) + eth_call. Default: stop for human APPROVE (no send).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
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
  gasEstimateForUnprovenUnshield,
  generateUnshieldProof,
  getProver,
  getTXOsReceivedPOIStatusInfoForWallet,
  loadWalletByID,
  populateProvedUnshield,
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
  Interface,
  Contract,
} from 'ethers';
import {
  NETWORK,
  NETWORK_INFO,
  IS_MAINNET,
  RPC_URL,
  ETHERSCAN_TX_BASE,
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

const require = createRequire(import.meta.url);
const TXID = TXIDVersion.V2_PoseidonMerkle;
const CONTRACT_CID = 'QmWFEVTTH3kdFxA8GLUKnCNZe5JwTVy7nJi2HgnzbVBLF4';
const WANT_SEND = process.argv.includes('--send');
const VKEY_01x02 = path.join(ARTIFACTS_PATH, 'artifacts-v2.1/01x02/vkey.json');
const CONTRACT_VKEY_REF = '/tmp/v2-artifacts/contract/vkey.json';

function circuitDirFromPublicInputs(publicInputs) {
  const n = publicInputs?.nullifiers?.length ?? 0;
  const c = publicInputs?.commitmentsOut?.length ?? 0;
  return `${String(n).padStart(2, '0')}x${String(c).padStart(2, '0')}`;
}

function vkeyPathForCircuit(circuitDir) {
  return path.join(ARTIFACTS_PATH, `artifacts-v2.1/${circuitDir}/vkey.json`);
}

function assertVkeyMatchesContract() {
  // Brief gate: 01x02 (first unshield shape) must match contract set QmWFEVTT…
  if (!fs.existsSync(VKEY_01x02) || !fs.existsSync(CONTRACT_VKEY_REF)) {
    throw new Error('Missing cached or contract vkey for comparison');
  }
  const a = fs.readFileSync(VKEY_01x02);
  const b = fs.readFileSync(CONTRACT_VKEY_REF);
  if (!a.equals(b)) {
    throw new Error('CACHED 01x02 vkey.json !== QmWFEVTT…/vkey.json — STOP');
  }
  console.log('PRECHECK: 01x02 vkey.json == QmWFEVTT…/vkey.json (byte-identical)');
}

async function ensureWalletLoaded() {
  const mnemonic = process.env.MNEMONIC;
  const encryptionKey = process.env.ENCRYPTION_KEY;
  let railgunWalletId = process.env.RAILGUN_WALLET_ID;
  if (!mnemonic || !encryptionKey || !railgunWalletId) {
    throw new Error('Missing MNEMONIC / ENCRYPTION_KEY / RAILGUN_WALLET_ID');
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
  return { mnemonic, encryptionKey, railgunWalletId };
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
      console.log('PPOI', JSON.stringify(ppoi, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    } catch {}
    console.log(
      `WETH total=${formatEther(total)} spendable=${formatEther(spendable)} need≥${formatEther(minAmount)}`,
    );
    if (spendable >= minAmount) return { spendable, total };
    await new Promise((r) => setTimeout(r, 20_000));
  }
  throw new Error('Timed out waiting for spendable balance');
}

async function gasDetails(network, gasEstimate) {
  const evmGasType = getEVMGasTypeForTransaction(network, true);
  const provider = new JsonRpcProvider(RPC_URL);
  const fee = await provider.getFeeData();
  const pad = 130n;
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

/** Capture proof+publicInputs when engine verifies during generateUnshieldProof */
function installProofCapture() {
  const prover = getProver();
  const captured = { proof: null, publicInputs: null, artifactsVkey: null };
  const orig = prover.verifyRailgunProof.bind(prover);
  prover.verifyRailgunProof = async (publicInputs, proof, artifacts) => {
    captured.proof = proof;
    captured.publicInputs = publicInputs;
    captured.artifactsVkey = artifacts?.vkey ?? null;
    return orig(publicInputs, proof, artifacts);
  };
  return captured;
}

function toSnarkjsProof(proof) {
  // Engine SnarkProof: { a: [x,y], b: [[],[]] , c: [x,y] } or {pi_a,...}
  if (proof.pi_a) return proof;
  const a = proof.a;
  const b = proof.b;
  const c = proof.c;
  // a may be {x,y} or [x,y]
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

async function writeReport(report) {
  const out = path.join(ROOT_DIR, 'presend-v2-report.json');
  fs.writeFileSync(
    out,
    JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );
  console.log('Wrote', out);
}

async function main() {
  // Brief v2: mainnet first, then Sepolia — both allowed here
  console.log('Network', NETWORK, 'mainnet=', IS_MAINNET);
  assertVkeyMatchesContract();

  const report = {
    brief: 'v2',
    network: NETWORK,
    proxy: NETWORK_INFO.proxyContract,
    versions: { wallet: '11.2.0', engine: '9.9.1', sharedModels: '8.2.1', ethers: '6.14.3' },
    contractCid: CONTRACT_CID,
    vkeyMatch: true,
    steps: {},
    preSend: {},
    overall: 'incomplete',
  };

  await startEngine({ debug: true });
  const capture = installProofCapture();
  const { mnemonic, encryptionKey, railgunWalletId } = await ensureWalletLoaded();
  const provider = new JsonRpcProvider(RPC_URL);
  const wallet = Wallet.fromPhrase(mnemonic, provider);
  console.log('Public', wallet.address, 'ETH', formatEther(await provider.getBalance(wallet.address)));

  const unshieldAmount = parseEther(process.env.UNSHIELD_ETH || UNSHIELD_ETH || '0.005');
  console.log('\n=== SCAN until spendable ===');
  const bal = await waitSpendable(railgunWalletId, unshieldAmount);
  report.steps.scan = {
    status: 'pass',
    total: formatEther(bal.total),
    spendable: formatEther(bal.spendable),
  };

  const unshieldRecipient = {
    tokenAddress: WETH_ADDRESS,
    amount: unshieldAmount,
    recipientAddress: wallet.address,
  };

  console.log(`\n=== PROVE unshield ${formatEther(unshieldAmount)} ===`);
  const originalGas = await gasDetails(NETWORK, 3_000_000n);
  const { gasEstimate } = await gasEstimateForUnprovenUnshield(
    TXID, NETWORK, railgunWalletId, encryptionKey,
    [unshieldRecipient], [], originalGas, undefined, true,
  );
  const txGas = await gasDetails(NETWORK, gasEstimate);
  const overallBatchMinGasPrice = calculateGasPrice(txGas);

  const t0 = Date.now();
  await generateUnshieldProof(
    TXID, NETWORK, railgunWalletId, encryptionKey,
    [unshieldRecipient], [], undefined, true, overallBatchMinGasPrice,
    (p) => console.log('Proof progress', p),
  );
  const proofMs = Date.now() - t0;
  console.log('proof ms', proofMs);
  report.steps.unshieldProof = {
    status: 'pass',
    proofTimeMs: proofMs,
    proofTimeSec: Number((proofMs / 1000).toFixed(1)),
    amount: formatEther(unshieldAmount),
  };

  const populated = await populateProvedUnshield(
    TXID, NETWORK, railgunWalletId,
    [unshieldRecipient], [], undefined, true,
    overallBatchMinGasPrice, txGas,
  );

  // --- Pre-send 1: snarkjs verify ---
  console.log('\n=== PRE-SEND: snarkjs.groth16.verify ===');
  let verifyOk = false;
  try {
    if (!capture.proof || !capture.publicInputs) {
      throw new Error('Proof capture empty — generateUnshieldProof did not call verifyRailgunProof');
    }
    const circuitDir = circuitDirFromPublicInputs(capture.publicInputs);
    const vkeyPath = vkeyPathForCircuit(circuitDir);
    if (!fs.existsSync(vkeyPath)) {
      throw new Error(`Missing vkey for circuit ${circuitDir} at ${vkeyPath}`);
    }
    const vkey = JSON.parse(fs.readFileSync(vkeyPath, 'utf8'));
    console.log(`using circuit ${circuitDir} vkey (${vkeyPath})`);
    const proof = toSnarkjsProof(capture.proof);
    const signals = publicSignalsFromInputs(capture.publicInputs);
    fs.writeFileSync(
      path.join(ROOT_DIR, 'last-proved-unshield.json'),
      JSON.stringify({ proof, signals, publicInputs: capture.publicInputs, circuitDir }, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v, 2),
    );
    verifyOk = await groth16.verify(vkey, signals, proof);
    console.log('snarkjs.verify =>', verifyOk);
    report.preSend.snarkjsVerify = {
      status: verifyOk ? 'pass' : 'fail',
      verifyOk,
      circuitDir,
    };
  } catch (e) {
    report.preSend.snarkjsVerify = { status: 'fail', error: String(e?.message ?? e) };
    console.error('snarkjs.verify ERROR', e?.message ?? e);
  }

  if (!verifyOk) {
    report.overall = 'fail-presend-snarkjs';
    await writeReport(report);
    console.error('\nSTOP: snarkjs verify failed — not sending.');
    await stopEngine();
    process.exit(2);
  }

  // --- Pre-send 2: eth_call ---
  console.log('\n=== PRE-SEND: eth_call simulate ===');
  let ethCallOk = false;
  try {
    await provider.call({
      to: populated.transaction.to,
      from: wallet.address,
      data: populated.transaction.data,
      value: populated.transaction.value ?? 0n,
    });
    ethCallOk = true;
    console.log('eth_call => success');
    report.preSend.ethCall = { status: 'pass' };
  } catch (e) {
    let decoded = e.reason || e.shortMessage || e.message;
    const data = e.data || e.info?.error?.data;
    if (typeof data === 'string' && data.startsWith('0x08c379a0')) {
      try {
        decoded = Interface.from(['error Error(string)']).parseError(data).args[0];
      } catch {}
    }
    console.error('eth_call REVERT:', decoded);
    report.preSend.ethCall = { status: 'fail', reason: String(decoded) };
  }

  if (!ethCallOk) {
    report.overall = 'fail-presend-ethcall';
    await writeReport(report);
    console.error('\nSTOP: eth_call reverted — not sending.');
    await stopEngine();
    process.exit(3);
  }

  report.overall = 'presend-pass-awaiting-approve';
  report.populatedTx = {
    to: populated.transaction.to,
    dataLen: String(populated.transaction.data || '').length,
  };
  await writeReport(report);

  console.log('\n=== BOTH PRE-SEND CHECKS PASSED ===');
  console.log('STOP for human APPROVE before mainnet send.');
  console.log(
    'After APPROVE: APPROVE_TRANSACTIONS=1 RAILGUN_NETWORK=Ethereum node src/unshield-v2-presend.mjs --send',
  );

  if (!WANT_SEND || process.env.APPROVE_TRANSACTIONS !== '1') {
    await stopEngine();
    process.exit(0);
  }

  const tx = await wallet.sendTransaction(populated.transaction);
  console.log('unshield tx', tx.hash);
  const receipt = await tx.wait();
  report.steps.unshieldSubmit = {
    status: receipt.status === 1 ? 'pass' : 'fail',
    txHash: tx.hash,
    etherscan: `${ETHERSCAN_TX_BASE}${tx.hash}`,
    blockNumber: receipt.blockNumber,
  };
  report.overall = receipt.status === 1 ? 'pass' : 'fail-onchain';
  await writeReport(report);
  await stopEngine();
}

main().catch(async (err) => {
  console.error('FAIL', err);
  try { await stopRailgunEngine(); } catch {}
  process.exit(1);
});
