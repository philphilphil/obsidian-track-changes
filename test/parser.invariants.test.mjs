// Parser invariants the rest of the plugin relies on. These pin the contracts
// that the editor decorations, reading-mode post-processor, panel, and the
// accept/reject/finalize edit builders all assume about parse() output. They
// fail fast if a future parser change quietly breaks one of those assumptions.
//
// Run with: node test/parser.invariants.test.mjs
//
// Coverage map:
//   A  node.raw is the verbatim source slice for all six kinds (the anchor
//      contract — edits slice raw out of the document by [from, to))
//   B  parse().nodes are sorted and non-overlapping after the dedup pass
//   C  delete / substitution bodies with newlines or blank lines stay ONE node
//   D  thread adjacency: only inline space/tab between two {>>..<<} markers makes
//      a reply; any line break or prose splits them into separate threads
//   E  metadata prefix (author="..." date="...") parses onto metaAttrs /
//      metaAuthor / metaDate, and a malformed prefix fails locally
//   F  legacy {>>Name: ..<<} author prefix still parses (back-compat)
//   G  markup whose endpoints sit inside a code region is inert (boundary seam)
//   H  AI-added text {=+..+=} is the sixth kind: same raw / dedup / metadata
//      contracts, but visual-only — never a thread participant

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Compile the TS source through esbuild and import it as an ES module, so the
// test runs against the real parser without a separate build step.
async function load(rel) {
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

const { parse } = await load("../src/parser.ts");

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

console.log("parser.invariants:");

// A. node.raw is the verbatim source slice across all six kinds.
test("A node.raw is the verbatim source slice for all 6 kinds", () => {
  const src =
    "{++add++} {--del--} {~~old~>new~~} {>>Bob: comment<<} {==highlight==} {=+aitext+=}";
  const r = parse(src);
  assert.equal(r.nodes.length, 6);
  const byKind = Object.fromEntries(r.nodes.map((n) => [n.kind, n]));
  assert.equal(byKind.addition.raw, "{++add++}");
  assert.equal(byKind.deletion.raw, "{--del--}");
  assert.equal(byKind.substitution.raw, "{~~old~>new~~}");
  assert.equal(byKind.comment.raw, "{>>Bob: comment<<}");
  assert.equal(byKind.highlight.raw, "{==highlight==}");
  assert.equal(byKind.aitext.raw, "{=+aitext+=}");
  // raw must always equal the slice it claims to span — the anchor contract.
  for (const n of r.nodes) {
    assert.equal(n.raw, src.slice(n.from, n.to), `${n.kind} raw != slice`);
  }
});

// B. Accepted nodes are non-overlapping after dedup. A substitution's interior
// (`{++ins++}`) re-matches as a smaller addition; dedup must drop the contained
// node so the returned list never overlaps.
test("B parse().nodes are sorted and non-overlapping after dedup", () => {
  const src = "before {~~{++ins++}~>out~~} after {==hi==} {>>note<<}";
  const r = parse(src);
  let lastEnd = -1;
  for (const n of r.nodes) {
    assert.ok(n.from >= lastEnd, `node at ${n.from} overlaps prev end ${lastEnd}`);
    assert.ok(n.to > n.from, "node has non-positive span");
    lastEnd = n.to;
  }
  // The interior {++ins++} must NOT survive as its own node.
  assert.ok(
    !r.nodes.some((n) => n.kind === "addition" && n.raw === "{++ins++}"),
    "interior addition leaked past dedup"
  );
});

// C. Multiline bodies stay one node — the body matchers are non-greedy over
// [\s\S], so a newline or a blank line inside the body must not split it.
test("C deletion body with newline parses as ONE node", () => {
  const r = parse("{--line1\nline2--}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "deletion");
  assert.equal(r.nodes[0].text, "line1\nline2");
});

test("C deletion body with blank line parses as ONE node", () => {
  const r = parse("{--line1\n\nline2--}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "deletion");
  assert.equal(r.nodes[0].text, "line1\n\nline2");
});

test("C substitution body with newline parses as ONE node", () => {
  const r = parse("{~~old\nold2~>new\nnew2~~}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "substitution");
  assert.equal(r.nodes[0].oldText, "old\nold2");
  assert.equal(r.nodes[0].newText, "new\nnew2");
});

test("C substitution body with blank line parses as ONE node", () => {
  const r = parse("{~~old\n\nold2~>new\n\nnew2~~}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "substitution");
  assert.equal(r.nodes[0].oldText, "old\n\nold2");
  assert.equal(r.nodes[0].newText, "new\n\nnew2");
});

// D. Thread adjacency. Two {>>..<<} markers form a thread (root + reply) only
// when the gap between them is inline whitespace — spaces or tabs. Any line
// break (LF, CR, CRLF), blank line, or prose splits them into separate threads.
// CR is the trap: it is not inline whitespace, so a CRLF gap must split. Pin it
// so a future "be lenient about whitespace" change can't silently merge comments
// across a line boundary.
test("D space gap forms ONE thread (root + reply)", () => {
  const r = parse("{>>root<<} {>>reply<<}");
  assert.equal(r.threads.length, 1);
  assert.equal(r.threads[0].replyIndexes.length, 1);
  assert.equal(r.nodeThread[0], 0);
  assert.equal(r.nodeThread[1], 0);
});

test("D tab gap forms ONE thread", () => {
  const r = parse("{>>root<<}\t{>>reply<<}");
  assert.equal(r.threads.length, 1);
  assert.equal(r.threads[0].replyIndexes.length, 1);
});

test("D LF gap SPLITS into two threads", () => {
  const r = parse("{>>a<<}\n{>>b<<}");
  assert.equal(r.threads.length, 2);
  assert.equal(r.threads[0].replyIndexes.length, 0);
  assert.equal(r.threads[1].replyIndexes.length, 0);
});

test("D CRLF gap SPLITS into two threads (\\r is not inline whitespace)", () => {
  const r = parse("{>>a<<}\r\n{>>b<<}");
  assert.equal(r.threads.length, 2, "CRLF gap must not group comments into one thread");
  assert.equal(r.threads[0].replyIndexes.length, 0);
  assert.equal(r.threads[1].replyIndexes.length, 0);
});

test("D lone CR gap SPLITS into two threads", () => {
  const r = parse("{>>a<<}\r{>>b<<}");
  assert.equal(r.threads.length, 2, "bare CR gap must not group comments");
});

test("D blank line gap SPLITS into two threads", () => {
  const r = parse("{>>a<<}\n\n{>>b<<}");
  assert.equal(r.threads.length, 2);
});

test("D trailing-space-then-CRLF gap still SPLITS (mixed inline + line break)", () => {
  // A reply requires the WHOLE gap to be inline whitespace. " \r\n" contains a
  // line break, so it must not group even though it starts with a space.
  const r = parse("{>>a<<} \r\n{>>b<<}");
  assert.equal(r.threads.length, 2);
});

test("D prose between two comments SPLITS into two threads", () => {
  const r = parse("{>>a<<} and {>>b<<}");
  assert.equal(r.threads.length, 2);
});

// E. Inline metadata prefix. A run of key="value" pairs between the outer `{`
// and the kind sigil surfaces on metaAttrs (every key, lowercased) plus the
// typed accessors metaAuthor / metaDate. The prefix is stripped from the node's
// payload (text / inner range). A value may not contain " { } or a newline — a
// truncated or otherwise malformed prefix collapses and the mark fails to form
// LOCALLY, so it can never swallow following text.
test("E author + date prefix on an addition surfaces on metaAttrs and accessors", () => {
  const r = parse('{author="Claude" date="2026-06-22T14:03Z"++added++}');
  assert.equal(r.nodes.length, 1);
  const n = r.nodes[0];
  assert.equal(n.kind, "addition");
  assert.equal(n.text, "added", "prefix must be stripped from the payload");
  assert.equal(n.metaAuthor, "Claude");
  assert.equal(n.metaDate, "2026-06-22T14:03Z");
  assert.equal(n.metaAttrs.author, "Claude");
  assert.equal(n.metaAttrs.date, "2026-06-22T14:03Z");
  assert.equal(n.metaRaw, 'author="Claude" date="2026-06-22T14:03Z"');
});

test("E author prefix on a comment surfaces metaAuthor", () => {
  const r = parse('{author="gpt">>note<<}');
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "comment");
  assert.equal(r.nodes[0].metaAuthor, "gpt");
  assert.equal(r.nodes[0].metaDate, null);
  assert.equal(r.nodes[0].text, "note");
});

test("E date-only prefix sets metaDate and leaves metaAuthor null", () => {
  const r = parse('{date="2026-06-22"~~old~>new~~}');
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "substitution");
  assert.equal(r.nodes[0].metaDate, "2026-06-22");
  assert.equal(r.nodes[0].metaAuthor, null);
});

test("E a mark with no prefix has empty metaAttrs and empty metaRaw", () => {
  const r = parse("{++added++}");
  assert.equal(r.nodes.length, 1);
  assert.deepEqual(r.nodes[0].metaAttrs, {});
  assert.equal(r.nodes[0].metaAuthor, null);
  assert.equal(r.nodes[0].metaRaw, "");
});

test("E an empty value is dropped from metaAttrs but the mark still forms", () => {
  const r = parse('{author=""++t++}');
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "addition");
  assert.equal(r.nodes[0].text, "t");
  assert.deepEqual(r.nodes[0].metaAttrs, {}, "empty value must not appear as a key");
  assert.equal(r.nodes[0].metaAuthor, null);
});

test("E an unterminated value yields NO node (fails locally, no downstream swallow)", () => {
  // The value opens with `"` and meets the kind sigil before any closing quote,
  // so the prefix collapses and the mark never forms — rather than consuming the
  // rest of the line as a value.
  assert.equal(parse('{date="2026++added++}').nodes.length, 0);
});

test("E a malformed prefix does not eat a later valid mark", () => {
  // Same line: the corrupt mark fails to form, the following {++ok++} still does.
  const same = parse('{date="2026++x++} {++ok++}');
  assert.equal(same.nodes.length, 1);
  assert.equal(same.nodes[0].text, "ok");
  // Across a newline: identical containment.
  const across = parse('{date="2026\n{++ok++}');
  assert.equal(across.nodes.length, 1);
  assert.equal(across.nodes[0].text, "ok");
});

test("E a brace inside a value is illegal, so the mark fails to form", () => {
  assert.equal(parse('{author="a{b"++t++}').nodes.length, 0);
});

// F. Legacy author prefix. Before the metadata grammar, comments carried an
// author as a `{>>Name: ..<<}` body prefix (single alpha-leading token, <= 30
// chars). The parser still reads it for back-compat and exposes it as
// CommentNode.authorName; newer documents use the author="..." form above.
function authorOf(src) {
  const r = parse(src);
  const c = r.nodes.find((n) => n.kind === "comment");
  return c ? c.authorName : undefined;
}

test("F legacy <Name>: prefix is captured as authorName (original casing)", () => {
  assert.equal(authorOf("{>>gpt: hi<<}"), "gpt");
});

test("F legacy prefix that is not a single alpha-leading token falls back to null", () => {
  assert.equal(authorOf("{>>see line 4: bad<<}"), null); // multi-word phrase
  assert.equal(authorOf("{>>4chan: hi<<}"), null);       // digit-leading
  assert.equal(authorOf(`{>>${"a".repeat(31)}: hi<<}`), null); // over 30 chars
});

// G. Code regions are inert. A CriticMarkup marker whose endpoints sit inside an
// inline code span or a fenced block must not parse; markup just outside the
// region must. These pin the off-by-one seam where "just inside" vs "just
// outside" code is decided. (Fence mechanics themselves are covered in
// parser.edge.test.mjs — not re-tested here.)
test("G marker wholly inside an inline span is inert", () => {
  const r = parse("text `{++x++}` more");
  assert.equal(r.nodes.length, 0, "marker wholly inside an inline span yields no node");
});

test("G marker immediately AFTER a closing backtick parses", () => {
  const r = parse("a `code`{++real++} b");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "addition");
  assert.equal(r.nodes[0].text, "real");
});

test("G marker immediately BEFORE an opening backtick parses", () => {
  const r = parse("a {++real++}`code` b");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].text, "real");
});

test("G marker on the line directly after a fence closer parses", () => {
  const r = parse("```\ncode\n```\n{++real++}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].text, "real");
});

test("G marker on the line directly before a fence opener parses", () => {
  const r = parse("{++real++}\n```\ncode\n```");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].text, "real");
});

test("G marker riding the fence's opening line is inert; real prose after the close parses", () => {
  const r = parse("```js {++fake++}\ncode\n```\n{++real++}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].text, "real");
});

// H. AI-added text ({=+..+=}) is the sixth parse() kind: a visual-only mark.
// It obeys the same raw-slice and dedup contracts as the other kinds and
// carries the metadata prefix, but is NEVER a thread participant (no review
// card) — pin that so a future change can't quietly give it thread semantics.
test("H aitext is the 6th kind; raw is the verbatim slice and sigils strip", () => {
  const src = "{=+ai text+=}";
  const r = parse(src);
  assert.equal(r.nodes.length, 1);
  const n = r.nodes[0];
  assert.equal(n.kind, "aitext");
  assert.equal(n.text, "ai text", "sigils must strip from the payload");
  assert.equal(n.raw, src.slice(n.from, n.to), "aitext raw != slice");
});

test("H aitext carries the metadata prefix like the other kinds", () => {
  const r = parse('{author="Claude"=+x+=}');
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "aitext");
  assert.equal(r.nodes[0].metaAuthor, "Claude");
  assert.equal(r.nodes[0].text, "x");
});

test("H aitext is never a thread participant (nodeThread -1, no thread)", () => {
  const r = parse("{=+inserted+=}");
  assert.equal(r.threads.length, 0);
  assert.equal(r.nodeThread[0], -1);
});

test("H an aitext mark between two comments SPLITS them (gap isn't whitespace)", () => {
  const r = parse("{>>a<<} {=+x+=} {>>b<<}");
  assert.equal(r.threads.length, 2, "non-whitespace between comments must not group them");
  const ai = r.nodes.findIndex((n) => n.kind === "aitext");
  assert.equal(r.nodeThread[ai], -1);
});

test("H a nested mark inside an aitext body collapses into it (dedup), no thread", () => {
  const r = parse("{=+outer {>>inner<<} text+=}");
  assert.equal(r.nodes.length, 1, "the inner comment must not survive dedup");
  assert.equal(r.nodes[0].kind, "aitext");
  assert.equal(r.threads.length, 0, "the swallowed comment must not form a thread");
});
