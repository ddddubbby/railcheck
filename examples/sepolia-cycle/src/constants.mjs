import { NETWORK_CONFIG, NetworkName } from '@railgun-community/shared-models';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env') });

/**
 * Network selection via RAILGUN_NETWORK:
 * - EthereumSepolia (default) — Sepolia proof check / #120
 * - Ethereum — mainnet cycle
 */
const networkEnv = (process.env.RAILGUN_NETWORK || 'EthereumSepolia').trim();
const NETWORK_BY_ENV = {
  EthereumSepolia: NetworkName.EthereumSepolia,
  Ethereum_Sepolia: NetworkName.EthereumSepolia,
  Sepolia: NetworkName.EthereumSepolia,
  Ethereum: NetworkName.Ethereum,
  Mainnet: NetworkName.Ethereum,
  EthereumMainnet: NetworkName.Ethereum,
};

export const NETWORK = NETWORK_BY_ENV[networkEnv] ?? NetworkName.EthereumSepolia;
export const IS_MAINNET = NETWORK === NetworkName.Ethereum;

export const NETWORK_INFO = NETWORK_CONFIG[NETWORK];

export const DEPLOYMENT_BLOCK = NETWORK_INFO?.deploymentBlock;
export const PROXY_CONTRACT = NETWORK_INFO?.proxyContract;
export const WETH_ADDRESS = NETWORK_INFO?.baseToken?.wrappedAddress;

export const SEPOLIA_RPC_URL =
  process.env.SEPOLIA_RPC_URL ??
  'https://ethereum-sepolia-rpc.publicnode.com';

export const MAINNET_RPC_URL =
  process.env.MAINNET_RPC_URL ?? 'https://ethereum-rpc.publicnode.com';

/** Active RPC for the selected network */
export const RPC_URL = IS_MAINNET ? MAINNET_RPC_URL : SEPOLIA_RPC_URL;

export const ETHERSCAN_TX_BASE = IS_MAINNET
  ? 'https://etherscan.io/tx/'
  : 'https://sepolia.etherscan.io/tx/';

/** Separate LevelDB so Sepolia and mainnet scans do not collide */
export const DB_PATH = path.join(
  ROOT_DIR,
  IS_MAINNET ? 'engine-mainnet.db' : 'engine.db',
);
export const ARTIFACTS_PATH = path.join(ROOT_DIR, 'artifacts');

/** PPOI aggregator (community public node from official docs) */
export const POI_NODE_URLS = ['https://ppoi.fdi.network'];

export const WALLET_SOURCE = IS_MAINNET ? 'railcheckmain' : 'railchecksep';

/** Amounts: 0.012 ETH covers a 0.01 shield and gas at low fees */
export const SHIELD_ETH = process.env.SHIELD_ETH ?? '0.01';
export const UNSHIELD_ETH = process.env.UNSHIELD_ETH ?? '0.005';
