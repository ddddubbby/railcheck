// The daily update of every pool (WETH, USDT, USDC): see scripts/lib/update.mjs.
import { makeRpc } from "./lib/reader.mjs";
import { updatePools } from "./lib/update.mjs";

// A new pool left out of a run shows as a warning on the Actions run page.
const warn = (message) =>
  console.log(process.env.GITHUB_ACTIONS === "true" ? `::warning::${message}` : `Warning: ${message}`);
await updatePools({ rpc: makeRpc(), warn });
