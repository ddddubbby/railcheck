import { test } from "node:test";
import assert from "node:assert/strict";
import { pulseStats } from "../scripts/lib/pulse.mjs";
const end = 1791449471;
const manifest = {
  dataTime: end,
  lastBlock: 26146598,
  lastBlockHash: "anchor",
};
const start = end - 7 * 86400;
const snapshot = (withdrawals = []) => ({
  version: 1,
  chainId: 1,
  token: "WETH",
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
  );
  assert.equal(p.bins.length, 169);
  assert.equal(p.bins[0].start, start);
  assert.equal(p.bins[0].end, boundary);
  assert.equal(p.bins.at(-1).end, end);
  assert.equal(p.bins[0].deposits, 2);
  assert.equal(p.bins[1].deposits, 1);
  assert.equal(p.depositCount, 4);
  assert.equal(p.withdrawalCount, 3);
  assert.equal(p.depositWei, 10000000000n);
  assert.equal(p.withdrawalWei, 1234567890123456800n);
  assert.equal(
    p.bins.reduce((n, b) => n + BigInt(b.withdrawalWei), 0n),
    p.withdrawalWei,
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
  assert.equal(pulseStats([], snapshot(), manifest).withdrawalCount, 0);
  for (const change of [
    { lastBlock: 1 },
    { lastBlockHash: "other" },
    { dataTime: end - 1 },
    { token: "DAI" },
  ])
    assert.throws(() => pulseStats([], { ...snapshot(), ...change }, manifest));
  for (const row of [
    { time: end + 1, amountWei: "1" },
    { time: start - 1, amountWei: "1" },
    { time: end, amountWei: "-1" },
    { time: end, amountWei: "1.5" },
  ])
    assert.throws(() => pulseStats([], snapshot([row]), manifest));
});
