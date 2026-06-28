// Rendering + Settings/migration tests for CriticMarkup Plus (spec §13).
// Run with: node test/plus.render-settings.test.mjs
//
// Covers the "Rendering" and "Settings / migration" sub-sections of the test
// matrix plus the cross-cutting critical guards the design calls load-bearing:
// byte-equality strip per mark, the no-regression cases, the corruption guards
// (the --inside-date straddle must NOT span marks; legit single braces survive),
// reply stamping (date always; author only when set; sanitization), and
// fail-closed rebase.
//
// The DOM-mutating halves of reading.ts / decorations.ts pull in `obsidian` and
// `@codemirror/*` and can't be imported into a Node data-URL module, so the
// rendering assertions operate at the offset / pure-helper level the spec scopes
// them to ("offset-level helpers; DOM half stays untested"). The author
// precedence + label/hue contract is the one in src/editor/decorations.ts
// (resolveAuthor / metaLabel) and the one in main.ts loadSettings — both
// replicated here verbatim so a drift in the source surfaces as a test edit.

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadTs(rel, opts = {}) {
  const out = await build({
    entryPoints: [resolve(__dirname, rel)],
    bundle: true,
    format: "esm",
    target: "es2018",
    write: false,
    platform: "neutral",
    ...opts,
  });
  const code = out.outputFiles[0].text;
  return await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

// settings.ts imports `obsidian`; stub it so the module loads as a data-URL.
const obsidianStub = {
  name: "stub-obsidian",
  setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents:
        "export class PluginSettingTab {}\n" +
        "export class Setting {\n" +
        "  setName(){return this;} setDesc(){return this;} setHeading(){return this;}\n" +
        "  addToggle(){return this;} addText(){return this;} addDropdown(){return this;}\n" +
        "}\n" +
        "export function debounce(fn){ const d = (...a) => fn(...a); d.cancel = () => d; return d; }\n",
      loader: "js",
    }));
  },
};

const parserMod = await loadTs("../src/parser.ts");
const authorsMod = await loadTs("../src/authors.ts");
const opsMod = await loadTs("../src/operations.ts");
const settingsMod = await loadTs("../src/settings.ts", { plugins: [obsidianStub] });

const { parse, nodeAtOffset } = parserMod;
const { authorHueIndex, AUTHOR_RE } = authorsMod;
const {
  applyEdits,
  rebaseEdit,
  appendReply,
  sanitizeAuthorName,
  finalizeEdits,
  acceptAddition,
  rejectAddition,
  acceptDeletion,
  rejectDeletion,
  acceptSubstitution,
  rejectSubstitution,
  removeHighlight,
  DEFAULT_FINALIZE,
} = opsMod;
const { DEFAULT_SETTINGS } = settingsMod;

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

// --- Render-layer contract replicas (src/editor/decorations.ts §5.2) ---------
// Author precedence: metaAuthor → legacy authorName (comments only) →
// localAuthorName → "You". Returns the resolved label and the underlying named
// author (null when it falls through to "You").
function resolveAuthor(node, localAuthorName) {
  const legacy = node.kind === "comment" ? node.authorName : null;
  const local = (localAuthorName ?? "").trim();
  const named = node.metaAuthor ?? legacy ?? (local !== "" ? local : null);
  return { label: named ?? "You", named };
}
function metaLabel(node, localAuthorName) {
  const { label } = resolveAuthor(node, localAuthorName);
  return node.metaDate ? `${label} · ${node.metaDate}` : label;
}
// hue applied iff there is a named author (matches markAttrs in decorations.ts).
function authorHue(node, localAuthorName) {
  const { named } = resolveAuthor(node, localAuthorName);
  return named ? authorHueIndex(named) : null;
}

// loadSettings merge replica (src/main.ts:85-89): top-level shallow merge with a
// one-level-deep finalize re-merge.
function loadSettingsMerge(stored) {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    finalize: { ...DEFAULT_SETTINGS.finalize, ...(stored.finalize ?? {}) },
  };
}

// Local calendar day (YYYY-MM-DD), mirroring formatReplyDate's "date" style.
// Must use local getFullYear/getMonth/getDate, not toISOString (UTC) — west of
// UTC in the evening the two differ by a day and the assertion goes flaky.
const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();

console.log("plus.render-settings:");

// ===========================================================================
// Cross-cutting: no-regression — standard prefix-free marks parse identically.
// ===========================================================================

test("no-regression: prefix-free marks parse byte-identically (payload + offsets)", () => {
  const cases = [
    { src: "{++x++}", kind: "addition", field: "text", val: "x" },
    { src: "{--x--}", kind: "deletion", field: "text", val: "x" },
    { src: "{>>x<<}", kind: "comment", field: "text", val: "x" },
    { src: "{==x==}", kind: "highlight", field: "text", val: "x" },
  ];
  for (const c of cases) {
    const r = parse(c.src);
    assert.equal(r.nodes.length, 1, c.src);
    const n = r.nodes[0];
    assert.equal(n.kind, c.kind, c.src);
    assert.equal(n[c.field], c.val, c.src);
    assert.equal(n.from, 0, c.src);
    assert.equal(n.to, c.src.length, c.src);
    assert.equal(n.raw, c.src, c.src);
    // No prefix → metadata empty, body bounded by the legacy 3-char tokens.
    assert.equal(n.metaRaw, "", c.src);
    assert.equal(n.metaAuthor, null, c.src);
    assert.equal(n.metaDate, null, c.src);
    assert.equal(n.innerFrom, 3, c.src);
    assert.equal(n.innerTo, c.src.length - 3, c.src);
  }
  const sub = parse("{~~a~>b~~}").nodes[0];
  assert.equal(sub.kind, "substitution");
  assert.equal(sub.oldText, "a");
  assert.equal(sub.newText, "b");
  assert.equal(sub.metaRaw, "");
  assert.equal(sub.innerFrom, 3);
});

test("no-regression: legacy {>>Claude: hi<<} → comment, authorName Claude, body hi", () => {
  const n = parse("{>>Claude: hi<<}").nodes[0];
  assert.equal(n.kind, "comment");
  assert.equal(n.authorName, "Claude");
  assert.equal(n.text, "hi");
  // Legacy path still resolves to Claude through metaAuthor fallback.
  assert.equal(n.metaAuthor, "Claude");
});

// ===========================================================================
// Rendering: Source / Live-Preview / Reading consistency (offset level, §13).
// ===========================================================================

test("offset invariant: payload excludes the prefix and sigils for all five kinds", () => {
  const fixtures = [
    '{author="Claude" date="2026-06-14"++added++}',
    '{author="Claude" date="2026-06-14"--deleted--}',
    '{author="Claude"~~old~>new~~}',
    '{author="Claude">>comment<<}',
    '{author="Claude"==hi==}',
  ];
  for (const src of fixtures) {
    const r = parse(src);
    assert.equal(r.nodes.length, 1, src);
    const n = r.nodes[0];
    assert.equal(n.from, 0, src);
    assert.equal(n.to, src.length, src);
    assert.equal(n.raw, src, src);
    // The prefix substring lives between `{` and the sigil, inside raw, never in payload.
    assert.equal(src.slice(n.from + 1, n.from + 1 + n.metaRaw.length), n.metaRaw, src);
    const payloads = [];
    if (n.kind === "substitution") payloads.push(n.oldText, n.newText);
    else payloads.push(n.text);
    for (const p of payloads) {
      assert.ok(!p.includes(n.metaRaw), `payload leaked prefix: ${src}`);
      assert.ok(!p.includes("author="), `payload echoes author=: ${src}`);
      assert.ok(!p.includes("date="), `payload echoes date=: ${src}`);
    }
    // innerFrom/innerTo bound exactly the first payload (body for non-subst).
    if (n.kind !== "substitution") {
      assert.equal(src.slice(n.innerFrom, n.innerTo), n.text, src);
    } else {
      assert.equal(src.slice(n.innerFrom, n.innerTo), n.oldText, src);
    }
  }
});

test("Live-Preview prefix-hide range [from, innerFrom) is exactly `{<prefix><sigil>`", () => {
  const src = '{author="Claude" date="2026-06-14"++added++}';
  const n = parse(src).nodes[0];
  const hidden = src.slice(n.from, n.innerFrom);
  // hiddenDecoration over from..innerFrom removes the opening incl. the prefix.
  assert.equal(hidden, '{author="Claude" date="2026-06-14"++');
  assert.ok(hidden.includes("author="));
  assert.ok(hidden.includes("date="));
  // The visible body that remains never echoes the prefix.
  const visible = src.slice(n.innerFrom, n.innerTo);
  assert.equal(visible, "added");
  assert.ok(!visible.includes("author="));
  assert.ok(!visible.includes("date="));
});

test("Reading: stripping [from, innerFrom) and [innerTo, to) leaves only the body — no prefix echo", () => {
  // Mirrors reading.ts hiding the open token ({<prefix><sigil>) and close sigil.
  const src = 'Keep {author="GPT" date="2026-06-14"==important==} here.';
  const n = parse(src).nodes.find((x) => x.kind === "highlight");
  const rendered =
    src.slice(0, n.from) + src.slice(n.innerFrom, n.innerTo) + src.slice(n.to);
  assert.equal(rendered, "Keep important here.");
  assert.ok(!rendered.includes("author="));
  assert.ok(!rendered.includes("date="));
});

test("Source mode shows raw prefix verbatim (intended) — raw === source slice", () => {
  const src = '{author="Claude" date="2026-06-14"++added++}';
  const n = parse(src).nodes[0];
  // Source mode renders n.raw untouched; it intentionally still shows the prefix.
  assert.equal(n.raw, src);
  assert.ok(n.raw.includes('author="Claude"'));
});

test("Reading safety-net: metaRaw is separable so the prefix can be discarded, not surfaced", () => {
  // LITERAL_MARKUP_RE / renderLiteralMatch discards the prefix capture; at the
  // data level that is exactly metaRaw being a distinct, droppable substring.
  const src = '{author="Bob" date="2026/06/14">>note<<}';
  const n = parse(src).nodes[0];
  assert.equal(n.metaRaw, 'author="Bob" date="2026/06/14"');
  // What a literal-fallback renderer keeps (body, prefix discarded):
  const kept = src.slice(n.innerFrom, n.innerTo);
  assert.equal(kept, "note");
  assert.ok(!kept.includes("author="));
  assert.ok(!kept.includes("date="));
  // Slash date kept verbatim for display, never validated.
  assert.equal(n.metaDate, "2026/06/14");
});

test("reading view hides the quoted prefix from output", () => {
  // Offset-level mirror of reading.ts stripping the open token (incl. the quoted
  // prefix) and the close sigil: only the body survives, no `author=`/`date=`.
  const src = '{author="Claude" date="2026-06-14"==important==}';
  const n = parse(src).nodes[0];
  const rendered =
    src.slice(0, n.from) + src.slice(n.innerFrom, n.innerTo) + src.slice(n.to);
  assert.equal(/author=|date=/.test(rendered), false);
  assert.ok(rendered.includes("important"));
});

// ===========================================================================
// Rendering: display fallback + author precedence + hue (§13).
// ===========================================================================

test("display fallback: unattributed mark with localAuthorName='Phil' → label Phil, hue authorHueIndex('Phil')", () => {
  const n = parse("{++x++}").nodes[0];
  assert.equal(n.metaAuthor, null);
  assert.equal(resolveAuthor(n, "Phil").label, "Phil");
  assert.equal(authorHue(n, "Phil"), authorHueIndex("Phil"));
});

test("display fallback: unattributed mark with localAuthorName='' → 'You', no hue", () => {
  const n = parse("{++x++}").nodes[0];
  assert.equal(resolveAuthor(n, "").label, "You");
  assert.equal(authorHue(n, ""), null);
});

test("explicit author beats the localAuthorName fallback", () => {
  const n = parse('{author="Claude"++x++}').nodes[0];
  assert.equal(resolveAuthor(n, "Phil").label, "Claude");
  assert.equal(authorHue(n, "Phil"), authorHueIndex("Claude"));
});

test("display fallback applies to every kind, not just comments", () => {
  for (const src of ["{++x++}", "{--x--}", "{~~a~>b~~}", "{==x==}"]) {
    const n = parse(src).nodes[0];
    assert.equal(resolveAuthor(n, "Phil").label, "Phil", src);
    assert.equal(authorHue(n, "Phil"), authorHueIndex("Phil"), src);
  }
});

test('both-present precedence (panel + reading): {author="Alice">>Bob: hello<<} → Alice, hue Alice, body hello', () => {
  const n = parse('{author="Alice">>Bob: hello<<}').nodes[0];
  assert.equal(n.kind, "comment");
  assert.equal(n.metaAuthor, "Alice");
  assert.equal(n.authorName, "Bob"); // legacy capture kept for the legacy path
  assert.equal(n.text, "hello"); // legacy <Name>: stripped from displayed text
  assert.equal(resolveAuthor(n, "Phil").label, "Alice");
  assert.equal(authorHue(n, "Phil"), authorHueIndex("Alice"));
});

test("metaLabel: author · date when date present; author alone when absent", () => {
  const withDate = parse('{author="Claude" date="2026-06-14"++x++}').nodes[0];
  assert.equal(metaLabel(withDate, "Phil"), "Claude · 2026-06-14");
  const noDate = parse('{author="Claude"++x++}').nodes[0];
  assert.equal(metaLabel(noDate, "Phil"), "Claude");
  const fallback = parse("{++x++}").nodes[0];
  assert.equal(metaLabel(fallback, ""), "You");
});

test("author with spaces resolves and hues on the whole trimmed name", () => {
  const n = parse('{author="Jean Dupont">>spaces<<}').nodes[0];
  assert.equal(n.metaAuthor, "Jean Dupont");
  assert.equal(resolveAuthor(n, "").label, "Jean Dupont");
  assert.equal(authorHue(n, ""), authorHueIndex("Jean Dupont"));
});

// ===========================================================================
// Cross-cutting: byte-equality strip per mark (the central corruption vector).
// ===========================================================================

test("byte-equality strip per kind: accept/reject output === bare-prefix-removed equivalent", () => {
  const cases = [
    { src: 'Add {author="A" date="2026-06-14"++X++}.', op: (n) => acceptAddition(n), out: "Add X." },
    { src: 'Add {author="A" date="2026-06-14"++X++}.', op: (n) => rejectAddition(n), out: "Add ." },
    { src: 'Drop {author="Claude"--this--} it.', op: (n) => acceptDeletion(n), out: "Drop  it." },
    {
      src: 'Keep {author="Claude" date="2026-06-14"--this sentence--} here.',
      op: (n) => rejectDeletion(n),
      out: "Keep this sentence here.",
    },
    { src: 'The {author="GPT"~~old word~>new word~~} stays.', op: (n) => acceptSubstitution(n), out: "The new word stays." },
    { src: 'The {author="GPT"~~old word~>new word~~} stays.', op: (n) => rejectSubstitution(n), out: "The old word stays." },
    { src: 'x {author="A"==important==} y', op: (n) => removeHighlight(n), out: "x important y" },
  ];
  for (const c of cases) {
    const r = parse(c.src);
    const n = r.nodes[0];
    const out = applyEdits(c.src, [c.op(n)]);
    assert.equal(out, c.out, c.src);
    // Zero prefix bleed: the restored / kept content carries no metadata.
    assert.ok(!out.includes("author="), `prefix bled into output: ${c.src}`);
    assert.ok(!out.includes("date="), `date bled into output: ${c.src}`);
  }
});

test('substitution-ordering safety: {author="X"~~a~>b==c==d~~} accept=b==c==d, reject=a', () => {
  const src = '{author="X"~~a~>b==c==d~~}';
  const r = parse(src);
  assert.equal(r.nodes.length, 1);
  const n = r.nodes[0];
  assert.equal(n.kind, "substitution");
  assert.equal(n.oldText, "a");
  assert.equal(n.newText, "b==c==d");
  assert.equal(applyEdits(src, [acceptSubstitution(n)]), "b==c==d");
  assert.equal(applyEdits(src, [rejectSubstitution(n)]), "a");
});

// ===========================================================================
// Cross-cutting: corruption guards (must NOT span marks; single braces survive).
// ===========================================================================

test("corruption guard: unterminated quote must NOT span the comment and a real deletion", () => {
  // `date="2026--bad` never closes its quote before the next brace, so the pair
  // fails, the prefix collapses to "", and the bogus comment forms no mark — it
  // can never hand its `--` to the deletion sigil and straddle. Only the genuine
  // deletion survives.
  const src = '{author="X" date="2026--bad>>c<<} and {--realdel--}';
  const r = parse(src);
  // No single mark may straddle from the bogus prefix to the real deletion.
  for (const n of r.nodes) {
    assert.ok(
      !(n.from <= src.indexOf(">>c") && n.to >= src.indexOf("{--realdel")),
      `straddling mark survived: ${JSON.stringify(n)}`,
    );
  }
  // The genuine deletion survives intact.
  const del = r.nodes.find((n) => n.kind === "deletion" && n.text === "realdel");
  assert.ok(del, "real deletion must survive the guard");
  assert.equal(del.raw, "{--realdel--}");
});

test("corruption guard: unquoted short date {date=2026--6--deleted--} forms no mark", () => {
  // No quote → not a valid pair → prefix collapses to ""; `{date=2026…` is not a
  // sigil, so the whole thing forms no mark — there is no deletion to reject and
  // `6--deleted` can never be restored as prose.
  const src = "{date=2026--6--deleted--}";
  const r = parse(src);
  assert.equal(r.nodes.length, 0, "unquoted short date forms no mark");
});

test("corruption guard: brace inside a quoted value degrades to no mark", () => {
  // `}` is forbidden in the value class, so the quote can't close — no mark.
  const r = parse('{author="a}b">>x<<}');
  assert.equal(r.nodes.length, 0);
});

test("legit single brace in prose survives as one deletion", () => {
  const src = "{--remove the {foo} placeholder--}";
  const r = parse(src);
  assert.equal(r.nodes.length, 1);
  const n = r.nodes[0];
  assert.equal(n.kind, "deletion");
  assert.equal(n.text, "remove the {foo} placeholder");
  assert.equal(n.raw, src);
});

test("timezone offset parses inside a quoted value (rich punctuation allowed)", () => {
  // `+`, `:`, `-` are all legal inside the quoted value class, so a full ISO
  // offset timestamp now parses (unlike the old `;`-grammar limitation).
  const n = parse('{author="Claude" date="2026-06-14T13:45:00+02:00">>c<<}').nodes[0];
  assert.equal(n.kind, "comment");
  assert.equal(n.text, "c");
  assert.equal(n.metaDate, "2026-06-14T13:45:00+02:00");
});

test("ISO datetime with : and Z parses; prefix captured whole", () => {
  const n = parse('{author="Claude" date="2026-06-14T13:45:00Z">>c<<}').nodes[0];
  assert.equal(n.kind, "comment");
  assert.equal(n.text, "c");
  assert.equal(n.metaAuthor, "Claude");
  assert.equal(n.metaDate, "2026-06-14T13:45:00Z");
  assert.equal(n.metaRaw, 'author="Claude" date="2026-06-14T13:45:00Z"');
});

test("empty/malformed prefixes degrade safely", () => {
  assert.equal(parse("{=>>x<<}").nodes.length, 0, "{=>>x<<} → no mark");
  assert.equal(parse("{;>>x<<}").nodes.length, 0, "{;>>x<<} → no mark");
  // Quoted value flush against the sigil → valid mark; the degrade case is an
  // unquoted value (no `"`) or an unterminated quote.
  assert.equal(parse('{author="A">>x<<}').nodes.length, 1, "quoted value abutting sigil → valid mark");
  assert.equal(parse("{author=A>>x<<}").nodes.length, 0, "unquoted value → no mark");
  assert.equal(parse('{author="A>>x<<}').nodes.length, 0, "unterminated quote → no mark");
  assert.equal(parse('{ author="Claude" ++a++}').nodes.length, 0, "leading space → no mark");
  // Empty value (quoted "") → dropped, so the comment has metaAuthor null.
  const r = parse('{author="">>x<<}');
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "comment");
  assert.equal(r.nodes[0].metaAuthor, null);
});

// ===========================================================================
// Cross-cutting: reply stamping (date always; author only when set; sanitize).
// ===========================================================================

test('reply stamping: localAuthorName=\'Phil\' → {author="Phil" date="<today>">>r<<}, re-parses to Phil', () => {
  const src = "{>>Claude: root<<}";
  const r = parse(src);
  const edit = appendReply(src, r.threads[0], r, "r", "Phil");
  const out = applyEdits(src, [edit]);
  const reply = `{author="Phil" date="${TODAY}">>r<<}`;
  assert.ok(out.endsWith(reply), out);
  assert.match(TODAY, /^\d{4}-\d{2}-\d{2}$/);
  // Re-parse the appended reply: author resolves to Phil.
  const rp = parse(out);
  const replyNode = rp.nodes.find((n) => n.text === "r");
  assert.ok(replyNode, "reply must re-parse");
  assert.equal(replyNode.metaAuthor, "Phil");
  assert.equal(replyNode.metaDate, TODAY);
});

test('reply stamping: localAuthorName=\'\' → {date="<today>">>r<<}, no author=, re-parses to null → You', () => {
  const src = "{>>Claude: root<<}";
  const r = parse(src);
  const edit = appendReply(src, r.threads[0], r, "r", "");
  const out = applyEdits(src, [edit]);
  assert.ok(out.endsWith(`{date="${TODAY}">>r<<}`), out);
  assert.ok(!out.includes("author="), "must never write an empty author=");
  const replyNode = parse(out).nodes.find((n) => n.text === "r");
  assert.equal(replyNode.metaAuthor, null);
  assert.equal(resolveAuthor(replyNode, "").label, "You");
});

test("reply stamping: malicious name is sanitized, parses as one comment, rebase still works", () => {
  const src = "{>>Claude: root<<}";
  const r = parse(src);
  // The quoted prefix only forbids `"`, `{`, `}` (+ control) in a value, so the
  // sanitizer drops just those; `;`/`=` survive but can't break out of the quote.
  const malicious = 'Phil; author="Mallory"{}';
  const edit = appendReply(src, r.threads[0], r, "hi", malicious);
  const sanitized = sanitizeAuthorName(malicious);
  assert.ok(!/["{}]/.test(sanitized), "sanitized name still has quote/brace chars");
  const out = applyEdits(src, [edit]);
  const rp = parse(out);
  // Exactly one reply comment, attributed to the sanitized name.
  const replyNode = rp.nodes.find((n) => n.text === "hi");
  assert.ok(replyNode, "reply must parse as one comment");
  assert.equal(replyNode.metaAuthor, sanitized);
  // The whole document is still two comments (root + reply), no straddle.
  assert.equal(rp.nodes.filter((n) => n.kind === "comment").length, 2);
  // Rebase the edit against the unchanged doc → unchanged offsets (anchors hold).
  const rebased = rebaseEdit(src, edit);
  assert.ok(rebased, "rebase must succeed against the original doc");
  assert.equal(applyEdits(src, [rebased]), out);
});

// ===========================================================================
// Cross-cutting: fail-closed rebase.
// ===========================================================================

test("fail-closed rebase: drifting the on-disk prefix drops the edit (never corrupts)", () => {
  const src = 'Keep {author="Claude" date="2026-06-14"--this--} here.';
  const r = parse(src);
  const n = r.nodes[0];
  const edit = rejectDeletion(n); // expected === n.raw, includes the prefix
  // Drift the date in the document since parse-time.
  const drifted = src.replace('date="2026-06-14"', 'date="2026-06-15"');
  const rebased = rebaseEdit(drifted, edit);
  // No `before` anchor on an accept/reject edit → fail closed (returns null).
  assert.equal(rebased, null);
});

test("rebase round-trip per kind: expected === node.raw (incl. prefix), applies clean", () => {
  const fixtures = [
    { src: 'a {author="A" date="2026-06-14"++x++} b', op: (n) => acceptAddition(n), out: "a x b" },
    { src: 'a {author="A"--x--} b', op: (n) => acceptDeletion(n), out: "a  b" },
    { src: 'a {author="A"~~o~>n~~} b', op: (n) => acceptSubstitution(n), out: "a n b" },
    { src: 'a {author="A"==x==} b', op: (n) => removeHighlight(n), out: "a x b" },
  ];
  for (const c of fixtures) {
    const r = parse(c.src);
    const n = r.nodes[0];
    const edit = c.op(n);
    assert.equal(edit.expected, n.raw, c.src);
    assert.ok(edit.expected.includes(n.metaRaw), c.src);
    const rebased = rebaseEdit(c.src, edit); // doc unchanged → identity
    assert.ok(rebased, c.src);
    assert.equal(applyEdits(c.src, [rebased]), c.out, c.src);
  }
});

// ===========================================================================
// Settings / migration (§13).
// ===========================================================================

test("DEFAULT_SETTINGS carries localAuthorName: '' at the top level (not under finalize)", () => {
  assert.equal(DEFAULT_SETTINGS.localAuthorName, "");
  assert.ok(!("localAuthorName" in DEFAULT_SETTINGS.finalize));
});

test("new-key default-merge: partial stored finalize gains localAuthorName='' + inherited finalize subkeys", () => {
  const stored = { finalize: { additions: "reject" } };
  const merged = loadSettingsMerge(stored);
  assert.equal(merged.localAuthorName, "");
  assert.equal(merged.finalize.additions, "reject");
  // Other finalize sub-keys inherit defaults via the one-deep merge.
  assert.equal(merged.finalize.deletions, DEFAULT_SETTINGS.finalize.deletions);
  assert.equal(merged.finalize.substitutions, DEFAULT_SETTINGS.finalize.substitutions);
  assert.equal(merged.finalize.stripHighlights, DEFAULT_SETTINGS.finalize.stripHighlights);
});

test("round-trip: stored localAuthorName='Phil' survives loadSettings unchanged", () => {
  const merged = loadSettingsMerge({ localAuthorName: "Phil" });
  assert.equal(merged.localAuthorName, "Phil");
  // Untouched stored keys still inherit defaults.
  assert.equal(merged.readingShowComments, DEFAULT_SETTINGS.readingShowComments);
  assert.equal(merged.finalize.additions, DEFAULT_SETTINGS.finalize.additions);
});

test("empty stored data.json yields full defaults incl. localAuthorName=''", () => {
  const merged = loadSettingsMerge({});
  assert.deepEqual(merged, {
    ...DEFAULT_SETTINGS,
    finalize: { ...DEFAULT_SETTINGS.finalize },
  });
  assert.equal(merged.localAuthorName, "");
});

test("new-key default-merge: replyDateStyle defaults to 'date'", () => {
  const merged = loadSettingsMerge({ localAuthorName: "Phil" });
  assert.equal(merged.replyDateStyle, "date");
});

// ===========================================================================
// Finalize: rendering-adjacent — published output never echoes the prefix.
// ===========================================================================

test("finalize strips the prefix on all five marks (no author=/date=/braces for resolved marks)", () => {
  const src =
    '{author="A" date="2026-06-14"++a++}{author="B"--b--}{author="C"~~o~>n~~}{author="D">>c<<}{author="E"==h==}';
  const r = parse(src);
  const out = applyEdits(src, finalizeEdits(r, DEFAULT_FINALIZE));
  assert.ok(!out.includes("author="), out);
  assert.ok(!out.includes("date="), out);
  assert.ok(!out.includes("{"), out);
  assert.ok(!out.includes("}"), out);
});

test("finalize with stripHighlights=false leaves a prefixed highlight verbatim (documented)", () => {
  const src = '{author="X"==keep==}';
  const r = parse(src);
  const opts = { ...DEFAULT_FINALIZE, stripHighlights: false };
  const out = applyEdits(src, finalizeEdits(r, opts));
  // Documented behavior: the kept highlight retains its author/date metadata.
  assert.equal(out, '{author="X"==keep==}');
});

console.log("done.");
