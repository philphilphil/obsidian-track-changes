import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = await build({
  entryPoints: [resolve(__dirname, "../src/trackdiff.ts")],
  bundle: true,
  format: "esm",
  target: "es2018",
  write: false,
  platform: "node",
});
const code = out.outputFiles[0].text;
const mod = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const { tokenize } = mod;

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

console.log("trackdiff tokenize:");

const join = (tokens) => tokens.map((t) => t.text).join("");

test("plain prose: words and spaces, lossless", () => {
  const src = "hello brave world";
  const toks = tokenize(src);
  assert.equal(join(toks), src);
  assert.deepEqual(
    toks.map((t) => t.kind),
    ["word", "space", "word", "space", "word"],
  );
});

test("mark is one atomic token", () => {
  const src = 'a {++new++} b';
  const toks = tokenize(src);
  assert.equal(join(toks), src);
  const mark = toks.find((t) => t.kind === "mark");
  assert.equal(mark.text, "{++new++}");
});

test("mark with metadata prefix is one atomic token", () => {
  const src = 'x {author="Phil" date="2026-07-24"--gone--} y';
  const mark = tokenize(src).find((t) => t.kind === "mark");
  assert.equal(mark.text, '{author="Phil" date="2026-07-24"--gone--}');
});

test("all six kinds tokenize as marks", () => {
  const src = "{++a++} {--b--} {~~c~>d~~} {==e==} {>>f<<} {=+g+=}";
  assert.equal(tokenize(src).filter((t) => t.kind === "mark").length, 6);
});

test("fenced code block is one atomic token", () => {
  const src = "before\n```\nlet x = 1;\n```\nafter";
  const toks = tokenize(src);
  assert.equal(join(toks), src);
  const code = toks.find((t) => t.kind === "code");
  assert.ok(code.text.startsWith("```"));
  assert.ok(code.text.includes("let x = 1;"));
});

test("inline code is atomic", () => {
  const toks = tokenize("use `foo bar` here");
  const code = toks.find((t) => t.kind === "code");
  assert.equal(code.text, "`foo bar`");
});

test("markup inside code stays code, not mark", () => {
  const src = "```\n{++not a mark++}\n```";
  const toks = tokenize(src);
  assert.equal(toks.filter((t) => t.kind === "mark").length, 0);
});

test("mark wrapping inline code wins over the code region", () => {
  const src = "{++ see `foo` ++}";
  const toks = tokenize(src);
  assert.equal(toks.length, 1);
  assert.equal(toks[0].kind, "mark");
});

test("whitespace tokens preserve newlines", () => {
  const toks = tokenize("a\n\nb");
  assert.equal(join(toks), "a\n\nb");
  assert.equal(toks[1].kind, "space");
  assert.equal(toks[1].text, "\n\n");
});

console.log("done.");
