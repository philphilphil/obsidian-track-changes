// Tests for the native-markup leak ranges. Run with: node test/native-leak.test.mjs
//
// Spans mirror what Obsidian's syntax tree produced for synthetic repro notes
// (one ~4,000-char paragraph): the native `==` highlight hijacked by a
// CriticMarkup `{==…==}` and left running to the paragraph end.

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = await build({
  entryPoints: [resolve(__dirname, "../src/editor/native-leak.ts")],
  bundle: true,
  format: "esm",
  target: "es2018",
  write: false,
  platform: "node",
});
const code = out.outputFiles[0].text;
const { leakRanges, markedParagraphs, collectRuns } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));

function test(name, fn) {
  try {
    fn();
    console.log("  ok  -", name);
  } catch (err) {
    console.error("  FAIL -", name);
    console.error(err);
    process.exitCode = 1;
  }
}

// In these cases every mark is a highlight, so marks and keep coincide.
const hl = (runs, marks) => leakRanges(runs, marks, marks);

test("well-formed: native run inside the mark leaks nothing", () => {
  assert.deepEqual(hl([[1733, 1756]], [[1699, 1757]]), []);
});

test("URL in the anchor swallows ==}: tail after the mark is a leak", () => {
  assert.deepEqual(hl([[1738, 4643]], [[1704, 1768]]), [[1768, 4643]]);
});

test("a==b before the mark: prose before and the tail after both leak", () => {
  assert.deepEqual(hl([[1718, 1764, true], [1783, 4661, false]], [[1728, 1786]]), [[1718, 1728], [1786, 4661]]);
});

test("genuine native highlight that touches no mark is left alone", () => {
  assert.deepEqual(hl([[10, 20], [50, 60]], [[30, 40]]), []);
});

test("leak spanning two highlight marks is split around both", () => {
  // Opened by the first mark's sigil, runs past the second.
  assert.deepEqual(hl([[12, 100]], [[10, 20], [40, 50]]), [[20, 40], [50, 100]]);
});

test("addition body inside a leaked run is cleared too (only highlights keep)", () => {
  // highlight mark [10,20], addition mark [40,50]; the run escapes the highlight.
  assert.deepEqual(leakRanges([[12, 100]], [[10, 20], [40, 50]], [[10, 20]]), [[20, 100]]);
});

test("a native run staying inside one non-keep mark is not a leak", () => {
  // `{++some ==x== text++}`: Obsidian closes inside the addition.
  assert.deepEqual(leakRanges([[15, 22]], [[10, 40]], []), []);
});

test("an unclosed run that stops inside a mark is not a leak", () => {
  // `~~before {++added++}` at a paragraph end, or a partial tree's frontier.
  assert.deepEqual(leakRanges([[0, 30, false]], [[10, 30]], []), []);
  // With a real closer inside the mark it is one (the mark's sigil closed it);
  // nothing is kept for a non-keep mark, so the whole run is cleared.
  assert.deepEqual(leakRanges([[0, 30, true]], [[10, 30]], []), [[0, 30]]);
});

test("a genuine native run wrapping a mark is left alone", () => {
  // `~~before {++added++} after~~`: opened and closed in prose.
  assert.deepEqual(leakRanges([[0, 40, true]], [[10, 25]], []), []);
});

test("a run that starts inside a mark and wraps a later one is cleared", () => {
  assert.deepEqual(leakRanges([[12, 100]], [[10, 20], [40, 50]], [[10, 20]]), [[20, 100]]);
});

// Token fixtures shaped like Obsidian's stream tokens.
const O = "formatting_formatting-highlight_highlight";
const C = "formatting_formatting-highlight_formatting-highlight-end_highlight";
const tok = (name, from, to) => ({ name, from, to });

test("collectRuns: contiguous tokens form one run, closer ends it", () => {
  const src = "==ab== ==cd==";
  const t = [tok(O, 0, 2), tok("highlight", 2, 4), tok(C, 4, 6), tok(O, 7, 9), tok("highlight", 9, 11), tok(C, 11, 13)];
  assert.deepEqual(collectRuns(t, src, "highlight"), [[0, 6, true], [7, 13, true]]);
});

test("collectRuns: an open run continues across a soft line break (LF and CRLF)", () => {
  for (const nl of ["\n", "\r\n"]) {
    const src = "==ab" + nl + "cd";
    const t = [tok(O, 0, 2), tok("highlight", 2, 4), tok("highlight", 4 + nl.length, 6 + nl.length)];
    assert.deepEqual(collectRuns(t, src, "highlight"), [[0, 6 + nl.length, false]]);
  }
});

test("collectRuns: a run closed at a line end does not absorb a fresh one", () => {
  const src = "a==b tail==\n==genuine==";
  const t = [tok(O, 1, 3), tok("highlight", 3, 9), tok(C, 9, 11), tok(O, 12, 14), tok("highlight", 14, 21), tok(C, 21, 23)];
  assert.deepEqual(collectRuns(t, src, "highlight"), [[1, 11, true], [12, 23, true]]);
});

test("collectRuns: an opener right after an unclosed line still starts a new run", () => {
  const src = "==ab\n==cd==";
  const t = [tok(O, 0, 2), tok("highlight", 2, 4), tok(O, 5, 7), tok("highlight", 7, 9), tok(C, 9, 11)];
  assert.deepEqual(collectRuns(t, src, "highlight"), [[0, 4, false], [5, 11, true]]);
});

test("collectRuns: a plain space or blank line never joins", () => {
  const src = "==ab x\n\ncd";
  const t = [tok(O, 0, 2), tok("highlight", 2, 4), tok("highlight", 5, 6), tok("highlight", 8, 10)];
  assert.deepEqual(collectRuns(t, src, "highlight"), [[0, 4, false], [5, 6, false], [8, 10, false]]);
});

test("collectRuns: a dual-class token counts for both kinds; other kinds are ignored", () => {
  const src = "~~==ab==~~";
  const t = [
    tok("formatting_formatting-strikethrough_strikethrough", 0, 2),
    tok("formatting_formatting-highlight_highlight_strikethrough", 2, 4),
    tok("highlight_strikethrough", 4, 6),
    tok("formatting_formatting-highlight_formatting-highlight-end_highlight_strikethrough", 6, 8),
    tok("formatting_formatting-strikethrough_formatting-strikethrough-end_strikethrough", 8, 10),
  ];
  assert.deepEqual(collectRuns(t, src, "highlight"), [[2, 8, true]]);
  assert.deepEqual(collectRuns(t, src, "strikethrough"), [[0, 10, true]]);
});

test("markedParagraphs: only paragraphs holding a mark, one per paragraph", () => {
  const src = "alpha {==x==} beta {>>c<<}\n\nplain\n\ngamma {++y++}";
  const a = src.indexOf("{=="), c = src.indexOf("{>>"), y = src.indexOf("{++");
  const marks = [[a, a + 7], [c, c + 7], [y, y + 7]];
  assert.deepEqual(markedParagraphs(src, marks), [[0, src.indexOf("\n\n")], [src.lastIndexOf("\n\n") + 2, src.length]]);
});

test("markedParagraphs: a mark spanning paragraphs covers all of them", () => {
  const src = "{++First paragraph.\n\nSecond paragraph a==b++} prose.\n\nThird.";
  const to = src.indexOf("++}") + 3;
  assert.deepEqual(markedParagraphs(src, [[0, to]]), [[0, src.lastIndexOf("\n\n")]]);
});

test("markedParagraphs: blank line with spaces/tabs separates paragraphs", () => {
  const src = "a {--x--}\n \t\nb";
  assert.deepEqual(markedParagraphs(src, [[2, 9]]), [[0, 9]]);
});

// Reference: the obvious quadratic version the sweep must agree with.
function naiveLeaks(runs, marks, keep) {
  const out = [];
  for (const [a, b, closed] of runs) {
    if (!marks.some(([f, t]) => f < b && t > a)) continue;
    if (marks.some(([f, t]) => f <= a && t >= b)) continue;
    const startsInside = marks.some(([f, t]) => f <= a && a < t);
    const endsInside = closed && marks.some(([f, t]) => f < b && b <= t);
    if (!startsInside && !endsInside) continue;
    let pieces = [[a, b]];
    for (const [f, t] of keep) {
      pieces = pieces.flatMap(([x, y]) => [
        ...(x < f ? [[x, Math.min(y, f)]] : []),
        ...(y > t ? [[Math.max(x, t), y]] : []),
      ]);
    }
    out.push(...pieces.filter(([x, y]) => y > x));
  }
  return out.sort((p, q) => p[0] - q[0]);
}

// Sorted, non-overlapping random spans over [0, len).
function randomSpans(rand, len, n) {
  const cuts = Array.from({ length: 2 * n }, () => Math.floor(rand() * len)).sort((x, y) => x - y);
  const spans = [];
  for (let i = 0; i + 1 < cuts.length; i += 2) if (cuts[i + 1] > cuts[i]) spans.push([cuts[i], cuts[i + 1]]);
  return spans.filter((s, i) => i === 0 || s[0] >= spans[i - 1][1]);
}

test("sweep agrees with the naive version on random inputs", () => {
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 1000; i++) {
    const runs = randomSpans(rand, 300, 1 + Math.floor(rand() * 8)).map(([a, b]) => [a, b, rand() < 0.5]);
    const marks = randomSpans(rand, 300, 1 + Math.floor(rand() * 8));
    const keep = marks.filter(() => rand() < 0.5);
    assert.deepEqual(leakRanges(runs, marks, keep), naiveLeaks(runs, marks, keep), JSON.stringify({ runs, marks, keep }));
  }
});

test("large document: 20k runs and marks stay fast", () => {
  const runs = [], marks = [];
  for (let i = 0; i < 20000; i++) {
    marks.push([i * 100, i * 100 + 30]);
    runs.push([i * 100 + 10, i * 100 + 60]);
  }
  const t0 = Date.now();
  const leaks = leakRanges(runs, marks, marks);
  assert.equal(leaks.length, 20000);
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0}ms`);
});
