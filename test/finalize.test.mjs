// Tests for finalizeEdits and summarizeFinalize.
// Run with: node test/finalize.test.mjs

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
const { applyEdits, finalizeEdits, summarizeFinalize, DEFAULT_FINALIZE } = ops;

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

console.log("finalize:");

test("empty document → 0 edits, all-zero summary", () => {
  const r = parse("");
  const edits = finalizeEdits(r, DEFAULT_FINALIZE);
  assert.equal(edits.length, 0);
  const s = summarizeFinalize(r, DEFAULT_FINALIZE);
  assert.deepEqual(s, {
    comments: 0,
    additionsAccepted: 0,
    additionsRejected: 0,
    deletionsAccepted: 0,
    deletionsRejected: 0,
    substitutionsAccepted: 0,
    substitutionsRejected: 0,
    highlights: 0,
  });
});

test("plain prose with no markup → 0 edits, all-zero summary", () => {
  const r = parse("just some prose, nothing fancy.");
  assert.equal(finalizeEdits(r, DEFAULT_FINALIZE).length, 0);
  const s = summarizeFinalize(r, DEFAULT_FINALIZE);
  assert.equal(s.comments, 0);
  assert.equal(s.highlights, 0);
});

test("only highlights, stripHighlights: false → 0 edits, highlights counted", () => {
  const src = "a {==one==} b {==two==} c";
  const r = parse(src);
  const opts = { ...DEFAULT_FINALIZE, stripHighlights: false };
  const edits = finalizeEdits(r, opts);
  assert.equal(edits.length, 0);
  const s = summarizeFinalize(r, opts);
  assert.equal(s.highlights, 2);
});

test("only highlights, stripHighlights: true → strips wrappers, keeps text", () => {
  const src = "a {==one==} b {==two==} c";
  const r = parse(src);
  const opts = { ...DEFAULT_FINALIZE, stripHighlights: true };
  const edits = finalizeEdits(r, opts);
  assert.equal(edits.length, 2);
  const out = applyEdits(src, edits);
  assert.equal(out, "a one b two c");
});

test("mixed document, all-accept → expected final string", () => {
  const src = "a {++ins++} b {--del--} c {~~old~>new~~} d {>>Claude: note<<} e {==hl==} f";
  const r = parse(src);
  const opts = {
    additions: "accept",
    deletions: "accept",
    substitutions: "accept",
    stripHighlights: true,
  };
  const out = applyEdits(src, finalizeEdits(r, opts));
  // addition→"ins", deletion→removed, substitution→"new",
  // comment→stripped, highlight wrapper stripped → "hl"
  assert.equal(out, "a ins b  c new d  e hl f");
});

test("mixed document, all-reject → expected final string", () => {
  const src = "a {++ins++} b {--del--} c {~~old~>new~~} d {>>Claude: note<<} e {==hl==} f";
  const r = parse(src);
  const opts = {
    additions: "reject",
    deletions: "reject",
    substitutions: "reject",
    stripHighlights: true,
  };
  const out = applyEdits(src, finalizeEdits(r, opts));
  // addition→removed, deletion→"del", substitution→"old",
  // comment→stripped, highlight wrapper stripped → "hl"
  assert.equal(out, "a  b del c old d  e hl f");
});

test("summary counts add up across all forms", () => {
  const src = [
    "{++a1++}{++a2++}{++a3++}",
    "{--d1--}{--d2--}",
    "{~~o~>n~~}",
    "{>>Claude: c1<<} {>>c2<<}", // two comments
    "{==h1==}{==h2==}{==h3==}{==h4==}",
  ].join(" ");
  const r = parse(src);
  const opts = {
    additions: "accept",
    deletions: "reject",
    substitutions: "accept",
    stripHighlights: true,
  };
  const s = summarizeFinalize(r, opts);
  assert.equal(s.additionsAccepted, 3);
  assert.equal(s.additionsRejected, 0);
  assert.equal(s.deletionsAccepted, 0);
  assert.equal(s.deletionsRejected, 2);
  assert.equal(s.substitutionsAccepted, 1);
  assert.equal(s.substitutionsRejected, 0);
  assert.equal(s.comments, 2);
  assert.equal(s.highlights, 4);
});

test("summary mirrors opts: flipping accept/reject moves counts to the other bucket", () => {
  const src = "{++a++} {--d--} {~~o~>n~~}";
  const r = parse(src);
  const flipped = {
    additions: "reject",
    deletions: "accept",
    substitutions: "reject",
    stripHighlights: true,
  };
  const s = summarizeFinalize(r, flipped);
  assert.equal(s.additionsRejected, 1);
  assert.equal(s.additionsAccepted, 0);
  assert.equal(s.deletionsAccepted, 1);
  assert.equal(s.deletionsRejected, 0);
  assert.equal(s.substitutionsRejected, 1);
  assert.equal(s.substitutionsAccepted, 0);
});

test("finalizeEdits returns edits with distinct, non-overlapping `from` values", () => {
  const src = "a {++x++} b {--y--} c {~~o~>n~~} d {>>note<<} e {==h==} f";
  const r = parse(src);
  const edits = finalizeEdits(r, {
    additions: "accept",
    deletions: "reject",
    substitutions: "accept",
    stripHighlights: true,
  });
  const froms = edits.map((e) => e.from);
  const set = new Set(froms);
  assert.equal(set.size, froms.length, "all `from` values must be distinct");
  // and non-overlapping: sorted by `from`, each edit ends at or before the next begins
  const sorted = [...edits].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i - 1].to <= sorted[i].from,
      `edit ${i - 1} (to=${sorted[i - 1].to}) overlaps edit ${i} (from=${sorted[i].from})`,
    );
  }
});

test("DEFAULT_FINALIZE: keep additions, keep original prose, strip comments+highlights", () => {
  const src = "a {++x++} b {--y--} c {~~o~>n~~} d {>>Claude: note<<} e {==hl==} f";
  const r = parse(src);
  const out = applyEdits(src, finalizeEdits(r, DEFAULT_FINALIZE));
  assert.equal(out, "a x b y c o d  e hl f");
});

console.log("done.");
