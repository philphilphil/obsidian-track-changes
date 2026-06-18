// Smoke tests for the char-level diff. Run with: node test/diff.test.mjs
//
// Uses a tiny inline compile step so we don't need ts-node.

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = await build({
  entryPoints: [resolve(__dirname, "../src/diff.ts")],
  bundle: true,
  format: "esm",
  target: "es2018",
  write: false,
  platform: "neutral",
});
const code = out.outputFiles[0].text;
const mod = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const { diffChars } = mod;

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

function join(runs) {
  return runs.map((r) => r.text).join("");
}

function checkInvariants(d, oldText, newText) {
  assert.equal(join(d.oldRuns), oldText, "oldRuns must join to oldText");
  assert.equal(join(d.newRuns), newText, "newRuns must join to newText");
  for (const r of d.oldRuns) assert.notEqual(r.text, "", "no empty old run");
  for (const r of d.newRuns) assert.notEqual(r.text, "", "no empty new run");
  for (let i = 1; i < d.oldRuns.length; i++) {
    assert.notEqual(d.oldRuns[i].changed, d.oldRuns[i - 1].changed, "no adjacent same-flag old runs");
  }
  for (let i = 1; i < d.newRuns.length; i++) {
    assert.notEqual(d.newRuns[i].changed, d.newRuns[i - 1].changed, "no adjacent same-flag new runs");
  }
}

console.log("diff:");

test("within-word typo: shared prefix/suffix unchanged, middle changed", () => {
  const d = diffChars("recieve", "receive");
  checkInvariants(d, "recieve", "receive");
  // shared prefix 'rec' and suffix 've' fall in unchanged runs; the differing
  // middle ('i'/'e' swap) is changed. (LCS may extend the shared region inward,
  // e.g. share the common 'e', so assert containment rather than exact bounds.)
  assert.ok(d.oldRuns[0].text.startsWith("rec") && !d.oldRuns[0].changed);
  assert.ok(d.newRuns[0].text.startsWith("rec") && !d.newRuns[0].changed);
  const oldLast = d.oldRuns[d.oldRuns.length - 1];
  const newLast = d.newRuns[d.newRuns.length - 1];
  assert.ok(oldLast.text.endsWith("ve") && !oldLast.changed);
  assert.ok(newLast.text.endsWith("ve") && !newLast.changed);
  assert.ok(d.oldRuns.some((r) => r.changed));
  assert.ok(d.newRuns.some((r) => r.changed));
});

test("ampersand swap: surrounding spaces/words unchanged, & -> and changed", () => {
  const d = diffChars("cats & dogs", "cats and dogs");
  checkInvariants(d, "cats & dogs", "cats and dogs");
  assert.equal(d.oldRuns[0].changed, false);
  assert.equal(d.oldRuns[0].text, "cats ");
  assert.equal(d.oldRuns[d.oldRuns.length - 1].changed, false);
  assert.equal(d.oldRuns[d.oldRuns.length - 1].text, " dogs");
  const oldChanged = d.oldRuns.filter((r) => r.changed);
  const newChanged = d.newRuns.filter((r) => r.changed);
  assert.equal(oldChanged.length, 1);
  assert.equal(oldChanged[0].text, "&");
  assert.equal(newChanged.length, 1);
  assert.equal(newChanged[0].text, "and");
});

test("prefix-only change", () => {
  const d = diffChars("Xtail", "Ytail");
  checkInvariants(d, "Xtail", "Ytail");
  assert.deepEqual(d.oldRuns, [
    { text: "X", changed: true },
    { text: "tail", changed: false },
  ]);
  assert.deepEqual(d.newRuns, [
    { text: "Y", changed: true },
    { text: "tail", changed: false },
  ]);
});

test("suffix-only change", () => {
  const d = diffChars("headX", "headY");
  checkInvariants(d, "headX", "headY");
  assert.deepEqual(d.oldRuns, [
    { text: "head", changed: false },
    { text: "X", changed: true },
  ]);
  assert.deepEqual(d.newRuns, [
    { text: "head", changed: false },
    { text: "Y", changed: true },
  ]);
});

test("insertion-only: color -> colour, no changed run on old side", () => {
  const d = diffChars("color", "colour");
  checkInvariants(d, "color", "colour");
  assert.ok(!d.oldRuns.some((r) => r.changed), "old side has no changed run");
  const newChanged = d.newRuns.filter((r) => r.changed);
  assert.equal(newChanged.length, 1);
  assert.equal(newChanged[0].text, "u");
});

test("deletion-only: colour -> color, no changed run on new side", () => {
  const d = diffChars("colour", "color");
  checkInvariants(d, "colour", "color");
  assert.ok(!d.newRuns.some((r) => r.changed), "new side has no changed run");
  const oldChanged = d.oldRuns.filter((r) => r.changed);
  assert.equal(oldChanged.length, 1);
  assert.equal(oldChanged[0].text, "u");
});

test("multi-region: two separate changed runs each side (LCS keeps shared middle)", () => {
  const d = diffChars("the cat sat on the mat", "the dog sat on the rug");
  checkInvariants(d, "the cat sat on the mat", "the dog sat on the rug");
  const oldChanged = d.oldRuns.filter((r) => r.changed);
  const newChanged = d.newRuns.filter((r) => r.changed);
  assert.equal(oldChanged.length, 2, "two changed runs on old side");
  assert.equal(newChanged.length, 2, "two changed runs on new side");
  // ' sat on the ' stays shared
  assert.ok(d.oldRuns.some((r) => !r.changed && r.text === " sat on the "));
  assert.ok(d.newRuns.some((r) => !r.changed && r.text === " sat on the "));
});

test("identical inputs => one unchanged run each side", () => {
  const d = diffChars("same", "same");
  checkInvariants(d, "same", "same");
  assert.deepEqual(d.oldRuns, [{ text: "same", changed: false }]);
  assert.deepEqual(d.newRuns, [{ text: "same", changed: false }]);
});

test("old empty", () => {
  const d = diffChars("", "abc");
  checkInvariants(d, "", "abc");
  assert.deepEqual(d.oldRuns, []);
  assert.deepEqual(d.newRuns, [{ text: "abc", changed: true }]);
});

test("new empty", () => {
  const d = diffChars("abc", "");
  checkInvariants(d, "abc", "");
  assert.deepEqual(d.oldRuns, [{ text: "abc", changed: true }]);
  assert.deepEqual(d.newRuns, []);
});

test("both empty", () => {
  const d = diffChars("", "");
  checkInvariants(d, "", "");
  assert.deepEqual(d.oldRuns, []);
  assert.deepEqual(d.newRuns, []);
});

test("CAP fallback: huge differing middles => single changed run per side, fast", () => {
  // Distinct alphabets so prefix/suffix are zero and the middle product blows the cap.
  const a = "a".repeat(600);
  const b = "b".repeat(600);
  const start = Date.now();
  const d = diffChars(a, b);
  const elapsed = Date.now() - start;
  checkInvariants(d, a, b);
  assert.deepEqual(d.oldRuns, [{ text: a, changed: true }]);
  assert.deepEqual(d.newRuns, [{ text: b, changed: true }]);
  assert.ok(elapsed < 1000, "cap fallback should be fast, took " + elapsed + "ms");
});

console.log("done.");
