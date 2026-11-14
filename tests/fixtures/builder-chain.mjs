// The fake chain of the builder tests: block n has time 12n, and `fork` changes
// every block hash. It holds three WETH shields (two from one sender), USDT and
// USDC shields, a USDT swap output, a shield of both stables in one transaction
// and a shield of a token that no pool covers. No network.
import { readFileSync } from "node:fs";
import { NULLIFIED_TOPIC, SHIELD_TOPIC, RAILGUN_PROXY } from "../../packages/builder/reader.mjs";

export const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
export const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
export const OTHER = "0x6b175474e89094c44da98b954eedeac495271d0f";
export const hex = (n) => `0x${n.toString(16)}`;
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const pad = (tx) => tx.padEnd(66, "0");
const from = (d) => "0x" + String(d).repeat(40);

export const fixture = JSON.parse(readFileSync("tests/fixtures/ethereum-logs.json", "utf8"));
// The external shield, copied into three transactions: two from one sender.
const base = fixture.logs[2];
export const wethLogs = [
  [26131570, "0xaa", from(1)],
  [26131600, "0xbb", from(1)],
  [26131700, "0xcc", from(2)],
].map(([block, tx, sender]) => ({
  ...base,
  blockNumber: hex(block),
  blockTimestamp: undefined,
  transactionHash: pad(tx),
  from: sender,
}));

/** A Shield log with one commitment per [token, value] note. */
export function shieldLog(tx, block, notes, index = 0, sender) {
  return {
    address: RAILGUN_PROXY,
    transactionHash: pad(tx),
    blockNumber: hex(block),
    logIndex: hex(index),
    topics: [SHIELD_TOPIC],
    data:
      "0x" +
      [
        word(0), word(0), word(160),
        word(192 + 160 * notes.length), word(224 + 160 * notes.length),
        word(notes.length),
        ...notes.flatMap(([address, value]) => [word(1), word(0), word(address), word(0), word(value)]),
        word(0), word(0),
      ].join(""),
    from: sender,
  };
}
const nullifiedLog = (tx, block, index = 0) => ({
  address: RAILGUN_PROXY,
  transactionHash: pad(tx),
  blockNumber: hex(block),
  logIndex: hex(index),
  topics: [NULLIFIED_TOPIC],
  data: "0x" + word(0) + word(64) + word(0),
});

// The stable shields. USDT sender 1 is also a WETH sender: groups are per pool.
export const stableLogs = [
  shieldLog("0xe1", 26131575, [[USDT, 1_234_567_891n]], 0, from(1)),
  shieldLog("0xe2", 26131590, [[USDC, 500_000_001n]], 0, from(3)),
  // Both stables in one transaction: one sender lookup, a row in each pool.
  shieldLog("0xe3", 26131605, [[USDT, 20_000_000n], [USDC, 100_000_000n]], 0, from(4)),
  // A USDT swap output: Nullified and Shield in one transaction.
  nullifiedLog("0xe4", 26131610, 0),
  shieldLog("0xe4", 26131610, [[USDT, 777_777n]], 1),
  // A token that no pool covers.
  shieldLog("0xe5", 26131620, [[OTHER, 3n * 10n ** 18n]], 0, from(5)),
  // After the second head.
  shieldLog("0xe6", 26131720, [[USDT, 50_000_000n]], 0, from(6)),
  shieldLog("0xe7", 26131730, [[USDC, 2_500_000n]], 0, from(3)),
];
// WETH and USDT in one transaction, for the `mixed` chain.
export const mixedLogs = [
  shieldLog("0xe8", 26131615, [[WETH, 2_000_000_000_123_456_789n], [USDT, 3_000_000n]], 0, from(7)),
];
// A WETH swap output, for the `reshield` chain.
export const wethSwapLogs = [
  { ...wethLogs[0], topics: [NULLIFIED_TOPIC], transactionHash: pad("0xdd"), blockNumber: hex(26131600), logIndex: "0x0" },
  { ...wethLogs[0], transactionHash: pad("0xdd"), blockNumber: hex(26131600), logIndex: "0x1" },
];

/**
 * The fake chain. `ranges` records each eth_getLogs range, `asked` each sender
 * lookup. Options add the WETH-and-USDT transaction (`mixed`) and the WETH swap
 * output (`reshield`).
 */
export function chain({ mixed = false, reshield = false } = {}) {
  const logs = [...wethLogs, ...stableLogs, ...(mixed ? mixedLogs : []), ...(reshield ? wethSwapLogs : [])];
  const c = { head: 26131700, fork: "a", ranges: [], asked: [], logs };
  c.rpc = async (method, [arg]) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_blockNumber") return hex(c.head);
    if (method === "eth_getBlockByNumber") {
      const n = Number(arg);
      return { timestamp: hex(12 * n), hash: `0x${c.fork}${n}` };
    }
    if (method === "eth_getLogs") {
      const lo = Number(arg.fromBlock), hi = Number(arg.toBlock);
      c.ranges.push([lo, hi]);
      return logs
        .filter((l) => Number(l.blockNumber) >= lo && Number(l.blockNumber) <= hi)
        .map(({ from: _, ...log }) => log);
    }
    if (method === "eth_getTransactionByHash") {
      c.asked.push(arg);
      return { from: logs.find((l) => l.transactionHash === arg && l.from).from };
    }
    throw Error(method);
  };
  return c;
}
