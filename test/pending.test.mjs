import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = await build({
  entryPoints: [resolve(__dirname, "../src/pending.ts")],
  bundle: true,
  format: "esm",
  target: "es2018",
  write: false,
  platform: "node",
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")
);
const { summarizeSource, sortRows, filterRows, totals, pendingCount, describeSummary } = mod;

// ---- summarizeSource mirrors the panel header ----

// No braces at all: the fast path, nothing pending.
assert.deepEqual(summarizeSource("plain prose\nno marks"), {
  suggestions: 0, comments: 0, highlights: 0,
});
// Braces but no CriticMarkup.
assert.deepEqual(summarizeSource("a {b} c"), { suggestions: 0, comments: 0, highlights: 0 });

// One of each change kind.
assert.deepEqual(
  summarizeSource("{++add++} {--del--} {~~old~>new~~}"),
  { suggestions: 3, comments: 0, highlights: 0 },
);

// A thread (root + reply) is one comment; a lone highlight counts.
assert.deepEqual(
  summarizeSource("x {>>root<<} {>>reply<<} y\n\n{==hl==} z"),
  { suggestions: 0, comments: 1, highlights: 1 },
);

// A highlight anchoring a thread folds into the thread: not a highlight.
assert.deepEqual(
  summarizeSource("{==anchored==}{>>why<<}"),
  { suggestions: 0, comments: 1, highlights: 0 },
);

// A thread anchored on a change folds into the suggestion: not a comment.
assert.deepEqual(
  summarizeSource('{++new++}{author="Claude" date="2026-10-20">>rationale<<}'),
  { suggestions: 1, comments: 0, highlights: 0 },
);

// Blank line between comments: two separate threads.
assert.deepEqual(
  summarizeSource("{>>a<<}\n\n{>>b<<}"),
  { suggestions: 0, comments: 2, highlights: 0 },
);

// aitext is visual-only and never pending; marks in code are not marks.
assert.deepEqual(
  summarizeSource("{=+ai+=}\n\n```\n{++not a mark++}\n```\n`{--inline--}`"),
  { suggestions: 0, comments: 0, highlights: 0 },
);

assert.equal(pendingCount({ suggestions: 2, comments: 1, highlights: 1 }), 4);

// ---- ordering: most to review first, suggestions outrank comments outrank highlights ----

const rows = [
  { path: "b/two.md", suggestions: 1, comments: 5, highlights: 0 },
  { path: "a/one.md", suggestions: 1, comments: 5, highlights: 0 },
  { path: "c/three.md", suggestions: 0, comments: 9, highlights: 9 },
  { path: "d/four.md", suggestions: 3, comments: 0, highlights: 0 },
  { path: "e/five.md", suggestions: 1, comments: 5, highlights: 2 },
];
assert.deepEqual(
  sortRows(rows).map((r) => r.path),
  ["d/four.md", "e/five.md", "a/one.md", "b/two.md", "c/three.md"],
);
// sortRows does not mutate its input.
assert.equal(rows[0].path, "b/two.md");

// ---- filter: case-insensitive, every term must match somewhere in the path ----

assert.equal(filterRows(rows, "").length, 5);
assert.equal(filterRows(rows, "   ").length, 5);
assert.deepEqual(filterRows(rows, "ONE").map((r) => r.path), ["a/one.md"]);
assert.deepEqual(filterRows(rows, "e .md").map((r) => r.path).sort(), [
  "a/one.md", "c/three.md", "e/five.md",
]);
assert.equal(filterRows(rows, "zzz").length, 0);

// ---- totals and the summary line ----

assert.deepEqual(totals(rows), { files: 5, suggestions: 6, comments: 24, highlights: 11 });
assert.deepEqual(totals([]), { files: 0, suggestions: 0, comments: 0, highlights: 0 });
assert.equal(describeSummary({ suggestions: 1, comments: 2, highlights: 0 }), "1 suggestion · 2 comments");
assert.equal(describeSummary({ suggestions: 0, comments: 1, highlights: 1 }), "0 suggestions · 1 comment · 1 highlight");

console.log("pending.test.mjs: ok");
