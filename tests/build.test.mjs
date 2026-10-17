import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  cpSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { resolve } from "node:path";
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
      "packages",
      "scripts",
      "package.json",
      "LICENSE",
      "README.md",
      ".env.example",
      ".github",
    ])
      cpSync(path, join(directory, path), { recursive: true });
    // The build loads marked at build time.
    symlinkSync(resolve("node_modules"), join(directory, "node_modules"), "dir");
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
    const graph = JSON.parse(json);
    assert.ok(Array.isArray(graph["@graph"]));
    assert.equal(
      graph["@graph"].find((n) => n["@type"] === "WebApplication")?.name,
      "railcheck",
    );
    assert.equal(
      (html.match(/<script type="application\/ld\+json">/g) || []).length,
      1,
    );
    assert.doesNotMatch(html, /demo|sample|synthetic|\sstyle=|noindex/i);
    assert.doesNotMatch(html, /\{\{/);
    assert.match(html, /<dl class="pulse-stats">/);
    const activity = JSON.parse(
      html.match(/data-activity="([^"]+)"/)[1].replaceAll("&quot;", '"'),
    );
    assert.equal(activity.end - activity.start, 3 * 86400);
    assert.equal(activity.bins.length, 73);
    assert.ok(activity.bins.some((b) => b.withdrawals > 0));
    assert.match(
      html,
      /Snapshot · \d+ \w{3}, \d{2}:\d{2} UTC · Block [\d,]+/,
    );
    // Only amounts and counts: no addresses or transaction hashes.
    assert.doesNotMatch(html, /0x[0-9a-f]{8,}/i);
    assert.match(
      readFileSync(join(directory, "dist/index.md"), "utf8"),
      /[\d,]+ shields and [\d,]+ unshields/,
    );
    const page = readFileSync(
      join(directory, "dist/how-it-works/index.html"),
      "utf8",
    );
    assert.match(page, /<title>How the railcheck privacy check works<\/title>/);
    const pageJson = page.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    )[1];
    const pageGraph = JSON.parse(pageJson)["@graph"];
    assert.ok(pageGraph.some((n) => n["@type"] === "TechArticle"));
    assert.ok(!pageGraph.some((n) => n["@type"] === "FAQPage"));
    assert.equal(
      (page.match(/<script type="application\/ld\+json">/g) || []).length,
      1,
    );
    assert.match(page, /<h2 id="disclaimer">/);
    assert.match(page, /<h2 id="data">/);
    assert.match(page, /<link rel="canonical" href="https:\/\/railcheck\.example\/how-it-works\/">/);
    assert.match(page, /aria-current="page">How it works<\/a>/);
    assert.match(page, /href="https:\/\/github\.com\/example\/railcheck" rel="noopener noreferrer">Source<\/a>/);
    assert.doesNotMatch(page, /eyebrow|\{\{|href="\/about\//);
    const pageMd = readFileSync(join(directory, "dist/how-it-works.md"), "utf8");
    assert.equal(pageMd, readFileSync(join(directory, "dist/how-it-works/index.md"), "utf8"));
    assert.match(pageMd, /^## Data$/m);
    assert.doesNotMatch(pageMd, /\{#/);
    const docs = readFileSync(join(directory, "dist/docs/index.html"), "utf8");
    const docsGraph = JSON.parse(
      docs.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1],
    )["@graph"];
    assert.ok(docsGraph.some((n) => n["@type"] === "SoftwareSourceCode" && n["@id"].endsWith("/#sdk")));
    assert.ok(docsGraph.some((n) => n["@type"] === "TechArticle"));
    assert.match(docs, /<button type="button" class="copy-page" data-src="\/docs.md" hidden>/);
    assert.match(docs, /<script type="module" src="\/docs.mjs"><\/script>/);
    assert.match(docs, /href="\/docs.md">View as Markdown<\/a>/);
    assert.match(docs, /Preview 0\.1\.0 · Updated <time datetime="\d{4}-\d{2}-\d{2}">/);
    const docsMd = readFileSync(join(directory, "dist/docs.md"), "utf8");
    assert.match(docsMd, /^## Reference$/m);
    // Unpublished sections stay out of every output.
    for (const out of [docs, docsMd, readFileSync(join(directory, "dist/docs/index.md"), "utf8")])
      assert.doesNotMatch(out, /For AI agents|@railcheck\/mcp|if:mcp/);
    const sitemap = readFileSync(join(directory, "dist/sitemap.xml"), "utf8");
    assert.match(sitemap, /https:\/\/railcheck\.example\/how-it-works\/<\/loc><lastmod>\d{4}-\d{2}-\d{2}</);
    assert.doesNotMatch(sitemap, /about/);
    assert.match(sitemap, /https:\/\/railcheck\.example\/docs\/<\/loc>/);
    assert.match(
      readFileSync(join(directory, "dist/llms.txt"), "utf8"),
      /\[How it works\]\(https:\/\/railcheck\.example\/how-it-works\.md\)/,
    );
    assert.doesNotMatch(html + page, /href="\/about\//);
    const { redirects } = JSON.parse(
      readFileSync(join(directory, "vercel.json"), "utf8"),
    );
    for (const [source, destination] of [
      ["/about", "/how-it-works/"],
      ["/about/:path*", "/how-it-works/"],
      ["/plan", "/"],
      ["/plan/:path*", "/"],
    ])
      assert.ok(
        redirects.some(
          (r) =>
            r.source === source && r.destination === destination && r.permanent,
        ),
      );
    assert.ok(!redirects.some((r) => r.source.startsWith("/how-it-works")));
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
    assert.ok(names.includes("packages/builder/index.mjs"));
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
