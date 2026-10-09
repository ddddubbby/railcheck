import { ACTIVITY_SECONDS } from "./activity.mjs";

// Real UTC hours, with partial hours at the two edges of the rolling window.
export function pulseStats(deposits, snapshot, manifest) {
  const end = manifest.dataTime,
    start = end - ACTIVITY_SECONDS;
  if (
    snapshot.version !== 1 ||
    snapshot.chainId !== 1 ||
    snapshot.token !== "WETH" ||
    snapshot.dataTime !== end ||
    snapshot.fromTime > start ||
    snapshot.lastBlock !== manifest.lastBlock ||
    snapshot.lastBlockHash !== manifest.lastBlockHash ||
    !Array.isArray(snapshot.withdrawals)
  )
    throw Error(
      "Activity and deposit snapshots must cover the same confirmed block.",
    );
  const firstHour = Math.floor(start / 3600) * 3600;
  const bins = Array.from(
    { length: Math.floor((end - firstHour) / 3600) + 1 },
    (_, i) => ({
      start: Math.max(start, firstHour + i * 3600),
      end: Math.min(end, firstHour + (i + 1) * 3600),
      deposits: 0,
      withdrawals: 0,
      depositWei: 0n,
      withdrawalWei: 0n,
    }),
  );
  let depositCount = 0,
    withdrawalCount = 0,
    depositWei = 0n,
    withdrawalWei = 0n;
  for (const d of deposits) {
    if (d.time < start || d.time > end) continue;
    const bin = bins[Math.floor((d.time - firstHour) / 3600)];
    bin.deposits++;
    // The existing pool stores nano-ETH. Do not reconstruct a gross fee amount.
    const wei = BigInt(d.amount) * 1000000000n;
    bin.depositWei += wei;
    depositWei += wei;
    depositCount++;
  }
  // A snapshot may cover a longer window (for example one written before the
  // window shrank); rows before the window are dropped, not trusted less.
  for (const w of snapshot.withdrawals) {
    if (
      !Number.isSafeInteger(w.time) ||
      w.time < snapshot.fromTime ||
      w.time > end ||
      !/^[1-9]\d*$/.test(w.amountWei)
    )
      throw Error("Invalid withdrawal snapshot row.");
    if (w.time < start) continue;
    const bin = bins[Math.floor((w.time - firstHour) / 3600)];
    bin.withdrawals++;
    const wei = BigInt(w.amountWei);
    bin.withdrawalWei += wei;
    withdrawalWei += wei;
    withdrawalCount++;
  }
  return {
    start,
    end,
    depositCount,
    withdrawalCount,
    depositWei,
    withdrawalWei,
    bins: bins.map((b) => ({
      ...b,
      depositWei: b.depositWei.toString(),
      withdrawalWei: b.withdrawalWei.toString(),
    })),
  };
}
