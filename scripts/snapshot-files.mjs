// Prints the data files of the published snapshot, one per line, for the
// workflows' `git add`: the manifest, and the CSV and pool files of WETH and of
// every pool in `manifest.pools`. Only files that exist are listed, so a pool
// left out of a run (its first build failed) never breaks the commit step.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TOKENS, tokenById } from "./lib/tokens.mjs";

export function snapshotFiles(dir = ".") {
  const manifestPath = "public/data/manifest.json";
  const manifest = JSON.parse(readFileSync(join(dir, manifestPath), "utf8"));
  const tokens = [TOKENS[0], ...Object.keys(manifest.pools ?? {}).map(tokenById).filter(Boolean)];
  return [
    ...tokens.flatMap((t) => [t.depositsCsv, t.reshieldsCsv, `public/data/${t.file}`]),
    manifestPath,
  ].filter((p) => existsSync(join(dir, p)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(snapshotFiles().join("\n"));
