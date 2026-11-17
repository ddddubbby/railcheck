import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("src/index.html", "utf8");
const css = readFileSync("src/style.css", "utf8");
const flow = readFileSync("public/flow.mjs", "utf8");

test("no-JavaScript users get a message instead of a dead form", () => {
  const start = html.indexOf("<noscript>");
  const end = html.indexOf("</noscript>");
  assert.ok(start >= 0 && end > start, "the noscript block exists");
  assert.ok(html.slice(start, end).includes("This check needs JavaScript"));
  assert.ok(start < html.indexOf('id="flow-form"'), "the message comes before the form");
  // A media query hides the form, so no script has to run first and the
  // header does not shift when one does.
  const noScript = css.slice(css.indexOf("@media (scripting: none)"));
  assert.ok(noScript.length < css.length, "the scripting media query exists");
  assert.match(noScript, /^@media \(scripting: none\) \{\s*#flow-form,\s*#progress,/);
  assert.ok(!/no-js/.test(html + css + flow), "no class has to be removed by a script");
});

test("decorative step numbers stay out of accessible names", () => {
  // Two numbered steps since R1.6: the link questions are an optional panel.
  for (const n of ["1", "2"])
    assert.ok(html.includes(`<span class="step-number" aria-hidden="true">${n}</span>`));
});

test("matching shields show open, right under the score pixels", () => {
  const readout = html.indexOf('id="readout"'),
    crowd = html.indexOf('id="crowd"'),
    matches = html.indexOf('id="matches"'),
    copy = html.indexOf('id="result-copy"');
  assert.ok(readout >= 0 && readout < crowd && crowd < matches && matches < copy, "the matches follow the meter and the pixel crowd");
  assert.ok(!/<details[^>]*>(?:(?!<\/details>)[^])*id="matches"/.test(html), "the matches are not collapsed");
  assert.ok(!/details\.append\(matchTable/.test(flow), "the match table stays out of Details");
  assert.ok(flow.includes("matches(lastSets)"));
});

test("explanations and coverage wait behind \"What does this mean?\"", () => {
  const render = flow.slice(flow.indexOf("function render("), flow.indexOf("function matches("));
  assert.ok(render.includes('el("summary", "What does this mean?")'));
  for (const text of ["Not covered: timing", "Your amount is fixed", "Check again when you unshield", "An observer can link"]) {
    const line = render.split("\n").find((l) => l.includes(text)) || "";
    assert.ok(line && !line.includes("parts.push"), `${text} is not on the first level`);
  }
});
