/**
 * After npm install: prefer RAILGUN_IPFS_GATEWAY (default filebase) over
 * hard-coded ipfs-lb.com, which returned 502 during the Sepolia proof check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(
  root,
  'node_modules/@railgun-community/wallet/dist/services/artifacts/artifact-util.js',
);

if (!fs.existsSync(target)) {
  console.warn('patch-ipfs-gateway: artifact-util.js not found; skip');
  process.exit(0);
}

let src = fs.readFileSync(target, 'utf8');
const needle = "const IPFS_GATEWAY = 'https://ipfs-lb.com';";
const replacement =
  "const IPFS_GATEWAY = process.env.RAILGUN_IPFS_GATEWAY || 'https://ipfs.filebase.io';";

if (src.includes(replacement)) {
  console.log('patch-ipfs-gateway: already applied');
  process.exit(0);
}
if (!src.includes(needle)) {
  console.warn('patch-ipfs-gateway: unexpected artifact-util.js; skip');
  process.exit(0);
}

src = src.replace(needle, replacement);
fs.writeFileSync(target, src);
console.log('patch-ipfs-gateway: applied (default https://ipfs.filebase.io)');
