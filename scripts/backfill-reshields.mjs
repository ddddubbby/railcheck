// One-off: read the reshields (swap outputs) from the start of the 180-day
// window up to where the daily job's reshield history begins, and add them to
// data/reshields.csv. It reads newest blocks first in chunks and saves after
// each one, so a run that stops partway can be started again and resumes.
// Run `npm run data:update` afterwards: it rebuilds the pool from the CSV
// files and recomputes the metrics.
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { makeRpc, blockAtTime, CONFIRMATIONS } from "./lib/reader.mjs";
import { parseCsv, writeCsv } from "./lib/data.mjs";
import { backfillInChunks } from "./lib/backfill.mjs";

const rpc = makeRpc();
if (Number(await rpc("eth_chainId")) !== 1)
  throw Error("RPC_URL must be on Ethereum mainnet.");
if (!existsSync("public/data/manifest.json"))
  throw Error("Run the daily update first: the backfill needs its manifest.");
const manifest = JSON.parse(readFileSync("public/data/manifest.json", "utf8"));
if (manifest.demo || manifest.chainId !== 1)
  throw Error("The manifest is not live Ethereum data.");
const existing = existsSync("data/reshields.csv")
  ? parseCsv(readFileSync("data/reshields.csv", "utf8"))
  : [];
// The daily job has reshields from `reshieldsFromBlock` on. Everything in the
// window before that block is missing.
const head = Number(await rpc("eth_blockNumber")) - CONFIRMATIONS;
const fromBlock = await blockAtTime(rpc, manifest.windowStart, head);
const toBlock = Math.min((manifest.metrics?.reshieldsFromBlock ?? manifest.lastBlock + 1) - 1, head);
if (fromBlock > toBlock) {
  console.log("Reshield history already covers the window. Nothing to do.");
  process.exit(0);
}
console.log(`Reading reshields in blocks ${fromBlock}–${toBlock}, newest first.`);
function save(reshields, lowBlock) {
  // The daily job takes the earliest of this block and the oldest reshield row,
  // so the history start is right even when the first blocks had no reshield.
  manifest.metrics = { ...manifest.metrics, reshieldsFromBlock: lowBlock };
  const updates = [
    ["data/reshields.csv", writeCsv(reshields)],
    ["public/data/manifest.json", JSON.stringify(manifest, null, 2) + "\n"],
  ];
  try {
    for (const [path, value] of updates) writeFileSync(path + ".tmp", value);
    for (const [path] of updates) renameSync(path + ".tmp", path);
  } finally {
    for (const [path] of updates) rmSync(path + ".tmp", { force: true });
  }
  console.log(`Saved: ${reshields.length} reshields, history from block ${lowBlock}.`);
}
const { reshields, added } = await backfillInChunks(rpc, {
  fromBlock,
  toBlock,
  existing,
  chunk: Number(process.env.BACKFILL_CHUNK || 100000),
  onChunk: save,
  onProgress: console.log,
});
console.log(`Added ${added} reshields; ${reshields.length} in total from block ${fromBlock}.`);
