import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

const pub = process.env.PUBLIC_ADDRESS;
const zk = process.env.RAILGUN_ADDRESS;

if (!pub) {
  console.error('No PUBLIC_ADDRESS in .env — run npm run create-wallet first.');
  process.exit(1);
}

console.log(`Public 0x:  ${pub}`);
if (zk) console.log(`RAILGUN 0zk: ${zk}`);
