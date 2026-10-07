import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import {
  makeRpc,
  blockAtTime,
  readDeposits,
  CONFIRMATIONS,
} from "./lib/reader.mjs";
import { parseCsv, writeCsv, encodePool, WINDOW_SECONDS } from "./lib/data.mjs";
const rpc = makeRpc();
if (Number(await rpc("eth_chainId")) !== 1)
  throw Error("RPC_URL must be on Ethereum mainnet.");
const head = Number(await rpc("eth_blockNumber")) - CONFIRMATIONS;
if (!Number.isSafeInteger(head) || head <= 0)
  throw Error("Invalid Ethereum chain head.");
const block = await rpc("eth_getBlockByNumber", [
  `0x${head.toString(16)}`,
  false,
]);
const dataTime = Number(block?.timestamp);
if (
  !Number.isSafeInteger(dataTime) ||
  !/^0x[a-f0-9]{64}$/i.test(block?.hash || "")
)
  throw Error("Missing confirmed block.");
const cutoff = dataTime - WINDOW_SECONDS;
if (Math.abs(Date.now() / 1000 - dataTime) > 26 * 3600)
  throw Error("RPC returned an old or future head block.");
let rows = existsSync("data/deposits.csv")
  ? parseCsv(readFileSync("data/deposits.csv", "utf8"))
  : [];
let previous = existsSync("public/data/manifest.json")
  ? JSON.parse(readFileSync("public/data/manifest.json"))
  : null;
if (previous?.demo || previous?.chainId !== 1) previous = null;
const firstBlock = await blockAtTime(rpc, cutoff, head);
if (previous && previous.lastBlock > head)
  throw Error(
    "Data coverage moved backwards. Rebuild from Ethereum with a clean CSV and manifest.",
  );
if (previous?.lastBlockHash) {
  const anchor = await rpc("eth_getBlockByNumber", [
    `0x${previous.lastBlock.toString(16)}`,
    false,
  ]);
  if (anchor?.hash?.toLowerCase() !== previous.lastBlockHash.toLowerCase())
    throw Error(
      "Confirmed chain history changed. Rebuild the pool before publishing.",
    );
}
const ranges = [];
if (!previous) {
  // On bootstrap, verify the entire active window from Ethereum instead of trusting imported CSV rows.
  rows = rows.filter((d) => d.block < firstBlock);
  ranges.push([firstBlock, head]);
} else {
  if (firstBlock < previous.firstBlock)
    ranges.push([firstBlock, previous.firstBlock - 1]);
  if (previous.lastBlock < head) ranges.push([previous.lastBlock + 1, head]);
}
let added = 0,
  removed = 0;
for (const [start, end] of ranges)
  if (start <= end) {
    const result = await readDeposits(rpc, start, end, console.log);
    rows.push(...result.deposits);
    added += result.deposits.length;
    removed += result.removedInternal;
  }
rows.sort((a, b) => a.block - b.block || a.time - b.time);
if (rows.some((d) => d.block > head || d.time > dataTime))
  throw Error("Deposit data is ahead of the confirmed head.");
const { bytes, manifest } = encodePool(rows, {
  dataTime,
  lastBlock: head,
  firstBlock: Math.min(firstBlock, previous?.firstBlock ?? firstBlock),
  lastBlockHash: block.hash,
});
mkdirSync("public/data", { recursive: true });
mkdirSync("data", { recursive: true });
// Write the manifest last. A deployment never uses a partially written pool snapshot.
const updates = [
  ["data/deposits.csv", writeCsv(rows)],
  ["public/data/railgun-eth.bin", bytes],
  ["public/data/manifest.json", JSON.stringify(manifest, null, 2) + "\n"],
];
try {
  for (const [path, value] of updates) writeFileSync(path + ".tmp", value);
  for (const [path] of updates) renameSync(path + ".tmp", path);
} finally {
  for (const [path] of updates) rmSync(path + ".tmp", { force: true });
}
console.log(
  `Updated ${manifest.count} deposits through block ${head}. Added ${added}; excluded ${removed} internal shields.`,
);
