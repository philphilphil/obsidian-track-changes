// Finalize tests for CriticMarkup Plus (author/date prefix).
// Spec: docs/superpowers/specs/2026-06-14-criticmarkup-plus-design.md §10, §13.
// Run with: node test/plus.finalize.test.mjs

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
  finalizeEdits,
  summarizeFinalize,
  appendReply,
  sanitizeAuthorName,
  DEFAULT_FINALIZE,
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

const finalize = (src, opts = DEFAULT_FINALIZE) => applyEdits(src, finalizeEdits(parse(src), opts));

console.log("plus.finalize:");

// ─── Spec §13: Strips prefix all five ──────────────────────────────────────

test("strips prefix on all five marks with DEFAULT_FINALIZE", () => {
  const src =
    "{author=A;date=2026-06-14;++a++}{author=B;--b--}{author=C;~~o~>n~~}{author=D;>>c<<}{author=E;==h==}";
  const out = finalize(src);
  // Resolved marks leave no metadata and no delimiters behind.
  assert.ok(!out.includes("author="), `leaked author= in: ${JSON.stringify(out)}`);
  assert.ok(!out.includes("date="), `leaked date= in: ${JSON.stringify(out)}`);
  assert.ok(!out.includes("{"), `leaked { in: ${JSON.stringify(out)}`);
  assert.ok(!out.includes("}"), `leaked } in: ${JSON.stringify(out)}`);
});

test("DEFAULT_FINALIZE on prefixed marks yields the same string as the bare equivalent", () => {
  // accept additions, reject deletions, reject substitutions, strip highlights.
  const prefixed =
    "a {author=A;date=2026-06-14;++ins++} b {author=B;--del--} c " +
    "{author=C;~~old~>new~~} d {author=D;>>note<<} e {author=E;==hl==} f";
  const bare = "a {++ins++} b {--del--} c {~~old~>new~~} d {>>note<<} e {==hl==} f";
  assert.equal(finalize(prefixed), finalize(bare));
  // And the literal expected output.
  assert.equal(finalize(prefixed), "a ins b del c old d  e hl f");
});

test("all-accept across prefixed marks matches bare all-accept byte-for-byte", () => {
  const opts = {
    additions: "accept",
    deletions: "accept",
    substitutions: "accept",
    stripHighlights: true,
  };
  const prefixed =
    "a {author=A;++ins++} b {date=2026-06-14;--del--} c {author=C;~~old~>new~~} d " +
    "{author=D;>>Claude: note<<} e {author=E;==hl==} f";
  const bare = "a {++ins++} b {--del--} c {~~old~>new~~} d {>>Claude: note<<} e {==hl==} f";
  assert.equal(finalize(prefixed, opts), finalize(bare, opts));
  assert.equal(finalize(prefixed, opts), "a ins b  c new d  e hl f");
});

test("all-reject across prefixed marks matches bare all-reject byte-for-byte", () => {
  const opts = {
    additions: "reject",
    deletions: "reject",
    substitutions: "reject",
    stripHighlights: true,
  };
  const prefixed =
    "a {author=A;++ins++} b {author=B;--del--} c {author=C;date=2026-06-14;~~old~>new~~} d " +
    "{author=D;>>note<<} e {author=E;==hl==} f";
  const bare = "a {++ins++} b {--del--} c {~~old~>new~~} d {>>note<<} e {==hl==} f";
  assert.equal(finalize(prefixed, opts), finalize(bare, opts));
  assert.equal(finalize(prefixed, opts), "a  b del c old d  e hl f");
});

// ─── Byte-equality strip, per mark, restored content carries zero prefix bleed ─

test("addition accept keeps inner text only (no prefix bleed)", () => {
  assert.equal(finalize("Add {author=A;date=2026-06-14;++X++}.", { ...DEFAULT_FINALIZE, additions: "accept" }), "Add X.");
});

test("addition reject removes the whole mark", () => {
  assert.equal(finalize("Add {author=A;++X++}.", { ...DEFAULT_FINALIZE, additions: "reject" }), "Add .");
});

test("deletion reject restores real prose verbatim (no prefix bleed)", () => {
  assert.equal(
    finalize("Keep {author=Claude;date=2026-06-14;--this sentence--} here.", {
      ...DEFAULT_FINALIZE,
      deletions: "reject",
    }),
    "Keep this sentence here.",
  );
});

test("deletion accept removes the deleted span", () => {
  assert.equal(
    finalize("Drop {author=Claude;--this--} it.", { ...DEFAULT_FINALIZE, deletions: "accept" }),
    "Drop  it.",
  );
});

test("substitution reject restores oldText (no prefix bleed)", () => {
  assert.equal(
    finalize("The {author=GPT;~~old word~>new word~~} stays.", {
      ...DEFAULT_FINALIZE,
      substitutions: "reject",
    }),
    "The old word stays.",
  );
});

test("substitution accept uses newText (no prefix bleed)", () => {
  assert.equal(
    finalize("The {author=GPT;~~old word~>new word~~} stays.", {
      ...DEFAULT_FINALIZE,
      substitutions: "accept",
    }),
    "The new word stays.",
  );
});

test("highlight strip keeps inner text only", () => {
  assert.equal(
    finalize("see {author=A;==important==} now", { ...DEFAULT_FINALIZE, stripHighlights: true }),
    "see important now",
  );
});

test("comment is stripped whole including its prefix", () => {
  assert.equal(finalize("x {author=Claude;date=2026-06-14;>>a remark<<} y"), "x  y");
});

// ─── Spec §13: Un-stripped highlight retains its metadata ──────────────────

test("stripHighlights:false leaves a prefixed highlight verbatim", () => {
  const src = "before {author=X;==keep==} after";
  const out = finalize(src, { ...DEFAULT_FINALIZE, stripHighlights: false });
  assert.equal(out, "before {author=X;==keep==} after");
  assert.ok(out.includes("author=X;==keep=="), "kept highlight must retain author/date metadata");
});

test("stripHighlights:false produces zero highlight edits but other marks still resolve", () => {
  const src = "{author=A;++ins++} {author=H;date=2026-06-14;==keep==}";
  const r = parse(src);
  const opts = { ...DEFAULT_FINALIZE, additions: "accept", stripHighlights: false };
  const edits = finalizeEdits(r, opts);
  // Only the addition produces an edit; the highlight is left alone.
  assert.equal(edits.length, 1);
  const out = applyEdits(src, edits);
  assert.equal(out, "ins {author=H;date=2026-06-14;==keep==}");
});

test("summary counts a prefixed kept highlight (modal calls it out)", () => {
  const src = "{author=X;date=2026-06-14;==keep==}";
  const s = summarizeFinalize(parse(src), { ...DEFAULT_FINALIZE, stripHighlights: false });
  assert.equal(s.highlights, 1);
});

// ─── No-regression: standard prefix-free finalize is byte-identical ─────────

test("no-regression: bare-mark finalize unchanged for all five", () => {
  const src = "a {++ins++} b {--del--} c {~~old~>new~~} d {>>Claude: note<<} e {==hl==} f";
  assert.equal(finalize(src), "a ins b del c old d  e hl f");
});

test("no-regression: empty document → zero finalize edits", () => {
  assert.equal(finalizeEdits(parse(""), DEFAULT_FINALIZE).length, 0);
});

// ─── Summary parity: prefixed vs bare produce identical summaries ───────────

test("summary identical for prefixed and bare equivalents", () => {
  const opts = {
    additions: "accept",
    deletions: "reject",
    substitutions: "accept",
    stripHighlights: true,
  };
  const prefixed =
    "{author=A;++a1++}{date=2026-06-14;++a2++} {author=B;--d1--} {author=C;~~o~>n~~} " +
    "{author=D;>>Claude: c1<<} {author=E;==h1==}{author=F;==h2==}";
  const bare = "{++a1++}{++a2++} {--d1--} {~~o~>n~~} {>>Claude: c1<<} {==h1==}{==h2==}";
  assert.deepEqual(summarizeFinalize(parse(prefixed), opts), summarizeFinalize(parse(bare), opts));
});

// ─── Corruption guard: nesting straddle must NOT span marks at finalize ─────

test("malformed --in-date does NOT straddle into a real deletion on finalize", () => {
  // `date=2026--bad` has no terminating `;` before the sigil, so under the
  // mandatory-`;` grammar the bogus comment forms no mark and stays literal; the
  // real deletion 50+ chars away finalizes independently and remains intact.
  const src = "{author=X;date=2026--bad>>c<<} and {--realdel--}";
  const r = parse(src);
  // No single parsed mark spans from the bogus open brace to the real deletion close.
  for (const n of r.nodes) {
    const raw = src.slice(n.from, n.to);
    assert.ok(
      !(raw.includes(">>") && raw.includes("realdel")),
      `a mark straddles the comment and the real deletion: ${JSON.stringify(raw)}`,
    );
  }
  // Reject the (only legit) deletion → its prose restored; bogus text stays literal.
  const out = finalize(src, { ...DEFAULT_FINALIZE, deletions: "reject" });
  assert.ok(out.includes("realdel"), `real deletion content lost: ${JSON.stringify(out)}`);
  // The malformed comment text was never swallowed into the deletion span.
  assert.ok(out.includes("{author=X;date=2026--bad>>c<<}"), `bogus mark was rewritten: ${JSON.stringify(out)}`);
});

test("malformed short date forms no mark — never straddles neighbours", () => {
  // Under the mandatory-`;` grammar {date=2026--6--deleted--} forms no mark: the
  // truncated date value isn't followed by the required `;`, so the prefix never
  // closes and it cannot hand its `--` to a sigil and straddle. Pad it with real
  // prose and a real deletion to prove the surroundings finalize untouched.
  const src = "alpha {date=2026--6--deleted--} {--keepme--} omega";
  const r = parse(src);
  // No mark spans from the malformed open into the genuine deletion.
  for (const n of r.nodes) {
    const raw = src.slice(n.from, n.to);
    assert.ok(
      !(raw.includes("6--deleted") && raw.includes("keepme")),
      `mark straddles into the real deletion: ${JSON.stringify(raw)}`,
    );
  }
  // Rejecting deletions restores both bodies in place; surrounding prose intact.
  const out = finalize(src, { ...DEFAULT_FINALIZE, deletions: "reject" });
  assert.ok(out.startsWith("alpha ") && out.endsWith(" omega"), `prose corrupted: ${JSON.stringify(out)}`);
  assert.ok(out.includes("keepme"), `real deletion content lost: ${JSON.stringify(out)}`);
});

test("legit single brace in deletion prose survives finalize as one mark", () => {
  const src = "x {--remove the {foo} placeholder--} y";
  const r = parse(src);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "deletion");
  // reject keeps the prose including the legit single brace.
  assert.equal(
    finalize(src, { ...DEFAULT_FINALIZE, deletions: "reject" }),
    "x remove the {foo} placeholder y",
  );
});

// ─── Reply stamping: the only mark the plugin writes, then finalized away ───

const TODAY_RE = /^\d{4}-\d{2}-\d{2}$/;

test("reply stamps date always; finalize strips it (named author)", () => {
  const base = "{>>Claude: question<<}";
  const r = parse(base);
  const edit = appendReply(base, r.threads[0], r, "an answer", "Phil");
  const stamped = applyEdits(base, [edit]);
  // The reply carries author + today's date.
  const m = stamped.match(/\{author=Phil;date=(\d{4}-\d{2}-\d{2});>>an answer<<\}/);
  assert.ok(m, `unexpected reply shape: ${JSON.stringify(stamped)}`);
  assert.ok(TODAY_RE.test(m[1]), `date not YYYY-MM-DD: ${m[1]}`);
  // Re-parse confirms author resolves and finalize wipes all metadata.
  const out = finalize(stamped);
  assert.ok(!out.includes("author="), `finalize leaked author=: ${JSON.stringify(out)}`);
  assert.ok(!out.includes("date="), `finalize leaked date=: ${JSON.stringify(out)}`);
  assert.ok(!out.includes("{"), `finalize leaked brace: ${JSON.stringify(out)}`);
});

test("reply with empty localAuthorName carries date only, never empty author=", () => {
  const base = "{>>Claude: q<<}";
  const r = parse(base);
  const stamped = applyEdits(base, [appendReply(base, r.threads[0], r, "r", "")]);
  const m = stamped.match(/\{date=(\d{4}-\d{2}-\d{2});>>r<<\}/);
  assert.ok(m, `expected date-only reply: ${JSON.stringify(stamped)}`);
  assert.ok(!stamped.includes("author="), "must never write an empty author=");
  assert.ok(TODAY_RE.test(m[1]));
  // Re-parses to metaAuthor null (→ "You") and finalizes cleanly.
  const replyNode = parse(stamped).nodes.find((n) => n.text === "r");
  assert.equal(replyNode.metaAuthor, null);
  assert.equal(finalize(stamped), "");
});

test("reply sanitizes a hostile localAuthorName; mark stays parseable + finalizes", () => {
  const base = "{>>Claude: q<<}";
  const r = parse(base);
  const hostile = "Phil; author=Mallory{}";
  const stamped = applyEdits(base, [appendReply(base, r.threads[0], r, "ok", hostile)]);

  // Re-parse: the reply is the second comment node, attributed to the sanitized name.
  const re = parse(stamped);
  assert.equal(re.nodes.length, 2);
  const reply = re.nodes[1];
  assert.equal(reply.text, "ok");
  assert.equal(reply.metaAuthor, sanitizeAuthorName(hostile));

  // The reply's own consumed prefix carries no structural / sigil chars and is an
  // author= then date= pair, each terminated by `;` — the injected `; author=` /
  // braces were stripped.
  const prefix = reply.metaRaw;
  for (const ch of ["{", "}", "<", ">", "+", "~"]) {
    assert.ok(!prefix.includes(ch), `sanitized prefix contains ${ch}: ${JSON.stringify(prefix)}`);
  }
  assert.ok(!prefix.includes("--"), `sanitized prefix contains --: ${JSON.stringify(prefix)}`);
  // Exactly one author= and one date= survive (the structural separators), each
  // terminated by `;` under the mandatory-`;` grammar → two semicolons total.
  assert.equal((prefix.match(/author=/g) || []).length, 1);
  assert.equal((prefix.match(/date=/g) || []).length, 1);
  assert.equal((prefix.match(/;/g) || []).length, 2);

  // Finalize wipes everything, prefix and all.
  assert.equal(finalize(stamped), "");
});

// ─── finalize edits remain non-overlapping with prefixed adjacency ──────────

test("finalizeEdits over adjacent prefixed marks are non-overlapping", () => {
  const src = "{author=A;++x++}{author=B;--y--}{author=C;==z==}";
  const edits = finalizeEdits(parse(src), {
    additions: "accept",
    deletions: "reject",
    substitutions: "accept",
    stripHighlights: true,
  });
  const sorted = [...edits].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i - 1].to <= sorted[i].from, `edit ${i - 1} overlaps edit ${i}`);
  }
  // And the resolved output is clean.
  const out = applyEdits(src, edits);
  assert.equal(out, "xyz");
});

console.log("done.");
