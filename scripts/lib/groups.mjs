// Groups pool deposits by the address that sent each shield transaction.
// Addresses stay in memory: only group numbers are written to the pool file.

/** Sender of each transaction hash, with batched JSON-RPC and a slow fallback. */
export async function sendersOf(hashes, { urls, rpc, fetchImpl = fetch, size = 100 }) {
  const from = new Map();
  for (let i = 0; i < hashes.length; i += size) {
    const chunk = hashes.slice(i, i + size);
    let done = false;
    for (const url of urls) {
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            chunk.map((hash, id) => ({
              jsonrpc: "2.0",
              id,
              method: "eth_getTransactionByHash",
              params: [hash],
            })),
          ),
          signal: AbortSignal.timeout(30000),
        });
        const body = await response.json();
        if (!Array.isArray(body) || body.length !== chunk.length) throw Error();
        for (const item of body) {
          const sender = item?.result?.from?.toLowerCase();
          if (!/^0x[0-9a-f]{40}$/.test(sender || "")) throw Error();
          from.set(chunk[item.id], sender);
        }
        done = true;
        break;
      } catch {
        // Try the next endpoint; never log the URL, which can hold a key.
      }
    }
    if (!done)
      for (const hash of chunk) {
        const tx = await rpc("eth_getTransactionByHash", [hash]);
        if (!/^0x[0-9a-fA-F]{40}$/.test(tx?.from || ""))
          throw Error("Missing transaction sender.");
        from.set(hash, tx.from.toLowerCase());
      }
  }
  return from;
}

/** Group number per row: the order in which each sender first appears. */
export function assignGroups(rows, from) {
  const ids = new Map();
  return rows.map((row) => {
    const sender = from.get(row.hash);
    if (!sender) throw Error("Missing transaction sender.");
    if (!ids.has(sender)) ids.set(sender, ids.size);
    return ids.get(sender);
  });
}

/**
 * Gives each stored window row the hash of its shield transaction. The fresh list
 * may hold extra internal reshields; every stored row must find its transaction.
 */
export function matchHashes(windowRows, fresh) {
  const queue = new Map();
  for (const tx of fresh) {
    const key = `${tx.block}:${tx.amountWei}`;
    if (!queue.has(key)) queue.set(key, []);
    queue.get(key).push(tx.hash);
  }
  return windowRows.map((row) => {
    const hash = queue.get(`${row.block}:${row.amountWei}`)?.shift();
    if (!hash)
      throw Error("Depositor groups do not match the stored deposits. Rebuild the pool.");
    return { ...row, hash };
  });
}
