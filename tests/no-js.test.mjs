import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("src/index.html", "utf8");
const css = readFileSync("src/style.css", "utf8");
const flow = readFileSync("public/flow.mjs", "utf8");

test("no-JavaScript users get a message instead of a dead form", () => {
  assert.match(html, /<html lang="en" class="no-js">/);
  const start = html.indexOf("<noscript>");
  const end = html.indexOf("</noscript>");
  assert.ok(start >= 0 && end > start, "the noscript block exists");
  assert.ok(html.slice(start, end).includes("This check needs JavaScript"));
  assert.ok(start < html.indexOf('id="flow-form"'), "the message comes before the form");
  assert.ok(css.includes("html.no-js #flow-form"));
  assert.ok(css.includes("html.no-js #progress"));
  assert.ok(flow.includes('classList.remove("no-js")'));
});

test("decorative step numbers stay out of accessible names", () => {
  for (const n of ["1", "2", "3"])
    assert.ok(html.includes(`<span class="step-number" aria-hidden="true">${n}</span>`));
});

test("matching shields show open, right under the score pixels", () => {
  const readout = html.indexOf('id="readout"'),
    crowd = html.indexOf('id="crowd"'),
    matches = html.indexOf('id="matches"'),
    copy = html.indexOf('id="result-copy"');
  assert.ok(readout >= 0 && readout < crowd && crowd < matches && matches < copy, "the matches follow the meter and the pixel crowd");
  assert.ok(!/<details[^>]*>[^]*id="matches"/.test(html), "the matches are not collapsed");
  assert.ok(!/details\.append\(matchTable/.test(flow), "the match table stays out of Details");
  assert.ok(flow.includes("matches(lastSets)"));
});
