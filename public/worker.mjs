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
// How long a stable pool may take to load. A pool that takes longer is left out
// (its chip is not covered); it never holds up WETH, which is ready first.
const STABLE_TIMEOUT_MS = 20000;
let manifest;
const pools = {};
// The checks the WETH pool has always had: provenance, file name, and (after
// the fetch) the hash and size. A stable entry must also describe its token as
// the engine does, carry the reshield-history flag the pipeline writes only
// after its safety checks (VAL-5), cover a full 180-day window, and come from
// the same run as the WETH pool (one block for all, as scripts/lib/validate.mjs).
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
    entry.windowStart <= entry.dataTime - WINDOW &&
    entry.dataTime === manifest.dataTime &&
    entry.lastBlock === manifest.lastBlock
  );
}
async function fetchPool(entry, signal) {
  const r = await fetch("./data/" + entry.file, signal ? { credentials: "omit", signal } : { credentials: "omit" });
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
// A stable pool load that stops after STABLE_TIMEOUT_MS: the request is
// aborted, and the load fails even if a fetch ignores the signal.
function timed(load) {
  const controller = new AbortController();
  let timer;
  return Promise.race([
    load(controller.signal),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Error("timeout"));
      }, STABLE_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
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
      // requests do not show which token is checked. All requests start here,
      // together. A stable pool that fails its checks, or takes longer than
      // STABLE_TIMEOUT_MS, is left out: its chip shows "not covered", not an error.
      const loads = POOLS.map((p) => {
        const { id } = p,
          entry = id === "weth" ? manifest : manifest.pools?.[id];
        // Any other file name in the manifest is ignored, never fetched.
        if (!FILE.test(entry?.file) || entry.file !== p.file) return Promise.resolve(null);
        const load = async (signal) => {
          const deposits = await fetchPool(entry, signal);
          return valid(p, entry) ? { ...p, entry, deposits } : null;
        };
        return id === "weth" ? load() : timed(load).catch(() => null);
      });
      // WETH is ready as soon as its own pool is: the stable pools follow.
      const weth = await loads[0];
      if (!weth) throw Error();
      pools.weth = weth;
      self.postMessage({ type: "ready", manifest, covered: { weth: true }, counts: { weth: weth.entry.count } });
      const stables = await Promise.all(loads.slice(1)),
        covered = {},
        counts = {};
      POOLS.slice(1).forEach((p, i) => {
        covered[p.id] = !!stables[i];
        if (stables[i]) {
          pools[p.id] = stables[i];
          counts[p.id] = stables[i].entry.count;
        }
      });
      self.postMessage({ type: "pools", covered, counts });
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
