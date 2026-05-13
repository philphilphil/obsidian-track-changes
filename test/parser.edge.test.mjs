// Edge-case tests for the parser. Run with: node test/parser.edge.test.mjs

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = await build({
  entryPoints: [resolve(__dirname, "../src/parser.ts")],
  bundle: true,
  format: "esm",
  target: "es2018",
  write: false,
  platform: "neutral",
});
const code = out.outputFiles[0].text;
const mod = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const { parse, threadAtOffset, nodeAtOffset, contextSnippet } = mod;

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

console.log("parser.edge:");

test("empty comment body {>><<}", () => {
  const r = parse("{>><<}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "comment");
  assert.equal(r.nodes[0].text, "");
  assert.equal(r.nodes[0].authorName, null);
});

test("empty addition body {++++}", () => {
  const r = parse("{++++}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "addition");
  assert.equal(r.nodes[0].text, "");
});

test("empty deletion body {----}", () => {
  const r = parse("{----}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "deletion");
  assert.equal(r.nodes[0].text, "");
});

test("empty substitution body {~~~>~~}", () => {
  const r = parse("{~~~>~~}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "substitution");
  assert.equal(r.nodes[0].oldText, "");
  assert.equal(r.nodes[0].newText, "");
});

test("empty highlight body {====}", () => {
  const r = parse("{====}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "highlight");
  assert.equal(r.nodes[0].text, "");
});

test("multi-line addition body parses as one node", () => {
  const src = "{++line1\nline2++}";
  const r = parse(src);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "addition");
  assert.equal(r.nodes[0].text, "line1\nline2");
  assert.equal(r.nodes[0].from, 0);
  assert.equal(r.nodes[0].to, src.length);
});

test("multiple additions on one line parsed in document order", () => {
  const src = "a {++x++} b {++y++} c";
  const r = parse(src);
  assert.equal(r.nodes.length, 2);
  assert.equal(r.nodes[0].kind, "addition");
  assert.equal(r.nodes[0].text, "x");
  assert.equal(r.nodes[1].kind, "addition");
  assert.equal(r.nodes[1].text, "y");
  assert.ok(r.nodes[0].from < r.nodes[1].from);
});

test("substitution containing '++' inside is not confused with addition", () => {
  const src = "{~~has++plus~>fine~~}";
  const r = parse(src);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "substitution");
  assert.equal(r.nodes[0].oldText, "has++plus");
  assert.equal(r.nodes[0].newText, "fine");
});

test("adjacent comments with multi-space (no newline) are one thread", () => {
  const r = parse("{>>a<<}   {>>b<<}");
  assert.equal(r.threads.length, 1);
  assert.equal(r.threads[0].replyIndexes.length, 1);
});

test("adjacent comments separated by newline are two threads", () => {
  const r = parse("{>>a<<}\n{>>b<<}");
  assert.equal(r.threads.length, 2);
  assert.equal(r.threads[0].replyIndexes.length, 0);
  assert.equal(r.threads[1].replyIndexes.length, 0);
});

test("long thread: root + 3 replies all adjacent", () => {
  const src = "x {>>Claude: root<<}{>>reply1<<}{>>reply2<<}{>>Claude: reply3<<} y";
  const r = parse(src);
  assert.equal(r.threads.length, 1);
  const t = r.threads[0];
  assert.equal(t.replyIndexes.length, 3);
  // root range starts at the first {>>, ends after the last <<}
  assert.equal(src.slice(t.from, t.to),
    "{>>Claude: root<<}{>>reply1<<}{>>reply2<<}{>>Claude: reply3<<}");
  // all four comments belong to the same thread
  assert.equal(r.nodeThread[0], 0);
  assert.equal(r.nodeThread[1], 0);
  assert.equal(r.nodeThread[2], 0);
  assert.equal(r.nodeThread[3], 0);
});

test("substitution where new text contains '~>' literally", () => {
  // Behavior: regex is non-greedy on both old and new. The old matches the
  // shortest leading text before the first '~>'. New then expands non-greedily
  // until the terminating '~~}' is found — so new ends up being "new ~> arrow".
  const src = "{~~old~>new ~> arrow~~}";
  const r = parse(src);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "substitution");
  assert.equal(r.nodes[0].oldText, "old");
  assert.equal(r.nodes[0].newText, "new ~> arrow");
});

test("threadAtOffset returns -1 for position outside any thread", () => {
  const src = "plain text with {>>note<<} markup";
  const r = parse(src);
  assert.equal(threadAtOffset(r, 0), -1);
  assert.equal(threadAtOffset(r, src.length - 1), -1);
  // inside the comment should find thread 0
  const inside = src.indexOf("{>>") + 1;
  assert.equal(threadAtOffset(r, inside), 0);
});

test("nodeAtOffset returns -1 for position outside any node", () => {
  const src = "before {++ins++} after";
  const r = parse(src);
  assert.equal(nodeAtOffset(r, 0), -1);
  assert.equal(nodeAtOffset(r, src.length - 1), -1);
  const inside = src.indexOf("{++") + 1;
  assert.equal(nodeAtOffset(r, inside), 0);
});

test("contextSnippet clamps at start: no leading ellipsis, trailing ellipsis when clipped", () => {
  const src = "abc " + "x".repeat(200);
  // range at very start, small radius so trailing side is clipped
  const snip = contextSnippet(src, 0, 3, 10);
  assert.ok(!snip.startsWith("…"), "should not have leading ellipsis at doc start");
  assert.ok(snip.endsWith("…"), "should have trailing ellipsis when right side clipped");
});

test("contextSnippet clamps at end: no trailing ellipsis, leading ellipsis when clipped", () => {
  const src = "x".repeat(200) + " end";
  const from = src.length - 3;
  const to = src.length;
  const snip = contextSnippet(src, from, to, 10);
  assert.ok(snip.startsWith("…"), "should have leading ellipsis when left side clipped");
  assert.ok(!snip.endsWith("…"), "should not have trailing ellipsis at doc end");
});

test("contextSnippet adds both ellipses when clipped both sides", () => {
  const src = "x".repeat(500);
  const snip = contextSnippet(src, 200, 210, 10);
  assert.ok(snip.startsWith("…"));
  assert.ok(snip.endsWith("…"));
});

test("contextSnippet adds no ellipsis when whole doc fits in radius", () => {
  const src = "hello world";
  const snip = contextSnippet(src, 0, src.length, 40);
  assert.ok(!snip.startsWith("…"));
  assert.ok(!snip.endsWith("…"));
});

test("markup inside fenced code block is not parsed", () => {
  const src = "before\n```\n{++not a real addition++}\n```\nafter {++real++}";
  const r = parse(src);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].text, "real");
});

test("markup inside inline code span is not parsed", () => {
  const src = "literal `{++foo++}` versus real {++bar++}";
  const r = parse(src);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].text, "bar");
});

test("skipCode option can be disabled to recover legacy behavior", () => {
  const src = "before\n```\n{++inside++}\n```\nafter";
  const r = parse(src, { skipCode: false });
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].text, "inside");
});

console.log("done.");
