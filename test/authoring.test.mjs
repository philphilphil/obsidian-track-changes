import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = await build({
  entryPoints: [resolve(__dirname, "../src/authoring.ts")],
  bundle: true,
  format: "esm",
  target: "es2018",
  write: false,
  platform: "node",
});
const code = out.outputFiles[0].text;
const mod = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const { buildMark, checkGuards } = mod;

const parserOut = await build({
  entryPoints: [resolve(__dirname, "../src/parser.ts")],
  bundle: true,
  format: "esm",
  target: "es2018",
  write: false,
  platform: "node",
});
const parserMod = await import(
  "data:text/javascript;base64," + Buffer.from(parserOut.outputFiles[0].text).toString("base64")
);
const { parse } = parserMod;

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

console.log("authoring:");

const P = 'author="Phil" date="2026-07-24"';

test("addition without selection: empty pair, cursor inside", () => {
  const r = buildMark("addition", "", P);
  assert.ok(r.ok);
  assert.equal(r.text, `{${P}++++}`);
  assert.equal(r.cursorOffset, 1 + P.length + 2); // after `{<P>++`
});

test("addition with selection: refused", () => {
  const r = buildMark("addition", "some text", P);
  assert.ok(!r.ok);
  assert.match(r.refusal, /Substitution/);
});

test("deletion with selection: wraps, cursor after mark", () => {
  const r = buildMark("deletion", "kill me", P);
  assert.ok(r.ok);
  assert.equal(r.text, `{${P}--kill me--}`);
  assert.equal(r.cursorOffset, r.text.length);
});

test("deletion without selection: refused", () => {
  const r = buildMark("deletion", "", P);
  assert.ok(!r.ok);
  assert.match(r.refusal, /[Ss]elect/);
});

test("substitution with selection: cursor in replacement slot", () => {
  const r = buildMark("substitution", "old", P);
  assert.ok(r.ok);
  assert.equal(r.text, `{${P}~~old~>~~}`);
  assert.equal(r.cursorOffset, 1 + P.length + 2 + 3 + 2); // after `{<P>~~old~>`
});

test("substitution without selection: refused", () => {
  assert.ok(!buildMark("substitution", "", P).ok);
});

test("highlight with selection: wraps with attribution, cursor after", () => {
  const r = buildMark("highlight", "note this", P);
  assert.ok(r.ok);
  assert.equal(r.text, `{${P}==note this==}`);
  assert.equal(r.cursorOffset, r.text.length);
});

test("highlight without selection: refused", () => {
  assert.ok(!buildMark("highlight", "", P).ok);
});

test("comment without selection: floating, cursor in body", () => {
  const r = buildMark("comment", "", P);
  assert.ok(r.ok);
  assert.equal(r.text, `{${P}>><<}`);
  assert.equal(r.cursorOffset, 1 + P.length + 2);
});

test("comment with selection: bare anchor + attributed comment, cursor in body", () => {
  const r = buildMark("comment", "anchor me", P);
  assert.ok(r.ok);
  assert.equal(r.text, `{==anchor me==}{${P}>><<}`);
  assert.equal(r.cursorOffset, "{==anchor me==}".length + 1 + P.length + 2);
});

console.log("authoring round-trip:");

// Build a mark, drop it into surrounding prose, parse it back. The trailing-
// delimiter cases only survive because the parser closes on the FIRST closing
// run — pin that here rather than trusting the builder's string alone.
function roundTrip(kind, selection) {
  const r = buildMark(kind, selection, P);
  assert.ok(r.ok);
  const source = "A " + r.text + " B";
  return { source, nodes: parse(source).nodes };
}

function assertSingle(kind, selection) {
  const { source, nodes } = roundTrip(kind, selection);
  assert.equal(nodes.length, 1, `expected one node from ${source}`);
  assert.equal(nodes[0].kind, kind);
  assert.equal(source.slice(nodes[0].innerFrom, nodes[0].innerTo), selection);
  return nodes[0];
}

test("round-trip: deletion ending in a dash", () => {
  const n = assertSingle("deletion", "trailing dash-");
  assert.equal(n.raw, `{${P}--trailing dash---}`);
});

test("round-trip: highlight ending in `=`", () => {
  assertSingle("highlight", "ends with =");
});

test("round-trip: substitution whose old text ends in a tilde", () => {
  const n = assertSingle("substitution", "tilde~ end");
  assert.equal(n.oldText, "tilde~ end");
  assert.equal(n.newText, "");
});

test("round-trip: deletion containing a brace", () => {
  assertSingle("deletion", "brace } here");
});

test("round-trip: deletion containing a double quote", () => {
  assertSingle("deletion", 'quote " here');
});

test("round-trip: nested mark collapses into the outer deletion", () => {
  assertSingle("deletion", "has {++x++} inside");
});

test("round-trip: attribution survives the parser", () => {
  const n = assertSingle("deletion", "kill me");
  assert.equal(n.metaAuthor, "Phil");
  assert.equal(n.metaDate, "2026-07-24");
});

test("round-trip: comment with selection yields anchor + comment", () => {
  const { source, nodes } = roundTrip("comment", "anchor me");
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].kind, "highlight");
  assert.equal(source.slice(nodes[0].innerFrom, nodes[0].innerTo), "anchor me");
  assert.equal(nodes[0].metaAuthor, null); // the bare anchor carries no attribution
  assert.equal(nodes[1].kind, "comment");
  assert.equal(nodes[1].text, "");
  assert.equal(nodes[1].metaAuthor, "Phil");
});

console.log("authoring guards:");

test("guard: selection overlapping an existing mark is refused", () => {
  const src = "abc {++added++} def";
  // selection [2, 8) crosses into the mark
  assert.match(checkGuards(src, 2, 8, "deletion"), /overlap/i);
});

test("guard: cursor strictly inside an existing mark is refused", () => {
  const src = "abc {++added++} def";
  assert.match(checkGuards(src, 8, 8, "comment"), /overlap/i);
});

test("guard: cursor at a mark boundary is allowed", () => {
  const src = "abc {++added++} def";
  assert.equal(checkGuards(src, 4, 4, "comment"), null); // just before `{`
  assert.equal(checkGuards(src, 15, 15, "comment"), null); // just after `}`
});

test("guard: selection inside a fenced code block is refused", () => {
  const src = "before\n```\ncode here\n```\nafter";
  const from = src.indexOf("code");
  assert.match(checkGuards(src, from, from + 4, "highlight"), /code/i);
});

test("guard: selection inside inline code is refused", () => {
  const src = "use `foo bar` here";
  const from = src.indexOf("foo");
  assert.match(checkGuards(src, from, from + 3, "deletion"), /code/i);
});

test("guard: selection crossing a blank line is refused", () => {
  const src = "para one\n\npara two";
  assert.match(checkGuards(src, 0, src.length, "deletion"), /block/i);
});

test("guard: selection whose later line opens a block is refused", () => {
  const src = "some text\n# Heading";
  assert.match(checkGuards(src, 0, src.length, "deletion"), /block/i);
  const src2 = "some text\n- item";
  assert.match(checkGuards(src2, 0, src2.length, "deletion"), /block/i);
});

test("guard: selection whose FIRST line is a heading is refused", () => {
  const src = "# Heading\nbody text";
  assert.match(checkGuards(src, 0, src.length, "deletion"), /block/i);
  const src2 = "intro\n\n# Head\nbody";
  assert.match(checkGuards(src2, 7, 17, "deletion"), /block/i);
});

test("guard: selection starting mid-heading is refused", () => {
  const src = "# Head\nbody";
  assert.match(checkGuards(src, 2, src.length, "deletion"), /block/i);
});

test("guard: selection whose first line is a table row is refused", () => {
  const src = "| a | b |\nnext line";
  assert.match(checkGuards(src, 0, src.length, "deletion"), /block/i);
});

test("guard: first line with lazy continuation is allowed", () => {
  const src = "- item one\nplain follow";
  assert.equal(checkGuards(src, 0, src.length, "deletion"), null);
});

test("guard: soft-wrapped selection within one paragraph is allowed", () => {
  const src = "line one\nline two";
  assert.equal(checkGuards(src, 0, src.length, "deletion"), null);
});

test("guard: single-line selection on a heading is allowed", () => {
  const src = "# Heading here";
  assert.equal(checkGuards(src, 2, src.length, "deletion"), null);
});

test("guard: selection containing the closing delimiter is refused", () => {
  assert.match(checkGuards("a --} b", 0, 7, "deletion"), /--}/);
  assert.match(checkGuards("a ~> b", 0, 6, "substitution"), /~>/);
  assert.match(checkGuards("a ==} b", 0, 7, "highlight"), /==}/);
  assert.match(checkGuards("a ==} b", 0, 7, "comment"), /==}/); // selection goes inside the {==…==} anchor
});

test("guard: plain prose selection passes", () => {
  assert.equal(checkGuards("hello brave world", 6, 11, "deletion"), null);
});

console.log("done.");
