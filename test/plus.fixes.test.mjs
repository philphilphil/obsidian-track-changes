// Regression tests for CriticMarkup Plus, ported to the quoted `key="value"`
// metadata grammar. Two themes:
//   1. A mark whose body contains a nested mark collapses to the OUTER mark —
//      for prefixed and prefix-free marks alike (the inner is part of the
//      added/deleted text). Under the quoted grammar a value can't hold a
//      brace/quote/newline, so a prefixed mark can never straddle; there is no
//      prefix-gated nesting guard to drop the outer attributed mark.
//   2. corruption-locality of the quoted grammar: an unterminated quote, or a
//      brace / newline inside a value, fails to form a mark *locally* instead of
//      straddling downstream text — the role the old mandatory trailing `;`
//      used to play.
//
// Same inline esbuild + base64 data-URL harness as the other plus.* tests.

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function importTs(rel) {
  const out = await build({
    entryPoints: [resolve(__dirname, rel)],
    bundle: true,
    format: "esm",
    target: "es2018",
    write: false,
    platform: "neutral",
  });
  const code = out.outputFiles[0].text;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const { parse } = await importTs("../src/parser.ts");
const { sanitizeAuthorName, appendReply } = await importTs("../src/operations.ts");

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

const only = (src) => {
  const { nodes } = parse(src);
  assert.equal(nodes.length, 1, `expected exactly one node for ${JSON.stringify(src)}, got ${nodes.length}`);
  return nodes[0];
};

console.log("plus fixes:");

// ---------------------------------------------------------------------------
// 1. Prefix-free nested marks collapse to the OUTER mark (the inner is part of
//    the added/deleted text).
// ---------------------------------------------------------------------------

test("prefix-free deletion containing a comment -> single outer deletion", () => {
  const src = "{--remove {>>old note<<} too--}";
  const n = only(src);
  assert.equal(n.kind, "deletion");
  assert.equal(n.raw, src);
  assert.equal(n.text, "remove {>>old note<<} too");
  assert.equal(n.metaRaw, "");
});

test("prefix-free addition containing a comment -> single outer addition", () => {
  const n = only("{++add {>>note<<} here++}");
  assert.equal(n.kind, "addition");
  assert.equal(n.text, "add {>>note<<} here");
});

test("prefix-free comment containing an addition -> single outer comment", () => {
  const n = only("{>>outer {++inner++} comment<<}");
  assert.equal(n.kind, "comment");
  assert.equal(n.text, "outer {++inner++} comment");
});

test("prefix-free highlight containing a deletion -> single outer highlight", () => {
  const n = only("{==highlight {--del--} inside==}");
  assert.equal(n.kind, "highlight");
  assert.equal(n.text, "highlight {--del--} inside");
});

test("prefix-free substitution containing a highlight -> single substitution", () => {
  const n = only("{~~old~>new with {==hi==}~~}");
  assert.equal(n.kind, "substitution");
  assert.equal(n.oldText, "old");
  assert.equal(n.newText, "new with {==hi==}");
});

test("prose with a nested-mark deletion -> only the outer deletion, no inner leak", () => {
  const src = "Please {--delete this {>>why?<<} part--} now.";
  const { nodes } = parse(src);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, "deletion");
  assert.equal(nodes[0].text, "delete this {>>why?<<} part");
});

// ---------------------------------------------------------------------------
// 1b. PREFIXED marks containing a nested mark ALSO collapse to the OUTER mark,
//     keeping their attribution. (Regression: the old ;-grammar nesting guard,
//     gated on a non-empty prefix, dropped the outer attributed mark and
//     re-admitted the inner one. Under the quoted grammar a value can't hold a
//     brace/quote/newline, so a prefixed mark can never straddle and the guard
//     is gone.)
// ---------------------------------------------------------------------------

test("prefixed deletion containing a comment -> single outer deletion, attribution kept", () => {
  const src = '{author="A"--remove {>>old note<<} too--}';
  const n = only(src);
  assert.equal(n.kind, "deletion");
  assert.equal(n.metaAuthor, "A");
  assert.equal(n.text, "remove {>>old note<<} too");
  assert.equal(n.raw, src);
});

test("prefixed addition containing a comment -> single outer addition", () => {
  const n = only('{author="A" date="2026-06-14"++add {>>note<<} here++}');
  assert.equal(n.kind, "addition");
  assert.equal(n.metaAuthor, "A");
  assert.equal(n.metaDate, "2026-06-14");
  assert.equal(n.text, "add {>>note<<} here");
});

test("prefixed highlight containing a deletion -> single outer highlight", () => {
  const n = only('{author="A"==highlight {--del--} inside==}');
  assert.equal(n.kind, "highlight");
  assert.equal(n.metaAuthor, "A");
  assert.equal(n.text, "highlight {--del--} inside");
});

test("prefixed substitution whose new text contains a highlight -> single substitution", () => {
  const n = only('{date="2026-06-14"~~old~>new with {==hi==}~~}');
  assert.equal(n.kind, "substitution");
  assert.equal(n.metaDate, "2026-06-14");
  assert.equal(n.oldText, "old");
  assert.equal(n.newText, "new with {==hi==}");
});

test("prefixed comment containing an addition -> single outer comment", () => {
  const n = only('{author="A">>outer {++inner++} comment<<}');
  assert.equal(n.kind, "comment");
  assert.equal(n.metaAuthor, "A");
  assert.equal(n.text, "outer {++inner++} comment");
});

// ---------------------------------------------------------------------------
// 2. Corruption-locality of the quoted grammar.
// ---------------------------------------------------------------------------

test("corruption: unterminated quote forms no mark (fails locally)", () => {
  // No closing `"` before `}` — pair fails, prefix collapses to "", `{author=…`
  // is not a sigil, so nothing parses. The `++text++` is NOT rescued as an
  // addition because the only `{` is consumed by the failed prefix attempt.
  const { nodes } = parse('{author="Claude++text++}');
  assert.equal(nodes.length, 0);
});

test("corruption: brace inside a quoted value kills the mark", () => {
  // `}` is forbidden in the value class, so the value can't close — no mark.
  const { nodes } = parse('{author="a}b"++x++}');
  assert.equal(nodes.length, 0);
});

test("corruption: newline inside a quoted value kills the mark", () => {
  const { nodes } = parse('{author="line1\nline2"++x++}');
  assert.equal(nodes.length, 0);
});

test("corruption guard: malformed unquoted date does not swallow a neighbour", () => {
  // Legacy-style `date=2026--…` has no quote → not a valid pair → prefix "".
  const src = 'Keep {date=2026--6--this stays--} and {--really go--}.';
  const { nodes } = parse(src);
  // The first brace group forms no prefixed mark; the genuine deletion survives.
  const deletions = nodes.filter((n) => n.kind === "deletion");
  assert.ok(deletions.some((n) => n.text === "really go"));
});

test("prefix-free nested mark still collapses to the outer mark (no regression)", () => {
  const { nodes } = parse("{--remove {>>note<<} too--}");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, "deletion");
  assert.equal(nodes[0].text, "remove {>>note<<} too");
});

test("legit single brace in prose survives as one mark", () => {
  const { nodes } = parse("{--remove the {foo} placeholder--}");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, "deletion");
});

// ---------------------------------------------------------------------------
// 3. sanitizeAuthorName output always round-trips back through the quoted prefix
//    as exactly one mark with the sanitized author preserved.
// ---------------------------------------------------------------------------

test("sanitizeAuthorName output round-trips through the quoted prefix", () => {
  const name = sanitizeAuthorName('Bad"{}\nName');
  const n = only(`{author="${name}" date="2026-06-14">>r<<}`);
  assert.equal(n.kind, "comment");
  assert.equal(n.metaAuthor, name);
});

test("appendReply with a structural-char name produces a clean single-line mark", () => {
  const src = "{>>root<<}";
  const parsed = parse(src);
  const edit = appendReply(src, parsed.threads[0], parsed, "reply", 'E"vil{}\nName');
  const re = parse(edit.insert);
  assert.equal(re.nodes.length, 1);
  assert.equal(re.nodes[0].kind, "comment");
  assert.equal(re.nodes[0].metaAuthor, "EvilName");
});
