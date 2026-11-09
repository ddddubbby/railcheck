// On demand: count the public shields, reshields and unshields of every ERC-20
// token over the last 180 days, with their summed values, into data/census.json.
// It reads newest blocks first in chunks and saves after each one, so a run
// that stops partway can be started again and resumes. A finished census is
// replaced by a new one for the current 180 days on the next run.
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { makeRpc, blockAtTime, CONFIRMATIONS, RAILGUN_PROXY } from "./lib/reader.mjs";
import { WINDOW_SECONDS } from "./lib/data.mjs";
import { censusInChunks } from "./lib/census.mjs";

const PATH = "data/census.json";
const rpc = makeRpc();
if (Number(await rpc("eth_chainId")) !== 1)
  throw Error("RPC_URL must be on Ethereum mainnet.");
let census = existsSync(PATH) ? JSON.parse(readFileSync(PATH, "utf8")) : null;
if (census && (census.chainId !== 1 || census.complete)) census = null;
if (census) {
  console.log(`Resuming the census of blocks ${census.fromBlock}–${census.toBlock} below block ${census.readFromBlock}.`);
} else {
  const head = Number(await rpc("eth_blockNumber")) - CONFIRMATIONS;
  if (!Number.isSafeInteger(head) || head <= 0) throw Error("Invalid Ethereum chain head.");
  const block = await rpc("eth_getBlockByNumber", [`0x${head.toString(16)}`, false]);
  const dataTime = Number(block?.timestamp);
  if (!Number.isSafeInteger(dataTime)) throw Error("Missing confirmed block.");
  if (Math.abs(Date.now() / 1000 - dataTime) > 26 * 3600)
    throw Error("RPC returned an old or future head block.");
  const fromTime = dataTime - WINDOW_SECONDS;
  census = {
    chainId: 1,
    contract: RAILGUN_PROXY,
    windowDays: WINDOW_SECONDS / 86400,
    fromBlock: await blockAtTime(rpc, fromTime, head),
    toBlock: head,
    fromTime,
    toTime: dataTime,
    readFromBlock: head + 1,
    complete: false,
    tokens: {},
  };
  console.log(`Census of blocks ${census.fromBlock}–${census.toBlock}, newest first.`);
}
function save(tokens, lowBlock) {
  census = { ...census, readFromBlock: lowBlock, complete: lowBlock === census.fromBlock, tokens };
  try {
    writeFileSync(PATH + ".tmp", JSON.stringify(census, null, 2) + "\n");
    renameSync(PATH + ".tmp", PATH);
  } finally {
    rmSync(PATH + ".tmp", { force: true });
  }
  console.log(`Saved: ${Object.keys(tokens).length} tokens, blocks ${lowBlock}–${census.toBlock}.`);
}
await censusInChunks(rpc, {
  fromBlock: census.fromBlock,
  toBlock: census.toBlock,
  existing: census,
  chunk: Number(process.env.CENSUS_CHUNK || 100000),
  onChunk: save,
  onProgress: console.log,
});
if (!census.complete) save(census.tokens, census.fromBlock);
console.log(`Census complete: ${Object.keys(census.tokens).length} tokens.`);
