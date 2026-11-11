import { blockAtTime, readWithdrawals } from "./reader.mjs";
import { TOKENS } from "./tokens.mjs";

export const ACTIVITY_SECONDS = 3 * 86400;

// A separate three-day snapshot leaves the anonymity engine's pool format intact.
// Recipients and transaction hashes are discarded before writing to disk.
// The one read covers every token: the rows of each pool token make that
// pool's snapshot, and all rows give the unshield count per token (a coverage
// metric, counts only). Amounts are base units of the token (`amountWei`).
export async function withdrawalSnapshots(rpc, manifest, tokens = TOKENS, onProgress = () => {}) {
  const { dataTime, lastBlock, lastBlockHash } = manifest;
  const anchor = await rpc("eth_getBlockByNumber", [
    `0x${lastBlock.toString(16)}`,
    false,
  ]);
  if (
    anchor?.hash?.toLowerCase() !== lastBlockHash.toLowerCase() ||
    Number(anchor?.timestamp) !== dataTime
  )
    throw Error("Activity snapshot does not match the confirmed pool block.");
  const fromTime = dataTime - ACTIVITY_SECONDS;
  const firstBlock = await blockAtTime(rpc, fromTime, lastBlock);
  const all = await readWithdrawals(rpc, firstBlock, lastBlock, onProgress, { token: null });
  if (all.some((r) => r.time < fromTime || r.time > dataTime))
    throw Error("Withdrawal time is outside the activity window.");
  const unshieldsByToken = {};
  for (const r of all) unshieldsByToken[r.token] = (unshieldsByToken[r.token] ?? 0) + 1;
  const snapshots = {};
  for (const t of tokens)
    snapshots[t.id] = {
      version: 1,
      chainId: 1,
      token: t.symbol,
      fromTime,
      dataTime,
      lastBlock,
      lastBlockHash,
      withdrawals: all
        .filter((r) => r.token === t.contract)
        .map(({ time, amountWei }) => ({ time, amountWei: amountWei.toString() })),
    };
  return { snapshots, unshieldsByToken };
}

// The WETH snapshot alone, as before the stablecoin pools.
export async function withdrawalSnapshot(rpc, manifest, onProgress = () => {}) {
  const { snapshots, unshieldsByToken } = await withdrawalSnapshots(rpc, manifest, [TOKENS[0]], onProgress);
  return { snapshot: snapshots.weth, unshieldsByToken };
}
