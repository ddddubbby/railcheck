// Runnable example: railcheck advice through a Kohaku-style plugin, on the real
// mainnet snapshot. The plugin here is a stub that prints what it would prepare.
// Run from the repository root: node packages/kohaku/example.mjs 1.234567
import { readFileSync } from "node:fs";
import { decode, prepare, parseAmount, formatWei } from "@railcheck/core";
import { guard } from "@railcheck/kohaku";

const manifest = JSON.parse(readFileSync("public/data/manifest.json", "utf8"));
const bytes = readFileSync(`public/data/${manifest.file}`);
const deposits = decode(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  manifest,
);
const pool = prepare(deposits, {
  now: manifest.dataTime + 1,
  snapshot: { pool: "ethereum-weth", block: manifest.lastBlock, time: manifest.dataTime },
});

const plugin = {
  instanceId: async () => "0zk-example",
  prepareUnshield: async (assetAmount, to) => {
    console.log(`prepareUnshield: ${formatWei(assetAmount.amount)} ETH to ${to}`);
    return { __type: "privateOperation" };
  },
};

const safe = guard(plugin, {
  pool,
  constraint: "flexible", // the user allows a smaller amount
  getContext: async () => ({ addressReuse: false, pastTransfer: false }), // restOfDeposit unknown
  onAdvice: async (advice) => {
    const a = advice.assessment;
    console.log(`advice: ${a.status}, ${formatWei(a.amounts.unshieldAmount)} ETH scores ${a.score} (${a.band})`);
    console.log(`findings: ${a.findings.map((f) => f.code).join(", ") || "none"}`);
    const alt = advice.alternatives[0];
    if (alt) console.log(`alternative: ${formatWei(alt.amounts.unshieldAmount)} ETH scores ${alt.score}; recipient gets ${formatWei(alt.amounts.recipientAmount)} ETH`);
    return alt ? alt.amounts.unshieldAmount : null; // accept the alternative
  },
});

await safe.prepareUnshield(
  { asset: { __type: "native" }, amount: parseAmount(process.argv[2] ?? "1.234567") },
  "0x000000000000000000000000000000000000dEaD",
);
