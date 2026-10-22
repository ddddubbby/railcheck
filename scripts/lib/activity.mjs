import { blockAtTime, readWithdrawals, WETH } from "./reader.mjs";

export const ACTIVITY_SECONDS = 3 * 86400;

// A separate three-day snapshot leaves the anonymity engine's pool format intact.
// Recipients and transaction hashes are discarded before writing to disk.
// The one read covers every token: WETH rows make the snapshot, and all rows
// give the unshield count per token (a coverage metric, counts only).
export async function withdrawalSnapshot(rpc, manifest, onProgress = () => {}) {
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
  const rows = all.filter((r) => r.token === WETH);
  const unshieldsByToken = {};
  for (const r of all) unshieldsByToken[r.token] = (unshieldsByToken[r.token] ?? 0) + 1;
  const snapshot = {
    version: 1,
    chainId: 1,
    token: "WETH",
    fromTime,
    dataTime,
    lastBlock,
    lastBlockHash,
    withdrawals: rows.map(({ time, amountWei }) => ({
      time,
      amountWei: amountWei.toString(),
    })),
  };
  return { snapshot, unshieldsByToken };
}
