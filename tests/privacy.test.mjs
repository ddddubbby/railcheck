import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { decode } from "../lib/pool/index.mjs";
import { parseAmount, check } from "../lib/engine/index.mjs";
test("worker loads 2 common data files and makes no network request when checking", async () => {
  const calls = [],
    messages = [],
    self = { postMessage: (v) => messages.push(v) };
  const manifest = JSON.parse(readFileSync("tests/fixtures/manifest.json"));
  delete manifest.demo;
  manifest.chainId = 1;
  manifest.token = "WETH";
  const raw = readFileSync("tests/fixtures/pool.bin");
  const buffer = raw.buffer.slice(
    raw.byteOffset,
    raw.byteOffset + raw.byteLength,
  );
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => manifest,
      arrayBuffer: async () => buffer,
    };
  };
  runInNewContext(
    readFileSync("public/worker.mjs", "utf8").replace(/import[\s\S]*?;\n/g, ""),
    {
      self,
      fetch,
      crypto: webcrypto,
      decode,
      parseAmount,
      check,
      Uint8Array,
      Array,
      Date: class extends Date {
        static now() {
          return (manifest.dataTime + 1) * 1000;
        }
      },
      Error,
    },
  );
  await self.onmessage({ data: { type: "load" } });
  assert.equal(messages.at(-1).type, "ready");
  assert.equal(calls.length, 2);
  calls.length = 0;
  await self.onmessage({
    data: { type: "check", amount: "3.502749352", q1: "no", q2: "no", id: 1 },
  });
  assert.equal(messages.at(-1).type, "result");
  assert.equal(calls.length, 0);
});
test("client source has no persistence, telemetry or input URL writes", () => {
  const source = ["public/app.mjs", "public/worker.mjs"]
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
  assert.doesNotMatch(
    source,
    /localStorage|sessionStorage|indexedDB|document\.cookie|sendBeacon|XMLHttpRequest|WebSocket|location\s*=|history\.(pushState|replaceState)/,
  );
  const html = readFileSync("src/index.html", "utf8");
  assert.match(html, /<input[\s\S]*?id="amount"[\s\S]*?type="text"/);
  assert.doesNotMatch(html, /<form[^>]+(?:action|method)=/);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)="https?:/);
});
