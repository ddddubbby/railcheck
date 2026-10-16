import { decode } from "./lib/pool/index.mjs";
import { parseAmount, check, prepare, inspect } from "./lib/engine/index.mjs";
import { plan } from "./lib/engine/advice.mjs";
import { toJSON } from "./lib/format.mjs";
let deposits, manifest, pool;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") {
      const m = await fetch("./data/manifest.json", {
        cache: "no-store",
        credentials: "omit",
      });
      if (!m.ok) throw Error();
      manifest = await m.json();
      if (
        !/^railgun-eth\.bin$/.test(manifest.file) ||
        manifest.demo ||
        manifest.chainId !== 1 ||
        manifest.token !== "WETH"
      )
        throw Error();
      const r = await fetch("./data/" + manifest.file, { credentials: "omit" });
      if (!r.ok) throw Error();
      const buffer = await r.arrayBuffer();
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
        (x) => x.toString(16).padStart(2, "0"),
      ).join("");
      if (hash !== manifest.sha256 || buffer.byteLength !== manifest.size)
        throw Error();
      deposits = decode(buffer, manifest);
      self.postMessage({ type: "ready", manifest });
    } else if (data.type === "plan") {
      if (!deposits)
        throw Error(
          "The pool data did not load. Check your connection, then try again.",
        );
      // One sorted pool per page load, shared by every request.
      pool ||= prepare(deposits, {
        now: Date.now() / 1000,
        snapshot: {
          pool: "ethereum-weth",
          chainId: manifest.chainId,
          token: manifest.token,
          block: manifest.lastBlock,
          time: manifest.dataTime,
          windowStart: manifest.windowStart ?? manifest.dataTime - 180 * 86400,
          grouping: manifest.grouping ?? "none",
        },
      });
      const amount = parseAmount(data.amount),
        result = plan(pool, {
          action: data.action,
          amount,
          constraint: data.constraint,
          context: data.context,
          balance: data.balance ? parseAmount(data.balance) : null,
        });
      // Unshield: the match table. Shield: the deposits with the same pool
      // amount, which light up the pixel crowd.
      const checked = result.assessment.status !== "not-checked",
        sets = data.action === "unshield" && checked ? inspect(pool, amount).sets : [],
        credit = checked && data.action === "shield" ? Number(result.assessment.amounts.poolCredit / 10n ** 9n) : null,
        lit =
          credit === null
            ? sets.flatMap((set) => set.deposits.map((d) => d.id))
            : pool.sorted.filter((d) => Math.abs(d.amount - credit) <= pool.eps).map((d) => d.id);
      self.postMessage({
        type: "plan",
        id: data.id,
        result: toJSON(result),
        sets,
        lit,
        count: pool.amounts.length,
        manifest,
      });
    } else if (data.type === "check") {
      if (!deposits)
        throw Error(
          "The pool data did not load. Check your connection, then try again.",
        );
      const now = Date.now() / 1000;
      self.postMessage({
        type: "result",
        id: data.id,
        result: check(
          deposits,
          parseAmount(data.amount),
          data.q1,
          data.q2,
          data.q3,
          now,
        ),
        manifest,
      });
    }
  } catch (e) {
    self.postMessage({
      type: "error",
      id: data.id,
      message:
        data.type === "load"
          ? "The pool data did not load. Check your connection, then try again."
          : e.message,
    });
  }
};
