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
  buildAttributionPrefix,
  validateReplyText,
  deleteCommentNode,
  deleteThread,
  removeHighlight,
  removeAiText,
  finalizeEdits,
  DEFAULT_FINALIZE,
  findChangeAt,
  acceptChange,
  rejectChange,
  editsAtCursor,
} = ops;

// Local calendar day (YYYY-MM-DD), mirroring formatReplyDate's "date" style.
// Must use local getFullYear/getMonth/getDate, not toISOString (UTC) — west of
// UTC in the evening the two differ by a day and the assertion goes flaky.
function localDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

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

console.log("operations:");

test("acceptAddition keeps the text", () => {
  const src = "x {++ins++} y";
  const r = parse(src);
  const out = applyEdits(src, [acceptAddition(r.nodes[0])]);
  assert.equal(out, "x ins y");
});

test("rejectAddition removes the block", () => {
  const src = "x {++ins++} y";
  const r = parse(src);
  const out = applyEdits(src, [rejectAddition(r.nodes[0])]);
  assert.equal(out, "x  y");
});

test("acceptDeletion removes the block", () => {
  const src = "x {--gone--} y";
  const r = parse(src);
  const out = applyEdits(src, [acceptDeletion(r.nodes[0])]);
  assert.equal(out, "x  y");
});

test("rejectDeletion keeps the text", () => {
  const src = "x {--gone--} y";
  const r = parse(src);
  const out = applyEdits(src, [rejectDeletion(r.nodes[0])]);
  assert.equal(out, "x gone y");
});

test("acceptSubstitution uses new text", () => {
  const src = "x {~~old~>new~~} y";
  const r = parse(src);
  const out = applyEdits(src, [acceptSubstitution(r.nodes[0])]);
  assert.equal(out, "x new y");
});

test("rejectSubstitution keeps old text", () => {
  const src = "x {~~old~>new~~} y";
  const r = parse(src);
  const out = applyEdits(src, [rejectSubstitution(r.nodes[0])]);
  assert.equal(out, "x old y");
});

test("removeHighlight strips the wrapper and keeps the text", () => {
  const src = "x {==look here==} y";
  const r = parse(src);
  const out = applyEdits(src, [removeHighlight(r.nodes[0])]);
  assert.equal(out, "x look here y");
});

test("removeAiText strips the wrapper and keeps the text", () => {
  const src = "x {=+added here+=} y";
  const r = parse(src);
  const edit = removeAiText(r.nodes[0]);
  assert.equal(edit.expected, "{=+added here+=}");
  assert.equal(edit.insert, "added here");
  const out = applyEdits(src, [edit]);
  assert.equal(out, "x added here y");
});

test("deleteCommentNode removes one message of a thread", () => {
  const src = "x {>>Claude: a<<}{>>done<<} y";
  const r = parse(src);
  const out = applyEdits(src, [deleteCommentNode(r.nodes[1])]);
  assert.equal(out, "x {>>Claude: a<<} y");
});

test("deleteThread removes all messages", () => {
  const src = "x {>>Claude: a<<}{>>done<<} y";
  const r = parse(src);
  const out = applyEdits(src, [deleteThread(src, r.threads[0])]);
  assert.equal(out, "x  y");
});

test("appendReply inserts adjacent with a date= prefix", () => {
  // Spec §7.4: replies the plugin writes ALWAYS stamp date=<today>; with an
  // empty localAuthorName there is no author= (resolves to "You").
  const today = localDay();
  const src = "x {>>Claude: a<<} y";
  const r = parse(src);
  const edit = appendReply(src, r.threads[0], r, "thanks");
  const out = applyEdits(src, [edit]);
  assert.equal(out, `x {>>Claude: a<<}{date="${today}">>thanks<<} y`);
  // and the new structure parses as a single thread with one reply
  const r2 = parse(out);
  assert.equal(r2.threads.length, 1);
  assert.equal(r2.threads[0].replyIndexes.length, 1);
  assert.equal(r2.nodes[1].authorName, null);
  assert.equal(r2.nodes[1].metaAuthor, null);
  assert.equal(r2.nodes[1].metaDate, today);
});

test("appendReply attaches after the last message of an existing thread", () => {
  const today = localDay();
  const src = "x {>>Claude: a<<}{>>ignore<<} y";
  const r = parse(src);
  const edit = appendReply(src, r.threads[0], r, "actually no");
  const out = applyEdits(src, [edit]);
  assert.equal(out, `x {>>Claude: a<<}{>>ignore<<}{date="${today}">>actually no<<} y`);
});

test("appendReply rejects comment closing delimiters in reply text", () => {
  const src = "x {>>Claude: a<<} y";
  const r = parse(src);
  assert.equal(
    validateReplyText("please keep <<} and continue"),
    "Replies cannot contain the CriticMarkup comment closing marker <<}.",
  );
  assert.throws(
    () => appendReply(src, r.threads[0], r, "please keep <<} and continue"),
    /CriticMarkup comment closing marker/,
  );
});

test("applyEdits handles multiple non-overlapping edits", () => {
  const src = "a {++x++} b {--y--} c";
  const r = parse(src);
  const out = applyEdits(src, [acceptAddition(r.nodes[0]), acceptDeletion(r.nodes[1])]);
  assert.equal(out, "a x b  c");
});

test("finalizeEdits with defaults: keep additions, keep original prose", () => {
  const src = "a {++x++} b {--y--} c {~~o~>n~~} d {>>Claude: note<<}";
  const r = parse(src);
  const out = applyEdits(src, finalizeEdits(r, DEFAULT_FINALIZE));
  // default: additions accept, deletions reject (keep), subs reject (keep old), strip comments
  assert.equal(out, "a x b y c o d ");
});

test("finalizeEdits with accept-all", () => {
  const src = "a {++x++} b {--y--} c {~~o~>n~~} d";
  const r = parse(src);
  const opts = { additions: "accept", deletions: "accept", substitutions: "accept", stripHighlights: true };
  const out = applyEdits(src, finalizeEdits(r, opts));
  assert.equal(out, "a x b  c n d");
});

test("buildAttributionPrefix: date only when no author", () => {
  const p = buildAttributionPrefix("", "date", new Date(2026, 6, 24, 12, 0, 0));
  assert.equal(p, 'date="2026-07-24"');
});

test("buildAttributionPrefix: author + date when name set", () => {
  const p = buildAttributionPrefix("Phil", "date", new Date(2026, 6, 24));
  assert.equal(p, 'author="Phil" date="2026-07-24"');
});

test("buildAttributionPrefix: datetime style", () => {
  const p = buildAttributionPrefix("", "datetime", new Date(Date.UTC(2026, 6, 24, 12, 23, 46)));
  assert.equal(p, 'date="2026-07-24T12:23:46Z"');
});

test("buildAttributionPrefix: sanitizes and trims the name", () => {
  const p = buildAttributionPrefix('  P{h}i"l\n ', "date", new Date(2026, 6, 24));
  assert.equal(p, 'author="Phil" date="2026-07-24"');
});

test("findChangeAt: inside, at from, at to", () => {
  const src = "x {++ins++} y";
  const nodes = parse(src).nodes;
  assert.equal(findChangeAt(nodes, 5)?.kind, "addition");
  assert.equal(findChangeAt(nodes, 2)?.kind, "addition");
  assert.equal(findChangeAt(nodes, 11)?.kind, "addition");
});

test("findChangeAt: just outside returns null", () => {
  const nodes = parse("x {++ins++} y").nodes;
  assert.equal(findChangeAt(nodes, 1), null);
  assert.equal(findChangeAt(nodes, 12), null);
});

test("findChangeAt: ignores comments, highlights, aitext", () => {
  const src = "{>>c<<} {==h==} {=+a+=}";
  const nodes = parse(src).nodes;
  assert.equal(nodes.length, 3);
  for (let i = 0; i <= src.length; i++) assert.equal(findChangeAt(nodes, i), null);
});

test("findChangeAt: prefixed mark spans its prefix", () => {
  const src = 'x {author="AI" --gone--} y';
  const nodes = parse(src).nodes;
  assert.equal(findChangeAt(nodes, 3)?.kind, "deletion");
  assert.equal(findChangeAt(nodes, src.indexOf("} y") + 1)?.kind, "deletion");
});

test("findChangeAt: adjacent marks pick the first", () => {
  const src = "{++a++}{--b--}";
  const nodes = parse(src).nodes;
  assert.equal(findChangeAt(nodes, 7)?.kind, "addition");
  assert.equal(findChangeAt(nodes, 8)?.kind, "deletion");
});

test("acceptChange/rejectChange dispatch per kind", () => {
  const cases = [
    ["x {++ins++} y", "x ins y", "x  y"],
    ["x {--gone--} y", "x  y", "x gone y"],
    ["x {~~old~>new~~} y", "x new y", "x old y"],
  ];
  for (const [src, accepted, rejected] of cases) {
    const node = findChangeAt(parse(src).nodes, 4);
    assert.equal(applyEdits(src, [acceptChange(node)]), accepted);
    assert.equal(applyEdits(src, [rejectChange(node)]), rejected);
  }
});

test("editsAtCursor: accept/reject a change, notice off one", () => {
  const src = "x {++ins++} y";
  const parsed = parse(src);
  assert.equal(applyEdits(src, editsAtCursor(parsed, 4, "accept")), "x ins y");
  assert.equal(applyEdits(src, editsAtCursor(parsed, 4, "reject")), "x  y");
  assert.equal(editsAtCursor(parsed, 0, "accept"), "No change at cursor.");
});

test("editsAtCursor: remove a standalone highlight", () => {
  const src = "x {==h==} y";
  const parsed = parse(src);
  assert.equal(applyEdits(src, editsAtCursor(parsed, 9, "remove-highlight")), "x h y");
  assert.equal(editsAtCursor(parsed, 0, "remove-highlight"), "No highlight at cursor.");
});

test("editsAtCursor: an anchor highlight is not removable on its own", () => {
  const parsed = parse("{==h==}{>>c<<}");
  assert.equal(typeof editsAtCursor(parsed, 3, "remove-highlight"), "string");
});

test("editsAtCursor: delete a reply keeps the anchor", () => {
  const src = "{==h==}{>>a<<} {>>b<<} z";
  const parsed = parse(src);
  assert.equal(applyEdits(src, editsAtCursor(parsed, 17, "delete-comment")), "{==h==}{>>a<<}  z");
});

test("editsAtCursor: delete the only message removes its anchor", () => {
  const src = "x {==h==}{>>c<<} y";
  const parsed = parse(src);
  const edits = editsAtCursor(parsed, 12, "delete-comment");
  assert.equal(applyEdits(src, edits), "x h y");
  assert.equal(editsAtCursor(parsed, 0, "delete-comment"), "No comment at cursor.");
});

console.log("done.");
