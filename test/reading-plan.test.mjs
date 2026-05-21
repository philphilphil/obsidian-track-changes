// Unit tests for the pure reading-mode helpers. Run with: node test/reading-plan.test.mjs
//
// The DOM-mutating half of reading.ts can't be tested without a browser,
// but section mapping, intersection, and per-thread icon selection are
// pure functions over the parser output.

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadModule(srcPath) {
  const out = await build({
    entryPoints: [resolve(__dirname, srcPath)],
    bundle: true,
    format: "esm",
    target: "es2018",
    write: false,
    platform: "neutral",
  });
  const code = out.outputFiles[0].text;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const parserMod = await loadModule("../src/parser.ts");
const planMod = await loadModule("../src/reading-plan.ts");

const { parse } = parserMod;
const { sectionCharRange, intersectingOps, commentsToIcon } = planMod;

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

console.log("reading-plan:");

test("sectionCharRange: single line at start", () => {
  const src = "line zero\nline one\nline two";
  assert.deepEqual(sectionCharRange(src, 0, 0), [0, 9]);
});

test("sectionCharRange: middle line", () => {
  const src = "line zero\nline one\nline two";
  // "line one" is offsets 10..18
  assert.deepEqual(sectionCharRange(src, 1, 1), [10, 18]);
});

test("sectionCharRange: multi-line range", () => {
  const src = "a\nb\nc\nd";
  assert.deepEqual(sectionCharRange(src, 1, 2), [2, 5]);
});

test("sectionCharRange: last line without trailing newline", () => {
  const src = "a\nb\nc";
  assert.deepEqual(sectionCharRange(src, 2, 2), [4, 5]);
});

test("intersectingOps: in-section, before, after", () => {
  // Three additions; only the middle one falls in our section.
  const src = "{++a++} prose {++b++} prose {++c++}";
  //          0123456789...
  // a: 0..7, b: 14..21, c: 28..35
  const parsed = parse(src);
  const ops = intersectingOps(parsed, 10, 25);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].node.text, "b");
  assert.equal(ops[0].openIn, true);
  assert.equal(ops[0].closeIn, true);
});

test("intersectingOps: open-only (markup starts in section, ends after)", () => {
  const src = "before {++addition\n\ncontinues here++} after";
  // Find the addition's start/end
  const parsed = parse(src);
  const addn = parsed.nodes.find((n) => n.kind === "addition");
  assert.ok(addn, "should have addition");
  // Section covers only the first line.
  const firstLineEnd = src.indexOf("\n");
  const ops = intersectingOps(parsed, 0, firstLineEnd);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].openIn, true);
  assert.equal(ops[0].closeIn, false);
});

test("intersectingOps: close-only (markup ends in section)", () => {
  const src = "before {++addition\n\ncontinues here++} after";
  const parsed = parse(src);
  // Section covers only the third line (after the blank).
  const thirdLineStart = src.indexOf("continues");
  const ops = intersectingOps(parsed, thirdLineStart, src.length);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].openIn, false);
  assert.equal(ops[0].closeIn, true);
});

test("intersectingOps: fully interior section (paragraph in the middle of a deletion)", () => {
  const src = "intro {--first paragraph of deletion\n\nmiddle paragraph\n\nlast paragraph of deletion--} outro";
  const parsed = parse(src);
  const del = parsed.nodes.find((n) => n.kind === "deletion");
  assert.ok(del, "should have deletion");
  // The middle paragraph is fully interior to the deletion.
  const mid = src.indexOf("middle paragraph");
  const midEnd = mid + "middle paragraph".length;
  const ops = intersectingOps(parsed, mid, midEnd);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].openIn, false);
  assert.equal(ops[0].closeIn, false);
});

test("intersectingOps: empty section yields nothing", () => {
  const src = "no markup here";
  const parsed = parse(src);
  const ops = intersectingOps(parsed, 0, src.length);
  assert.equal(ops.length, 0);
});

test("commentsToIcon: one icon per thread", () => {
  const src = "x {>>Claude: first<<} {>>Claude: reply<<} y";
  // Two consecutive comments — single inline whitespace gap → one thread.
  const parsed = parse(src);
  assert.equal(parsed.threads.length, 1);
  const icons = commentsToIcon(parsed, 0, src.length);
  assert.equal(icons.size, 1);
});

test("commentsToIcon: separate threads each get an icon", () => {
  const src = "x {>>Claude: a<<}\ny {>>Claude: b<<}";
  const parsed = parse(src);
  assert.equal(parsed.threads.length, 2);
  const icons = commentsToIcon(parsed, 0, src.length);
  assert.equal(icons.size, 2);
});

test("commentsToIcon: thread root in earlier section gets icon in its own section, not its replies' section", () => {
  // Layout:
  //   line 0: prose {>>AI: root<<} {>>AI: reply<<}  -- both in line 0 (one thread)
  // All in one section so the test trivially gets one icon. Verify by
  // restricting section to just the reply offset range.
  const src = "{>>AI: root<<} {>>AI: reply<<}";
  const parsed = parse(src);
  assert.equal(parsed.threads.length, 1);
  // Section that covers ONLY the reply (root's open is before secFrom):
  const replyOpen = src.indexOf("{>>AI: reply");
  const icons = commentsToIcon(parsed, replyOpen, src.length);
  // Root not in section, so no icon should be emitted (the icon belongs in
  // the section that contains the root).
  assert.equal(icons.size, 0);
});

test("commentsToIcon: icon emitted in section containing the root", () => {
  const src = "{>>AI: root<<} {>>AI: reply<<}";
  const parsed = parse(src);
  const rootOpen = src.indexOf("{>>AI: root");
  const replyOpen = src.indexOf("{>>AI: reply");
  const icons = commentsToIcon(parsed, rootOpen, replyOpen);
  // Root in section, reply not — but they're the same thread.
  assert.equal(icons.size, 1);
});
