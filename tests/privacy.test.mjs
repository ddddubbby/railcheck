import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { decode } from "../lib/pool/index.mjs";
import { parseAmount, check, prepare, inspect, ETH_ASSET, USDT_ASSET, USDC_ASSET } from "../lib/engine/index.mjs";
import { plan } from "../lib/engine/advice.mjs";
import { toJSON } from "../lib/format.mjs";

// The fixture pool, as the WETH pool and as each stable pool: the worker checks
// the hash and size of every file against its own manifest entry.
const raw = readFileSync("tests/fixtures/pool.bin");
const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
function fixture() {
  const manifest = JSON.parse(readFileSync("tests/fixtures/manifest.json"));
  delete manifest.demo;
  manifest.chainId = 1;
  manifest.token = ETH_ASSET.address;
  manifest.lastBlock = 24000000;
  const stable = (asset, file) => ({
    version: manifest.version,
    pool: `railgun-ethereum-${asset.symbol.toLowerCase()}`,
    chainId: 1,
    token: asset.address,
    symbol: asset.symbol,
    decimals: 6,
    unitDecimals: 6,
    file,
    sha256: manifest.sha256,
    size: manifest.size,
    count: manifest.count,
    dataTime: manifest.dataTime,
    lastBlock: manifest.lastBlock,
    confirmations: 64,
    windowStart: manifest.dataTime - 180 * 86400,
    windowEnd: manifest.dataTime,
    grouping: "none",
    reshieldHistoryComplete: true,
  });
  manifest.pools = {
    usdt: stable(USDT_ASSET, "railgun-usdt.bin"),
    usdc: stable(USDC_ASSET, "railgun-usdc.bin"),
  };
  return manifest;
}
// Runs public/worker.mjs with a fetch that records every request. `hang(url)`:
// that request never answers. `manual`: the worker's timers never run on their
// own; each is kept in `timers` with its delay and the request it guards, and
// `fire(timer)` runs it. The load is then not awaited: `message(type)` waits for
// a message, and `loading` settles when the load does.
async function worker(manifest, { hang = () => false, manual = false } = {}) {
  const calls = [],
    messages = [],
    timers = [],
    waiting = [],
    self = {
      postMessage: (v) => {
        messages.push(v);
        waiting.splice(0).forEach((wake) => wake());
      },
    };
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (hang(url)) return new Promise(() => {});
    return {
      ok: true,
      json: async () => manifest,
      arrayBuffer: async () => buffer.slice(0),
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
      prepare,
      inspect,
      plan,
      toJSON,
      ETH_ASSET,
      USDT_ASSET,
      USDC_ASSET,
      AbortController,
      // A stable pool's fetch starts just before its timer, so the last
      // request is the one the timer guards.
      setTimeout: manual
        ? (fn, ms) => {
            const timer = { fn, ms, url: calls.at(-1)?.url, cleared: false };
            timers.push(timer);
            return timer;
          }
        : setTimeout,
      clearTimeout: manual ? (timer) => timer && (timer.cleared = true) : clearTimeout,
      Date: class extends Date {
        static now() {
          return (manifest.dataTime + 1) * 1000;
        }
      },
    },
  );
  const loading = self.onmessage({ data: { type: "load" } });
  if (!manual) await loading;
  const fire = (timer) => {
    assert.equal(timer.cleared, false, "the timer is still pending");
    timer.cleared = true;
    timer.fn();
  };
  const message = async (type) => {
    while (!messages.some((m) => m.type === type)) await new Promise((wake) => waiting.push(wake));
    return messages.find((m) => m.type === type);
  };
  const send = async (data) => {
    await self.onmessage({ data });
    return messages.at(-1);
  };
  // WETH reports "ready" first; the stable pools follow in "pools".
  const covered = () => ({
    ...messages.find((m) => m.type === "ready")?.covered,
    ...messages.find((m) => m.type === "pools")?.covered,
  });
  return {
    calls,
    messages,
    send,
    covered,
    urls: () => calls.map((c) => c.url).sort(),
    timers,
    fire,
    message,
    loading,
  };
}
// VAL-7: the only requests are the manifest and the allowed pool files, all at
// load, whatever token is checked later.
const ALLOWED = ["./data/manifest.json", "./data/railgun-eth.bin", "./data/railgun-usdc.bin", "./data/railgun-usdt.bin"];

test("worker loads the manifest and every pool file at load, and makes no network request when checking", async () => {
  const w = await worker(fixture());
  assert.deepEqual(w.messages.map((m) => m.type), ["ready", "pools"]);
  assert.deepEqual(w.covered(), { weth: true, usdt: true, usdc: true });
  assert.deepEqual(w.urls(), ALLOWED);
  assert.ok(w.calls.every((c) => c.options.credentials === "omit"), "no request sends credentials");
  w.calls.length = 0;
  assert.equal((await w.send({ type: "check", amount: "3.502749352", q1: "no", q2: "no", q3: "no", id: 1 })).type, "result");
  assert.equal((await w.send({ type: "plan", action: "shield", amount: "1.0731", constraint: "flexible", id: 2 })).type, "plan");
  const unshield = await w.send({
    type: "plan", action: "unshield", amount: "3.502749352", constraint: "flexible",
    context: { addressReuse: false, pastTransfer: false }, balance: "5", id: 3,
  });
  assert.equal(unshield.type, "plan");
  assert.equal(unshield.result.action, "unshield");
  for (const token of ["usdt", "usdc"]) {
    const reply = await w.send({ type: "plan", token, action: "unshield", amount: "120.5", constraint: "fixed", context: {}, id: 4 });
    assert.equal(reply.type, "plan", `${token}: ${reply.message}`);
    assert.equal(reply.token, token);
    assert.equal(reply.result.assessment.asset.symbol, token.toUpperCase());
  }
  assert.equal(w.calls.length, 0);
});

test("worker never fetches a pool file name outside the allow-list", async () => {
  const manifest = fixture();
  manifest.pools.usdt.file = "../railgun-usdt.bin";
  // A known file name under another pool's id is ignored too.
  manifest.pools.usdc.file = "railgun-eth.bin";
  manifest.pools.dai = { ...manifest.pools.usdc, file: "railgun-dai.bin" };
  const w = await worker(manifest);
  assert.equal(w.messages[0].type, "ready");
  assert.deepEqual(w.covered(), { weth: true, usdt: false, usdc: false });
  assert.deepEqual(w.urls(), ["./data/manifest.json", "./data/railgun-eth.bin"]);
  const reply = await w.send({ type: "plan", token: "usdt", action: "shield", amount: "1", constraint: "fixed", id: 1 });
  assert.equal(reply.type, "error");
  // An absolute URL or a query string is not an allowed file name either.
  for (const file of [
    "https://example.com/railgun-usdt.bin",
    "//example.com/railgun-usdt.bin",
    "railgun-usdt.bin?v=1",
    "railgun-usdt.bin#x",
  ]) {
    const m = fixture();
    m.pools.usdt.file = file;
    const v = await worker(m);
    assert.equal(v.covered().usdt, false, file);
    assert.deepEqual(v.urls(), ALLOWED.filter((u) => !u.includes("usdt")), file);
  }
});

test("a stalled stable pool does not hold up WETH, and its chip is not covered", async () => {
  // The test runs the timeout itself, so the healthy pool can never race it.
  const w = await worker(fixture(), { hang: (url) => url.endsWith("railgun-usdt.bin"), manual: true });
  // WETH is ready while the stalled request is still open and no timer has run.
  await w.message("ready");
  assert.deepEqual(w.messages.map((m) => m.type), ["ready"]);
  // Every request still starts at load, the stalled one too.
  assert.deepEqual(w.urls(), ALLOWED);
  const stalled = w.calls.find((c) => c.url.endsWith("railgun-usdt.bin"));
  assert.equal(stalled.options.signal.aborted, false, "not aborted before the timeout");
  // One 20 s timeout per stable pool.
  assert.deepEqual(
    w.timers.map((t) => [t.url, t.ms]),
    [
      ["./data/railgun-usdt.bin", 20000],
      ["./data/railgun-usdc.bin", 20000],
    ],
  );
  w.fire(w.timers[0]);
  await w.loading;
  assert.deepEqual(w.covered(), { weth: true, usdt: false, usdc: true });
  assert.equal(stalled.options.signal.aborted, true, "the stalled request is aborted");
  assert.equal(w.timers[1].cleared, true, "the healthy pool's timer is cleared, never run");
  assert.equal(stalled.options.credentials, "omit");
  const reply = await w.send({ type: "plan", action: "shield", amount: "1.0731", constraint: "flexible", id: 1 });
  assert.equal(reply.type, "plan");
});


test("a stable pool that is missing, incomplete or fails its checks is not covered, and WETH still loads", async () => {
  for (const [name, change] of [
    ["missing", (m) => delete m.pools.usdt],
    ["short window", (m) => (m.pools.usdt.windowStart = m.dataTime - 90 * 86400)],
    ["no reshield-history flag", (m) => delete m.pools.usdt.reshieldHistoryComplete],
    ["unconfirmed", (m) => (m.pools.usdt.confirmations = 12)],
    ["other token", (m) => (m.pools.usdt.token = USDC_ASSET.address)],
    ["other decimals", (m) => (m.pools.usdt.decimals = 18)],
    ["demo", (m) => (m.pools.usdt.demo = true)],
    ["hash", (m) => (m.pools.usdt.sha256 = "0".repeat(64))],
    // Not from the same run as the WETH pool (scripts/lib/validate.mjs).
    ["other run: dataTime", (m) => (m.pools.usdt.dataTime += 600)],
    ["other run: lastBlock", (m) => (m.pools.usdt.lastBlock -= 1)],
  ]) {
    const manifest = fixture();
    change(manifest);
    const w = await worker(manifest);
    assert.equal(w.messages[0].type, "ready", name);
    assert.deepEqual(w.covered(), { weth: true, usdt: false, usdc: true }, name);
    // A published pool is fetched even when it fails a check, so the requests
    // do not depend on the checks either.
    assert.deepEqual(w.urls(), name === "missing" ? ALLOWED.filter((u) => !u.includes("usdt")) : ALLOWED, name);
  }
});

test("a WETH result is the same as before the stable pools, byte for byte", async () => {
  const manifest = fixture(),
    w = await worker(manifest),
    now = manifest.dataTime + 1;
  const deposits = decode(buffer.slice(0), manifest);
  // The pool exactly as the WETH-only worker prepared it.
  const pool = prepare(deposits, {
    now,
    snapshot: {
      pool: "ethereum-weth",
      chainId: 1,
      token: manifest.token,
      block: manifest.lastBlock,
      time: manifest.dataTime,
      windowStart: manifest.windowStart ?? manifest.dataTime - 180 * 86400,
      grouping: manifest.grouping ?? "none",
      reshieldHistoryComplete: manifest.metrics?.reshieldHistoryComplete,
    },
  });
  for (const [id, message] of [
    [1, { action: "unshield", amount: "3.502749352", constraint: "flexible", context: { addressReuse: false }, balance: "5" }],
    [2, { action: "shield", amount: "1.0731", constraint: "flexible" }],
  ]) {
    const reply = await w.send({ type: "plan", ...message, id });
    const expected = plan(pool, {
      ...message,
      amount: parseAmount(message.amount),
      balance: message.balance ? parseAmount(message.balance) : null,
    });
    assert.equal(JSON.stringify(reply.result), JSON.stringify(toJSON(expected)));
    assert.equal(reply.token, "weth");
  }
  const result = await w.send({ type: "check", amount: "3.502749352", q1: "no", q2: "no", q3: "no", id: 3 });
  assert.equal(
    JSON.stringify(result.result),
    JSON.stringify(check(deposits, parseAmount("3.502749352"), "no", "no", "no", now)),
  );
});

test("the worker parses a stable amount at 6 decimals and rejects a 7th", async () => {
  const w = await worker(fixture());
  const ok = await w.send({ type: "plan", token: "usdt", action: "shield", amount: "120.123456", constraint: "fixed", id: 1 });
  assert.equal(ok.type, "plan", ok.message);
  assert.equal(ok.result.assessment.amounts.shieldInput, "120123456");
  const bad = await w.send({ type: "plan", token: "usdt", action: "shield", amount: "120.1234567", constraint: "fixed", id: 2 });
  assert.equal(bad.type, "error");
  assert.match(bad.message, /decimals/);
});
test("client source has no persistence, telemetry or input URL writes", () => {
  const source = [
    "public/app.mjs",
    "public/nav.mjs",
    "public/worker.mjs",
    "public/flow.mjs",
    "public/docs.mjs",
  ]
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
  assert.doesNotMatch(
    source,
    /localStorage|sessionStorage|indexedDB|document\.cookie|sendBeacon|XMLHttpRequest|WebSocket|location\s*=|history\.(pushState|replaceState)/,
  );
  for (const page of ["src/index.html"]) {
    const html = readFileSync(page, "utf8");
    assert.doesNotMatch(html, /<form[^>]+(?:action|method)=/);
    assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)="https?:/);
  }
  const html = readFileSync("src/index.html", "utf8");
  assert.match(html, /<input[\s\S]*?id="amount"[\s\S]*?type="text"/);
  assert.doesNotMatch(html, /<form[^>]+(?:action|method)=/);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)="https?:/);
});
