import { readDeposits, readWithdrawals } from "./reader.mjs";

const KINDS = ["public", "reshield", "unshield"];

const empty = () => Object.fromEntries(KINDS.map((k) => [k, { count: 0, valueWei: "0" }]));
const sorted = (tokens) =>
  Object.fromEntries(Object.entries(tokens).sort(([a], [b]) => (a < b ? -1 : 1)));

// Adds reader rows to per-token totals: { [token]: { public, reshield, unshield } },
// each { count, valueWei } with valueWei a decimal string of base units. Only the
// token contract address of a row is kept; hashes and blocks are dropped here.
export function addToTotals(tokens, rows) {
  const out = structuredClone(tokens);
  for (const { token, kind, amountWei } of rows) {
    if (!/^0x[a-f0-9]{40}$/.test(token) || !KINDS.includes(kind) || typeof amountWei !== "bigint")
      throw Error("Invalid census row.");
    const entry = (out[token] ||= empty())[kind];
    entry.count += 1;
    entry.valueWei = (BigInt(entry.valueWei) + amountWei).toString();
  }
  return sorted(out);
}

// Sums two sets of per-token totals (disjoint block ranges).
export function mergeTotals(a, b) {
  const out = structuredClone(a);
  for (const [token, kinds] of Object.entries(b)) {
    const t = (out[token] ||= empty());
    for (const k of KINDS) {
      t[k].count += kinds[k].count;
      t[k].valueWei = (BigInt(t[k].valueWei) + BigInt(kinds[k].valueWei)).toString();
    }
  }
  return sorted(out);
}

// Totals for one block range, every ERC-20. Counts: public shields per
// transaction and token, reshields per note, unshields per transaction and token.
export async function censusOfRange(rpc, fromBlock, toBlock, onProgress = () => {}) {
  if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock))
    throw Error("Census needs a block range.");
  if (fromBlock > toBlock) return {};
  const all = { token: null };
  const { deposits } = await readDeposits(rpc, fromBlock, toBlock, onProgress, all);
  const withdrawals = await readWithdrawals(rpc, fromBlock, toBlock, onProgress, all);
  return addToTotals({}, [...deposits, ...withdrawals.map((w) => ({ ...w, kind: "unshield" }))]);
}

// The same, newest blocks first in chunks. `existing` is a saved census
// ({ tokens, readFromBlock }) for the same range: blocks from readFromBlock up
// are already counted, so a resumed run reads only the blocks below it. After
// each chunk, `onChunk(tokens, lowBlock)` gets the totals so far and the
// oldest block read, for the caller to save.
export async function censusInChunks(
  rpc,
  { fromBlock, toBlock, existing = null, chunk = 100000, onChunk = async () => {}, onProgress },
) {
  if (!Number.isSafeInteger(chunk) || chunk < 1) throw Error("Chunk size must be a positive integer.");
  let tokens = existing?.tokens ?? {};
  const start = existing ? existing.readFromBlock - 1 : toBlock;
  for (let high = start; high >= fromBlock; high -= chunk) {
    const low = Math.max(fromBlock, high - chunk + 1);
    tokens = mergeTotals(tokens, await censusOfRange(rpc, low, high, onProgress));
    await onChunk(tokens, low);
  }
  return tokens;
}
