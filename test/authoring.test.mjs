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
const { buildMark } = mod;

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

console.log("done.");
