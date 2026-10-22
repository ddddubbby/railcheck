import { createHash } from "node:crypto";
import {
  NO_GROUP,
  KIND_SHIELD,
  KIND_RESHIELD,
} from "../../lib/pool/index.mjs";
export const WINDOW_SECONDS = 180 * 86400;
export { NO_GROUP, KIND_SHIELD, KIND_RESHIELD };

export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift();
  if (header !== "block,time,amount_wei" && header !== "block,time,amount_wei,kind")
    throw Error("Unexpected deposit CSV columns.");
  const withKind = header.endsWith(",kind");
  let previous = -1;
  return lines.filter(Boolean).map((line) => {
    if (
      !(withKind ? /^\d+,\d+,\d+,[01]$/ : /^\d+,\d+,\d+$/).test(line)
    )
      throw Error("Invalid deposit CSV row.");
    const [block, time, amount, kind] = line.split(",");
    const row = {
      block: Number(block),
      time: Number(time),
      amountWei: BigInt(amount),
      kind: withKind ? Number(kind) : KIND_SHIELD,
    };
    if (
      !Number.isSafeInteger(row.block) ||
      row.block < previous ||
      !Number.isSafeInteger(row.time) ||
      row.time <= 0 ||
      row.amountWei <= 0n ||
      (row.kind !== KIND_SHIELD && row.kind !== KIND_RESHIELD)
    )
      throw Error("Invalid or unsorted deposit CSV.");
    previous = row.block;
    return row;
  });
}
export function writeCsv(rows) {
  return (
    "block,time,amount_wei,kind\n" +
    rows
      .map(
        (d) =>
          `${d.block},${d.time},${d.amountWei},${d.kind ?? KIND_SHIELD}`,
      )
      .join("\n") +
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
    reshieldsAdded = 0,
    internalsExcluded = 0,
    unshieldsLast3Days = null,
  },
) {
  const recent = rows
    .filter((d) => d.time >= dataTime - WINDOW_SECONDS && d.time <= dataTime)
    .sort((a, b) => a.time - b.time);
  if (!recent.length)
    throw Error("No eligible deposits in the 180-day window.");
  // v3: kind byte + group always present. v2: group only. v1: amount + time.
  const hasKind = recent.every(
    (d) => d.kind === KIND_SHIELD || d.kind === KIND_RESHIELD,
  );
  const hasGroup = recent.every((d) => Number.isSafeInteger(d.group));
  const version = hasKind ? 3 : hasGroup ? 2 : 1;
  const rowBytes = version === 3 ? 17 : version === 2 ? 16 : 12;
  const bytes = Buffer.alloc(16 + recent.length * rowBytes);
  bytes.write("EXCK");
  bytes.writeUInt32LE(version, 4);
  bytes.writeUInt32LE(recent.length, 8);
  recent.forEach((d, i) => {
    const nano = (d.amountWei + 500000000n) / 1000000000n;
    if (nano > BigInt(Number.MAX_SAFE_INTEGER) || nano < 0n)
      throw Error("Deposit exceeds the EXCK v1 amount range.");
    bytes.writeDoubleLE(Number(nano), 16 + i * 8);
    bytes.writeUInt32LE(d.time, 16 + recent.length * 8 + i * 4);
    if (version >= 2) {
      const group =
        version === 3
          ? Number.isSafeInteger(d.group)
            ? d.group
            : NO_GROUP
          : d.group;
      // Reshields never carry a depositor group.
      bytes.writeUInt32LE(
        version === 3 && d.kind === KIND_RESHIELD ? NO_GROUP : group,
        16 + recent.length * 12 + i * 4,
      );
    }
    if (version === 3) bytes.writeUInt8(d.kind, 16 + recent.length * 16 + i);
  });
  const anySenderGroup = recent.some(
    (d) =>
      Number.isSafeInteger(d.group) &&
      (d.group >>> 0) !== NO_GROUP &&
      d.kind !== KIND_RESHIELD,
  );
  const manifest = {
    version,
    pool: "railgun-ethereum",
    token: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
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
      "Ethereum mainnet RAILGUN Shield events, WETH only; includes public shields and swap-output reshields (Nullified transactions).",
    reshieldsAdded,
    internalsExcluded,
  };
  // The data contract: the window and the grouping rule travel with the pool.
  manifest.windowStart = dataTime - WINDOW_SECONDS;
  manifest.windowEnd = dataTime;
  manifest.grouping =
    version >= 2 && anySenderGroup ? "tx-sender" : "none";
  if (unshieldsLast3Days) manifest.unshieldsLast3Days = unshieldsLast3Days;
  return { bytes, manifest };
}
