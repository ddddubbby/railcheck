// Runnable example: railcheck advice through a Kohaku-style plugin, on the real
// mainnet snapshot. The plugin here is a stub that prints what it would prepare.
// Run from the repository root: node packages/kohaku/example.mjs 1.234567 [weth|usdt|usdc]
import { readFileSync } from "node:fs";
import { decode, prepare, parseAmount, formatWei, ASSETS } from "@railcheck/core";
import { guard } from "@railcheck/kohaku";

const [value = "1.234567", id = "weth"] = process.argv.slice(2);
const asset = ASSETS.find((a) => a.symbol.toLowerCase() === id);
if (!asset) throw Error(`Unknown token: ${id}. Use weth, usdt or usdc.`);
const manifest = JSON.parse(readFileSync("public/data/manifest.json", "utf8"));
const entry = id === "weth" ? manifest : manifest.pools[id];
const bytes = readFileSync(`public/data/${entry.file}`);
const deposits = decode(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  entry,
);
const pool = prepare(deposits, {
  now: entry.dataTime + 1,
  asset,
  snapshot: { pool: entry.pool, chainId: entry.chainId, token: entry.token, block: entry.lastBlock, time: entry.dataTime },
});
const unit = asset.unit ?? asset.symbol,
  show = (wei) => `${formatWei(wei, undefined, asset)} ${unit}`;

const plugin = {
  instanceId: async () => "0zk-example",
  prepareUnshield: async (assetAmount, to) => {
    console.log(`prepareUnshield: ${show(assetAmount.amount)} to ${to}`);
    return { __type: "privateOperation" };
  },
};

const safe = guard(plugin, {
  pool,
  constraint: "flexible", // the user allows a smaller amount
  getContext: async () => ({ addressReuse: false, pastTransfer: false }), // restOfDeposit unknown
  onAdvice: async (advice) => {
    const a = advice.assessment;
    console.log(`advice: ${a.status}, ${show(a.amounts.unshieldAmount)} scores ${a.score} (${a.band})`);
    console.log(`findings: ${a.findings.map((f) => f.code).join(", ") || "none"}`);
    const alt = advice.alternatives[0];
    if (alt) console.log(`alternative: ${show(alt.amounts.unshieldAmount)} scores ${alt.score}; recipient gets ${show(alt.amounts.recipientAmount)}`);
    return alt ? alt.amounts.unshieldAmount : null; // accept the alternative
  },
});

await safe.prepareUnshield(
  {
    asset: id === "weth" ? { __type: "native" } : { __type: "erc20", contract: asset.address },
    amount: parseAmount(value, asset),
  },
  "0x000000000000000000000000000000000000dEaD",
);
