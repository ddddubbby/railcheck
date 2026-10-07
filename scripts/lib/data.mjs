import { createHash } from "node:crypto";
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
  const recent = rows
    .filter((d) => d.time >= dataTime - WINDOW_SECONDS && d.time <= dataTime)
    .sort((a, b) => a.time - b.time);
  if (!recent.length)
    throw Error("No eligible deposits in the 180-day window.");
  const bytes = Buffer.alloc(16 + recent.length * 12);
  bytes.write("EXCK");
  bytes.writeUInt32LE(1, 4);
  bytes.writeUInt32LE(recent.length, 8);
  recent.forEach((d, i) => {
    const nano = (d.amountWei + 500000000n) / 1000000000n;
    if (nano > BigInt(Number.MAX_SAFE_INTEGER) || nano < 0n)
      throw Error("Deposit exceeds the EXCK v1 amount range.");
    bytes.writeDoubleLE(Number(nano), 16 + i * 8);
    bytes.writeUInt32LE(d.time, 16 + recent.length * 8 + i * 4);
  });
  const manifest = {
    version: 1,
    pool: "railgun-ethereum",
    token: "WETH",
    chainId: 1,
    file: "railgun-eth.bin",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    count: recent.length,
    firstDepositTime: recent[0].time,
    lastDepositTime: recent.at(-1).time,
    dataTime,
    firstBlock,
    lastBlock,
    lastBlockHash,
    confirmations: 64,
    buildTime: builtAt,
    source:
      "Ethereum mainnet RAILGUN Shield events, WETH only; excludes transactions with Nullified events.",
  };
  return { bytes, manifest };
}
