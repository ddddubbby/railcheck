import { decode } from "./lib/pool/index.mjs";
import { parseAmount, check } from "./lib/engine/index.mjs";
let deposits, manifest;
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
