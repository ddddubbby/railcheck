import { blockAtTime, readWithdrawals } from "./reader.mjs";

export const ACTIVITY_SECONDS = 3 * 86400;

// A separate three-day snapshot leaves the anonymity engine's pool format intact.
// Recipients and transaction hashes are discarded before writing to disk.
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
  const rows = await readWithdrawals(rpc, firstBlock, lastBlock, onProgress);
  if (rows.some((r) => r.time < fromTime || r.time > dataTime))
    throw Error("Withdrawal time is outside the activity window.");
  return {
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
}
