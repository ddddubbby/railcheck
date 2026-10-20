import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  prepare,
  score,
  check,
  decode,
  parseAmount,
  toStored,
  toBase,
  toJSON,
} from "../lib/index.mjs";
const raw = readFileSync("tests/fixtures/pool.bin"),
  manifest = JSON.parse(readFileSync("tests/fixtures/manifest.json")),
  deposits = decode(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
    manifest,
  ),
  now = manifest.dataTime + 1;
test("check() keeps its earlier output for definite answers, plus status and findings", () => {
  const before = JSON.parse(readFileSync("tests/fixtures/check-parity.json"));
  for (const [amount, expected] of Object.entries(before)) {
    const { status, findings, ...rest } = JSON.parse(
      JSON.stringify(check(deposits, parseAmount(amount), "no", "no", "no", now)),
    );
    assert.deepEqual(rest, expected);
    assert.ok(["clear", "attention"].includes(status) && Array.isArray(findings));
  }
});
test("score() matches the checker's amount score and is cached", () => {
  const pool = prepare(deposits, { now });
  for (const amount of Object.keys(JSON.parse(readFileSync("tests/fixtures/check-parity.json")))) {
    const wei = parseAmount(amount);
    assert.equal(score(pool, wei).score, check(deposits, wei, "no", "no", "no", now).amountScore);
    assert.equal(score(pool, wei), score(pool, wei));
  }
});
test("unit conversion and draft format", () => {
  assert.equal(toStored(parseAmount("0.9975")), 997500000n);
  assert.equal(toBase(997500000), parseAmount("0.9975"));
  assert.equal(toStored(1_499_999_999n), 1n);
  assert.deepEqual(toJSON({ amount: 10n ** 18n }), { amount: "1000000000000000000" });
});
