import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { decode } from "../../lib/pool/index.mjs";
import { parseCsv, WINDOW_SECONDS } from "./data.mjs";
import { TOKENS, tokenById, toUnits } from "./tokens.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Checks one pool of the manifest against its file and its CSV files, and
// returns the decoded deposits. `entry` is the manifest top level for WETH and
// `manifest.pools[id]` for the others.
export function validatePool(dir, t, entry, top) {
  const fail = (message) => {
    throw Error(`${t.symbol} pool: ${message}`);
  };
  if (
    entry.demo ||
    entry.chainId !== 1 ||
    entry.token !== t.contract ||
    entry.file !== t.file ||
    !(entry.confirmations >= 64)
  )
    fail("live data provenance is missing.");
  if (
    entry !== top &&
    (entry.symbol !== t.symbol ||
      entry.decimals !== t.decimals ||
      entry.unitDecimals !== t.unitDecimals ||
      typeof entry.reshieldHistoryComplete !== "boolean")
  )
    fail("token description differs from the pipeline's token list.");
  // Every pool comes from the same run: one confirmed block for all.
  if (
    entry.dataTime !== top.dataTime ||
    entry.lastBlock !== top.lastBlock ||
    entry.lastBlockHash !== top.lastBlockHash
  )
    fail("the pool block differs from the WETH pool block.");
  const raw = readFileSync(join(dir, "public/data", entry.file));
  if (sha256(raw) !== entry.sha256 || raw.length !== entry.size)
    fail("hash or size differs from manifest.");
  const pool = decode(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), entry);
  const activity = JSON.stringify(entry.activity);
  if (
    !activity ||
    sha256(activity) !== entry.activitySha256 ||
    entry.activity.token !== t.symbol ||
    entry.activity.dataTime !== entry.dataTime
  )
    fail("activity snapshot differs from its hash or pool.");
  // The pool is the two CSV files merged by time, public shields first at a tie.
  const kinded = (path, kind) =>
    existsSync(join(dir, path))
      ? parseCsv(readFileSync(join(dir, path), "utf8")).map((d) => ({ ...d, kind }))
      : [];
  const rows = [
    ...kinded(t.depositsCsv, "public"),
    ...(entry.version === 3 ? kinded(t.reshieldsCsv, "reshield") : []),
  ];
  const recent = rows
    .filter((d) => d.time >= entry.dataTime - WINDOW_SECONDS && d.time <= entry.dataTime)
    .sort((a, b) => a.time - b.time || (a.kind === "reshield") - (b.kind === "reshield"));
  if (
    recent.length !== pool.length ||
    recent.some(
      (r, i) =>
        Number(toUnits(r.amountWei, t)) !== pool[i].amount ||
        r.time !== pool[i].time ||
        (entry.version === 3 && r.kind !== pool[i].kind),
    )
  )
    fail("CSV does not reproduce the pool.");
  return pool;
}

// Every pool in public/data/manifest.json: the top level (WETH) and each
// entry of `pools`. Returns { manifest, pools: { [id]: deposits } }.
export function validatePools(dir = ".") {
  const manifest = JSON.parse(readFileSync(join(dir, "public/data/manifest.json"), "utf8"));
  if (manifest.demo || manifest.chainId !== 1 || manifest.token !== TOKENS[0].contract)
    throw Error("Live data provenance is missing.");
  const pools = { weth: validatePool(dir, TOKENS[0], manifest, manifest) };
  for (const [id, entry] of Object.entries(manifest.pools ?? {})) {
    const t = tokenById(id);
    if (!t || t === TOKENS[0]) throw Error(`Unknown pool "${id}" in the manifest.`);
    pools[id] = validatePool(dir, t, entry, manifest);
  }
  return { manifest, pools };
}
