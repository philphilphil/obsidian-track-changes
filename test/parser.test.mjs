// Smoke tests for the parser. Run with: node test/parser.test.mjs
//
// Uses a tiny inline compile step so we don't need ts-node.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = await build({
  entryPoints: [resolve(__dirname, "../src/parser.ts")],
  bundle: false,
  format: "esm",
  target: "es2018",
  write: false,
  platform: "neutral",
});
const code = out.outputFiles[0].text;
const mod = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const { parse, threadAtOffset, nodeAtOffset } = mod;

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

console.log("parser:");

test("recognises a single AI-prefixed comment with default prefix", () => {
  const r = parse("hello {>>AI: nice<<} world");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "comment");
  assert.equal(r.nodes[0].author, "ai");
  assert.equal(r.nodes[0].text, "nice");
  assert.equal(r.threads.length, 1);
});

test("aiPrefix option lets the user pick a different marker", () => {
  const r = parse("hello {>>Claude: nice<<} world", { aiPrefix: "Claude" });
  assert.equal(r.nodes[0].author, "ai");
  assert.equal(r.nodes[0].text, "nice");
  // With default prefix, the same input is read as human.
  const r2 = parse("hello {>>Claude: nice<<} world");
  assert.equal(r2.nodes[0].author, "human");
});

test("aiPrefix matching is case-insensitive", () => {
  const r = parse("{>>ai: hi<<}");
  assert.equal(r.nodes[0].author, "ai");
  const r2 = parse("{>>aI:hi<<}");
  assert.equal(r2.nodes[0].author, "ai");
});

test("unprefixed comment is human", () => {
  const r = parse("hello {>>done<<} world");
  assert.equal(r.nodes[0].author, "human");
  assert.equal(r.nodes[0].text, "done");
});

test("adjacent comments form one thread", () => {
  const r = parse("x {>>Claude: a<<}{>>done<<} y");
  assert.equal(r.threads.length, 1);
  assert.equal(r.threads[0].replyIndexes.length, 1);
});

test("comments on different lines are separate threads", () => {
  const r = parse("x {>>Claude: a<<}\ny {>>Claude: b<<}");
  assert.equal(r.threads.length, 2);
});

test("inline whitespace between adjacent comments still threads", () => {
  const r = parse("x {>>Claude: a<<}  {>>done<<} y");
  assert.equal(r.threads.length, 1);
  assert.equal(r.threads[0].replyIndexes.length, 1);
});

test("parses addition", () => {
  const r = parse("x {++hello++} y");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "addition");
  assert.equal(r.nodes[0].text, "hello");
});

test("parses deletion", () => {
  const r = parse("x {--gone--} y");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "deletion");
  assert.equal(r.nodes[0].text, "gone");
});

test("parses substitution", () => {
  const r = parse("x {~~old~>new~~} y");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "substitution");
  assert.equal(r.nodes[0].oldText, "old");
  assert.equal(r.nodes[0].newText, "new");
});

test("parses highlight", () => {
  const r = parse("x {==look==} y");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "highlight");
});

test("mixed forms in document order", () => {
  const r = parse("a {++ins++} b {--del--} c {~~o~>n~~} d {>>Claude: c<<}");
  const kinds = r.nodes.map((n) => n.kind);
  assert.deepEqual(kinds, ["addition", "deletion", "substitution", "comment"]);
});

test("multi-message thread retains correct ranges", () => {
  const src = "x {>>Claude: a<<}{>>done<<} y";
  const r = parse(src);
  const t = r.threads[0];
  assert.equal(src.slice(t.from, t.to), "{>>Claude: a<<}{>>done<<}");
});

test("threadAtOffset finds the right thread", () => {
  const src = "x {>>Claude: a<<}\ny {>>Claude: b<<}";
  const r = parse(src);
  // offset within second comment
  const off = src.indexOf("{>>Claude: b");
  const t = threadAtOffset(r, off);
  assert.equal(t, 1);
});

test("nodeAtOffset finds the right node", () => {
  const src = "x {++ins++} y";
  const r = parse(src);
  const off = src.indexOf("{++");
  assert.equal(nodeAtOffset(r, off), 0);
});

test("AI prefix is whitespace-tolerant", () => {
  const r = parse("{>>  AI:hi<<}");
  assert.equal(r.nodes[0].author, "ai");
  assert.equal(r.nodes[0].text, "hi");
});

test("no overlap with neighbouring forms", () => {
  // A substitution sometimes embeds patterns that look like other forms.
  // Make sure we don't double-count.
  const r = parse("{~~x++y~>z--w~~}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "substitution");
});

test("empty source", () => {
  const r = parse("");
  assert.equal(r.nodes.length, 0);
  assert.equal(r.threads.length, 0);
});

console.log("done.");
