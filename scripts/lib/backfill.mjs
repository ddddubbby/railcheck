import { readDeposits } from "./reader.mjs";

const byRow = (a, b) =>
  a.block - b.block ||
  a.time - b.time ||
  (a.amountWei < b.amountWei ? -1 : a.amountWei > b.amountWei ? 1 : 0);
const key = (d) => `${d.block}:${d.time}:${d.amountWei}`;

// Reads the reshields (swap outputs) of a block range that the daily job never
// covered, and merges them into the rows already in data/reshields.csv. Public
// shields in the range are already in the pool, so only reshield rows are kept.
export async function backfillReshields(
  rpc,
  { fromBlock, toBlock, existing = [], onProgress = () => {} },
) {
  if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock))
    throw Error("Backfill needs a block range.");
  if (fromBlock > toBlock) return { reshields: existing.slice(), added: 0 };
  const { deposits } = await readDeposits(rpc, fromBlock, toBlock, onProgress);
  const seen = new Set(existing.map(key));
  const fresh = deposits
    .filter((d) => d.kind === "reshield")
    .map(({ block, time, amountWei }) => ({ block, time, amountWei }))
    .filter((d) => !seen.has(key(d)) && seen.add(key(d)));
  return { reshields: existing.concat(fresh).sort(byRow), added: fresh.length };
}

// The same, newest blocks first in chunks, so that a run that stops partway
// leaves a contiguous history: after each chunk, `onChunk(reshields, lowBlock)`
// gets every row so far and the oldest block read, for the caller to save.
export async function backfillInChunks(
  rpc,
  { fromBlock, toBlock, existing = [], chunk = 100000, onChunk = async () => {}, onProgress },
) {
  if (!Number.isSafeInteger(chunk) || chunk < 1) throw Error("Chunk size must be a positive integer.");
  let reshields = existing.slice(),
    added = 0;
  for (let high = toBlock; high >= fromBlock; high -= chunk) {
    const low = Math.max(fromBlock, high - chunk + 1);
    const result = await backfillReshields(rpc, { fromBlock: low, toBlock: high, existing: reshields, onProgress });
    reshields = result.reshields;
    added += result.added;
    await onChunk(reshields, low);
  }
  return { reshields, added };
}
