// The daily update of every pool (WETH, USDT, USDC): see scripts/lib/update.mjs.
import { makeRpc } from "./lib/reader.mjs";
import { updatePools } from "./lib/update.mjs";

await updatePools({ rpc: makeRpc() });
