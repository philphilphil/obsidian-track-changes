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

test("guard: soft-wrapped selection within one paragraph is allowed", () => {
  const src = "line one\nline two";
  assert.equal(checkGuards(src, 0, src.length, "deletion"), null);
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
