import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import {
  makeRpc,
  blockAtTime,
  readDeposits,
  CONFIRMATIONS,
} from "./lib/reader.mjs";
import {
  parseCsv,
  writeCsv,
  encodePool,
  WINDOW_SECONDS,
  KIND_SHIELD,
  KIND_RESHIELD,
} from "./lib/data.mjs";
import { withdrawalSnapshot } from "./lib/activity.mjs";
import { createHash } from "node:crypto";
const rpc = makeRpc();
if (Number(await rpc("eth_chainId")) !== 1)
  throw Error("RPC_URL must be on Ethereum mainnet.");
const head = Number(await rpc("eth_blockNumber")) - CONFIRMATIONS;
if (!Number.isSafeInteger(head) || head <= 0)
  throw Error("Invalid Ethereum chain head.");
const block = await rpc("eth_getBlockByNumber", [
  `0x${head.toString(16)}`,
  false,
]);
const dataTime = Number(block?.timestamp);
if (
  !Number.isSafeInteger(dataTime) ||
  !/^0x[a-f0-9]{64}$/i.test(block?.hash || "")
)
  throw Error("Missing confirmed block.");
const cutoff = dataTime - WINDOW_SECONDS;
if (Math.abs(Date.now() / 1000 - dataTime) > 26 * 3600)
  throw Error("RPC returned an old or future head block.");
// Public deposits (legacy CSV has no kind → parseCsv defaults to public).
let rows = existsSync("data/deposits.csv")
  ? parseCsv(readFileSync("data/deposits.csv", "utf8"))
  : [];
// R0.2 staging: path implies reshield. Promote into the v3 CSV/bin, then empty.
let stagedReshields = existsSync("data/reshields.csv")
  ? parseCsv(readFileSync("data/reshields.csv", "utf8")).map((r) => ({
      ...r,
      kind: KIND_RESHIELD,
    }))
  : [];
let previous = existsSync("public/data/manifest.json")
  ? JSON.parse(readFileSync("public/data/manifest.json"))
  : null;
if (previous?.demo || previous?.chainId !== 1) previous = null;
const firstBlock = await blockAtTime(rpc, cutoff, head);
if (previous && previous.lastBlock > head)
  throw Error(
    "Data coverage moved backwards. Rebuild from Ethereum with a clean CSV and manifest.",
  );
if (previous?.lastBlockHash) {
  const anchor = await rpc("eth_getBlockByNumber", [
    `0x${previous.lastBlock.toString(16)}`,
    false,
  ]);
  if (anchor?.hash?.toLowerCase() !== previous.lastBlockHash.toLowerCase())
    throw Error(
      "Confirmed chain history changed. Rebuild the pool before publishing.",
    );
}
const ranges = [];
if (!previous) {
  // On bootstrap, verify the entire active window from Ethereum instead of trusting imported CSV rows.
  rows = rows.filter((d) => d.block < firstBlock);
  stagedReshields = stagedReshields.filter((d) => d.block < firstBlock);
  ranges.push([firstBlock, head]);
} else {
  if (firstBlock < previous.firstBlock)
    ranges.push([firstBlock, previous.firstBlock - 1]);
  if (previous.lastBlock < head) ranges.push([previous.lastBlock + 1, head]);
}
const csvRow = (d) => ({
  block: d.block,
  time: d.time,
  amountWei: d.amountWei,
  kind: d.kind === "reshield" ? KIND_RESHIELD : KIND_SHIELD,
});
let added = 0,
  reshieldsAdded = 0,
  internalsExcluded = 0;
for (const [start, end] of ranges)
  if (start <= end) {
    const result = await readDeposits(rpc, start, end, console.log);
    const fresh = result.deposits.map(csvRow);
    rows.push(...fresh);
    added += fresh.length;
    reshieldsAdded += fresh.filter((d) => d.kind === KIND_RESHIELD).length;
    internalsExcluded += result.removedInternal;
  }
// Promote any remaining R0.2 staging rows that are not already in the unified CSV.
if (stagedReshields.length) {
  const key = (d) => `${d.block}:${d.time}:${d.amountWei}`;
  const have = new Set(
    rows.filter((r) => r.kind === KIND_RESHIELD).map(key),
  );
  for (const r of stagedReshields) if (!have.has(key(r))) rows.push(r);
}
rows.sort((a, b) => a.block - b.block || a.time - b.time);
if (rows.some((d) => d.block > head || d.time > dataTime))
  throw Error("Deposit data is ahead of the confirmed head.");
// EXCK v3: kind byte on every row; reshields enter the live bin only as kind=1.
const { bytes, manifest } = encodePool(rows, {
  dataTime,
  lastBlock: head,
  firstBlock: Math.min(firstBlock, previous?.firstBlock ?? firstBlock),
  lastBlockHash: block.hash,
  reshieldsAdded,
  internalsExcluded,
});
mkdirSync("public/data", { recursive: true });
mkdirSync("data", { recursive: true });
manifest.activity = await withdrawalSnapshot(rpc, manifest, console.log);
manifest.activitySha256 = createHash("sha256")
  .update(JSON.stringify(manifest.activity))
  .digest("hex");
manifest.unshieldsLast3Days = {
  [manifest.token]: manifest.activity.withdrawals.length,
};
// Staging file retired once the published pool carries kind (empty header only).
const updates = [
  ["data/deposits.csv", writeCsv(rows)],
  ["data/reshields.csv", writeCsv([])],
  ["public/data/railgun-eth.bin", bytes],
  ["public/data/manifest.json", JSON.stringify(manifest, null, 2) + "\n"],
];
try {
  for (const [path, value] of updates) writeFileSync(path + ".tmp", value);
  for (const [path] of updates) renameSync(path + ".tmp", path);
} finally {
  for (const [path] of updates) rmSync(path + ".tmp", { force: true });
}
console.log(
  `Updated ${manifest.count} deposits through block ${head}. Added ${added} (${reshieldsAdded} reshields); excluded ${internalsExcluded} internal shields.`,
);
