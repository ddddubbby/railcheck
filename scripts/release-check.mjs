import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
if (!process.env.SITE_URL && !process.env.VERCEL_PROJECT_PRODUCTION_URL)
  throw Error(
    "Set SITE_URL to the production HTTPS origin before a release check.",
  );
for (const args of [
  [
    "--test",
    ...readdirSync("tests")
      .filter((name) => name.endsWith(".test.mjs"))
      .map((name) => "tests/" + name),
  ],
  ["scripts/validate-data.mjs", "--release"],
  ["scripts/build.mjs"],
]) {
  const r = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status || 1);
}
