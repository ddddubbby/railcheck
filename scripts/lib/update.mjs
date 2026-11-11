import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { blockAtTime, readDeposits, CONFIRMATIONS } from "./reader.mjs";
import { parseCsv, writeCsv, encodePool, WINDOW_SECONDS } from "./data.mjs";
import { withdrawalSnapshots } from "./activity.mjs";
import { TOKENS, poolEntry, ENTRY_FIELDS } from "./tokens.mjs";
import { checkPool } from "./validate.mjs";

const MANIFEST = "public/data/manifest.json";
const byBlock = (a, b) => a.block - b.block || a.time - b.time;
const csvRow = ({ block, time, amountWei }) => ({ block, time, amountWei });
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Sorted, merged block ranges: overlapping or adjacent ranges become one.
export function mergeRanges(ranges) {
  const merged = [];
  for (const [start, end] of ranges
    .filter(([s, e]) => s <= e)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

// The parts of sorted, merged `ranges` that are not in sorted, merged `minus`.
export function subtractRanges(ranges, minus) {
  const out = [];
  for (const [start, end] of ranges) {
    let from = start;
    for (const [s, e] of minus) {
      if (e < from || s > end) continue;
      if (s > from) out.push([from, s - 1]);
      from = Math.max(from, e + 1);
    }
    if (from <= end) out.push([from, end]);
  }
  return out;
}

// Public shield transactions with more than one note of one token (OD-2), per
// token id. A count only: no address, hash or block leaves this function.
export function countMultiNoteShields(rows, tokens = TOKENS) {
  return Object.fromEntries(
    tokens.map((t) => [
      t.id,
      rows.filter((r) => r.kind === "public" && r.token === t.contract && r.notes > 1).length,
    ]),
  );
}

/**
 * The daily update of every pool in `tokens` (WETH first: it is the top level
 * of the manifest; the others go to `manifest.pools`). One log read per block
 * range serves every pool (DATA-9). A pool with no manifest entry or a missing
 * CSV reads its whole 180-day window (bootstrap); later runs read only the new
 * blocks. A new pool whose bootstrap fails is left out of the run; the others
 * are still published. All files are written first and the manifest last.
 */
export async function updatePools({
  rpc,
  dir = ".",
  tokens = TOKENS,
  now = () => Date.now(),
  log = console.log,
  warn = log,
  readOptions = {},
  // How long the read of new pools' windows may take before they are left out.
  bootstrapBudgetMs = 30 * 60 * 1000,
}) {
  if (tokens[0]?.id !== "weth") throw Error("The WETH pool must come first.");
  const path = (p) => join(dir, p);
  if (Number(await rpc("eth_chainId")) !== 1)
    throw Error("RPC_URL must be on Ethereum mainnet.");
  const head = Number(await rpc("eth_blockNumber")) - CONFIRMATIONS;
  if (!Number.isSafeInteger(head) || head <= 0)
    throw Error("Invalid Ethereum chain head.");
  const block = await rpc("eth_getBlockByNumber", [`0x${head.toString(16)}`, false]);
  const dataTime = Number(block?.timestamp);
  if (!Number.isSafeInteger(dataTime) || !/^0x[a-f0-9]{64}$/i.test(block?.hash || ""))
    throw Error("Missing confirmed block.");
  const cutoff = dataTime - WINDOW_SECONDS;
  if (Math.abs(now() / 1000 - dataTime) > 26 * 3600)
    throw Error("RPC returned an old or future head block.");
  let previousManifest = existsSync(path(MANIFEST))
    ? JSON.parse(readFileSync(path(MANIFEST), "utf8"))
    : null;
  if (previousManifest?.demo || previousManifest?.chainId !== 1) previousManifest = null;
  const firstBlock = await blockAtTime(rpc, cutoff, head);
  const anchors = new Map();
  const anchorHash = async (n) => {
    if (!anchors.has(n))
      anchors.set(n, (await rpc("eth_getBlockByNumber", [`0x${n.toString(16)}`, false]))?.hash);
    return anchors.get(n);
  };

  // Per pool: the stored rows, the previous coverage and the ranges to read.
  // A pool with no previous coverage bootstraps: it reads its whole window.
  // A bootstrapping pool other than WETH is optional for this run: if its
  // read or its checks fail, it is left out and the published pools still
  // update. Safety checks of published pools stop the whole run.
  const pools = [];
  for (const t of tokens) {
    const readCsv = (p) => (existsSync(path(p)) ? parseCsv(readFileSync(path(p), "utf8")) : []);
    let previous = poolEntry(previousManifest, t.id) ?? null;
    if (previous && (previous.chainId !== 1 || previous.token !== t.contract)) previous = null;
    // Reshields are kept in their own CSV (same columns) and written to the
    // pool with kind "reshield" (EXCK v3). Both CSV files must be there for an
    // incremental run; without either, the pool bootstraps.
    if (!existsSync(path(t.depositsCsv)) || !existsSync(path(t.reshieldsCsv))) previous = null;
    let rows = readCsv(t.depositsCsv),
      reshields = readCsv(t.reshieldsCsv);
    if (previous && previous.lastBlock > head)
      throw Error(
        `${t.symbol} data coverage moved backwards. Rebuild from Ethereum with a clean CSV and manifest.`,
      );
    if (previous?.lastBlockHash) {
      const hash = await anchorHash(previous.lastBlock);
      if (hash?.toLowerCase() !== previous.lastBlockHash.toLowerCase())
        throw Error(
          `Confirmed chain history changed (${t.symbol}). Rebuild the pool before publishing.`,
        );
    }
    const ranges = [];
    if (!previous) {
      // Bootstrap: verify the entire active window from Ethereum instead of
      // trusting imported CSV rows.
      rows = rows.filter((d) => d.block < firstBlock);
      reshields = reshields.filter((d) => d.block < firstBlock);
      ranges.push([firstBlock, head]);
    } else {
      if (firstBlock < previous.firstBlock) ranges.push([firstBlock, previous.firstBlock - 1]);
      if (previous.lastBlock < head) ranges.push([previous.lastBlock + 1, head]);
      // Rows inside the ranges about to be read are not covered by the
      // published manifest (a run that stopped between file renames): drop
      // them, so a re-run cannot count them twice.
      const unread = (d) => !ranges.some(([s, e]) => d.block >= s && d.block <= e);
      rows = rows.filter(unread);
      reshields = reshields.filter(unread);
    }
    const optional = !previous && t.id !== tokens[0].id;
    pools.push({ t, previous, optional, rows, reshields, ranges, added: 0, foundReshields: 0 });
  }
  const skip = (p, error) => {
    p.skipped = true;
    warn(
      `${p.t.symbol} pool left out of this run: its first full-window build failed (${error.message}). The other pools are published; the next run tries again.`,
    );
  };

  // DATA-9: one read of each block range for every pool, folded per token.
  // The ranges the published pools need are read first; the rest of a
  // bootstrap window is read after, under a time budget, so a failure there
  // only leaves out the new pools.
  const read = [];
  const required = mergeRanges(pools.filter((p) => !p.optional).flatMap((p) => p.ranges));
  for (const [start, end] of required) {
    const result = await readDeposits(rpc, start, end, log, { ...readOptions, token: null });
    read.push(...result.deposits);
  }
  const optional = pools.filter((p) => p.optional);
  if (optional.length) {
    const deadline = now() + bootstrapBudgetMs;
    const budgeted = async (method, params) => {
      if (now() > deadline) throw Error("bootstrap time budget exceeded");
      return rpc(method, params);
    };
    const extra = [];
    try {
      for (const [start, end] of subtractRanges(
        mergeRanges(optional.flatMap((p) => p.ranges)),
        required,
      )) {
        const result = await readDeposits(budgeted, start, end, log, { ...readOptions, token: null });
        extra.push(...result.deposits);
      }
      read.push(...extra);
    } catch (error) {
      for (const p of optional) skip(p, error);
    }
  }
  read.sort((a, b) => a.block - b.block);

  const build = (p) => {
    const inRange = (b) => p.ranges.some(([s, e]) => b >= s && b <= e);
    for (const d of read) {
      if (d.token !== p.t.contract || !inRange(d.block)) continue;
      if (d.kind === "reshield") {
        p.reshields.push(csvRow(d));
        p.foundReshields++;
      } else {
        p.rows.push(csvRow(d));
        p.added++;
      }
    }
    p.rows.sort(byBlock);
    p.reshields.sort(byBlock);
    if (p.rows.some((d) => d.block > head || d.time > dataTime))
      throw Error(`${p.t.symbol} deposit data is ahead of the confirmed head.`);
    if (p.reshields.some((d) => d.block > head || d.time > dataTime))
      throw Error(`${p.t.symbol} reshield data is ahead of the confirmed head.`);
    const { bytes, manifest } = encodePool(
      [...p.rows, ...p.reshields.map((r) => ({ ...r, kind: "reshield" }))],
      {
        dataTime,
        lastBlock: head,
        firstBlock: Math.min(firstBlock, p.previous?.firstBlock ?? firstBlock),
        lastBlockHash: block.hash,
        builtAt: new Date(now()).toISOString(),
        asset: p.t,
      },
    );
    Object.assign(p, { bytes, manifest });
  };
  for (const p of pools) {
    if (p.skipped) continue;
    if (!p.optional) build(p);
    else
      try {
        build(p);
      } catch (error) {
        skip(p, error);
      }
  }

  const { snapshots, unshieldsByToken } = await withdrawalSnapshots(
    rpc,
    { dataTime, lastBlock: head, lastBlockHash: block.hash },
    tokens,
    log,
  );
  const [weth, ...others] = pools;
  // WETH reshield history starts at the first run that read them, not at the
  // window start, unless a backfill moved it: the earliest of the recorded
  // start and the oldest reshield row.
  const reshieldsFromBlock = Math.min(
    weth.previous?.metrics?.reshieldsFromBlock ??
      (weth.previous ? weth.previous.lastBlock + 1 : firstBlock),
    weth.reshields[0]?.block ?? Infinity,
  );
  const manifest = weth.manifest;
  manifest.activity = snapshots.weth;
  // Coverage metrics of this run (counts only, no addresses): DATA-6 in the spec.
  manifest.metrics = {
    publicShieldsAdded: weth.added,
    reshieldsAdded: weth.foundReshields,
    reshieldsFromBlock,
    reshieldHistoryComplete: reshieldsFromBlock <= firstBlock,
    unshieldsByToken3d: unshieldsByToken,
    multiNoteShields: countMultiNoteShields(read, tokens),
  };
  manifest.activitySha256 = sha256(JSON.stringify(manifest.activity));
  const entries = {};
  for (const p of others) {
    if (p.skipped) continue;
    // A bootstrapped pool read its whole window, reshields included; later
    // runs read every new block, so a complete history stays complete.
    const reshieldHistoryComplete = p.previous ? p.previous.reshieldHistoryComplete === true : true;
    const activity = snapshots[p.t.id];
    const full = {
      ...p.manifest,
      symbol: p.t.symbol,
      decimals: p.t.decimals,
      unitDecimals: p.t.unitDecimals,
      reshieldHistoryComplete,
      activity,
      activitySha256: sha256(JSON.stringify(activity)),
    };
    entries[p.t.id] = Object.fromEntries(ENTRY_FIELDS.map((k) => [k, full[k]]));
  }
  // The checks of scripts/validate-data.mjs, before anything is written. A
  // bootstrapping pool that fails them is left out; any other pool stops the run.
  for (const p of pools) {
    if (p.skipped) continue;
    const check = () =>
      checkPool(p.t, p === weth ? manifest : entries[p.t.id], manifest, {
        raw: p.bytes,
        depositsText: writeCsv(p.rows),
        reshieldsText: writeCsv(p.reshields),
      });
    if (!p.optional) check();
    else
      try {
        check();
      } catch (error) {
        delete entries[p.t.id];
        skip(p, error);
      }
  }
  if (Object.keys(entries).length) manifest.pools = entries;

  mkdirSync(path("public/data"), { recursive: true });
  mkdirSync(path("data"), { recursive: true });
  // Write the manifest last. A deployment never uses a partially written pool snapshot.
  const published = pools.filter((p) => !p.skipped);
  const updates = [
    ...published.flatMap((p) => [
      [p.t.depositsCsv, writeCsv(p.rows)],
      [p.t.reshieldsCsv, writeCsv(p.reshields)],
      [`public/data/${p.t.file}`, p.bytes],
    ]),
    [MANIFEST, JSON.stringify(manifest, null, 2) + "\n"],
  ];
  writeAll(updates.map(([p, value]) => [path(p), value]));
  for (const p of published)
    log(
      `${p.t.symbol}: ${p.manifest.publicCount} public shields and ${p.manifest.reshieldCount} reshields through block ${head}${p.previous ? "" : " (full window read)"}. Added ${p.added} public shields and ${p.foundReshields} reshields.`,
    );
  return manifest;
}

// Writes every file to a temporary path first, then renames them in order, so
// the last path (the manifest) changes last.
export function writeAll(updates, fs = { writeFileSync, renameSync, rmSync }) {
  try {
    for (const [p, value] of updates) fs.writeFileSync(p + ".tmp", value);
    for (const [p] of updates) fs.renameSync(p + ".tmp", p);
  } finally {
    for (const [p] of updates) fs.rmSync(p + ".tmp", { force: true });
  }
}
