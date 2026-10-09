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
      "data",
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
    assert.match(
      html,
      /href="https:\/\/github\.com\/example\/railcheck"[^>]*>Open source<\/a\s*>/,
    );
    assert.doesNotMatch(html, /href="\/source\.zip"|Source code/);
    assert.match(
      html,
      /Not affiliated with\s*<a href="https:\/\/railgun\.org\/" rel="noopener noreferrer">RAILGUN<\/a>/,
    );
    const json = html.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    )[1];
    assert.equal(JSON.parse(json)["@type"], "WebApplication");
    assert.doesNotMatch(html, /demo|sample|synthetic|\sstyle=|noindex/i);
    assert.doesNotMatch(html, /\{\{/);
    assert.match(html, /<dl class="pulse-stats">/);
    const activity = JSON.parse(
      html.match(/data-activity="([^"]+)"/)[1].replaceAll("&quot;", '"'),
    );
    assert.equal(activity.end - activity.start, 7 * 86400);
    assert.equal(activity.bins.length, 169);
    assert.ok(activity.bins.some((b) => b.withdrawals > 0));
    assert.match(
      html,
      /Updated \d+ \w{3} \d{4} at \d{2}:\d{2} UTC · Block [\d,]+/,
    );
    // Only amounts and counts: no addresses or transaction hashes.
    assert.doesNotMatch(html, /0x[0-9a-f]{8,}/i);
    assert.match(
      readFileSync(join(directory, "dist/index.md"), "utf8"),
      /[\d,]+ deposits and [\d,]+ withdrawals/,
    );
    const about = readFileSync(
      join(directory, "dist/about/index.html"),
      "utf8",
    );
    assert.match(about, /<title>About railcheck<\/title>/);
    assert.match(about, /id="disclaimer"/);
    assert.match(about, /href="https:\/\/railcheck\.example\/about\/"/);
    assert.match(about, /class="eyebrow sys">Independent<\/p>/);
    assert.doesNotMatch(
      about,
      /Open source|href="\/source\.zip"|Source code|Last updated|Data updated|<footer/,
    );
    assert.match(about, /class="nav-link" href="\/">Check amount<\/a>/);
    assert.match(
      about,
      /planned\s*<a href="https:\/\/railgun\.org\/" rel="noopener noreferrer">RAILGUN<\/a>/,
    );
    assert.match(
      readFileSync(join(directory, "dist/about/index.md"), "utf8"),
      /Your input stays private/,
    );
    assert.match(
      readFileSync(join(directory, "dist/sitemap.xml"), "utf8"),
      /https:\/\/railcheck\.example\/about\//,
    );
    assert.match(
      readFileSync(join(directory, "dist/llms.txt"), "utf8"),
      /\[About\]\(https:\/\/railcheck\.example\/about\/index\.md\)/,
    );
    assert.doesNotMatch(html + about, /how-it-works/);
    const { redirects } = JSON.parse(
      readFileSync(join(directory, "vercel.json"), "utf8"),
    );
    for (const [source, destination] of [
      ["/how-it-works", "/about/"],
      ["/how-it-works/:path*", "/about/:path*"],
    ])
      assert.ok(
        redirects.some(
          (r) =>
            r.source === source && r.destination === destination && r.permanent,
        ),
      );
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
    assert.ok(!names.some((p) => p.startsWith("docs/")));
    assert.ok(names.includes("vercel.json"));
    assert.ok(!names.includes("data/validation.json"));
    assert.ok(names.includes(".github/workflows/update-pool.yml"));
    assert.ok(!names.includes(".env"));
    assert.ok(!names.some((p) => p.startsWith(".git/")));
    const corruptManifest = JSON.parse(readFileSync(join(directory, "public/data/manifest.json")));
    corruptManifest.activity.withdrawals = [];
    writeFileSync(join(directory, "public/data/manifest.json"), JSON.stringify(corruptManifest));
    const corrupt = spawnSync(process.execPath, ["scripts/build.mjs"], {
      cwd: directory, encoding: "utf8",
    });
    assert.notEqual(corrupt.status, 0);
    assert.match(corrupt.stderr, /Activity snapshot integrity check failed/);

  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
