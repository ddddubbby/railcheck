import { createHash } from "node:crypto";
export const WINDOW_SECONDS = 180 * 86400;
export const POOL_FILE = /^railgun-eth-[a-f0-9]{16}\.bin$/;
export function parseCsv(text, label = "deposit") {
  const lines = text.trim().split(/\r?\n/);
  if (lines.shift() !== "block,time,amount_wei")
    throw Error(`Unexpected ${label} CSV columns.`);
  let previous = -1;
  return lines.filter(Boolean).map((line) => {
    if (!/^\d+,\d+,\d+$/.test(line)) throw Error(`Invalid ${label} CSV row.`);
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
      throw Error(`Invalid or unsorted ${label} CSV.`);
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
export const inWindow = (rows, dataTime) =>
  rows
    .filter((d) => d.time >= dataTime - WINDOW_SECONDS && d.time <= dataTime)
    .sort((a, b) => a.time - b.time);
const toNano = (wei) => {
  const nano = (wei + 500000000n) / 1000000000n;
  if (nano > BigInt(Number.MAX_SAFE_INTEGER) || nano < 0n)
    throw Error("Amount exceeds the EXCK amount range.");
  return Number(nano);
};
// EXCK v2: "EXCK", version, deposit count n, withdrawal count m, then
// n + m float64 gwei amounts (deposits first) and n + m uint32 times.
export function encodePool(
  rows,
  withdrawalRows,
  {
    dataTime,
    lastBlock,
    firstBlock,
    lastBlockHash,
    builtAt = new Date().toISOString(),
  },
) {
  const recent = inWindow(rows, dataTime),
    exits = inWindow(withdrawalRows, dataTime);
  if (!recent.length)
    throw Error("No eligible deposits in the 180-day window.");
  const n = recent.length,
    m = exits.length,
    all = [...recent, ...exits];
  const bytes = Buffer.alloc(16 + (n + m) * 12);
  bytes.write("EXCK");
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(n, 8);
  bytes.writeUInt32LE(m, 12);
  all.forEach((d, i) => {
    bytes.writeDoubleLE(toNano(d.amountWei), 16 + i * 8);
    bytes.writeUInt32LE(d.time, 16 + (n + m) * 8 + i * 4);
  });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    version: 2,
    pool: "railgun-ethereum",
    token: "WETH",
    chainId: 1,
    file: `railgun-eth-${sha256.slice(0, 16)}.bin`,
    sha256,
    size: bytes.length,
    count: n,
    withdrawalCount: m,
    firstDepositTime: recent[0].time,
    lastDepositTime: recent.at(-1).time,
    dataTime,
    firstBlock,
    lastBlock,
    lastBlockHash,
    confirmations: 64,
    buildTime: builtAt,
    source:
      "Ethereum mainnet RAILGUN Shield and Unshield events, WETH only; deposits exclude transactions with Nullified events; withdrawals are amount plus fee and exclude transactions that also shield.",
  };
  return { bytes, manifest };
}
