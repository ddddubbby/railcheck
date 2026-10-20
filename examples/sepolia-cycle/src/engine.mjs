import fs from 'node:fs';
import path from 'node:path';
import LevelDOWN from 'leveldown';
import { groth16 } from 'snarkjs';
import {
  ArtifactStore,
  getProver,
  loadProvider,
  setLoggers,
  startRailgunEngine,
  stopRailgunEngine,
} from '@railgun-community/wallet';
import {
  ARTIFACTS_PATH,
  DB_PATH,
  NETWORK,
  NETWORK_INFO,
  POI_NODE_URLS,
  RPC_URL,
  WALLET_SOURCE,
} from './constants.mjs';

function createArtifactStore(documentsDir) {
  const resolvePath = (p) => path.join(documentsDir, p);

  const getFile = async (filePath) =>
    fs.promises.readFile(resolvePath(filePath));

  const storeFile = async (dir, filePath, item) => {
    await fs.promises.mkdir(resolvePath(dir), { recursive: true });
    await fs.promises.writeFile(resolvePath(filePath), item);
  };

  const fileExists = async (filePath) => {
    try {
      await fs.promises.access(resolvePath(filePath));
      return true;
    } catch {
      return false;
    }
  };

  return new ArtifactStore(getFile, storeFile, fileExists);
}

/**
 * Start engine + snarkjs prover + network provider.
 * Follows https://docs.railgun.org/developer-guide/wallet/getting-started
 */
export async function startEngine({ debug = true } = {}) {
  fs.mkdirSync(DB_PATH, { recursive: true });
  fs.mkdirSync(ARTIFACTS_PATH, { recursive: true });

  if (debug) {
    setLoggers(
      (msg) => console.log(`[railgun] ${msg}`),
      (err) => console.error(`[railgun:err] ${err}`),
    );
  }

  const db = LevelDOWN(DB_PATH);
  const artifactStore = createArtifactStore(ARTIFACTS_PATH);

  await startRailgunEngine(
    WALLET_SOURCE,
    db,
    debug,
    artifactStore,
    false, // useNativeArtifacts — false for Node
    false, // skipMerkletreeScans
    POI_NODE_URLS,
    [], // customPOILists
    true, // verboseScanLogging
  );

  // Groth16 via snarkjs (Node)
  getProver().setSnarkJSGroth16(groth16);

  const providerConfig = {
    chainId: NETWORK_INFO.chain.id,
    providers: [
      {
        provider: RPC_URL,
        priority: 1,
        weight: 2,
        maxLogsPerBatch: 1,
      },
    ],
  };

  const pollingInterval = 1000 * 60 * 5;
  await loadProvider(providerConfig, NETWORK, pollingInterval);

  console.log(
    `Engine ready: ${NETWORK} chainId=${NETWORK_INFO.chain.id} proxy=${NETWORK_INFO.proxyContract} deploymentBlock=${NETWORK_INFO.deploymentBlock} rpc=${RPC_URL} db=${DB_PATH}`,
  );
}

export async function stopEngine() {
  try {
    await stopRailgunEngine();
  } catch (err) {
    console.warn('stopRailgunEngine:', err?.message ?? err);
  }
}
