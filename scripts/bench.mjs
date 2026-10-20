// Times the engine on the real snapshot. Local Node numbers, not phone numbers.
import { readFileSync } from "node:fs";
import { decode } from "../lib/pool/index.mjs";
import { prepare, score, check, parseAmount } from "../lib/engine/index.mjs";
import { plan } from "../lib/engine/advice.mjs";
const manifest = JSON.parse(readFileSync("public/data/manifest.json", "utf8"));
const bytes = readFileSync(`public/data/${manifest.file}`);
const deposits = decode(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  manifest,
);
const now = manifest.dataTime + 1;
const amounts = ["0.05", "0.3", "0.9975", "1.234567", "2.5", "7.3", "10", "12", "37.91", "40"];
const time = (fn) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};
const rows = {
  "prepare()": [time(() => prepare(deposits, { now }))],
  "score()": amounts.map((a) => time(() => score(prepare(deposits, { now }), parseAmount(a)))),
  "check()": amounts.map((a) => time(() => check(deposits, parseAmount(a), "no", "no", "no", now))),
  "plan(shield)": amounts.map((a) =>
    time(() => plan(prepare(deposits, { now }), { action: "shield", amount: parseAmount(a), constraint: "flexible" })),
  ),
  "plan(unshield)": amounts.map((a) =>
    time(() => plan(prepare(deposits, { now }), { action: "unshield", amount: parseAmount(a), constraint: "flexible" })),
  ),
};
console.log(`${deposits.length} deposits, snapshot ${new Date(manifest.dataTime * 1000).toISOString()}`);
for (const [name, t] of Object.entries(rows)) {
  t.sort((a, b) => a - b);
  console.log(`${name.padEnd(18)} median ${t[t.length >> 1].toFixed(1).padStart(7)} ms   max ${t.at(-1).toFixed(1).padStart(7)} ms`);
}
