// Narrow decoder for the deployed RAILGUN v2 Shield and Unshield events.
// Defaults are Ethereum mainnet WETH; pass { proxy, token } for another pool.
export const RAILGUN_PROXY = "0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9";
export const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
export const SHIELD_TOPIC =
  "0x3a5b9dc26075a3801a6ddccf95fec485bb7500a91b44cec1add984c21ee6db3b";
export const NULLIFIED_TOPIC =
  "0x781745c57906dc2f175fec80a9c691744c91c48a34a83672c41c2604774eb11f";
// RailgunLogic.sol: Unshield(address,(uint8,address,uint256),uint256,uint256).
export const UNSHIELD_TOPIC =
  "0xd93cf895c7d5b2cd7dc7a098b678b3089f37d91f48d9b83a0800a91cbdf05284";
export const CONFIRMATIONS = 64;
const hex = (n) => `0x${n.toString(16)}`;

export function decodeShield(data) {
  if (!/^0x(?:[a-f0-9]{64})+$/i.test(data))
    throw Error("Malformed Shield event data.");
  const words = data.slice(2).match(/.{64}/g);
  const word = (i) => {
    if (i >= words.length) throw Error("Truncated Shield event.");
    return BigInt(`0x${words[i]}`);
  };
  if (words.length < 5) throw Error("Truncated Shield event.");
  const pointer = word(2);
  if (pointer < 160n || pointer % 32n || pointer > BigInt(data.length / 2))
    throw Error("Invalid commitment array offset.");
  const offset = Number(pointer / 32n),
    count = Number(word(offset));
  if (
    !Number.isSafeInteger(count) ||
    count > 100000 ||
    offset + 1 + count * 5 > words.length
  )
    throw Error("Invalid commitment array length.");
  const commitments = [];
  for (let i = 0; i < count; i++) {
    const start = offset + 1 + i * 5;
    const type = word(start + 1),
      address = word(start + 2),
      value = word(start + 4);
    if (type > 2n || address >= 2n ** 160n || value >= 2n ** 120n)
      throw Error("Invalid commitment fields.");
    commitments.push({
      tokenType: Number(type),
      tokenAddress: `0x${address.toString(16).padStart(40, "0")}`,
      value,
    });
  }
  return commitments;
}

export function foldShieldLogs(logs, { proxy = RAILGUN_PROXY, token = WETH } = {}) {
  const transactions = new Map(),
    seen = new Set();
  for (const log of logs) {
    if (log.removed)
      throw Error("RPC returned a removed log. Retry the update.");
    if (log.address?.toLowerCase() !== proxy)
      throw Error("RPC returned a log from another contract.");
    if (!/^0x[a-f0-9]{64}$/i.test(log.transactionHash || ""))
      throw Error("Missing transaction hash.");
    const block = Number(log.blockNumber),
      index = Number(log.logIndex);
    if (
      !Number.isSafeInteger(block) ||
      block < 0 ||
      !Number.isSafeInteger(index) ||
      index < 0
    )
      throw Error("Missing log position.");
    const id = `${log.transactionHash.toLowerCase()}:${index}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const key = log.transactionHash.toLowerCase();
    const row = transactions.get(key) || {
      block,
      index,
      notes: [],
      internal: false,
      hash: key,
    };
    if (row.block !== block) throw Error("Inconsistent transaction block.");
    row.index = Math.min(row.index, index);
    const topic = log.topics?.[0]?.toLowerCase();
    if (topic === NULLIFIED_TOPIC) row.internal = true;
    else if (topic === SHIELD_TOPIC) {
      for (const c of decodeShield(log.data))
        if (c.tokenType === 0 && c.tokenAddress === token) row.notes.push(c.value);
    } else throw Error("Unexpected event topic.");
    transactions.set(key, row);
  }
  // Public shields: one row per transaction (sum). Reshields (Nullified): one row per note.
  // kind: "public" | "reshield" — settled here for pool v3 (R0.3) and buildPool (SDK-4).
  const kept = [];
  for (const row of [...transactions.values()].sort(
    (a, b) => a.block - b.block || a.index - b.index,
  )) {
    if (!row.notes.length) continue;
    if (row.internal) {
      for (const amountWei of row.notes)
        kept.push({
          block: row.block,
          amountWei,
          hash: row.hash,
          kind: "reshield",
        });
    } else {
      kept.push({
        block: row.block,
        amountWei: row.notes.reduce((sum, n) => sum + n, 0n),
        hash: row.hash,
        kind: "public",
      });
    }
  }
  return {
    // Count of reshield note rows found (formerly "internal shields excluded").
    removedInternal: kept.filter((r) => r.kind === "reshield").length,
    kept,
  };
}

export function makeRpc({
  urls,
  fetchImpl = fetch,
  timeoutMs = 30000,
  retries = 2,
} = {}) {
  const endpoints =
    urls ||
    [
      process.env.RPC_URL,
      "https://gateway.tenderly.co/public/mainnet",
      "https://eth.drpc.org",
    ].filter(Boolean);
  let id = 0;
  const call = async (method, params = []) => {
    for (const endpoint of endpoints) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const response = await fetchImpl(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) throw Error();
          const body = await response.json();
          if (body.error || !Object.hasOwn(body, "result")) throw Error();
          return body.result;
        } catch {
          if (attempt < retries)
            await new Promise((resolve) =>
              setTimeout(resolve, 300 * 2 ** attempt),
            );
        }
      }
    }
    // Never include the RPC URL: it can contain an access key.
    throw Error(
      `Ethereum RPC failed for ${method}. Try RPC_URL with an archive-capable mainnet endpoint.`,
    );
  };
  /** Many calls in one JSON-RPC batch request: [[method, params]] → results, in order. */
  call.batch = async (calls) => {
    for (const endpoint of endpoints) {
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            calls.map(([method, params], i) => ({ jsonrpc: "2.0", id: i, method, params })),
          ),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = await response.json();
        if (!Array.isArray(body) || body.length !== calls.length) throw Error();
        const results = [];
        for (const item of body) {
          if (item.error || !Object.hasOwn(item, "result")) throw Error();
          results[item.id] = item.result;
        }
        return results;
      } catch {
        // Try the next endpoint.
      }
    }
    throw Error("Ethereum RPC batch failed.");
  };
  return call;
}

/**
 * First block with timestamp >= `timestamp`. It guesses from the time gap
 * (interpolation), and bisects on alternate steps, so it always ends.
 */
export async function blockAtTime(rpc, timestamp, head) {
  const timeOf = async (n) => {
    const block = await rpc("eth_getBlockByNumber", [hex(n), false]);
    const time = Number(block?.timestamp);
    if (!Number.isSafeInteger(time)) throw Error("Missing block timestamp.");
    return time;
  };
  let high = head,
    tHigh = await timeOf(head);
  if (tHigh < timestamp) return head + 1;
  // Find a low block before the timestamp: guess 12 s blocks, then step back further.
  let step = Math.ceil((tHigh - timestamp) / 12) + 100,
    low = Math.max(0, head - step),
    tLow = await timeOf(low);
  while (tLow >= timestamp && low > 0) {
    high = low;
    tHigh = tLow;
    step *= 2;
    low = Math.max(0, high - step);
    tLow = await timeOf(low);
  }
  if (tLow >= timestamp) return low;
  // Now tLow < timestamp <= tHigh.
  for (let bisect = false; high - low > 1; bisect = !bisect) {
    let middle = bisect
      ? Math.floor((low + high) / 2)
      : low + Math.floor(((timestamp - tLow) * (high - low)) / (tHigh - tLow || 1));
    middle = Math.min(high - 1, Math.max(low + 1, middle));
    const time = await timeOf(middle);
    if (time < timestamp) (low = middle), (tLow = time);
    else (high = middle), (tHigh = time);
  }
  return high;
}

export function foldUnshieldLogs(logs, { proxy = RAILGUN_PROXY, token = WETH } = {}) {
  const transactions = new Map(),
    seen = new Set();
  for (const log of logs) {
    const block = Number(log.blockNumber),
      index = Number(log.logIndex);
    if (
      log.removed ||
      log.address?.toLowerCase() !== proxy ||
      log.topics?.length !== 1 ||
      log.topics[0].toLowerCase() !== UNSHIELD_TOPIC ||
      !/^0x[a-f0-9]{64}$/i.test(log.transactionHash || "") ||
      !Number.isSafeInteger(block) ||
      block < 0 ||
      !Number.isSafeInteger(index) ||
      index < 0
    )
      throw Error("Invalid Unshield log.");
    if (!/^0x(?:[a-f0-9]{64}){6}$/i.test(log.data || ""))
      throw Error("Malformed Unshield event data.");
    const [recipient, type, address, subId, amount] = log.data
      .slice(2)
      .match(/.{64}/g)
      .map((w) => BigInt(`0x${w}`));
    if (recipient >= 2n ** 160n || type > 2n || address >= 2n ** 160n)
      throw Error("Invalid Unshield fields.");
    const key = log.transactionHash.toLowerCase(),
      id = `${key}:${index}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (type !== 0n || address !== BigInt(token) || amount === 0n) continue;
    if (subId !== 0n) throw Error("Invalid ERC20 token sub-ID.");
    const row = transactions.get(key) || { block, index, amountWei: 0n };
    if (row.block !== block) throw Error("Inconsistent transaction block.");
    row.amountWei += amount;
    row.index = Math.min(row.index, index);
    transactions.set(key, row);
  }
  return {
    removedInternal: 0,
    kept: [...transactions.values()]
      .sort((a, b) => a.block - b.block || a.index - b.index)
      .map(({ block, amountWei }) => ({ block, amountWei })),
  };
}

export function readDeposits(rpc, fromBlock, toBlock, onProgress = () => {}, pool = {}) {
  return readEvents(
    rpc,
    fromBlock,
    toBlock,
    onProgress,
    [SHIELD_TOPIC, NULLIFIED_TOPIC],
    foldShieldLogs,
    pool,
  );
}

export async function readWithdrawals(
  rpc,
  fromBlock,
  toBlock,
  onProgress = () => {},
  pool = {},
) {
  const result = await readEvents(
    rpc,
    fromBlock,
    toBlock,
    onProgress,
    [UNSHIELD_TOPIC],
    foldUnshieldLogs,
    pool,
  );
  return result.deposits;
}

async function readEvents(rpc, fromBlock, toBlock, onProgress, topics, fold, pool = {}) {
  const times = new Map(),
    deposits = [];
  let removedInternal = 0;
  async function readRange(start, end, out) {
    if (failed) throw failed;
    let logs;
    try {
      logs = await rpc("eth_getLogs", [
        {
          address: pool.proxy ?? RAILGUN_PROXY,
          topics: [topics],
          fromBlock: hex(start),
          toBlock: hex(end),
        },
      ]);
    } catch (error) {
      // Providers have different range/result limits. Never skip a failed range.
      // A refusal can be a range limit or a rate limit. Split, but never below
      // minRange: past that point, more calls only make a rate limit worse.
      if (end - start + 1 <= minRange) throw (failed ||= error);
      const middle = Math.floor((start + end) / 2);
      size = Math.min(size, Math.max(minRange, middle - start + 1));
      await readRange(start, middle, out);
      await readRange(middle + 1, end, out);
      return;
    }
    if (!Array.isArray(logs)) throw Error("Invalid Ethereum log response.");
    for (const l of logs) {
      const block = Number(l.blockNumber);
      if (block < start || block > end)
        throw Error("RPC log is outside the requested range.");
      if (l.blockTimestamp != null) {
        const time = Number(l.blockTimestamp);
        if (!Number.isSafeInteger(time) || time <= 0)
          throw Error("Invalid log timestamp.");
        if (times.has(block) && times.get(block) !== time)
          throw Error("Inconsistent log timestamps.");
        times.set(block, time);
      }
    }
    const folded = fold(logs, pool);
    removedInternal += folded.removedInternal;
    const missing = [...new Set(folded.kept.map((r) => r.block))].filter(
      (n) => !times.has(n),
    );
    for (let i = 0; i < missing.length; i += 8)
      await Promise.all(
        missing.slice(i, i + 8).map(async (block) => {
          const b = await rpc("eth_getBlockByNumber", [hex(block), false]);
          if (
            !b ||
            !Number.isSafeInteger(Number(b.timestamp)) ||
            Number(b.timestamp) <= 0
          )
            throw Error("Missing block timestamp.");
          times.set(block, Number(b.timestamp));
        }),
      );
    out.push(...folded.kept.map((d) => ({ ...d, time: times.get(d.block) })));
    onProgress(
      `Read blocks ${start}–${end}: ${folded.kept.length} transactions.`,
    );
  }
  // Workers read ranges in parallel (pool.concurrency). After a split, later ranges
  // use the smaller size that worked. Results keep block order.
  let size = pool.rangeSize ?? 200000,
    next = fromBlock;
  const minRange = pool.minRange ?? 1000;
  let failed = null; // the first final error stops every worker
  const parts = [];
  async function worker() {
    while (next <= toBlock) {
      const start = next,
        end = Math.min(toBlock, start + size - 1),
        out = [];
      next = end + 1;
      parts.push([start, out]);
      await readRange(start, end, out);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, pool.concurrency ?? 1) }, worker));
  parts.sort((a, b) => a[0] - b[0]);
  for (const [, out] of parts) deposits.push(...out);
  return { deposits, removedInternal };
}
