import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// UI-R4 / UI-7: form ≤ 60 words; result first level ≤ 25 (numbers not counted).
const FORM_BUDGET = 60;
const RESULT_BUDGET = 25;

const html = readFileSync("src/index.html", "utf8");
const flow = readFileSync("public/flow.mjs", "utf8");

function stripTags(source) {
  return source
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removeElements(html, attrPattern) {
  const re = new RegExp(`<(?<tag>[a-zA-Z0-9]+)([^>]*${attrPattern}[^>]*)>`, "gi");
  let out = html;
  let match;
  while ((match = re.exec(out))) {
    const tag = match.groups.tag;
    const start = match.index;
    const openEnd = match.index + match[0].length;
    const close = new RegExp(`</${tag}\\s*>`, "i");
    let depth = 1,
      i = openEnd;
    while (depth && i < out.length) {
      const nextOpen = out.slice(i).search(new RegExp(`<${tag}\\b[^>]*>`, "i"));
      const nextClose = out.slice(i).search(close);
      if (nextClose < 0) break;
      if (nextOpen >= 0 && nextOpen < nextClose) {
        depth++;
        i += nextOpen + 1;
        continue;
      }
      depth--;
      if (!depth) {
        const end = i + nextClose + out.slice(i).match(close)[0].length;
        out = out.slice(0, start) + " " + out.slice(end);
        re.lastIndex = 0;
        break;
      }
      i += nextClose + 1;
    }
  }
  return out;
}

// Drop elements that are not visible on the default form (errors, fee hint, status).
function visibleFormHtml(source) {
  const start = source.indexOf('id="flow-form"');
  const open = source.lastIndexOf("<form", start);
  const end = source.indexOf("</form>", start);
  assert.ok(open >= 0 && end > open, "form markup exists");
  let form = source.slice(open, end + "</form>".length);
  form = removeElements(form, String.raw`\bhidden\b`);
  form = removeElements(form, String.raw`aria-hidden="true"`);
  form = form.replace(/\{\{[^}]+\}\}/g, "Yes No Not sure");
  return form;
}

function words(text, { skipNumbers = false } = {}) {
  const tokens = text.match(/[A-Za-z][A-Za-z']*/g) || [];
  if (!skipNumbers) return tokens;
  // Pure numeric tokens are already excluded; also drop score-like leftovers.
  return tokens.filter((w) => !/^\d/.test(w));
}

function stringLiterals(source) {
  const out = [];
  const re = /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let match;
  while ((match = re.exec(source))) out.push(match[2].replace(/\\n/g, " "));
  return out;
}

test("form visible words stay within the UI-R4 budget", () => {
  const text = stripTags(visibleFormHtml(html));
  const count = words(text).length;
  assert.ok(
    count <= FORM_BUDGET,
    `form has ${count} words (budget ${FORM_BUDGET}): ${text}`,
  );
});

test("result first-level copy stays within the UI-R4 budget", () => {
  const render = flow.slice(flow.indexOf("function render("), flow.indexOf("function matches("));
  const headline = flow.slice(flow.indexOf("function headline("), flow.indexOf("function render("));
  // First-level strings: headline() verdicts and text pushed to `parts` (not `notes` / details).
  const verdicts = stringLiterals(headline).filter((s) => /[.]$/.test(s.trim()));
  const firstLevel = [];
  for (const line of render.split("\n")) {
    if (line.includes('el("summary"') || line.includes("details.append(")) break;
    if (!/\bparts\.push\b/.test(line) && !/el\("p"/.test(line) && !/el\("button"/.test(line)) continue;
    if (/\bnotes\.(push|unshift)\b/.test(line)) continue;
    for (const s of stringLiterals(line)) {
      if (["p", "button", "verdict", "secondary", "hint", "details", "summary"].includes(s)) continue;
      if (s.includes("What does this mean")) continue;
      firstLevel.push(s);
    }
  }
  assert.ok(verdicts.length >= 5, `headline covers the main statuses (${verdicts.length})`);
  assert.ok(
    firstLevel.some((s) => s.includes("Use a new address")),
    "address-link action stays on the first level",
  );
  assert.ok(
    firstLevel.some((s) => s.includes("No Low amount in range")),
    "empty-alternative message stays on the first level",
  );
  const scenarios = [
    ...verdicts.map((v) => [v]),
    ...verdicts.map((v) => [v, "Use a new address."]),
    ...verdicts.map((v) => [v, "No Low amount in range."]),
    ...verdicts.map((v) => [v, "Use ETH · scores"]),
  ];
  for (const parts of scenarios) {
    const text = parts.join(" ");
    const count = words(text, { skipNumbers: true }).length;
    assert.ok(
      count <= RESULT_BUDGET,
      `result first level has ${count} words (budget ${RESULT_BUDGET}): ${text}`,
    );
  }
});

test("token chips fail early for unsupported tokens", () => {
  assert.match(html, /name="token"[^>]*value="weth"/);
  assert.match(html, /name="token"[^>]*value="usdc"/);
  assert.match(html, /name="token"[^>]*value="other"/);
  assert.match(html, /Soon/);
  assert.match(html, /Not covered/);
  assert.match(html, /id="chain-tag"[^>]*>Ethereum/);
  assert.ok(flow.includes("covered()"));
  assert.ok(flow.includes('$("amount").disabled'));
  assert.ok(flow.includes("COVERED"));
  assert.ok(flow.includes("usdc: false"));
  assert.ok(flow.includes("other: false"));
  assert.ok(flow.includes("weth: true"));
});
