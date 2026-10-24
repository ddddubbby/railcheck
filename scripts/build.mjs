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
import {
  readPage,
  toMarkdown,
  toHtml,
  renderPage,
  header,
  footer,
} from "./lib/pages.mjs";
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
if (manifest.demo || manifest.chainId !== 1 || manifest.token !== "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2")
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
const source = sourceURL || "https://github.com/ddddubbby/railcheck";
// Unpublished blocks in the Markdown sources stay out of every output.
const flags = { mcp: process.env.PUBLISH_MCP === "1" };
// The check page copy date. Change it only when the copy of / changes.
const HOME_UPDATED = "2026-10-17";
const SITE = "https://railcheck.xyz";
const org = {
  "@type": "Organization",
  "@id": `${SITE}/#org`,
  name: "railcheck",
  url: `${SITE}/`,
  sameAs: ["https://github.com/ddddubbby/railcheck"],
};
const site = {
  "@type": "WebSite",
  "@id": `${SITE}/#site`,
  name: "railcheck",
  url: `${SITE}/`,
  publisher: { "@id": `${SITE}/#org` },
};
const app = {
  "@type": "WebApplication",
  "@id": `${SITE}/#app`,
  name: "railcheck",
  url: `${SITE}/`,
  description:
    "Check if a RAILGUN shield or unshield amount can link back to you. The check runs on your device.",
  applicationCategory: "FinanceApplication",
  operatingSystem: "Web",
  isPartOf: { "@id": `${SITE}/#site` },
  publisher: { "@id": `${SITE}/#org` },
  featureList: [
    "Checks a planned shield or unshield amount against RAILGUN WETH shields on Ethereum from the last 180 days",
    "Looks for sets of 1, 2 or 3 shields that add up to an unshield amount",
    "Gives a risk score from 0 to 100 and a safer amount when one exists",
    "Runs in the browser with no wallet connection and no address input",
  ],
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  isAccessibleForFree: true,
  license: "https://opensource.org/license/mit/",
};
const jsonld = (graph) =>
  `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c")}</script>`;
const TEXT_PAGES = [
  {
    file: "src/how-it-works.md",
    path: "/how-it-works/",
    jsonld: (meta) => [{
      "@type": "TechArticle",
      "@id": `${SITE}/how-it-works/#method`,
      headline: meta.title,
      description: meta.description,
      dateModified: meta.updated,
      about: [{ "@id": `${SITE}/#app` }, { "@id": `${SITE}/#sdk` }],
      isPartOf: { "@id": `${SITE}/#site` },
      publisher: { "@id": `${SITE}/#org` },
    }],
  },
  {
    file: "src/docs.md",
    path: "/docs/",
    tools: {
      version: "Preview 0.1.0",
      issues: "https://github.com/ddddubbby/railcheck/issues",
    },
    jsonld: (meta) => [
      {
        "@type": "SoftwareSourceCode",
        "@id": `${SITE}/#sdk`,
        name: "railcheck wallet SDK",
        description:
          "Local privacy advice for RAILGUN shields and unshields. Wallets build the pool from their own RPC. No data goes to railcheck.",
        codeRepository: "https://github.com/ddddubbby/railcheck",
        programmingLanguage: "JavaScript",
        runtimePlatform: "Node.js 22",
        license: "https://opensource.org/license/mit/",
        isAccessibleForFree: true,
        publisher: { "@id": `${SITE}/#org` },
        hasPart: ["@railcheck/core", "@railcheck/builder", "@railcheck/kohaku"].map(
          (name) => ({ "@type": "SoftwareSourceCode", name }),
        ),
      },
      {
        "@type": "TechArticle",
        "@id": `${SITE}/docs/#docs`,
        headline: meta.title,
        description: meta.description,
        dateModified: meta.updated,
        about: { "@id": `${SITE}/#sdk` },
        isPartOf: { "@id": `${SITE}/#site` },
        publisher: { "@id": `${SITE}/#org` },
      },
    ],
  },
];
/** Canonical, Open Graph and Twitter tags, or noindex when there is no origin. */
function withMetadata(html, path) {
  let metadata = "";
  if (origin && path !== "/404") {
    const title = html.match(/<title>(.*?)<\/title>/)[1];
    const description = html.match(
      /<meta\s+name="description"\s+content="([^"]+)"\s*\/?>/,
    )[1];
    const url = `${origin}${path}`;
    metadata += `<link rel="canonical" href="${escape(url)}"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:url" content="${escape(url)}"><meta property="og:type" content="website"><meta property="og:image" content="${escape(origin + "/og.png")}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${escape(origin + "/og.png")}"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${description}">`;
  } else metadata = '<meta name="robots" content="noindex, nofollow">';
  return html.replace("</head>", `${metadata}</head>`);
}
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("public", "dist", { recursive: true });
cpSync("lib", "dist/lib", { recursive: true });
cpSync("src/style.css", "dist/style.css");
for (const [file, destination, path] of [
  ["src/index.html", "dist/index.html", "/"],
  ["src/404.html", "dist/404.html", "/404"],
]) {
  let html = readFileSync(file, "utf8")
    .replace("{{JSONLD}}", jsonld([org, site, app]))
    .replace("{{HEADER}}", header(path))
    .replace(
      "{{FOOTER}}",
      footer(source, path === "/" ? `Data updated ${date(manifest.dataTime)}` : ""),
    );
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
    .replace(
      "{{PULSE_UPDATED}}",
      `Snapshot · ${shortDate(pulse.end)}, ${clock(pulse.end)} UTC · Block ${number(manifest.lastBlock)}`,
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
      `${number(pulse.depositCount)} shields and ${number(pulse.withdrawalCount)} unshields from ${shortDate(pulse.start)} to ${date(pulse.end)}, grouped by UTC hour. ${eth(pulse.depositWei)} ETH shielded and ${eth(pulse.withdrawalWei)} ETH unshielded.`,
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
  html = withMetadata(html, path);
  writeFileSync(destination, html);
}
cpSync("src/index.md", "dist/index.md");
const markdown = { "/": readFileSync("src/index.md", "utf8") };
const updated = { "/": HOME_UPDATED };
for (const page of TEXT_PAGES) {
  const parsed = readPage(readFileSync(page.file, "utf8"), flags);
  const { html, toc } = toHtml(parsed);
  const dir = `dist${page.path}`;
  mkdirSync(dir, { recursive: true });
  const published = toMarkdown(parsed);
  writeFileSync(`dist${page.path.replace(/\/$/, "")}.md`, published);
  writeFileSync(`${dir}index.md`, published);
  writeFileSync(
    `${dir}index.html`,
    withMetadata(
      renderPage({
        path: page.path,
        meta: parsed.meta,
        html,
        toc,
        sourceURL: source,
        jsonld: {
          "@context": "https://schema.org",
          "@graph": [org, site, ...page.jsonld(parsed.meta)],
        },
        tools: page.tools,
      }),
      page.path,
    ),
  );
  updated[page.path] = parsed.meta.updated;
  markdown[page.path] = published;
}
if (origin) {
  writeFileSync(
    "dist/robots.txt",
    `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
  );
  writeFileSync(
    "dist/sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Object.entries(updated).map(([path, day]) => `<url><loc>${escape(origin + path)}</loc><lastmod>${day}</lastmod></url>`).join("")}</urlset>\n`,
  );
} else writeFileSync("dist/robots.txt", "User-agent: *\nDisallow: /\n");
const prefix = origin || "";
// llms.txt follows the community proposal: H1, block-quote summary, link sections.
writeFileSync(
  "dist/llms.txt",
  `# railcheck

> Local privacy advice for RAILGUN shields and unshields on Ethereum. railcheck tells a user if an amount can link a shield to an unshield. It runs on the device and never asks for an address.

railcheck has two parts: a web check for users, and a wallet SDK (\`@railcheck/core\`, \`@railcheck/builder\`, \`@railcheck/kohaku\`). This preview covers RAILGUN WETH on Ethereum mainnet and Sepolia.

## Docs

- [How it works](${prefix}/how-it-works.md): how railcheck makes the score, which data it uses, what stays private, and its limits.
- [For wallets](${prefix}/docs.md): how to build the pool from your own RPC, get advice with \`plan()\`, use the Kohaku adapter, and read each result field.
- [Check](${prefix}/index.md): what the web check asks and what it gives.

## Instructions for agents

- Ask the user for missing inputs. Do not guess the answers to the three questions. If the user does not know, send "not sure" (\`undefined\`).
- Never show the status \`not-checked\` as \`clear\`.
- A Low score does not guarantee privacy. Say this when you give a result.
- Do not give addresses to railcheck. The check does not use them.

## Optional

- [All pages in one file](${prefix}/llms-full.txt)
- [Source code](https://github.com/ddddubbby/railcheck): MIT license.
`,
);
writeFileSync(
  "dist/llms-full.txt",
  ["/", "/how-it-works/", "/docs/"]
    .map((path) => `<!-- ${prefix}${path} -->\n\n${markdown[path].trim()}\n`)
    .join("\n---\n\n"),
);
await import("./archive.mjs");
console.log(
  `Built static railcheck with ${manifest.publicCount ?? manifest.count} public shields (${date(manifest.dataTime)}).`,
);
if (!origin)
  console.log(
    "SITE_URL is not configured. Local/preview pages stay unindexed; production metadata will be generated when it is set.",
  );
