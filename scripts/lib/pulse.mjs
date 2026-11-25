import { ACTIVITY_SECONDS } from "./activity.mjs";
import { unitOf } from "./tokens.mjs";

// Real UTC hours, with partial hours at the two edges of the rolling window.
// `entry` is the pool's manifest entry and `token` its TOKENS row. Amounts are
// base units of the token.
export function pulseStats(deposits, snapshot, entry, token) {
  const end = entry.dataTime,
    start = end - ACTIVITY_SECONDS;
  if (
    snapshot.version !== 1 ||
    snapshot.chainId !== 1 ||
    snapshot.token !== token.symbol ||
    snapshot.dataTime !== end ||
    snapshot.fromTime > start ||
    snapshot.lastBlock !== entry.lastBlock ||
    snapshot.lastBlockHash !== entry.lastBlockHash ||
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
      depositAmount: 0n,
      withdrawalAmount: 0n,
    }),
  );
  const unit = unitOf(token);
  let depositCount = 0,
    withdrawalCount = 0,
    depositAmount = 0n,
    withdrawalAmount = 0n;
  for (const d of deposits) {
    // The chart shows public shields; swap outputs are not shields a user sent.
    if (d.kind === "reshield" || d.time < start || d.time > end) continue;
    const bin = bins[Math.floor((d.time - firstHour) / 3600)];
    bin.deposits++;
    // Pool units to base units. Do not reconstruct a gross fee amount.
    const amount = BigInt(d.amount) * unit;
    bin.depositAmount += amount;
    depositAmount += amount;
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
    const amount = BigInt(w.amountWei);
    bin.withdrawalAmount += amount;
    withdrawalAmount += amount;
    withdrawalCount++;
  }
  return {
    start,
    end,
    depositCount,
    withdrawalCount,
    depositAmount,
    withdrawalAmount,
    bins: bins.map((b) => ({
      ...b,
      depositAmount: b.depositAmount.toString(),
      withdrawalAmount: b.withdrawalAmount.toString(),
    })),
  };
}
