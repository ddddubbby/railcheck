import { decode } from "./lib/pool/index.mjs";
import { parseAmount, check, prepare, inspect, ETH_ASSET, USDT_ASSET, USDC_ASSET } from "./lib/engine/index.mjs";
import { plan } from "./lib/engine/advice.mjs";
import { toJSON } from "./lib/format.mjs";
// The published pools: WETH is the manifest top level, the others are entries
// of `manifest.pools`. Only these file names are ever fetched.
const FILE = /^railgun-(eth|usdt|usdc)\.bin$/;
const POOLS = [
  { id: "weth", file: "railgun-eth.bin", asset: ETH_ASSET, name: "ethereum-weth" },
  { id: "usdt", file: "railgun-usdt.bin", asset: USDT_ASSET, name: "ethereum-usdt" },
  { id: "usdc", file: "railgun-usdc.bin", asset: USDC_ASSET, name: "ethereum-usdc" },
];
const WINDOW = 180 * 86400;
const UNLOADED = "The pool data did not load. Check your connection, then try again.";
let manifest;
const pools = {};
// The checks the WETH pool has always had: provenance, file name, and (after
// the fetch) the hash and size. A stable entry must also describe its token as
// the engine does, carry the reshield-history flag the pipeline writes only
// after its safety checks (VAL-5), and cover a full 180-day window.
function valid({ id, file, asset }, entry) {
  if (
    !entry ||
    !FILE.test(entry.file) ||
    entry.file !== file ||
    entry.demo ||
    entry.chainId !== 1 ||
    entry.token !== asset.address
  )
    return false;
  if (id === "weth") return true;
  return (
    entry.symbol === asset.symbol &&
    entry.decimals === asset.decimals &&
    entry.unitDecimals === asset.unitDecimals &&
    entry.confirmations >= 64 &&
    typeof entry.reshieldHistoryComplete === "boolean" &&
    Number.isSafeInteger(entry.windowStart) &&
    Number.isSafeInteger(entry.dataTime) &&
    entry.windowStart <= entry.dataTime - WINDOW
  );
}
async function fetchPool(entry) {
  const r = await fetch("./data/" + entry.file, { credentials: "omit" });
  if (!r.ok) throw Error();
  const buffer = await r.arrayBuffer();
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== entry.sha256 || buffer.byteLength !== entry.size) throw Error();
  return decode(buffer, entry);
}
// One sorted pool per token and page load, shared by every request.
function prepared(p) {
  const { entry } = p;
  return (p.pool ||= prepare(p.deposits, {
    now: Date.now() / 1000,
    asset: p.asset,
    snapshot: {
      pool: p.name,
      chainId: entry.chainId,
      token: entry.token,
      block: entry.lastBlock,
      time: entry.dataTime,
      windowStart: entry.windowStart ?? entry.dataTime - WINDOW,
      grouping: entry.grouping ?? "none",
      // false when the swap-output rows do not reach back to the window
      // start: coverage is then "limited" (swap-output-history). Missing
      // in older manifests: left out, as before.
      reshieldHistoryComplete:
        p.id === "weth" ? manifest.metrics?.reshieldHistoryComplete : entry.reshieldHistoryComplete,
    },
  }));
}
// The pool of a request: WETH when the message names none.
function poolOf(id = "weth") {
  const p = pools[id];
  if (!p) throw Error(UNLOADED);
  return p;
}
self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") {
      const m = await fetch("./data/manifest.json", {
        cache: "no-store",
        credentials: "omit",
      });
      if (!m.ok) throw Error();
      manifest = await m.json();
      if (!valid(POOLS[0], manifest)) throw Error();
      // Every published pool is fetched now, whatever token is picked, so the
      // requests do not show which token is checked. A stable pool that fails
      // its checks is left out: its chip shows "not covered", not an error.
      const results = await Promise.allSettled(
        POOLS.map(async (p) => {
          const { id } = p,
            entry = id === "weth" ? manifest : manifest.pools?.[id];
          // Any other file name in the manifest is ignored, never fetched.
          if (!FILE.test(entry?.file) || entry.file !== p.file) return null;
          const deposits = await fetchPool(entry);
          return valid(p, entry) ? { entry, deposits } : null;
        }),
      );
      if (results[0].status !== "fulfilled" || !results[0].value) throw Error();
      const covered = {};
      POOLS.forEach((p, i) => {
        const r = results[i];
        covered[p.id] = r.status === "fulfilled" && !!r.value;
        if (covered[p.id]) pools[p.id] = { ...p, ...r.value };
      });
      self.postMessage({
        type: "ready",
        manifest,
        covered,
        counts: Object.fromEntries(Object.entries(pools).map(([id, p]) => [id, p.entry.count])),
      });
    } else if (data.type === "plan") {
      const p = poolOf(data.token),
        pool = prepared(p),
        { asset } = p;
      const amount = parseAmount(data.amount, asset),
        result = plan(pool, {
          action: data.action,
          amount,
          constraint: data.constraint,
          context: data.context,
          balance: data.balance ? parseAmount(data.balance, asset) : null,
        });
      // Unshield: the match table. Shield: the deposits with the same pool
      // amount, which light up the pixel crowd.
      const checked = result.assessment.status !== "not-checked",
        sets = data.action === "unshield" && checked ? inspect(pool, amount).sets : [],
        credit = checked && data.action === "shield" ? Number(result.assessment.amounts.poolCredit / pool.scale) : null,
        lit =
          credit === null
            ? sets.flatMap((set) => set.deposits.map((d) => d.id))
            : pool.sorted.filter((d) => Math.abs(d.amount - credit) <= pool.eps).map((d) => d.id);
      self.postMessage({
        type: "plan",
        id: data.id,
        token: p.id,
        result: toJSON(result),
        sets,
        lit,
        count: pool.amounts.length,
        manifest: p.entry,
      });
    } else if (data.type === "check") {
      const p = poolOf(data.token);
      const now = Date.now() / 1000;
      self.postMessage({
        type: "result",
        id: data.id,
        token: p.id,
        result: check(
          p.deposits,
          parseAmount(data.amount, p.asset),
          data.q1,
          data.q2,
          data.q3,
          now,
          p.asset,
        ),
        manifest: p.entry,
      });
    }
  } catch (e) {
    self.postMessage({
      type: "error",
      id: data.id,
      message: data.type === "load" ? UNLOADED : e.message,
    });
  }
};
