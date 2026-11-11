// R3.2: USDT and USDC pools in the daily build, on a synthetic chain (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { decode } from "../lib/pool/index.mjs";
import {
  foldShieldLogs,
  decodeShield,
  WETH,
  SHIELD_TOPIC,
  NULLIFIED_TOPIC,
} from "../scripts/lib/reader.mjs";
import { encodePool, parseCsv, writeCsv } from "../scripts/lib/data.mjs";
import { TOKENS, tokenById, poolEntry, ENTRY_FIELDS, toUnits } from "../scripts/lib/tokens.mjs";
import { updatePools, mergeRanges, countMultiNoteShields, writeAll } from "../scripts/lib/update.mjs";
import { validatePools } from "../scripts/lib/validate.mjs";
import { makeChain, makeLogs, nowOf, HEAD1, HEAD2, USDT, USDC, OTHER, hashOf } from "./fixtures/chain.mjs";

const golden = JSON.parse(readFileSync("tests/fixtures/weth-golden.json", "utf8"));
const logs = makeLogs();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const tempDir = () => mkdtempSync(join(tmpdir(), "railcheck-pools-"));
const read = (dir, path) => readFileSync(join(dir, path));
const manifestOf = (dir) => JSON.parse(read(dir, "public/data/manifest.json"));
const buffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
async function run(dir, rawHead, { tokens = TOKENS, calls = [], fork } = {}) {
  return updatePools({
    rpc: makeChain({ rawHead, logs, calls, fork }),
    dir,
    tokens,
    now: () => nowOf(rawHead),
    log: () => {},
  });
}
const shieldReads = (calls) =>
  calls
    .filter(([m, [p]]) => m === "eth_getLogs" && p.topics[0].includes(SHIELD_TOPIC))
    .map(([, [p]]) => [Number(p.fromBlock), Number(p.toBlock)]);

test("token list: WETH first and unchanged, USDT and USDC in base units with their own files", () => {
  assert.deepEqual(
    TOKENS.map((t) => [t.id, t.symbol, t.contract, t.decimals, t.unitDecimals, t.file, t.depositsCsv, t.reshieldsCsv]),
    [
      ["weth", "WETH", WETH, 18, 9, "railgun-eth.bin", "data/deposits.csv", "data/reshields.csv"],
      ["usdt", "USDT", USDT, 6, 6, "railgun-usdt.bin", "data/deposits-usdt.csv", "data/reshields-usdt.csv"],
      ["usdc", "USDC", USDC, 6, 6, "railgun-usdc.bin", "data/deposits-usdc.csv", "data/reshields-usdc.csv"],
    ],
  );
  assert.deepEqual(mergeRanges([[5, 9], [1, 3], [4, 4], [20, 30], [25, 26], [8, 7]]), [[1, 9], [20, 30]]);
});

test("multi-token fold: one read gives every pool its own rows, as a per-token read would", () => {
  const shields = logs.filter((l) => l.topics[0] === SHIELD_TOPIC || l.topics[0] === NULLIFIED_TOPIC);
  const all = foldShieldLogs(shields, { token: null }).kept;
  for (const t of TOKENS) {
    const alone = foldShieldLogs(shields, { token: t.contract }).kept;
    const mine = all.filter((r) => r.token === t.contract);
    assert.deepEqual(
      mine.map(({ block, amountWei, kind, hash }) => ({ block, amountWei, kind, hash })),
      alone.map(({ block, amountWei, kind, hash }) => ({ block, amountWei, kind, hash })),
    );
    assert.ok(mine.some((r) => r.kind === "public") && mine.some((r) => r.kind === "reshield"));
  }
  // A public shield of two USDT notes and one other note: one USDT row of two notes.
  const multi = all.find((r) => r.token === USDT && r.kind === "public" && r.notes === 2);
  assert.ok(multi);
  assert.equal(all.find((r) => r.hash === multi.hash && r.token === OTHER).notes, 1);
});

test("WETH output is byte-identical to the WETH-only build for the same chain", async () => {
  const dir = tempDir();
  try {
    for (const [name, head] of [["bootstrap", HEAD1], ["incremental", HEAD2]]) {
      await run(dir, head);
      const old = golden[name];
      assert.equal(sha(read(dir, "public/data/railgun-eth.bin")), old.bin, name);
      assert.equal(sha(read(dir, "data/deposits.csv")), old.deposits, name);
      assert.equal(sha(read(dir, "data/reshields.csv")), old.reshields, name);
      const { pools, ...top } = manifestOf(dir);
      assert.ok(pools.usdt && pools.usdc);
      // Two intended changes: the corrected source text (task 6) and the OD-2 count.
      const { multiNoteShields, ...metrics } = top.metrics;
      assert.deepEqual(Object.keys(multiNoteShields), ["weth", "usdt", "usdc"]);
      assert.match(top.source, /can raise a score, never lower it/);
      assert.doesNotMatch(top.source, /not scored yet/);
      const expected = { ...old.manifest, source: top.source, metrics: old.manifest.metrics };
      assert.deepEqual({ ...top, metrics }, expected);
      assert.deepEqual(Object.keys(top), Object.keys(old.manifest));
      assert.equal(
        JSON.stringify({ ...top, metrics }, null, 2),
        JSON.stringify(expected, null, 2),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("USDT and USDC bootstrap their whole window in the same read as WETH, then run incrementally", async () => {
  const dir = tempDir();
  try {
    // Today's state: a WETH-only manifest and CSVs, one hour before HEAD1.
    await run(dir, HEAD1 - 300, { tokens: [TOKENS[0]] });
    const before = manifestOf(dir);
    assert.equal(before.pools, undefined);
    assert.ok(!existsSync(join(dir, "data/deposits-usdt.csv")));

    // First run with the new pools: USDT and USDC have no coverage, so the run
    // reads their full window. WETH's own new blocks are inside it: one read.
    let calls = [];
    const first = await run(dir, HEAD1, { calls });
    const firstBlock = first.pools.usdt.firstBlock;
    assert.deepEqual(shieldReads(calls).length > 0 && mergeRanges(shieldReads(calls)), [[firstBlock, first.lastBlock]]);
    const covered = shieldReads(calls).reduce((n, [s, e]) => n + e - s + 1, 0);
    assert.equal(covered, first.lastBlock - firstBlock + 1, "every block read once");
    for (const id of ["usdt", "usdc"]) {
      const entry = first.pools[id];
      assert.deepEqual(Object.keys(entry), ENTRY_FIELDS);
      assert.equal(entry.reshieldHistoryComplete, true);
      assert.equal(entry.windowStart, first.windowStart);
      assert.equal(entry.lastBlockHash, first.lastBlockHash);
      assert.ok(entry.reshieldCount > 0 && entry.publicCount > 0);
    }
    // WETH kept its incremental coverage, and its pool is the one a full
    // WETH-only build at this head gives.
    assert.equal(first.firstBlock, before.firstBlock);
    assert.equal(first.sha256, golden.bootstrap.manifest.sha256);

    // Second run: every pool reads only the new blocks.
    calls = [];
    const second = await run(dir, HEAD2, { calls });
    assert.deepEqual(mergeRanges(shieldReads(calls)), [[first.lastBlock + 1, second.lastBlock]]);
    assert.equal(second.pools.usdt.firstBlock, firstBlock);
    assert.equal(second.pools.usdt.reshieldHistoryComplete, true);

    // The incremental USDT pool equals a fresh full-window build at the same head.
    const fresh = tempDir();
    try {
      const rebuilt = await run(fresh, HEAD2);
      for (const id of ["usdt", "usdc"]) {
        assert.equal(second.pools[id].sha256, rebuilt.pools[id].sha256, id);
        assert.deepEqual(
          read(dir, `public/data/${tokenById(id).file}`),
          read(fresh, `public/data/${tokenById(id).file}`),
        );
      }
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }

    // Each pool keeps its own safety checks.
    await assert.rejects(run(dir, HEAD1), /coverage moved backwards/);
    await assert.rejects(
      run(dir, HEAD2 + 100, { fork: (n) => (n === second.lastBlock ? 1 : 0) }),
      /Confirmed chain history changed \(WETH\)/,
    );
    // A USDT entry with another anchor fails on its own.
    const m = manifestOf(dir);
    m.pools.usdt.lastBlockHash = hashOf(m.lastBlock, 9);
    writeFileSync(join(dir, "public/data/manifest.json"), JSON.stringify(m));
    await assert.rejects(run(dir, HEAD2 + 100), /Confirmed chain history changed \(USDT\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a USDT pool entry decodes with decode(buffer, entry) and stores amounts in 1e-6 units", async () => {
  const dir = tempDir();
  try {
    const manifest = await run(dir, HEAD1);
    for (const id of ["weth", "usdt", "usdc"]) {
      const entry = id === "weth" ? manifest : manifest.pools[id];
      assert.equal(poolEntry(manifest, id), entry);
      const t = tokenById(id);
      const deposits = decode(buffer(read(dir, `public/data/${entry.file}`)), entry);
      assert.equal(deposits.length, entry.count);
      assert.equal(deposits.filter((d) => d.kind === "reshield").length, entry.reshieldCount);
      const csv = parseCsv(read(dir, t.depositsCsv).toString());
      const publicAmounts = deposits.filter((d) => d.kind === "public").map((d) => d.amount);
      // USDT and USDC: the stored amount is the base-unit amount itself.
      const expected = csv.map((r) => Number(id === "weth" ? (r.amountWei + 500000000n) / 10n ** 9n : r.amountWei));
      assert.deepEqual(publicAmounts.sort((a, b) => a - b), expected.sort((a, b) => a - b));
    }
    const usdt = manifest.pools.usdt;
    assert.equal(usdt.symbol, "USDT");
    assert.equal(usdt.decimals, 6);
    assert.equal(usdt.unitDecimals, 6);
    assert.equal(usdt.token, USDT);
    assert.equal(usdt.activity.token, "USDT");
    assert.ok(usdt.activity.withdrawals.length > 0);
    assert.equal(usdt.activitySha256, sha(JSON.stringify(usdt.activity)));
    // Activity amounts are base units of the token, under the same field name.
    const unshielded = logs.filter((l) => l.topics[0] !== SHIELD_TOPIC && l.topics[0] !== NULLIFIED_TOPIC);
    const usdtAmounts = new Set(
      unshielded.filter((l) => l.data.slice(2 + 128, 2 + 192).endsWith(USDT.slice(2))).map((l) => BigInt("0x" + l.data.slice(2 + 256, 2 + 320)).toString()),
    );
    for (const w of usdt.activity.withdrawals) assert.ok(usdtAmounts.has(w.amountWei));
    // Top-level fields stay WETH only: no token description is added there.
    for (const key of ["symbol", "decimals", "unitDecimals", "reshieldHistoryComplete"])
      assert.ok(!Object.hasOwn(manifest, key), key);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the 6-decimal stored unit is exact, and safe for every 120-bit note that fits", () => {
  const usdt = tokenById("usdt"), weth = tokenById("weth");
  assert.equal(toUnits(1_234_567n, usdt), 1_234_567n);
  assert.equal(toUnits(1_500_000_000n, weth), 2n);
  assert.equal(toUnits(1_499_999_999n, weth), 1n);
  const rows = [
    { block: 1, time: 100, amountWei: 1n },
    { block: 2, time: 101, amountWei: 999_999_999_999n }, // 999,999.999999 USDT
    { block: 3, time: 102, amountWei: 25_000_000n, kind: "reshield" },
  ];
  const { bytes, manifest } = encodePool(rows, {
    dataTime: 103, lastBlock: 3, firstBlock: 1, lastBlockHash: "0x" + "0".repeat(64), asset: usdt,
  });
  assert.equal(manifest.file, "railgun-usdt.bin");
  assert.equal(manifest.token, USDT);
  assert.equal(manifest.pool, "railgun-ethereum-usdt");
  assert.deepEqual(decode(buffer(bytes), manifest).map((d) => d.amount), [1, 999_999_999_999, 25_000_000]);
  assert.throws(
    () => encodePool([{ block: 1, time: 100, amountWei: 2n ** 60n }], { dataTime: 103, lastBlock: 3, firstBlock: 1, lastBlockHash: "0x", asset: usdt }),
    /amount range/,
  );
});

test("multiNoteShields counts public shield transactions with more than one note of a token", async () => {
  const dir = tempDir();
  try {
    const manifest = await run(dir, HEAD1);
    // Independent count from the raw logs over the run's read range.
    const from = manifest.pools.usdt.firstBlock, to = manifest.lastBlock;
    const swaps = new Set(logs.filter((l) => l.topics[0] === NULLIFIED_TOPIC).map((l) => l.transactionHash));
    const expected = { weth: 0, usdt: 0, usdc: 0 };
    for (const l of logs) {
      const block = Number(l.blockNumber);
      if (l.topics[0] !== SHIELD_TOPIC || swaps.has(l.transactionHash) || block < from || block > to) continue;
      for (const t of TOKENS)
        if (decodeShield(l.data).filter((c) => c.tokenAddress === t.contract).length > 1) expected[t.id]++;
    }
    assert.ok(expected.weth > 0 && expected.usdt > 0 && expected.usdc > 0);
    assert.deepEqual(manifest.metrics.multiNoteShields, expected);
    assert.deepEqual(
      countMultiNoteShields([
        { kind: "public", token: USDT, notes: 3 },
        { kind: "reshield", token: USDT, notes: 2 },
        { kind: "public", token: USDC, notes: 1 },
      ]),
      { weth: 0, usdt: 1, usdc: 0 },
    );
    // Counts only: the only addresses in the manifest are token contracts and block hashes.
    const json = JSON.stringify(manifest);
    for (const l of logs) assert.ok(!json.includes(l.transactionHash.slice(2)));
    assert.ok(!json.includes("be".repeat(20)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the validator checks every pool of a multi-pool manifest", async () => {
  const dir = tempDir();
  try {
    await run(dir, HEAD1);
    const { pools } = validatePools(dir);
    assert.deepEqual(Object.keys(pools), ["weth", "usdt", "usdc"]);
    const manifest = manifestOf(dir);
    for (const id of ["usdt", "usdc"]) assert.equal(pools[id].length, manifest.pools[id].count);
    // A WETH-only manifest (today's layout) still validates.
    const { pools: _, ...wethOnly } = manifest;
    const path = join(dir, "public/data/manifest.json");
    writeFileSync(path, JSON.stringify(wethOnly));
    assert.deepEqual(Object.keys(validatePools(dir).pools), ["weth"]);
    const restore = () => writeFileSync(path, JSON.stringify(manifest));
    const broken = (change, pattern) => {
      const m = structuredClone(manifest);
      change(m);
      writeFileSync(path, JSON.stringify(m));
      assert.throws(() => validatePools(dir), pattern);
      restore();
    };
    broken((m) => (m.pools.usdt.sha256 = "0".repeat(64)), /USDT pool: hash or size/);
    broken((m) => (m.pools.usdc.size += 1), /USDC pool: hash or size/);
    broken((m) => (m.pools.usdt.token = USDC), /USDT pool: live data provenance/);
    broken((m) => (m.pools.usdc.unitDecimals = 9), /USDC pool: token description/);
    broken((m) => (m.pools.usdt.lastBlock -= 1), /USDT pool: the pool block/);
    broken((m) => m.pools.usdc.activity.withdrawals.pop(), /USDC pool: activity/);
    broken((m) => (m.pools.dai = m.pools.usdt), /Unknown pool "dai"/);
    // A pool file that does not decode with its entry.
    broken((m) => (m.pools.usdt.count -= 1), /Invalid pool format/);
    // The CSV must reproduce each pool.
    const csv = join(dir, "data/deposits-usdc.csv");
    const rows = parseCsv(readFileSync(csv, "utf8"));
    rows[0].amountWei += 1n;
    writeFileSync(csv, writeCsv(rows));
    assert.throws(() => validatePools(dir), /USDC pool: CSV does not reproduce the pool/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pool and CSV files are written before the manifest, and a failed write leaves the manifest", async () => {
  const order = [];
  const fs = {
    writeFileSync: (p) => order.push(["write", p]),
    renameSync: (from, to) => order.push(["rename", to]),
    rmSync: () => {},
  };
  writeAll([["a.csv", ""], ["b.bin", ""], ["manifest.json", ""]], fs);
  assert.deepEqual(order.filter(([op]) => op === "rename").map(([, p]) => p), ["a.csv", "b.bin", "manifest.json"]);
  assert.ok(order.findIndex(([op]) => op === "rename") > order.findLastIndex(([op]) => op === "write"));

  const dir = tempDir();
  try {
    await run(dir, HEAD1);
    const manifest = read(dir, "public/data/manifest.json");
    // Make the USDC pool path unwritable (a directory): the run fails before
    // the manifest changes, and leaves no temporary files.
    rmSync(join(dir, "public/data/railgun-usdc.bin"));
    const blocker = join(dir, "public/data/railgun-usdc.bin");
    (await import("node:fs")).mkdirSync(join(blocker, "x"), { recursive: true });
    await assert.rejects(run(dir, HEAD2));
    assert.deepEqual(read(dir, "public/data/manifest.json"), manifest);
    assert.ok(!existsSync(join(dir, "public/data/manifest.json.tmp")));
    assert.ok(!existsSync(join(dir, "data/deposits-usdt.csv.tmp")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
