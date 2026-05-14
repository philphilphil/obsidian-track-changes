// Tests for rebaseEdit. Run with: node test/rebase.test.mjs
//
// NOTE: rebaseEdit may not be implemented yet in src/operations.ts — these
// tests will fail loudly with "rebaseEdit not implemented yet" until the main
// session adds it. The file itself still builds and runs.

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
const { rebaseEdit } = ops;

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

function requireRebase() {
  if (typeof rebaseEdit !== "function") {
    throw new Error("rebaseEdit not implemented yet");
  }
}

console.log("rebase:");

test("returns edit unchanged when `expected` is undefined", () => {
  requireRebase();
  const doc = "hello world";
  const edit = { from: 0, to: 5, insert: "HELLO" };
  const out = rebaseEdit(doc, edit);
  assert.deepEqual(out, edit);
});

test("returns edit unchanged when doc.slice(from,to) === expected", () => {
  requireRebase();
  const doc = "hello world";
  const edit = { from: 6, to: 11, insert: "WORLD", expected: "world" };
  const out = rebaseEdit(doc, edit);
  // Same offsets, same insert. The `expected` field may or may not be carried
  // through — we only check the load-bearing fields.
  assert.equal(out.from, 6);
  assert.equal(out.to, 11);
  assert.equal(out.insert, "WORLD");
});

test("returns edit unchanged when exact expected text repeats nearby", () => {
  requireRebase();
  const doc = "{++x++} and {++x++}";
  const edit = { from: 0, to: 7, insert: "x", expected: "{++x++}" };
  const out = rebaseEdit(doc, edit);
  assert.ok(out !== null, "expected exact in-place match to succeed");
  assert.equal(out.from, 0);
  assert.equal(out.to, 7);
  assert.equal(out.insert, "x");
});

test("expected-only stale edit does not relocate to another identical marker", () => {
  requireRebase();
  const currentDoc = " and {++x++}";
  const edit = { from: 0, to: 7, insert: "x", expected: "{++x++}" };
  const out = rebaseEdit(currentDoc, edit);
  assert.equal(out, null);
});

test("shifted doc with explicit unique context anchor → returns rebased edit", () => {
  requireRebase();
  // Original doc: "prefix TARGET suffix"
  // We pretend an edit was computed against the original where TARGET was at offset 7.
  // The current doc has had "PREPEND " inserted at the start, shifting TARGET by +8.
  const currentDoc = "PREPEND prefix TARGET suffix";
  const originalFrom = 7;
  const originalTo = originalFrom + "TARGET".length;
  const edit = {
    from: originalFrom,
    to: originalTo,
    insert: "REPLACED",
    expected: "TARGET",
    before: "prefix ",
  };
  const out = rebaseEdit(currentDoc, edit);
  assert.ok(out !== null, "expected rebase to succeed");
  const newFrom = currentDoc.indexOf("TARGET");
  assert.equal(out.from, newFrom);
  assert.equal(out.to, newFrom + "TARGET".length);
  assert.equal(out.insert, "REPLACED");
  // And the rebased range really points to the expected substring
  assert.equal(currentDoc.slice(out.from, out.to), "TARGET");
});

test("expected substring missing in window → returns null", () => {
  requireRebase();
  const currentDoc = "completely different content here";
  const edit = {
    from: 5,
    to: 11,
    insert: "X",
    expected: "TARGET",
  };
  const out = rebaseEdit(currentDoc, edit);
  assert.equal(out, null);
});

test("context anchor appears multiple times in window → ambiguous, returns null", () => {
  requireRebase();
  // "prefix TARGET" appears twice within a small window around the stale offset.
  const currentDoc = "aaa prefix TARGET bbb prefix TARGET ccc";
  const edit = {
    from: 50,
    to: 56,
    insert: "X",
    expected: "TARGET",
    before: "prefix ",
  };
  const out = rebaseEdit(currentDoc, edit);
  assert.equal(out, null, "ambiguous matches must return null");
});

test("context anchor outside the ±200 window → returns null", () => {
  requireRebase();
  // Place "prefix TARGET" far away from the original offset so the search window misses it.
  const filler = "x".repeat(500);
  const currentDoc = filler + " prefix TARGET " + filler;
  const edit = {
    from: 0,
    to: 6,
    insert: "X",
    expected: "TARGET",
    before: "prefix ",
  };
  const out = rebaseEdit(currentDoc, edit);
  assert.equal(out, null);
});

console.log("done.");
