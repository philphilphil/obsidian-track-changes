// Operations tests for CriticMarkup Plus (author/date metadata prefix).
// Spec: docs/superpowers/specs/2026-06-14-criticmarkup-plus-design.md §13 (Operations).
// Run with: node test/plus.operations.test.mjs
//
// Self-contained: compiles the TS under test in-memory with esbuild and imports
// it as a base64 data URL, mirroring test/operations.test.mjs exactly.

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
const {
  applyEdits,
  acceptAddition,
  rejectAddition,
  acceptDeletion,
  rejectDeletion,
  acceptSubstitution,
  rejectSubstitution,
  appendReply,
  removeHighlight,
  sanitizeAuthorName,
} = ops;

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

// Local calendar day (YYYY-MM-DD), mirroring formatReplyDate's "date" style.
// Must use local getFullYear/getMonth/getDate, not toISOString (UTC) — west of
// UTC in the evening the two differ by a day and the assertion goes flaky.
const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Parse exactly one node and return it, asserting the count.
function onlyNode(src) {
  const r = parse(src);
  assert.equal(r.nodes.length, 1, `expected exactly one node in ${JSON.stringify(src)}`);
  return r.nodes[0];
}

console.log("plus.operations:");

// ---------------------------------------------------------------------------
// Byte-equality strip per kind: prefixed accept output === bare-mark op output,
// with ZERO prefix bleed into restored content. (§13 Operations, first bullet)
// ---------------------------------------------------------------------------

test("byte-equality strip — addition accept equals bare-mark accept", () => {
  const prefixed = 'x {author="Claude" date="2026-06-14"++ins++} y';
  const bare = "x {++ins++} y";
  const op = applyEdits(prefixed, [acceptAddition(onlyNode(prefixed))]);
  const ref = applyEdits(bare, [acceptAddition(onlyNode(bare))]);
  assert.equal(op, "x ins y");
  assert.equal(op, ref);
  assert.ok(!op.includes("author="), "no author= bleed");
  assert.ok(!op.includes("date="), "no date= bleed");
});

test("byte-equality strip — addition reject equals bare-mark reject", () => {
  const prefixed = 'x {author="Claude" date="2026-06-14"++ins++} y';
  const bare = "x {++ins++} y";
  const op = applyEdits(prefixed, [rejectAddition(onlyNode(prefixed))]);
  const ref = applyEdits(bare, [rejectAddition(onlyNode(bare))]);
  assert.equal(op, "x  y");
  assert.equal(op, ref);
});

test("byte-equality strip — deletion accept equals bare-mark accept", () => {
  const prefixed = 'x {author="Claude" date="2026-06-14"--gone--} y';
  const bare = "x {--gone--} y";
  const op = applyEdits(prefixed, [acceptDeletion(onlyNode(prefixed))]);
  const ref = applyEdits(bare, [acceptDeletion(onlyNode(bare))]);
  assert.equal(op, "x  y");
  assert.equal(op, ref);
});

test("byte-equality strip — deletion reject restores prose with zero prefix bleed", () => {
  const prefixed = 'x {author="Claude" date="2026-06-14"--gone--} y';
  const bare = "x {--gone--} y";
  const op = applyEdits(prefixed, [rejectDeletion(onlyNode(prefixed))]);
  const ref = applyEdits(bare, [rejectDeletion(onlyNode(bare))]);
  assert.equal(op, "x gone y");
  assert.equal(op, ref);
  assert.ok(!op.includes("author="));
  assert.ok(!op.includes("Claude"));
  assert.ok(!op.includes("date="));
});

test("byte-equality strip — substitution accept restores new with zero prefix bleed", () => {
  const prefixed = 'x {author="GPT" date="2026-06-14"~~old~>new~~} y';
  const bare = "x {~~old~>new~~} y";
  const op = applyEdits(prefixed, [acceptSubstitution(onlyNode(prefixed))]);
  const ref = applyEdits(bare, [acceptSubstitution(onlyNode(bare))]);
  assert.equal(op, "x new y");
  assert.equal(op, ref);
  assert.ok(!op.includes("author="));
  assert.ok(!op.includes("GPT"));
});

test("byte-equality strip — substitution reject restores old with zero prefix bleed", () => {
  const prefixed = 'x {author="GPT" date="2026-06-14"~~old~>new~~} y';
  const bare = "x {~~old~>new~~} y";
  const op = applyEdits(prefixed, [rejectSubstitution(onlyNode(prefixed))]);
  const ref = applyEdits(bare, [rejectSubstitution(onlyNode(bare))]);
  assert.equal(op, "x old y");
  assert.equal(op, ref);
  assert.ok(!op.includes("author="));
  assert.ok(!op.includes("GPT"));
});

test("byte-equality strip — highlight remove equals bare-mark remove", () => {
  const prefixed = 'x {author="A"==important==} y';
  const bare = "x {==important==} y";
  const op = applyEdits(prefixed, [removeHighlight(onlyNode(prefixed))]);
  const ref = applyEdits(bare, [removeHighlight(onlyNode(bare))]);
  assert.equal(op, "x important y");
  assert.equal(op, ref);
  assert.ok(!op.includes("author="));
});

// ---------------------------------------------------------------------------
// Spec-named round trips. (§13 Operations bullets)
// ---------------------------------------------------------------------------

test("deletion-reject keeps prose", () => {
  const src = 'Keep {author="Claude" date="2026-06-14"--this sentence--} here.';
  const out = applyEdits(src, [rejectDeletion(onlyNode(src))]);
  assert.equal(out, "Keep this sentence here.");
});

test("deletion-accept applies", () => {
  const src = 'Drop {author="Claude"--this--} it.';
  const out = applyEdits(src, [acceptDeletion(onlyNode(src))]);
  assert.equal(out, "Drop  it.");
});

test("substitution-reject restores old / accept uses new", () => {
  const src = 'The {author="GPT"~~old word~>new word~~} stays.';
  const rej = applyEdits(src, [rejectSubstitution(onlyNode(src))]);
  assert.equal(rej, "The old word stays.");
  const acc = applyEdits(src, [acceptSubstitution(onlyNode(src))]);
  assert.equal(acc, "The new word stays.");
});

test("addition accept keeps text / reject removes", () => {
  const src = 'Add {author="A" date="2026-06-14"++X++}.';
  const acc = applyEdits(src, [acceptAddition(onlyNode(src))]);
  assert.equal(acc, "Add X.");
  const rej = applyEdits(src, [rejectAddition(onlyNode(src))]);
  assert.equal(rej, "Add .");
});

test("highlight remove keeps inner text", () => {
  const src = '{author="A"==important==}';
  const out = applyEdits(src, [removeHighlight(onlyNode(src))]);
  assert.equal(out, "important");
});

// ---------------------------------------------------------------------------
// Non-overlap with adjacency. (§13 Operations)
// ---------------------------------------------------------------------------

test("non-overlap with adjacency — accept(A)+reject(B) yields x, no throw", () => {
  const src = '{author="A"++x++}{author="B"--y--}';
  const r = parse(src);
  assert.equal(r.nodes.length, 2);
  // Two non-overlapping nodes: next.from >= prev.to.
  assert.ok(r.nodes[1].from >= r.nodes[0].to, "adjacent nodes do not overlap");
  const a = r.nodes[0].kind === "addition" ? r.nodes[0] : r.nodes[1];
  const b = r.nodes[0].kind === "deletion" ? r.nodes[0] : r.nodes[1];
  let out;
  assert.doesNotThrow(() => {
    out = applyEdits(src, [acceptAddition(a), acceptDeletion(b)]);
  });
  // accept addition (keep x) + accept deletion (remove y) => "x"
  assert.equal(out, "x");
});

// ---------------------------------------------------------------------------
// Reply stamping. (§13 Operations — Reply stamping)
// ---------------------------------------------------------------------------

test('appendReply with localAuthorName writes quoted author + date', () => {
  const src = "{>>root<<}";
  const parsed = parse(src);
  const edit = appendReply(src, parsed.threads[0], parsed, "my reply", "Phil");
  // date is real-clock; assert structure, not the literal date.
  assert.match(edit.insert, /^\{author="Phil" date="\d{4}-\d{2}-\d{2}">>my reply<<\}$/);
  // Round-trips: re-parsing the inserted reply yields author Phil.
  const re = parse(edit.insert);
  assert.equal(re.nodes[0].metaAuthor, "Phil");
});

test('appendReply with empty localAuthorName writes date only (→ You)', () => {
  const src = "{>>root<<}";
  const parsed = parse(src);
  const edit = appendReply(src, parsed.threads[0], parsed, "r", "");
  assert.match(edit.insert, /^\{date="\d{4}-\d{2}-\d{2}">>r<<\}$/);
  assert.equal(parse(edit.insert).nodes[0].metaAuthor, null);
});

test('appendReply name with spaces survives (quotes allow whitespace)', () => {
  const src = "{>>root<<}";
  const parsed = parse(src);
  const edit = appendReply(src, parsed.threads[0], parsed, "r", "Phil Baum");
  assert.match(edit.insert, /^\{author="Phil Baum" date="[^"]+">>r<<\}$/);
  assert.equal(parse(edit.insert).nodes[0].metaAuthor, "Phil Baum");
});

test("appendReply sanitizes structural chars but keeps a clean single line", () => {
  const src = "{>>root<<}";
  const parsed = parse(src);
  const edit = appendReply(src, parsed.threads[0], parsed, "r", 'E"vil{}\nName');
  const re = parse(edit.insert);
  assert.equal(re.nodes.length, 1);
  assert.equal(re.nodes[0].metaAuthor, "EvilName");
});

test("appendReply datetime style stamps a full ISO timestamp", () => {
  const src = "{>>root<<}";
  const parsed = parse(src);
  const edit = appendReply(src, parsed.threads[0], parsed, "r", "Phil", "datetime");
  assert.match(edit.insert, /date="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z"/);
});

test('sanitizeAuthorName keeps `;`, `=`, `-`, spaces; drops `"{}` and control', () => {
  assert.equal(sanitizeAuthorName('A; B=C-D'), "A; B=C-D");
  // `"{}`  are dropped; the surrounding spaces are kept (the value class allows them).
  assert.equal(sanitizeAuthorName('x"{}  y'), "x  y");
});

test("reply stamping — localAuthorName=Phil stamps author + today, re-parses to Phil", () => {
  const src = "x {>>Claude: a<<} y";
  const r = parse(src);
  const edit = appendReply(src, r.threads[0], r, "r", "Phil");
  const out = applyEdits(src, [edit]);
  assert.equal(out, `x {>>Claude: a<<}{author="Phil" date="${TODAY}">>r<<} y`);
  assert.ok(ISO_DATE.test(TODAY), "today matches YYYY-MM-DD");
  const r2 = parse(out);
  assert.equal(r2.threads.length, 1);
  assert.equal(r2.threads[0].replyIndexes.length, 1);
  const reply = r2.nodes[r2.threads[0].replyIndexes[0]];
  assert.equal(reply.kind, "comment");
  assert.equal(reply.metaAuthor, "Phil");
  assert.equal(reply.metaDate, TODAY);
  assert.equal(reply.text, "r");
});

test("reply stamping — empty localAuthorName writes date only, no author=, re-parses metaAuthor null", () => {
  const src = "x {>>Claude: a<<} y";
  const r = parse(src);
  const edit = appendReply(src, r.threads[0], r, "r", "");
  const out = applyEdits(src, [edit]);
  assert.equal(out, `x {>>Claude: a<<}{date="${TODAY}">>r<<} y`);
  assert.ok(!edit.insert.includes("author="), "never writes an empty author=");
  const r2 = parse(out);
  const reply = r2.nodes[r2.threads[0].replyIndexes[0]];
  assert.equal(reply.metaAuthor, null);
  assert.equal(reply.metaDate, TODAY);
});

test("reply stamping — defaulted localAuthorName arg behaves as empty", () => {
  const src = "x {>>Claude: a<<} y";
  const r = parse(src);
  const edit = appendReply(src, r.threads[0], r, "r");
  const out = applyEdits(src, [edit]);
  assert.equal(out, `x {>>Claude: a<<}{date="${TODAY}">>r<<} y`);
});

test("reply stamping — sanitization strips structural chars and still parses as one comment", () => {
  const src = "x {>>Claude: a<<} y";
  const r = parse(src);
  const dangerous = 'Phil author="Mallory"{}';
  const edit = appendReply(src, r.threads[0], r, "r", dangerous);
  const out = applyEdits(src, [edit]);
  // The stamped prefix must contain no structural chars the quoted-value class
  // forbids. Extract just the author value the stamper wrote.
  const m = out.match(/\{author="([^"]*)" date=/);
  assert.ok(m, "stamped an author= value");
  const authorVal = m[1];
  for (const ch of ['"', "{", "}"]) {
    assert.ok(!authorVal.includes(ch), `sanitized name still contains ${ch}`);
  }
  // Whole thing parses as exactly one extra comment (the reply), attributed to
  // the sanitized name, and rebase-able (one comment node added).
  const r2 = parse(out);
  assert.equal(r2.threads.length, 1);
  assert.equal(r2.threads[0].replyIndexes.length, 1);
  const reply = r2.nodes[r2.threads[0].replyIndexes[0]];
  assert.equal(reply.kind, "comment");
  assert.equal(reply.metaAuthor, authorVal);
  assert.equal(reply.text, "r");
});

test("reply stamping — date always matches YYYY-MM-DD in the written mark", () => {
  const src = "x {>>Claude: a<<} y";
  const r = parse(src);
  const edit = appendReply(src, r.threads[0], r, "r", "Phil");
  const m = edit.insert.match(/date="([^"]*)">>/);
  assert.ok(m, "reply carries a date=");
  assert.ok(ISO_DATE.test(m[1]), `stamped date ${m[1]} is YYYY-MM-DD`);
});

// Fail-closed anchors on the reply edit: expected="" and before=last.raw, which
// now includes the previous comment's prefix (§7.4). Verify the anchor carries
// the prefix so uniqueness only tightens.
test("reply stamping — before anchor includes the previous comment's prefix", () => {
  const src = 'x {author="Bob" date="2026-06-14">>root<<} y';
  const r = parse(src);
  const edit = appendReply(src, r.threads[0], r, "r", "Phil");
  assert.equal(edit.expected, "");
  assert.equal(edit.before, '{author="Bob" date="2026-06-14">>root<<}');
  assert.ok(edit.before.includes('author="Bob"'), "anchor includes prefix");
});

// ---------------------------------------------------------------------------
// Substitution-ordering safety: a ~~…~> body whose new side contains an inner
// ==…== must accept/reject byte-identically to the bare-prefix equivalent. (§13)
// ---------------------------------------------------------------------------

test("substitution-ordering safety — inner ==…== preserved on accept/reject", () => {
  const prefixed = 'p {author="X"~~a~>b==c==d~~} q';
  const bare = "p {~~a~>b==c==d~~} q";
  const np = onlyNode(prefixed);
  const nb = onlyNode(bare);
  assert.equal(np.kind, "substitution");
  assert.equal(np.oldText, "a");
  assert.equal(np.newText, "b==c==d");
  const accP = applyEdits(prefixed, [acceptSubstitution(np)]);
  const accB = applyEdits(bare, [acceptSubstitution(nb)]);
  assert.equal(accP, "p b==c==d q");
  assert.equal(accP, accB);
  const rejP = applyEdits(prefixed, [rejectSubstitution(np)]);
  const rejB = applyEdits(bare, [rejectSubstitution(nb)]);
  assert.equal(rejP, "p a q");
  assert.equal(rejP, rejB);
});

// ---------------------------------------------------------------------------
// Corruption guard at the operations level: the --inside-date straddle must NOT
// produce a single mark spanning a comment and a real deletion; rejecting it
// must never corrupt the document. The legit single brace must survive. (§4.6,
// §13 corruption cases — operations consequence.)
// ---------------------------------------------------------------------------

test("corruption guard — malformed --date does not straddle; real deletion survives an op", () => {
  // `date="2026--bad` has no closing quote before the sigil, so the bogus
  // comment forms no mark at all under the quoted grammar — it can never hand
  // its `--` to the deletion sigil and straddle. The genuine deletion is
  // therefore the only surviving mark.
  const src = '{author="X" date="2026--bad>>c<<} and {--realdel--}';
  const r = parse(src);
  // No single node may span from the comment's `{` to the real deletion's `}`.
  for (const n of r.nodes) {
    const spansBoth = n.raw.includes(">>c<<") && n.raw.includes("realdel");
    assert.ok(!spansBoth, "a mark straddled the comment and the real deletion");
  }
  // The genuine deletion must still be present and actionable.
  const del = r.nodes.find((n) => n.kind === "deletion" && n.text === "realdel");
  assert.ok(del, "the real {--realdel--} deletion survived parsing");
  const out = applyEdits(src, [rejectDeletion(del)]);
  // rejectDeletion keeps "realdel"; the bogus prefix text stays literal, untouched.
  assert.equal(out, '{author="X" date="2026--bad>>c<<} and realdel');
});

test("corruption guard — short malformed date forms no mark (no op can restore it)", () => {
  // Under the quoted grammar `date="2026--6--deleted--}` is simply no mark: the
  // truncated date value isn't closed by a `"`, so there is no deletion to
  // reject and `6--deleted` can never be resurrected as user prose.
  const src = '{date="2026--6--deleted--}';
  const r = parse(src);
  assert.equal(r.nodes.length, 0, "malformed --date forms no mark at all");
});

test("legit single brace in deletion survives and reject restores it verbatim", () => {
  const src = "x {--remove the {foo} placeholder--} y";
  const n = onlyNode(src);
  assert.equal(n.kind, "deletion");
  assert.equal(n.text, "remove the {foo} placeholder");
  const out = applyEdits(src, [rejectDeletion(n)]);
  assert.equal(out, "x remove the {foo} placeholder y");
});

// ---------------------------------------------------------------------------
// Anchor / fail-closed: every accept/reject edit carries expected === node.raw
// (including the prefix), so a drifted prefix fails closed rather than corrupts.
// (§7.2, §14 risk 5 — operations consequence.)
// ---------------------------------------------------------------------------

test("edit expected === node.raw and includes the prefix (all five kinds)", () => {
  const cases = [
    ['{author="A" date="2026-06-14"++t++}', acceptAddition],
    ['{author="A" date="2026-06-14"--t--}', rejectDeletion],
    ['{author="A"~~o~>n~~}', acceptSubstitution],
    ['{author="A">>c<<}', null], // comment: no accept/reject; check raw spans prefix
    ['{author="A"==t==}', removeHighlight],
  ];
  for (const [src, opFn] of cases) {
    const n = onlyNode(src);
    assert.equal(n.raw, src, `raw must span outer-brace to outer-brace for ${src}`);
    assert.ok(n.raw.includes('author="A"'), `raw includes the prefix for ${src}`);
    if (opFn) {
      const edit = opFn(n);
      assert.equal(edit.expected, n.raw, `expected === raw for ${src}`);
      assert.ok(edit.expected.includes('author="A"'), `expected includes prefix for ${src}`);
    }
  }
});

console.log("done.");
