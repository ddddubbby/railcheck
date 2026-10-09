import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
  existsSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { decode } from "../lib/pool/index.mjs";
import { pulseStats } from "./lib/pulse.mjs";
const date = (t) =>
  new Date(t * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
const escape = (value) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const manifest = JSON.parse(readFileSync("public/data/manifest.json", "utf8"));
if (manifest.demo || manifest.chainId !== 1 || manifest.token !== "WETH")
  throw Error(
    "Build requires live Ethereum WETH data. Run npm run data:update.",
  );
const bytes = readFileSync(`public/data/${manifest.file}`);
if (
  createHash("sha256").update(bytes).digest("hex") !== manifest.sha256 ||
  bytes.length !== manifest.size
)
  throw Error("Pool integrity check failed.");
const activityBytes = JSON.stringify(manifest.activity);
if (
  !activityBytes ||
  createHash("sha256").update(activityBytes).digest("hex") !==
  manifest.activitySha256
)
  throw Error(
    "Activity snapshot integrity check failed. Run npm run data:update.",
  );
const pulse = pulseStats(
  decode(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    manifest,
  ),
  JSON.parse(activityBytes),
  manifest,
);
const number = (n) => n.toLocaleString("en");
// Headline totals share one precision so the two columns line up.
const total = (wei) =>
  new Intl.NumberFormat("en", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(wei) / 1e18);
const eth = (wei) =>
  new Intl.NumberFormat("en", { maximumFractionDigits: 3 }).format(
    Number(wei) / 1e18,
  );
const selected = Math.max(0, pulse.bins.length - 2); // Latest complete UTC hour.
const latest = pulse.bins[selected];
const shortDate = (time) =>
  new Date(time * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const clock = (time) =>
  new Date(time * 1000).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
let origin = process.env.SITE_URL?.trim();
if (
  !origin &&
  process.env.VERCEL_ENV === "production" &&
  process.env.VERCEL_PROJECT_PRODUCTION_URL
)
  origin = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
if (origin) {
  const parsed = new URL(origin);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  )
    throw Error(
      "SITE_URL must be an HTTPS origin with no path or credentials.",
    );
  origin = parsed.origin;
}
const sourceURL = process.env.SOURCE_URL?.trim();
if (sourceURL) {
  const parsed = new URL(sourceURL);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw Error("SOURCE_URL must be an HTTPS URL.");
}
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/about", { recursive: true });
cpSync("public", "dist", { recursive: true });
cpSync("lib", "dist/lib", { recursive: true });
cpSync("src/style.css", "dist/style.css");
for (const [source, destination, path] of [
  ["src/index.html", "dist/index.html", "/"],
  ["src/about.html", "dist/about/index.html", "/about/"],
  ["src/404.html", "dist/404.html", "/404"],
]) {
  let html = readFileSync(source, "utf8");
  for (const q of ["q1", "q2", "q3"])
    html = html.replace(
      `{{${q.toUpperCase()}}}`,
      [
        ["yes", "Yes"],
        ["no", "No"],
        ["unsure", "Not sure"],
      ]
        .map(
          ([value, label]) =>
            `<label class="choice"><input type="radio" name="${q}" value="${value}" aria-describedby="${q}-error"><span>${label}</span></label>`,
        )
        .join(""),
    );
  html = html
    .replace("{{METER}}", "<i></i>".repeat(10))
    .replaceAll("{{DATA_DATE}}", `Data updated ${date(manifest.dataTime)}`)
    .replaceAll("{{CONTENT_DATE}}", "8 Oct 2026")
    .replace(
      "{{PULSE_UPDATED}}",
      `Snapshot · ${shortDate(pulse.end)}, ${clock(pulse.end)} UTC`,
    )
    .replace(
      "{{PULSE_META}}",
      `Updated ${date(pulse.end)} at ${clock(pulse.end)} UTC · Block ${number(manifest.lastBlock)}`,
    )
    .replace(
      "{{PULSE_DATA}}",
      escape(
        JSON.stringify({
          start: pulse.start,
          end: pulse.end,
          bins: pulse.bins,
        }),
      ),
    )
    .replace("{{PULSE_MAX}}", String(pulse.bins.length - 1))
    .replace("{{PULSE_SELECTED}}", String(selected))
    .replace(
      "{{PULSE_SUMMARY}}",
      `${number(pulse.depositCount)} deposits and ${number(pulse.withdrawalCount)} withdrawals from ${shortDate(pulse.start)} to ${date(pulse.end)}, grouped by UTC hour. ${eth(pulse.depositWei)} ETH shielded and ${eth(pulse.withdrawalWei)} ETH unshielded.`,
    )
    .replace("{{PULSE_DEPOSITS}}", number(pulse.depositCount))
    .replace("{{PULSE_WITHDRAWALS}}", number(pulse.withdrawalCount))
    .replace("{{PULSE_DEPOSIT_ETH}}", total(pulse.depositWei))
    .replace("{{PULSE_WITHDRAWAL_ETH}}", total(pulse.withdrawalWei))
    .replace("{{PULSE_DAY}}", shortDate(latest.start))
    .replace(
      "{{PULSE_TIME}}",
      `${clock(latest.start)}–${clock(latest.end)} UTC`,
    )
    .replace("{{PULSE_HOUR_DEPOSITS}}", number(latest.deposits))
    .replace("{{PULSE_HOUR_WITHDRAWALS}}", number(latest.withdrawals))
    .replace("{{PULSE_HOUR_DEPOSIT_ETH}}", eth(latest.depositWei))
    .replace("{{PULSE_HOUR_WITHDRAWAL_ETH}}", eth(latest.withdrawalWei));
  if (sourceURL)
    html = html.replaceAll(
      'href="https://github.com/ddddubbby/railcheck"',
      `href="${escape(sourceURL)}"`,
    );
  let metadata = "";
  if (origin && path !== "/404") {
    const title = html.match(/<title>(.*?)<\/title>/)[1];
    const description = html.match(
      /<meta\s+name="description"\s+content="([^"]+)"\s*\/?>/,
    )[1];
    const url = `${origin}${path}`;
    metadata += `<link rel="canonical" href="${escape(url)}"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${description}"><meta property="og:url" content="${escape(url)}"><meta property="og:type" content="website"><meta property="og:image" content="${escape(origin + "/og.png")}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${escape(origin + "/og.png")}"><meta name="twitter:title" content="${escape(title)}"><meta name="twitter:description" content="${description}">`;
    if (path === "/")
      metadata += `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "WebApplication", name: "railcheck", url, description: "Check if a RAILGUN withdrawal amount points to a deposit. All calculation runs on your device.", applicationCategory: "FinanceApplication", operatingSystem: "Web", offers: { "@type": "Offer", price: "0", priceCurrency: "USD" }, isAccessibleForFree: true, license: "https://opensource.org/license/mit/" }).replace(/</g, "\\u003c")}</script>`;
  } else metadata = '<meta name="robots" content="noindex, nofollow">';
  html = html.replace("</head>", `${metadata}</head>`);
  writeFileSync(destination, html);
  if (path !== "/404") {
    const body = html
      .replace(/<head>[\s\S]*?<\/head>/, "")
      .replace(/<header>[\s\S]*?<\/header>/, "")
      .replace(/<footer>[\s\S]*?<\/footer>/, "")
      .replace(/<noscript>[\s\S]*?<\/noscript>/g, "")
      .replace(/<h1[^>]*>/g, "\n# ")
      .replace(/<h2[^>]*>/g, "\n## ")
      .replace(/<h3[^>]*>/g, "\n### ")
      .replace(/<summary[^>]*>/g, "\n### ")
      .replace(/<li[^>]*>/g, "\n- ")
      .replace(/<\/(?:p|h1|h2|h3|summary|section|fieldset|tr)>/g, "\n\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/ {2,}/g, " ")
      .replace(/\n\s*\n\s*\n/g, "\n\n")
      .trim();
    writeFileSync(destination.replace(/\.html$/, ".md"), body + "\n");
  }
}
if (origin) {
  writeFileSync(
    "dist/robots.txt",
    `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
  );
  writeFileSync(
    "dist/sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["/", "/about/"].map((path) => `<url><loc>${escape(origin + path)}</loc><lastmod>2026-10-08</lastmod></url>`).join("")}</urlset>\n`,
  );
} else writeFileSync("dist/robots.txt", "User-agent: *\nDisallow: /\n");
const prefix = origin || "";
writeFileSync(
  "dist/llms.txt",
  `# railcheck\n\nrailcheck compares a planned RAILGUN ETH withdrawal on Ethereum with deposits of the last 180 days. The check runs in the browser. It collects no amounts or addresses.\n\n- [Check](${prefix}/index.md)\n- [About](${prefix}/about/index.md)\n- [Pool manifest](${prefix}/data/manifest.json)\n`,
);
await import("./archive.mjs");
console.log(
  `Built static railcheck with ${manifest.count} deposits (${date(manifest.dataTime)}).`,
);
if (!origin)
  console.log(
    "SITE_URL is not configured. Local/preview pages stay unindexed; production metadata will be generated when it is set.",
  );
