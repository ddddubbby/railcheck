import { createHash } from "node:crypto";
import { poolSize, NO_GROUP } from "../../lib/pool/index.mjs";
const isReshield = (d) => d.kind === "reshield";
export const WINDOW_SECONDS = 180 * 86400;
export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.shift() !== "block,time,amount_wei")
    throw Error("Unexpected deposit CSV columns.");
  let previous = -1;
  return lines.filter(Boolean).map((line) => {
    if (!/^\d+,\d+,\d+$/.test(line)) throw Error("Invalid deposit CSV row.");
    const [block, time, amount] = line.split(",");
    const row = {
      block: Number(block),
      time: Number(time),
      amountWei: BigInt(amount),
    };
    if (
      !Number.isSafeInteger(row.block) ||
      row.block < previous ||
      !Number.isSafeInteger(row.time) ||
      row.time <= 0 ||
      row.amountWei <= 0n
    )
      throw Error("Invalid or unsorted deposit CSV.");
    previous = row.block;
    return row;
  });
}
export function writeCsv(rows) {
  return (
    "block,time,amount_wei\n" +
    rows.map((d) => `${d.block},${d.time},${d.amountWei}`).join("\n") +
    "\n"
  );
}
export function encodePool(
  rows,
  {
    dataTime,
    lastBlock,
    firstBlock,
    lastBlockHash,
    builtAt = new Date().toISOString(),
  },
) {
  // Public shields before reshields at the same time, so a reader that merges
  // the two CSV files in that order reproduces the pool.
  const recent = rows
    .filter((d) => d.time >= dataTime - WINDOW_SECONDS && d.time <= dataTime)
    .sort((a, b) => a.time - b.time || isReshield(a) - isReshield(b));
  if (!recent.length)
    throw Error("No eligible deposits in the 180-day window.");
  const reshieldCount = recent.filter(isReshield).length;
  // Version 2 adds one depositor group number per deposit (never an address).
  // Version 3 adds the kind (public shield or reshield) and allows no group.
  const grouped = recent.every((d) => isReshield(d) || Number.isSafeInteger(d.group));
  const version = reshieldCount ? 3 : grouped ? 2 : 1;
  const n = recent.length;
  const bytes = Buffer.alloc(poolSize(version, n));
  bytes.write("EXCK");
  bytes.writeUInt32LE(version, 4);
  bytes.writeUInt32LE(n, 8);
  recent.forEach((d, i) => {
    const nano = (d.amountWei + 500000000n) / 1000000000n;
    if (nano > BigInt(Number.MAX_SAFE_INTEGER) || nano < 0n)
      throw Error("Deposit exceeds the EXCK v1 amount range.");
    bytes.writeDoubleLE(Number(nano), 16 + i * 8);
    bytes.writeUInt32LE(d.time, 16 + n * 8 + i * 4);
    if (version >= 2) {
      const group = grouped && !isReshield(d) ? d.group : NO_GROUP;
      if (group !== NO_GROUP && !(group >= 0 && group < NO_GROUP))
        throw Error("Deposit group is out of range.");
      bytes.writeUInt32LE(group, 16 + n * 12 + i * 4);
    }
    if (version === 3) bytes.writeUInt8(isReshield(d) ? 1 : 0, 16 + n * 16 + i);
  });
  const manifest = {
    version,
    pool: "railgun-ethereum",
    token: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    chainId: 1,
    file: "railgun-eth.bin",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    count: n,
    publicCount: n - reshieldCount,
    reshieldCount,
    firstDepositTime: recent[0].time,
    lastDepositTime: recent.at(-1).time,
    dataTime,
    firstBlock,
    lastBlock,
    lastBlockHash,
    confirmations: 64,
    buildTime: builtAt,
    source: reshieldCount
      ? "Ethereum mainnet RAILGUN Shield events, WETH only; reshields (transactions with Nullified events) are marked and not scored yet."
      : "Ethereum mainnet RAILGUN Shield events, WETH only; excludes transactions with Nullified events.",
  };
  // The data contract: the window and the grouping rule travel with the pool.
  manifest.windowStart = dataTime - WINDOW_SECONDS;
  manifest.windowEnd = dataTime;
  manifest.grouping = grouped ? "tx-sender" : "none";
  return { bytes, manifest };
}
