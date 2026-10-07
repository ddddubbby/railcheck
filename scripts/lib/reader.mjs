// Narrow decoder for the deployed RAILGUN v2 Shield event. No browser RPC calls.
export const RAILGUN_PROXY = "0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9";
export const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
export const SHIELD_TOPIC =
  "0x3a5b9dc26075a3801a6ddccf95fec485bb7500a91b44cec1add984c21ee6db3b";
export const NULLIFIED_TOPIC =
  "0x781745c57906dc2f175fec80a9c691744c91c48a34a83672c41c2604774eb11f";
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

export function foldShieldLogs(logs) {
  const transactions = new Map(),
    seen = new Set();
  for (const log of logs) {
    if (log.removed)
      throw Error("RPC returned a removed log. Retry the update.");
    if (log.address?.toLowerCase() !== RAILGUN_PROXY)
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
      amountWei: 0n,
      internal: false,
    };
    if (row.block !== block) throw Error("Inconsistent transaction block.");
    row.index = Math.min(row.index, index);
    const topic = log.topics?.[0]?.toLowerCase();
    if (topic === NULLIFIED_TOPIC) row.internal = true;
    else if (topic === SHIELD_TOPIC) {
      for (const c of decodeShield(log.data))
        if (c.tokenType === 0 && c.tokenAddress === WETH)
          row.amountWei += c.value;
    } else throw Error("Unexpected event topic.");
    transactions.set(key, row);
  }
  const rows = [...transactions.values()].filter((r) => r.amountWei > 0n);
  return {
    removedInternal: rows.filter((r) => r.internal).length,
    kept: rows
      .filter((r) => !r.internal)
      .sort((a, b) => a.block - b.block || a.index - b.index)
      .map(({ block, amountWei }) => ({ block, amountWei })),
  };
}

export const PUBLIC_RPC_URLS = [
  "https://gateway.tenderly.co/public/mainnet",
  "https://rpc.mevblocker.io",
];

// A configured RPC_URL is the only primary. Public endpoints are not a silent fallback.
export function rpcCandidates(env = process.env) {
  const configured = env.RPC_URL?.trim();
  return configured ? [configured] : [...PUBLIC_RPC_URLS];
}

function endpointHost(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // The URL can contain an access key, so the original message is discarded.
    throw Error("RPC URLs must be HTTP(S).");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw Error("RPC URLs must be HTTP(S).");
  return parsed.host.toLowerCase();
}

// Witnesses are other hosts. A second URL on the primary host is not independent.
export function witnessCandidates(primaryUrl, env = process.env) {
  const primaryHost = endpointHost(primaryUrl);
  const seen = new Set();
  const urls = [];
  for (const url of [env.RPC_WITNESS_URL?.trim(), ...PUBLIC_RPC_URLS].filter(
    Boolean,
  )) {
    const host = endpointHost(url);
    if (host === primaryHost || seen.has(host)) continue;
    seen.add(host);
    urls.push(url);
  }
  return urls;
}

export function makeRpc({
  urls,
  fetchImpl = fetch,
  timeoutMs = 30000,
  retries = 2,
} = {}) {
  const endpoints = (urls || rpcCandidates()).filter(Boolean);
  let id = 0,
    pinned = null;
  return async (method, params = []) => {
    // Stay on the first endpoint that answers. Later calls must not switch provider.
    for (const endpoint of pinned ? [pinned] : endpoints) {
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
          pinned = endpoint;
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
}

export async function openRpc(options = {}) {
  const list = options.urls || rpcCandidates();
  for (const url of list) {
    const rpc = makeRpc({ ...options, urls: [url] });
    try {
      await rpc("eth_chainId");
      return { rpc, url };
    } catch {
      // A configured RPC_URL has no other candidate. Public lists try the next host.
    }
  }
  throw Error(
    "Ethereum RPC failed for eth_chainId. Try RPC_URL with an archive-capable mainnet endpoint.",
  );
}

export async function agreeOnBlock(primary, witness, number) {
  const tag = `0x${number.toString(16)}`;
  const [a, b] = await Promise.all([
    primary("eth_getBlockByNumber", [tag, false]),
    witness("eth_getBlockByNumber", [tag, false]),
  ]);
  const hash = a?.hash?.toLowerCase();
  const time = Number(a?.timestamp);
  if (
    !/^0x[a-f0-9]{64}$/.test(hash || "") ||
    !Number.isSafeInteger(time) ||
    time <= 0
  )
    throw Error("Missing confirmed block.");
  if (hash !== b?.hash?.toLowerCase() || time !== Number(b?.timestamp))
    throw Error(
      "Two Ethereum providers disagree on a block. The update was not published.",
    );
  return a;
}

export async function confirmWindowStart(primary, witness, firstBlock, cutoff) {
  const boundary = await agreeOnBlock(primary, witness, firstBlock);
  if (Number(boundary.timestamp) < cutoff)
    throw Error(
      "The window start does not match the confirmed block times. The update was not published.",
    );
  if (firstBlock > 0) {
    const before = await agreeOnBlock(primary, witness, firstBlock - 1);
    if (Number(before.timestamp) >= cutoff)
      throw Error(
        "The window start does not match the confirmed block times. The update was not published.",
      );
  }
}

function byDeposit(a, b) {
  if (a.block !== b.block) return a.block - b.block;
  if (a.time !== b.time) return a.time - b.time;
  if (a.amountWei < b.amountWei) return -1;
  if (a.amountWei > b.amountWei) return 1;
  return 0;
}

export function depositsMatch(left, right) {
  if (left.length !== right.length) return false;
  const a = [...left].sort(byDeposit),
    b = [...right].sort(byDeposit);
  return a.every(
    (row, i) =>
      row.block === b[i].block &&
      row.time === b[i].time &&
      row.amountWei === b[i].amountWei,
  );
}

export async function readConfirmedDeposits(
  primary,
  witness,
  start,
  end,
  onProgress = () => {},
) {
  const first = await readDeposits(primary, start, end, onProgress);
  let second;
  try {
    second = await readDeposits(witness, start, end);
  } catch {
    throw Error(
      `The witness RPC failed for blocks ${start}–${end}. The update was not published.`,
    );
  }
  if (
    first.removedInternal !== second.removedInternal ||
    !depositsMatch(first.deposits, second.deposits)
  )
    throw Error(
      `Two Ethereum providers disagree on blocks ${start}–${end}. The update was not published.`,
    );
  return first;
}

export async function blockAtTime(rpc, timestamp, head) {
  let low = 0,
    high = head;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const block = await rpc("eth_getBlockByNumber", [hex(middle), false]);
    if (!block || !Number.isSafeInteger(Number(block.timestamp)))
      throw Error("Missing block timestamp.");
    if (Number(block.timestamp) < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

export async function readDeposits(
  rpc,
  fromBlock,
  toBlock,
  onProgress = () => {},
) {
  const times = new Map(),
    deposits = [];
  let removedInternal = 0;
  async function readRange(start, end) {
    let logs;
    try {
      logs = await rpc("eth_getLogs", [
        {
          address: RAILGUN_PROXY,
          topics: [[SHIELD_TOPIC, NULLIFIED_TOPIC]],
          fromBlock: hex(start),
          toBlock: hex(end),
        },
      ]);
    } catch (error) {
      // Providers have different range/result limits. Never skip a failed range.
      if (start === end) throw error;
      const middle = Math.floor((start + end) / 2);
      await readRange(start, middle);
      await readRange(middle + 1, end);
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
    const folded = foldShieldLogs(logs);
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
    deposits.push(
      ...folded.kept.map((d) => ({ ...d, time: times.get(d.block) })),
    );
    onProgress(`Read blocks ${start}–${end}: ${folded.kept.length} deposits.`);
  }
  for (let start = fromBlock; start <= toBlock; start += 200000)
    await readRange(start, Math.min(toBlock, start + 199999));
  return { deposits, removedInternal };
}
