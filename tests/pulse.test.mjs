import { test } from "node:test";
import assert from "node:assert/strict";
import { pulseStats } from "../scripts/lib/pulse.mjs";
import { tokenById } from "../scripts/lib/tokens.mjs";
const WETH = tokenById("weth"),
  USDT = tokenById("usdt");
const end = 1791449471;
const manifest = {
  dataTime: end,
  lastBlock: 26146598,
  lastBlockHash: "anchor",
};
const start = end - 3 * 86400;
const snapshot = (withdrawals = [], token = "WETH") => ({
  version: 1,
  chainId: 1,
  token,
  fromTime: start,
  ...manifest,
  withdrawals,
});

test("UTC-hour bins include both window edges, preserve totals, and exclude older deposits", () => {
  const boundary = Math.ceil(start / 3600) * 3600;
  const deposits = [
    { time: start - 1, amount: 900 },
    { time: start, amount: 1 },
    { time: boundary - 1, amount: 2 },
    { time: boundary, amount: 3 },
    { time: end, amount: 4 },
    { time: end + 1, amount: 900 },
  ];
  const p = pulseStats(
    deposits,
    snapshot([
      { time: start, amountWei: "1" },
      { time: boundary, amountWei: "1234567890123456789" },
      { time: end, amountWei: "10" },
    ]),
    manifest,
    WETH,
  );
  assert.equal(p.bins.length, 73);
  assert.equal(p.bins[0].start, start);
  assert.equal(p.bins[0].end, boundary);
  assert.equal(p.bins.at(-1).end, end);
  assert.equal(p.bins[0].deposits, 2);
  assert.equal(p.bins[1].deposits, 1);
  assert.equal(p.depositCount, 4);
  assert.equal(p.withdrawalCount, 3);
  assert.equal(p.depositAmount, 10000000000n);
  assert.equal(p.withdrawalAmount, 1234567890123456800n);
  assert.equal(
    p.bins.reduce((n, b) => n + BigInt(b.withdrawalAmount), 0n),
    p.withdrawalAmount,
  );
  assert.equal(
    p.bins.reduce((n, b) => n + b.deposits, 0),
    4,
  );
  assert.ok(
    p.bins.slice(2, -1).every((b) => b.deposits === 0 && b.withdrawals === 0),
  );
});
test("empty windows remain valid and mismatched or malformed snapshots fail closed", () => {
  assert.equal(pulseStats([], snapshot(), manifest, WETH).withdrawalCount, 0);
  for (const change of [
    { lastBlock: 1 },
    { lastBlockHash: "other" },
    { dataTime: end - 1 },
    { token: "DAI" },
  ])
    assert.throws(() => pulseStats([], { ...snapshot(), ...change }, manifest, WETH));
  for (const row of [
    { time: end + 1, amountWei: "1" },
    { time: start - 1, amountWei: "1" },
    { time: end, amountWei: "-1" },
    { time: end, amountWei: "1.5" },
  ])
    assert.throws(() => pulseStats([], snapshot([row]), manifest, WETH));
});
test("a snapshot covering a longer window is trimmed to the activity window", () => {
  const older = { ...snapshot(), fromTime: start - 4 * 86400 };
  older.withdrawals = [
    { time: start - 86400, amountWei: "5" },
    { time: start, amountWei: "7" },
  ];
  const p = pulseStats([], older, manifest, WETH);
  assert.equal(p.withdrawalCount, 1);
  assert.equal(p.withdrawalAmount, 7n);
  assert.throws(() =>
    pulseStats([], { ...older, fromTime: start + 1 }, manifest, WETH),
  );
});
test("swap outputs (reshields) do not count as shields in the activity chart", () => {
  const p = pulseStats(
    [
      { time: end - 10, amount: 1 },
      { time: end - 5, amount: 2, kind: "reshield" },
    ],
    snapshot(),
    manifest,
    WETH,
  );
  assert.equal(p.depositCount, 1);
});
test("USDT pool units are base units; WETH pool units are nano-ETH", () => {
  const deposits = [{ time: end, amount: 1234567 }],
    withdrawals = [{ time: end, amountWei: "2500000" }];
  const usdt = pulseStats(deposits, snapshot(withdrawals, "USDT"), manifest, USDT);
  assert.equal(usdt.depositAmount, 1234567n);
  assert.equal(usdt.withdrawalAmount, 2500000n);
  assert.equal(usdt.bins.at(-1).depositAmount, "1234567");
  const weth = pulseStats(deposits, snapshot(withdrawals), manifest, WETH);
  assert.equal(weth.depositAmount, 1234567000000000n);
  assert.equal(weth.withdrawalAmount, 2500000n);
});
test("a snapshot of another token fails closed", () => {
  assert.throws(() => pulseStats([], snapshot(), manifest, USDT));
  assert.throws(() => pulseStats([], snapshot([], "USDT"), manifest, WETH));
});
