import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NETWORK,
  NETWORK_INFO,
  IS_MAINNET,
  SEPOLIA_RPC_URL,
  MAINNET_RPC_URL,
  RPC_URL,
  ETHERSCAN_TX_BASE,
  SHIELD_ETH,
  UNSHIELD_ETH,
  WETH_ADDRESS,
  DEPLOYMENT_BLOCK,
  ARTIFACTS_PATH,
  ROOT_DIR,
} from './constants.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

export {
  NETWORK,
  NETWORK_INFO,
  IS_MAINNET,
  SEPOLIA_RPC_URL,
  MAINNET_RPC_URL,
  RPC_URL,
  ETHERSCAN_TX_BASE,
  SHIELD_ETH,
  UNSHIELD_ETH,
  WETH_ADDRESS,
  DEPLOYMENT_BLOCK,
  ARTIFACTS_PATH,
  ROOT_DIR,
};

export const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
