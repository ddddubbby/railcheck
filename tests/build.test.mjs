import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  cpSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
test("production build emits metadata and excludes secrets from its source ZIP", () => {
  const directory = mkdtempSync(join(tmpdir(), "railcheck-build-"));
  try {
    for (const path of [
      "docs",
      "data",
      "CONTRIBUTING.md",
      "vercel.json",
      "package-lock.json",
      ".gitignore",
      "src",
      "public",
      "lib",
      "scripts",
      "package.json",
      "LICENSE",
      "README.md",
      ".env.example",
      ".github",
    ])
      cpSync(path, join(directory, path), { recursive: true });
    writeFileSync(
      join(directory, ".env"),
      "RPC_URL=https://secret.invalid/private-key\n",
    );
    writeFileSync(join(directory, "data/validation.json"), "{}\n");
    const run = spawnSync(process.execPath, ["scripts/build.mjs"], {
      cwd: directory,
      env: {
        ...process.env,
        SITE_URL: "https://railcheck.example",
        SOURCE_URL: "https://github.com/example/railcheck",
      },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const html = readFileSync(join(directory, "dist/index.html"), "utf8");
    assert.match(
      html,
      /<link rel="canonical" href="https:\/\/railcheck\.example\/">/,
    );
    assert.match(html, /href="https:\/\/github\.com\/example\/railcheck"/);
    const json = html.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    )[1];
    assert.equal(JSON.parse(json)["@type"], "WebApplication");
    assert.doesNotMatch(html, /demo|sample|synthetic|\sstyle=|noindex/i);
    const zip = readFileSync(join(directory, "dist/source.zip"));
    const end = zip.length - 22,
      count = zip.readUInt16LE(end + 10),
      names = [];
    let cursor = zip.readUInt32LE(end + 16);
    for (let i = 0; i < count; i++) {
      assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
      const n = zip.readUInt16LE(cursor + 28);
      names.push(zip.subarray(cursor + 46, cursor + 46 + n).toString());
      cursor +=
        46 + n + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
    }
    assert.ok(names.includes(".env.example"));
    assert.ok(names.includes("docs/maintaining.md"));
    assert.ok(names.includes("vercel.json"));
    assert.ok(!names.includes("data/validation.json"));
    assert.ok(names.includes(".github/workflows/update-pool.yml"));
    assert.ok(!names.includes(".env"));
    assert.ok(!names.some((p) => p.startsWith(".git/")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
