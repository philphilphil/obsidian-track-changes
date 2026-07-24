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
const { tokenize, blockSplit, computeTrackEdits } = mod;

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

console.log("trackdiff blockSplit:");

const rejoin = (pieces) => pieces.map((p) => p.text).join("");

test("single paragraph: one chunk", () => {
  assert.deepEqual(blockSplit("a b c"), [{ text: "a b c", sep: false }]);
});

test("soft newline stays in one chunk", () => {
  assert.deepEqual(blockSplit("a\nb"), [{ text: "a\nb", sep: false }]);
});

test("blank line splits into chunk/sep/chunk", () => {
  assert.deepEqual(blockSplit("a\n\nb"), [
    { text: "a", sep: false },
    { text: "\n\n", sep: true },
    { text: "b", sep: false },
  ]);
});

test("block-marker line starts its own chunk", () => {
  assert.deepEqual(blockSplit("a\n# h"), [
    { text: "a", sep: false },
    { text: "\n", sep: true },
    { text: "# h", sep: false },
  ]);
});

test("line after a marker line is its own chunk", () => {
  assert.deepEqual(blockSplit("# h\ntext"), [
    { text: "# h", sep: false },
    { text: "\n", sep: true },
    { text: "text", sep: false },
  ]);
});

test("multiple blank lines stay one separator", () => {
  const pieces = blockSplit("a\n\n\n\nb");
  assert.equal(pieces.length, 3);
  assert.equal(pieces[1].sep, true);
  assert.equal(rejoin(pieces), "a\n\n\n\nb");
});

test("lossless on a mixed document fragment", () => {
  const text = "intro line\n\n- item one\n- item two\n\n> quoted";
  assert.equal(rejoin(blockSplit(text)), text);
  for (const p of blockSplit(text)) {
    if (!p.sep) {
      assert.ok(!/\n[ \t]*\n/.test(p.text), "chunk contains a blank line: " + JSON.stringify(p.text));
    }
  }
});

test("whitespace-only input: one separator", () => {
  assert.deepEqual(blockSplit("\n\n"), [{ text: "\n\n", sep: true }]);
});

console.log("done.");

console.log("trackdiff computeTrackEdits:");

const PP = 'date="2026-07-24"';
const applyAll = (source, edits) => {
  const sorted = [...edits].sort((a, b) => b.from - a.from);
  for (let i = 0; i < sorted.length - 1; i++) {
    assert.ok(sorted[i + 1].to <= sorted[i].from, "edits overlap");
  }
  let out = source;
  for (const e of sorted) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
};

// Resolve every CriticMarkup mark (session + manual) in a marked string.
const acceptAll = (s) =>
  s
    .replace(/\{[^{}]*?~~[\s\S]*?~>([\s\S]*?)~~\}/g, "$1") // substitution → new
    .replace(/\{[^{}]*?\+\+([\s\S]*?)\+\+\}/g, "$1") // addition → text
    .replace(/\{[^{}]*?--[\s\S]*?--\}/g, "") // deletion → gone
    .replace(/\{[^{}]*?=\+([\s\S]*?)\+=\}/g, "$1") // aitext → text
    .replace(/\{[^{}]*?==([\s\S]*?)==\}/g, "$1") // highlight → text
    .replace(/\{[^{}]*?>>[\s\S]*?<<\}/g, ""); // comment → gone
const rejectAll = (s) =>
  s
    .replace(/\{[^{}]*?~~([\s\S]*?)~>[\s\S]*?~~\}/g, "$1") // substitution → old
    .replace(/\{[^{}]*?\+\+[\s\S]*?\+\+\}/g, "") // addition → gone
    .replace(/\{[^{}]*?--([\s\S]*?)--\}/g, "$1") // deletion → text
    .replace(/\{[^{}]*?=\+([\s\S]*?)\+=\}/g, "$1") // aitext → text
    .replace(/\{[^{}]*?==([\s\S]*?)==\}/g, "$1") // highlight → text
    .replace(/\{[^{}]*?>>[\s\S]*?<<\}/g, ""); // comment → gone

test("no changes: no edits", () => {
  const r = computeTrackEdits("same text", "same text", PP);
  assert.equal(r.edits.length, 0);
});

test("pure addition of words", () => {
  const base = "the cat sat";
  const cur = "the big cat sat";
  const r = computeTrackEdits(base, cur, PP);
  assert.equal(r.counts.additions, 1);
  assert.equal(applyAll(cur, r.edits), `the {${PP}++big ++}cat sat`);
});

test("pure deletion of words", () => {
  const base = "the big cat sat";
  const cur = "the cat sat";
  const r = computeTrackEdits(base, cur, PP);
  assert.equal(r.counts.deletions, 1);
  assert.equal(applyAll(cur, r.edits), `the {${PP}--big --}cat sat`);
});

test("replacement becomes a substitution", () => {
  const base = "the red cat";
  const cur = "the blue cat";
  const r = computeTrackEdits(base, cur, PP);
  assert.equal(r.counts.substitutions, 1);
  // The space tokens around "blue" are common, so the mark wraps only the word.
  assert.equal(applyAll(cur, r.edits), `the {${PP}~~red~>blue~~} cat`);
});

test("edits carry expected/before anchors", () => {
  const r1 = computeTrackEdits("a b c", "a x c", PP);
  assert.equal(r1.edits[0].expected, "x");
  const r2 = computeTrackEdits("a b c", "a c", PP); // pure deletion → insertion edit
  assert.equal(r2.edits[0].expected, "");
  assert.ok(r2.edits[0].before.length > 0);
});

test("multi-block addition splits into per-block marks", () => {
  const base = "start end";
  const cur = "start one\n\ntwo end";
  const r = computeTrackEdits(base, cur, PP);
  const out = applyAll(cur, r.edits);
  assert.equal(r.counts.additions, 2, "one mark per block chunk");
  assert.ok(!/\+\+[^}]*\n[ \t]*\n[^{]*\+\+\}/.test(out), "no addition mark contains a blank line");
});

test("whitespace-only change: no edits", () => {
  const r = computeTrackEdits("a b", "a  b", PP);
  assert.equal(r.edits.length, 0);
});

test("accept-all yields current, reject-all yields baseline (simple prose)", () => {
  const base = "one two three four five";
  const cur = "one 2 three five six";
  const r = computeTrackEdits(base, cur, PP);
  const marked = applyAll(cur, r.edits);
  // accept: additions keep text, deletions vanish, substitutions take new side
  const accepted = marked
    .replace(/\{[^{}]*?\+\+([\s\S]*?)\+\+\}/g, "$1")
    .replace(/\{[^{}]*?--[\s\S]*?--\}/g, "")
    .replace(/\{[^{}]*?~~[\s\S]*?~>([\s\S]*?)~~\}/g, "$1");
  assert.equal(accepted, cur);
  // reject: additions vanish, deletions keep text, substitutions take old side
  const rejected = marked
    .replace(/\{[^{}]*?\+\+[\s\S]*?\+\+\}/g, "")
    .replace(/\{[^{}]*?--([\s\S]*?)--\}/g, "$1")
    .replace(/\{[^{}]*?~~([\s\S]*?)~>[\s\S]*?~~\}/g, "$1");
  assert.equal(rejected, base);
});

console.log("trackdiff atomic-token rules:");

test("edit inside an existing mark is absorbed (never nested)", () => {
  const base = 'keep {++alpha beta gamma++} keep';
  const cur = 'keep {++alpha delta gamma++} keep';
  const r = computeTrackEdits(base, cur, PP);
  const out = applyAll(cur, r.edits);
  assert.equal(out, cur, "amended mark passes through untouched");
  assert.ok(r.counts.marksPassedThrough >= 1);
});

test("deleting a whole existing mark emits nothing", () => {
  const base = "a {--old--} b";
  const cur = "a b";
  const r = computeTrackEdits(base, cur, PP);
  assert.equal(applyAll(cur, r.edits), "a b");
});

test("a mark added mid-session passes through bare (e.g. panel reply)", () => {
  const base = "a {>>root<<} b";
  const cur = 'a {>>root<<}{date="2026-07-24">>reply<<} b';
  const r = computeTrackEdits(base, cur, PP);
  assert.equal(applyAll(cur, r.edits), cur, "reply not double-wrapped");
});

test("changed code block is left unmarked and counted once", () => {
  const base = "intro\n```\nlet x = 1;\n```\noutro";
  const cur = "intro\n```\nlet x = 2;\n```\noutro";
  const r = computeTrackEdits(base, cur, PP);
  assert.equal(applyAll(cur, r.edits), cur, "code change stands unmarked");
  assert.equal(r.counts.codeChanged, 1, "one changed block counts once, not per side");
});

// A pass-through mark authored mid-session wraps baseline text. The session
// diff must NOT re-mark that wrapped text, and reject-all must round-trip to
// the exact baseline through the pass-through mark alone.
test("wrap deletion added mid-session: no spurious session deletion", () => {
  const base = "the old cat sat";
  const cur = "the {--old--} cat sat";
  const r = computeTrackEdits(base, cur, PP);
  const marked = applyAll(cur, r.edits);
  assert.equal(marked, cur, "no double-marking");
  assert.ok(!r.edits.some((e) => e.insert.includes(`{${PP}--`)), "no {PP-- session deletion emitted");
  assert.equal(rejectAll(marked), base);
  assert.equal(acceptAll(marked), acceptAll(cur));
});

test("wrap substitution added mid-session: old side not double-marked", () => {
  const base = "the old way";
  const cur = "the {~~old~>new~~} way";
  const r = computeTrackEdits(base, cur, PP);
  const marked = applyAll(cur, r.edits);
  assert.equal(marked, cur, "no double-marking");
  assert.ok(!r.edits.some((e) => e.insert.includes(`{${PP}--`)), "no {PP-- session deletion emitted");
  assert.equal(rejectAll(marked), base);
  assert.equal(acceptAll(marked), acceptAll(cur));
});

test("wrap highlight+comment added mid-session: anchor not double-marked", () => {
  const base = "note this phrase please";
  const cur = "note {==this phrase==}{>>hmm<<} please";
  const r = computeTrackEdits(base, cur, PP);
  const marked = applyAll(cur, r.edits);
  assert.equal(marked, cur, "no double-marking");
  assert.ok(!r.edits.some((e) => e.insert.includes(`{${PP}--`)), "no {PP-- session deletion emitted");
  assert.equal(rejectAll(marked), base);
  assert.equal(acceptAll(marked), acceptAll(cur));
});

// Probe A: an identical word ("old") is genuinely deleted in one place AND
// wrapped by a manual mark elsewhere. Cluster scoping must mark the real
// deletion while leaving the manual mark clean — global word-equality could not.
test("wrap: identical word deleted elsewhere is still marked (cluster-scoped)", () => {
  const base = "old alpha keeps going and later old beta stands";
  const cur = "alpha keeps going and later {--old--} beta stands";
  const r = computeTrackEdits(base, cur, PP);
  const marked = applyAll(cur, r.edits);
  assert.ok(marked.includes(`{${PP}--old --}alpha`), "leading real deletion is marked");
  assert.ok(!/\{[^{}]*--old--\}\{--old--\}/.test(marked), "manual mark not double-wrapped");
  assert.ok(!marked.includes(`{${PP}--old--}{--old--}`), "no spurious mark beside manual mark");
  assert.equal(rejectAll(marked), base);
  assert.equal(acceptAll(marked), acceptAll(cur));
});

// Probe D: a whole sentence genuinely deleted, an identical sentence wrapped.
test("wrap: identical sentence deleted elsewhere is still marked", () => {
  const base = "the cat sat here. middle words stay. the cat sat here.";
  const cur = "middle words stay. {--the cat sat here.--}";
  const r = computeTrackEdits(base, cur, PP);
  const marked = applyAll(cur, r.edits);
  assert.ok(marked.includes(`{${PP}--the cat sat here. --}`), "leading sentence marked, spacing intact");
  assert.equal(rejectAll(marked), base);
  assert.equal(acceptAll(marked), acceptAll(cur));
});

// Probe F: real deletion adjacent to a highlight+comment that wraps identical
// words. Suppression must not orphan whitespace (no `{PP-- bad --}`).
test("wrap: real deletion keeps whitespace; wrapped words not re-marked", () => {
  const base = "remove the bad stuff now and keep the good stuff here";
  const cur = "remove stuff now and keep {==the good==}{>>nice<<} stuff here";
  const r = computeTrackEdits(base, cur, PP);
  const marked = applyAll(cur, r.edits);
  assert.ok(marked.includes(`{${PP}--the bad --}`), "deletion whitespace intact, no orphan space");
  assert.ok(!marked.includes(`{${PP}-- bad`), "no orphaned leading space in deletion body");
  assert.ok(!marked.includes(`{${PP}--the--}`), "no spurious mark beside highlight");
  assert.equal(rejectAll(marked), base);
  assert.equal(acceptAll(marked), acceptAll(cur));
});

// Mirror order: the wrap mark comes BEFORE the real deletion in the document.
test("wrap: wrap-mark before real deletion also round-trips", () => {
  const base = "old alpha beta and old gone";
  const cur = "{--old--} alpha beta and gone";
  const r = computeTrackEdits(base, cur, PP);
  const marked = applyAll(cur, r.edits);
  assert.ok(!marked.includes(`{${PP}--old--}{--old--}`), "manual mark not double-wrapped");
  assert.ok(marked.includes(`{${PP}--old --}gone`), "trailing real deletion is marked");
  assert.equal(rejectAll(marked), base);
  assert.equal(acceptAll(marked), acceptAll(cur));
});

test("too many changes: tooManyChanges flag set, no edits", () => {
  const base = Array.from({ length: 4000 }, (_, i) => `w${i}`).join(" ");
  const cur = Array.from({ length: 4000 }, (_, i) => `x${i}`).join(" ");
  const r = computeTrackEdits(base, cur, PP);
  assert.equal(r.tooManyChanges, true);
  assert.equal(r.edits.length, 0);
});

test("prose changes around an unchanged code block are still marked", () => {
  const base = "aaa\n```\ncode\n```\nbbb";
  const cur = "aaa zzz\n```\ncode\n```\nbbb";
  const r = computeTrackEdits(base, cur, PP);
  const out = applyAll(cur, r.edits);
  assert.ok(out.includes("++"), "prose addition marked");
  assert.ok(out.includes("```\ncode\n```"), "code block untouched");
});

test("safety valve: added text containing a delimiter fragment stays bare", () => {
  const base = "a b";
  const cur = "a broken ++} thing b";
  const r = computeTrackEdits(base, cur, PP);
  const out = applyAll(cur, r.edits);
  assert.ok(out.includes("broken ++} thing"), "unsafe text not wrapped");
  assert.ok(r.counts.unsafeSkipped >= 1);
});

test("safety valve: removed text containing a delimiter fragment is dropped, not marked", () => {
  const base = "a broken ++} thing b";
  const cur = "a b";
  const r = computeTrackEdits(base, cur, PP);
  const out = applyAll(cur, r.edits);
  assert.ok(!out.includes("{--"), "no deletion mark for unsafe text");
});

test("substitution not paired across an atomic token", () => {
  const base = "x one {==hl==} two y";
  const cur = "x uno {==hl==} dos y";
  const r = computeTrackEdits(base, cur, PP);
  const out = applyAll(cur, r.edits);
  assert.ok(out.includes("{==hl==}"), "highlight untouched");
  const parsedMarks = out.match(/\{[^{}]*(\+\+|--|~~)[^{}]*\}/g) ?? [];
  assert.ok(parsedMarks.length >= 2, "two independent changes marked");
});
