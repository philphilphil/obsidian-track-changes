import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadTs(rel) {
  const out = await build({
    entryPoints: [resolve(__dirname, rel)],
    bundle: true,
    format: "esm",
    target: "es2018",
    write: false,
    platform: "neutral",
  });
  const code = out.outputFiles[0].text;
  return await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const ops = await loadTs("../src/operations.ts");
const parserMod = await loadTs("../src/parser.ts");
const { parse } = parserMod;
const {
  applyEdits,
  acceptAddition,
  rejectAddition,
  acceptDeletion,
  rejectDeletion,
  acceptSubstitution,
  rejectSubstitution,
  appendReply,
  deleteCommentNode,
  deleteThread,
  finalizeEdits,
  DEFAULT_FINALIZE,
} = ops;

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

console.log("operations:");

test("acceptAddition keeps the text", () => {
  const src = "x {++ins++} y";
  const r = parse(src);
  const out = applyEdits(src, [acceptAddition(r.nodes[0])]);
  assert.equal(out, "x ins y");
});

test("rejectAddition removes the block", () => {
  const src = "x {++ins++} y";
  const r = parse(src);
  const out = applyEdits(src, [rejectAddition(r.nodes[0])]);
  assert.equal(out, "x  y");
});

test("acceptDeletion removes the block", () => {
  const src = "x {--gone--} y";
  const r = parse(src);
  const out = applyEdits(src, [acceptDeletion(r.nodes[0])]);
  assert.equal(out, "x  y");
});

test("rejectDeletion keeps the text", () => {
  const src = "x {--gone--} y";
  const r = parse(src);
  const out = applyEdits(src, [rejectDeletion(r.nodes[0])]);
  assert.equal(out, "x gone y");
});

test("acceptSubstitution uses new text", () => {
  const src = "x {~~old~>new~~} y";
  const r = parse(src);
  const out = applyEdits(src, [acceptSubstitution(r.nodes[0])]);
  assert.equal(out, "x new y");
});

test("rejectSubstitution keeps old text", () => {
  const src = "x {~~old~>new~~} y";
  const r = parse(src);
  const out = applyEdits(src, [rejectSubstitution(r.nodes[0])]);
  assert.equal(out, "x old y");
});

test("deleteCommentNode removes one message of a thread", () => {
  const src = "x {>>Claude: a<<}{>>done<<} y";
  const r = parse(src);
  const out = applyEdits(src, [deleteCommentNode(r.nodes[1])]);
  assert.equal(out, "x {>>Claude: a<<} y");
});

test("deleteThread removes all messages", () => {
  const src = "x {>>Claude: a<<}{>>done<<} y";
  const r = parse(src);
  const out = applyEdits(src, [deleteThread(src, r.threads[0])]);
  assert.equal(out, "x  y");
});

test("appendReply inserts adjacent without prefix", () => {
  const src = "x {>>Claude: a<<} y";
  const r = parse(src);
  const edit = appendReply(src, r.threads[0], r, "thanks");
  const out = applyEdits(src, [edit]);
  assert.equal(out, "x {>>Claude: a<<}{>>thanks<<} y");
  // and the new structure parses as a single thread with one reply
  const r2 = parse(out);
  assert.equal(r2.threads.length, 1);
  assert.equal(r2.threads[0].replyIndexes.length, 1);
  assert.equal(r2.nodes[1].author, "human");
});

test("appendReply attaches after the last message of an existing thread", () => {
  const src = "x {>>Claude: a<<}{>>ignore<<} y";
  const r = parse(src);
  const edit = appendReply(src, r.threads[0], r, "actually no");
  const out = applyEdits(src, [edit]);
  assert.equal(out, "x {>>Claude: a<<}{>>ignore<<}{>>actually no<<} y");
});

test("applyEdits handles multiple non-overlapping edits", () => {
  const src = "a {++x++} b {--y--} c";
  const r = parse(src);
  const out = applyEdits(src, [acceptAddition(r.nodes[0]), acceptDeletion(r.nodes[1])]);
  assert.equal(out, "a x b  c");
});

test("finalizeEdits with defaults: keep additions, keep original prose", () => {
  const src = "a {++x++} b {--y--} c {~~o~>n~~} d {>>Claude: note<<}";
  const r = parse(src);
  const out = applyEdits(src, finalizeEdits(r, DEFAULT_FINALIZE));
  // default: additions accept, deletions reject (keep), subs reject (keep old), strip comments
  assert.equal(out, "a x b y c o d ");
});

test("finalizeEdits with accept-all", () => {
  const src = "a {++x++} b {--y--} c {~~o~>n~~} d";
  const r = parse(src);
  const opts = { additions: "accept", deletions: "accept", substitutions: "accept", stripHighlights: true };
  const out = applyEdits(src, finalizeEdits(r, opts));
  assert.equal(out, "a x b  c n d");
});

console.log("done.");
