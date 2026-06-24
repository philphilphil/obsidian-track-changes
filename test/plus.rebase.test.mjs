// Rebase + round-trip tests for CriticMarkup Plus (author/date prefix).
// Covers spec section 13 "Rebase", plus the cross-cutting guarantees the prefix
// has to uphold so rebase stays safe: byte-equality strip per mark, parse
// no-regression for prefix-free marks, the corruption guards (an unterminated
// quoted value must NOT span marks; legit single braces survive), reply stamping
// (date always; author only when set; sanitization), and fail-closed rebase.
//
// Run with: node test/plus.rebase.test.mjs
//
// Harness mirrors test/rebase.test.mjs and test/parser.test.mjs exactly:
// esbuild in-memory bundle -> base64 data-URL import of the compiled TS, the
// copy-pasted test(name, fn) runner, and `import { strict as assert }`.

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

const parser = await loadTs("../src/parser.ts");
const ops = await loadTs("../src/operations.ts");

const { parse } = parser;
const {
  rebaseEdit,
  applyEdits,
  acceptAddition,
  rejectAddition,
  acceptDeletion,
  rejectDeletion,
  acceptSubstitution,
  rejectSubstitution,
  removeHighlight,
  deleteCommentNode,
  appendReply,
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

// Parse `src`, return the single node (asserting exactly one was parsed).
function only(src) {
  const r = parse(src);
  assert.equal(r.nodes.length, 1, `expected exactly one node in: ${src}`);
  return r.nodes[0];
}

const TODAY_RE = /^\d{4}-\d{2}-\d{2}$/;

console.log("plus.rebase:");

// ---------------------------------------------------------------------------
// Parse no-regression: prefix-free marks parse byte-identically to before.
// (If these drift, every rebase anchor below is built on sand.)
// ---------------------------------------------------------------------------

test("no-regression: prefix-free marks parse with empty metaRaw and bare payload", () => {
  const cases = [
    ["{++x++}", "addition", { text: "x" }],
    ["{--x--}", "deletion", { text: "x" }],
    ["{>>x<<}", "comment", { text: "x" }],
    ["{~~a~>b~~}", "substitution", { oldText: "a", newText: "b" }],
    ["{==x==}", "highlight", { text: "x" }],
  ];
  for (const [src, kind, payload] of cases) {
    const n = only(src);
    assert.equal(n.kind, kind, src);
    assert.equal(n.from, 0, src);
    assert.equal(n.to, src.length, src);
    assert.equal(n.raw, src, src);
    assert.equal(n.metaRaw, "", `metaRaw must be "" for ${src}`);
    assert.equal(n.metaAuthor, null, `metaAuthor null for ${src}`);
    assert.equal(n.metaDate, null, `metaDate null for ${src}`);
    for (const [k, v] of Object.entries(payload)) assert.equal(n[k], v, `${src}.${k}`);
  }
});

test("no-regression: legacy {>>Claude: hi<<} still parses author + clean body", () => {
  const n = only("{>>Claude: hi<<}");
  assert.equal(n.kind, "comment");
  assert.equal(n.authorName, "Claude");
  assert.equal(n.metaAuthor, "Claude"); // resolved via legacy fallback
  assert.equal(n.metaDate, null);
  assert.equal(n.text, "hi");
});

// ---------------------------------------------------------------------------
// Offset invariant: raw spans the whole mark INCLUDING the prefix; payload
// fields EXCLUDE the prefix and the sigils. (§6.3 — load-bearing for anchors.)
// ---------------------------------------------------------------------------

test("offset invariant: raw includes prefix; payload excludes prefix + sigils", () => {
  const samples = [
    '{author="Claude" date="2026-06-14"++added text++}',
    '{author="Claude" date="2026-06-14"--deleted text--}',
    '{author="Claude"~~old~>new~~}',
    '{author="Claude">>a comment<<}',
    '{author="Claude"==a highlight==}',
  ];
  for (const src of samples) {
    const n = only(src);
    assert.equal(n.from, 0, src);
    assert.equal(n.to, src.length, src);
    assert.equal(n.raw, src, `raw must span the whole mark for ${src}`);
    assert.notEqual(n.metaRaw, "", `metaRaw captured for ${src}`);
    // metaRaw is exactly source[from+1 .. innerSigil); it must not contain a sigil.
    assert.ok(src.includes(n.metaRaw), src);
    // No payload field may contain the prefix substring.
    const fields = ["text", "oldText", "newText"];
    for (const f of fields) {
      if (typeof n[f] === "string") {
        assert.ok(!n[f].includes(n.metaRaw), `${src}: ${f} must not contain metaRaw`);
        assert.ok(!n[f].includes("author="), `${src}: ${f} must not contain "author="`);
        assert.ok(!n[f].includes("date="), `${src}: ${f} must not contain "date="`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Byte-equality strip per mark: a prefixed mark, after its op, yields EXACTLY
// what the bare (prefix-free) mark would. Zero prefix bleed.
// ---------------------------------------------------------------------------

function editFor(node) {
  switch (node.kind) {
    case "addition":
      return { accept: acceptAddition(node), reject: rejectAddition(node) };
    case "deletion":
      return { accept: acceptDeletion(node), reject: rejectDeletion(node) };
    case "substitution":
      return { accept: acceptSubstitution(node), reject: rejectSubstitution(node) };
    case "highlight":
      return { remove: removeHighlight(node) };
    case "comment":
      return { delete: deleteCommentNode(node) };
    default:
      throw new Error("unknown kind " + node.kind);
  }
}

test("byte-equality strip: addition accept/reject == bare mark, no prefix bleed", () => {
  const pre = 'Add {author="A" date="2026-06-14"++X++}.';
  const bare = "Add {++X++}.";
  const np = parse(pre).nodes[0];
  const nb = parse(bare).nodes[0];
  assert.equal(applyEdits(pre, [acceptAddition(np)]), applyEdits(bare, [acceptAddition(nb)]));
  assert.equal(applyEdits(pre, [acceptAddition(np)]), "Add X.");
  assert.equal(applyEdits(pre, [rejectAddition(np)]), "Add .");
  assert.equal(applyEdits(pre, [rejectAddition(np)]), applyEdits(bare, [rejectAddition(nb)]));
});

test("byte-equality strip: deletion-reject keeps real prose, no prefix bleed", () => {
  const pre = 'Keep {author="Claude" date="2026-06-14"--this sentence--} here.';
  const np = parse(pre).nodes[0];
  assert.equal(applyEdits(pre, [rejectDeletion(np)]), "Keep this sentence here.");
  // deletion-accept applies the deletion
  const pre2 = 'Drop {author="Claude"--this--} it.';
  const np2 = parse(pre2).nodes[0];
  assert.equal(applyEdits(pre2, [acceptDeletion(np2)]), "Drop  it.");
});

test("byte-equality strip: substitution restores real content, no prefix bleed", () => {
  const pre = 'The {author="GPT"~~old word~>new word~~} stays.';
  const np = parse(pre).nodes[0];
  assert.equal(applyEdits(pre, [rejectSubstitution(np)]), "The old word stays.");
  assert.equal(applyEdits(pre, [acceptSubstitution(np)]), "The new word stays.");
  // Restored content must be exactly the inner text, zero prefix bleed.
  assert.equal(np.oldText, "old word");
  assert.equal(np.newText, "new word");
});

test("byte-equality strip: highlight remove keeps inner text", () => {
  const pre = 'x {author="A"==important==} y';
  const np = parse(pre).nodes[0];
  assert.equal(applyEdits(pre, [removeHighlight(np)]), "x important y");
});

test("byte-equality strip: substitution-inner-rematch newText kept whole (b==c==d)", () => {
  // The {==...==} inside the substitution must NOT be parsed as a highlight; the
  // substitution wins (substitutions-first ordering), newText is the whole run.
  const pre = 'z {author="X"~~a~>b==c==d~~} z';
  const r = parse(pre);
  assert.equal(r.nodes.length, 1);
  const np = r.nodes[0];
  assert.equal(np.kind, "substitution");
  assert.equal(np.oldText, "a");
  assert.equal(np.newText, "b==c==d");
  assert.equal(applyEdits(pre, [acceptSubstitution(np)]), "z b==c==d z");
  assert.equal(applyEdits(pre, [rejectSubstitution(np)]), "z a z");
});

// ---------------------------------------------------------------------------
// SPEC §13 Rebase — Round-trip per kind: expected === node.raw INCLUDES the
// prefix; applyEdits output byte-identical to the bare-mark operation.
// ---------------------------------------------------------------------------

test("rebase round-trip: expected === node.raw (includes prefix), in-place succeeds", () => {
  const samples = [
    'x {author="A" date="2026-06-14"++ins++} y',
    'x {author="A" date="2026-06-14"--del--} y',
    'x {author="A" date="2026-06-14"~~o~>n~~} y',
    'x {author="A" date="2026-06-14"==hi==} y',
    'x {author="A" date="2026-06-14">>cmt<<} y',
  ];
  for (const src of samples) {
    const n = parse(src).nodes[0];
    const { accept, reject, remove, delete: del } = editFor(n);
    const edit = accept ?? remove ?? del;
    // expected must be the full outer-brace-to-outer-brace slice, incl. prefix.
    assert.equal(edit.expected, n.raw, src);
    assert.equal(edit.expected, src.slice(n.from, n.to), src);
    assert.ok(edit.expected.includes(n.metaRaw), `expected carries the prefix for ${src}`);
    // In-place rebase against the same doc returns the edit unchanged.
    const rb = rebaseEdit(src, edit);
    assert.ok(rb !== null, `in-place rebase should succeed for ${src}`);
    assert.equal(rb.from, edit.from, src);
    assert.equal(rb.to, edit.to, src);
    assert.equal(rb.insert, edit.insert, src);
    // The rebased range really points at the prefixed mark.
    assert.equal(src.slice(rb.from, rb.to), n.raw, src);
    if (reject) {
      const rrb = rebaseEdit(src, reject);
      assert.ok(rrb !== null, `in-place reject rebase should succeed for ${src}`);
      assert.equal(rrb.from, reject.from, src);
      assert.equal(rrb.to, reject.to, src);
    }
  }
});

test("rebase round-trip: applyEdits output byte-identical to the bare-mark op", () => {
  // Same content, with and without the prefix, must finalize identically.
  const cases = [
    ['x {author="A" date="2026-06-14"++ins++} y', "x {++ins++} y", "accept"],
    ['x {author="A" date="2026-06-14"++ins++} y', "x {++ins++} y", "reject"],
    ['x {author="A" date="2026-06-14"--del--} y', "x {--del--} y", "accept"],
    ['x {author="A" date="2026-06-14"--del--} y', "x {--del--} y", "reject"],
    ['x {author="A" date="2026-06-14"~~o~>n~~} y', "x {~~o~>n~~} y", "accept"],
    ['x {author="A" date="2026-06-14"~~o~>n~~} y', "x {~~o~>n~~} y", "reject"],
    ['x {author="A" date="2026-06-14"==hi==} y', "x {==hi==} y", "remove"],
  ];
  const opFor = (n, which) => {
    if (n.kind === "addition") return which === "accept" ? acceptAddition(n) : rejectAddition(n);
    if (n.kind === "deletion") return which === "accept" ? acceptDeletion(n) : rejectDeletion(n);
    if (n.kind === "substitution")
      return which === "accept" ? acceptSubstitution(n) : rejectSubstitution(n);
    if (n.kind === "highlight") return removeHighlight(n);
    throw new Error("bad kind");
  };
  for (const [pre, bare, which] of cases) {
    const np = parse(pre).nodes[0];
    const nb = parse(bare).nodes[0];
    const outPre = applyEdits(pre, [rebaseEdit(pre, opFor(np, which))]);
    const outBare = applyEdits(bare, [rebaseEdit(bare, opFor(nb, which))]);
    assert.equal(outPre, outBare, `${which} ${pre} vs ${bare}`);
  }
});

test("rebase round-trip: comment delete via thread-aware before anchor", () => {
  // A prefixed comment's delete edit anchors on raw; rebase succeeds in place.
  const src = 'note {author="Claude" date="2026-06-14">>looks good<<} end';
  const n = parse(src).nodes[0];
  const edit = deleteCommentNode(n);
  assert.equal(edit.expected, n.raw);
  const rb = rebaseEdit(src, edit);
  assert.ok(rb !== null);
  assert.equal(applyEdits(src, [rb]), "note  end");
});

// ---------------------------------------------------------------------------
// SPEC §13 Rebase — Fail-closed: drift the on-disk prefix (change date=) so the
// current slice no longer equals `expected`; rebaseEdit returns null (drops,
// never corrupts). The accept/reject edits have no `before`, so they cannot
// relocate — they must fail closed.
// ---------------------------------------------------------------------------

test("rebase fail-closed: drifted date= prefix => rebaseEdit returns null (addition)", () => {
  const parsedSrc = 'x {author="A" date="2026-06-14"++ins++} y';
  const n = parse(parsedSrc).nodes[0];
  const edit = acceptAddition(n);
  // The doc on disk drifted: someone changed the date in the prefix.
  const driftedDoc = 'x {author="A" date="2026-06-15"++ins++} y';
  assert.notEqual(driftedDoc.slice(edit.from, edit.to), edit.expected);
  assert.equal(rebaseEdit(driftedDoc, edit), null);
});

test("rebase fail-closed: drifted prefix across all five kinds => null", () => {
  const cases = [
    ['x {author="A" date="2026-06-14"++ins++} y', 'x {author="A" date="2026-06-15"++ins++} y'],
    ['x {author="A" date="2026-06-14"--del--} y', 'x {author="A" date="2026-06-15"--del--} y'],
    ['x {author="A" date="2026-06-14"~~o~>n~~} y', 'x {author="A" date="2026-06-15"~~o~>n~~} y'],
    ['x {author="A" date="2026-06-14"==hi==} y', 'x {author="A" date="2026-06-15"==hi==} y'],
    ['x {author="A" date="2026-06-14">>c<<} y', 'x {author="A" date="2026-06-15">>c<<} y'],
  ];
  for (const [pre, drifted] of cases) {
    const n = parse(pre).nodes[0];
    const { accept, remove, delete: del } = editFor(n);
    const edit = accept ?? remove ?? del;
    assert.equal(rebaseEdit(drifted, edit), null, `should fail closed for ${pre}`);
  }
});

test("rebase fail-closed: drifted author= prefix (same date) => null", () => {
  const pre = 'x {author="Alice" date="2026-06-14"++ins++} y';
  const n = parse(pre).nodes[0];
  const edit = acceptAddition(n);
  const drifted = 'x {author="Bob" date="2026-06-14"++ins++} y';
  assert.equal(rebaseEdit(drifted, edit), null);
});

test("rebase fail-closed: removing the prefix entirely on disk => null", () => {
  // A bare mark and a prefixed mark are different raw text; the prefixed edit
  // must not silently re-target the now-bare mark (no `before`, fails closed).
  const pre = 'x {author="A" date="2026-06-14"++ins++} y';
  const n = parse(pre).nodes[0];
  const edit = acceptAddition(n);
  const bareDoc = "x {++ins++} y";
  assert.equal(rebaseEdit(bareDoc, edit), null);
});

// ---------------------------------------------------------------------------
// CORRUPTION GUARDS — the central never-corrupt invariant. An unterminated
// quoted value must NOT span across marks; legit single braces survive.
// ---------------------------------------------------------------------------

test("corruption guard: unterminated quote straddle does NOT span the comment + real deletion", () => {
  // The date value has no closing `"` before the next `}`, so the pair fails,
  // the prefix collapses to "" and no comment forms; the genuine deletion lives.
  const src = '{author="X" date="2026--bad>>c<<} and {--realdel--}';
  const r = parse(src);
  // The malformed comment degrades; the genuine deletion survives.
  const dels = r.nodes.filter((n) => n.kind === "deletion");
  assert.equal(dels.length, 1, "exactly one (real) deletion should survive");
  const del = dels[0];
  assert.equal(del.text, "realdel");
  assert.equal(src.slice(del.from, del.to), "{--realdel--}");
  // CRITICAL: no single mark may span from the comment into the real deletion.
  for (const n of r.nodes) {
    const spans = n.from < src.indexOf("{--realdel--}") && n.to > src.indexOf("{--realdel--}");
    assert.ok(!spans, `no mark may straddle into the real deletion (kind=${n.kind})`);
  }
  // And rejecting the surviving deletion must restore exactly "realdel", never
  // "...>>c<<} and {--realdel" or any straddled garbage.
  assert.equal(
    applyEdits(src, [rejectDeletion(del)]),
    '{author="X" date="2026--bad>>c<<} and realdel',
  );
});

test("corruption guard: unterminated quoted value — forms no mark, so no op can restore prose", () => {
  // {date="2026--6--deleted--} → the date value never closes its quote before the
  // final `}`, so the pair fails, the prefix collapses to "" and the whole thing
  // forms no mark. With no deletion node there is nothing to reject, so
  // "6--deleted" can never be restored as user prose.
  const src = '{date="2026--6--deleted--}';
  const r = parse(src);
  assert.equal(r.nodes.length, 0, "unterminated quoted value must form no mark");
});

test("corruption guard: legit single brace in prose survives as one deletion", () => {
  const src = "{--remove the {foo} placeholder--}";
  const r = parse(src);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "deletion");
  assert.equal(r.nodes[0].text, "remove the {foo} placeholder");
  // Round-trips cleanly: reject keeps the prose verbatim.
  assert.equal(applyEdits(src, [rejectDeletion(r.nodes[0])]), "remove the {foo} placeholder");
});

test("corruption guard: brace-in-value prefix degrades (no mark)", () => {
  // `{` is forbidden inside the quoted value, so the value can't close — no mark.
  assert.equal(parse('{author="Claude{nested}">>x<<}').nodes.length, 0);
});

// ---------------------------------------------------------------------------
// Malformed-degradation: every malformed prefix is inert or a plain mark.
// ---------------------------------------------------------------------------

test("malformed prefixes degrade safely (no mark / plain mark)", () => {
  assert.equal(parse("{=>>x<<}").nodes.length, 0, "stray = => no mark");
  assert.equal(parse("{;>>x<<}").nodes.length, 0, "leading ; => no mark");
  // A quoted pair whose value closes against the sigil is valid; the degrade case
  // is the UNQUOTED value (no `"` at all).
  assert.equal(parse('{author="A">>x<<}').nodes.length, 1, "quoted value abutting the sigil => valid mark");
  assert.equal(parse("{author=A>>x<<}").nodes.length, 0, "unquoted value => no mark");
  assert.equal(parse('{ author="Claude"++a++}').nodes.length, 0, "leading space => no mark");
  assert.equal(parse('{note="a"="b">>x<<}').nodes.length, 0, "stray = between pairs => no mark");
  // Empty value (`author=""`) => prefix is valid but the empty value is dropped, so
  // it is still a comment with metaAuthor null.
  const n = only('{author="">>x<<}');
  assert.equal(n.kind, "comment");
  assert.equal(n.metaAuthor, null);
  assert.equal(n.text, "x");
});

test("timezone-offset date now parses (quoted value holds the `+`)", () => {
  // Under the quoted grammar a full ISO-with-offset date is a legal value; the
  // old `;`-form choked on the `+`, the quoted form does not.
  const n = only('{author="Claude" date="2026-06-14T13:45:00+02:00">>c<<}');
  assert.equal(n.kind, "comment");
  assert.equal(n.metaDate, "2026-06-14T13:45:00+02:00");
});

// ---------------------------------------------------------------------------
// Reply stamping — date always; author only when name set; sanitization. The
// stamped reply must re-parse and rebase cleanly (the whole point of the prefix).
// ---------------------------------------------------------------------------

function threadFor(src) {
  const r = parse(src);
  assert.ok(r.threads.length >= 1, "expected a thread");
  return { src, parsed: r, thread: r.threads[0] };
}

test("reply stamping: with localAuthorName => author= + date=; re-parses + rebases", () => {
  const { src, parsed, thread } = threadFor("root {>>Claude: hi<<} tail");
  const edit = appendReply(src, thread, parsed, "thanks", "Phil");
  assert.match(edit.insert, /^\{author="Phil" date="\d{4}-\d{2}-\d{2}">>thanks<<\}$/);
  // date is the real clock, YYYY-MM-DD.
  const date = edit.insert.match(/date="(\d{4}-\d{2}-\d{2})"/)[1];
  assert.match(date, TODAY_RE);
  // (No second `new Date()` read here — comparing two independent clock reads
  // can disagree across a UTC-midnight boundary. The regex above is sufficient.)
  // The reply edit anchors on before=last.raw (now incl. its prefix); rebase in place.
  const rb = rebaseEdit(src, edit);
  assert.ok(rb !== null, "reply edit should rebase in place");
  const out = applyEdits(src, [rb]);
  // The appended reply re-parses to a comment attributed to Phil.
  const re = parse(out);
  const phil = re.nodes.find((n) => n.metaAuthor === "Phil");
  assert.ok(phil, "stamped reply re-parses with metaAuthor=Phil");
  assert.equal(phil.text, "thanks");
});

test("reply stamping: empty localAuthorName => date= only, no author=, => You", () => {
  const { src, parsed, thread } = threadFor("root {>>Claude: hi<<} tail");
  const edit = appendReply(src, thread, parsed, "ok", "");
  assert.match(edit.insert, /^\{date="\d{4}-\d{2}-\d{2}">>ok<<\}$/);
  assert.ok(!edit.insert.includes("author="), "never write an empty author=");
  const out = applyEdits(src, [rebaseEdit(src, edit)]);
  const re = parse(out);
  const reply = re.nodes.find((n) => n.text === "ok");
  assert.ok(reply, "reply present");
  assert.equal(reply.metaAuthor, null, "no author => null => resolves to You");
});

test("reply stamping: malicious name is sanitized; stays one mark; rebases", () => {
  // The quoted value class only forbids `"`, `{`, `}`, newline — those (and
  // control chars) are the only chars the sanitizer strips. `;`, `=`, `<`, `>`
  // etc. are safe inside the quotes, so they survive.
  const dirty = 'Phil"; author=Mallory{}';
  const clean = sanitizeAuthorName(dirty);
  for (const ch of ['"', "{", "}"]) {
    assert.ok(!clean.includes(ch), `sanitized name must not contain ${ch}`);
  }
  assert.equal(clean, "Phil; author=Mallory");
  const { src, parsed, thread } = threadFor("root {>>Claude: hi<<} tail");
  const edit = appendReply(src, thread, parsed, "reply", dirty);
  // The stamped prefix is a single author= pair; the value holds no `"`/`{`/`}`.
  assert.match(edit.insert, /^\{author="[^"{}]*" date="\d{4}-\d{2}-\d{2}">>reply<<\}$/);
  const out = applyEdits(src, [rebaseEdit(src, edit)]);
  // The whole document still parses without a straddle; the reply is ONE comment.
  const re = parse(out);
  const reply = re.nodes.find((n) => n.text === "reply");
  assert.ok(reply, "sanitized reply parses as a single comment");
  assert.equal(reply.kind, "comment");
  assert.equal(reply.metaAuthor, "Phil; author=Mallory");
});

test("reply stamping: appended reply threads with the root (adjacency preserved)", () => {
  const { src, parsed, thread } = threadFor("root {>>Claude: hi<<} tail");
  const edit = appendReply(src, thread, parsed, "agreed", "Phil");
  const out = applyEdits(src, [rebaseEdit(src, edit)]);
  const re = parse(out);
  assert.equal(re.threads.length, 1, "reply joins the existing thread");
  assert.equal(re.threads[0].replyIndexes.length, 1);
});

console.log("done.");
