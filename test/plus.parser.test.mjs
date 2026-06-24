// Parser tests for CriticMarkup Plus (author/date prefix). Run with:
//   node test/plus.parser.test.mjs
//
// Uses the same inline esbuild + base64 data-URL import harness as
// parser.test.mjs so we don't need ts-node. parser.ts and authors.ts are each
// compiled in memory and imported as ESM modules.

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function importTs(rel) {
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

const parserMod = await importTs("../src/parser.ts");
const authorsMod = await importTs("../src/authors.ts");
const { parse } = parserMod;
const { authorHueIndex } = authorsMod;

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

// Helper: assert a payload field never contains the consumed prefix.
function assertNoPrefixBleed(node) {
  if (node.metaRaw === "") return;
  for (const f of ["text", "oldText", "newText"]) {
    if (typeof node[f] === "string") {
      assert.ok(
        !node[f].includes(node.metaRaw),
        `payload ${f} (${JSON.stringify(node[f])}) leaked metaRaw (${JSON.stringify(node.metaRaw)})`,
      );
    }
  }
}

console.log("plus parser:");

// ---------------------------------------------------------------------------
// No-regression: standard prefix-free marks parse byte-identically to before.
// ---------------------------------------------------------------------------

test("no-regression: bare addition parses identically", () => {
  const r = parse("{++x++}");
  assert.equal(r.nodes.length, 1);
  const n = r.nodes[0];
  assert.equal(n.kind, "addition");
  assert.equal(n.text, "x");
  assert.equal(n.metaAuthor, null);
  assert.equal(n.metaDate, null);
  assert.equal(n.metaRaw, "");
  assert.equal(n.from, 0);
  assert.equal(n.to, "{++x++}".length);
  assert.equal(n.raw, "{++x++}");
  // innerFrom/innerTo bound exactly the payload.
  assert.equal("{++x++}".slice(n.innerFrom - n.from, n.innerTo - n.from), "x");
});

test("no-regression: bare deletion parses identically", () => {
  const r = parse("{--x--}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "deletion");
  assert.equal(r.nodes[0].text, "x");
  assert.equal(r.nodes[0].metaRaw, "");
});

test("no-regression: bare comment parses identically", () => {
  const r = parse("{>>x<<}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "comment");
  assert.equal(r.nodes[0].text, "x");
  assert.equal(r.nodes[0].metaAuthor, null);
  assert.equal(r.nodes[0].authorName, null);
  assert.equal(r.nodes[0].metaRaw, "");
});

test("no-regression: bare substitution parses identically", () => {
  const r = parse("{~~a~>b~~}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "substitution");
  assert.equal(r.nodes[0].oldText, "a");
  assert.equal(r.nodes[0].newText, "b");
  assert.equal(r.nodes[0].metaRaw, "");
});

test("no-regression: bare highlight parses identically", () => {
  const r = parse("{==x==}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "highlight");
  assert.equal(r.nodes[0].text, "x");
  assert.equal(r.nodes[0].metaRaw, "");
});

test("no-regression: legacy <Name>: comment still parses", () => {
  const r = parse("{>>Claude: hi<<}");
  assert.equal(r.nodes.length, 1);
  const n = r.nodes[0];
  assert.equal(n.kind, "comment");
  assert.equal(n.authorName, "Claude");
  assert.equal(n.text, "hi");
  // No prefix present, so metaAuthor resolves through the legacy path to Claude.
  assert.equal(n.metaAuthor, "Claude");
  assert.equal(n.metaRaw, "");
});

// ---------------------------------------------------------------------------
// Byte-equality strip per mark: raw includes the prefix, payload excludes it.
// ---------------------------------------------------------------------------

test("byte-equality: addition raw includes prefix, payload excludes it", () => {
  const src = '{author="Claude" date="2026-06-14"++added text++}';
  const r = parse(src);
  assert.equal(r.nodes.length, 1);
  const n = r.nodes[0];
  assert.equal(n.kind, "addition");
  assert.equal(n.raw, src); // raw spans outer-brace to outer-brace incl. prefix
  assert.equal(n.metaRaw, 'author="Claude" date="2026-06-14"');
  assert.equal(n.metaAuthor, "Claude");
  assert.equal(n.metaDate, "2026-06-14");
  assert.equal(n.text, "added text"); // payload excludes prefix + sigils
  assert.equal(src.slice(n.innerFrom, n.innerTo), "added text");
  assertNoPrefixBleed(n);
});

test("byte-equality: deletion raw includes prefix, payload excludes it", () => {
  const src = '{author="Claude" date="2026-06-14"--deleted text--}';
  const r = parse(src);
  const n = r.nodes[0];
  assert.equal(n.kind, "deletion");
  assert.equal(n.raw, src);
  assert.equal(n.metaRaw, 'author="Claude" date="2026-06-14"');
  assert.equal(n.text, "deleted text");
  assert.equal(src.slice(n.innerFrom, n.innerTo), "deleted text");
  assertNoPrefixBleed(n);
});

test("byte-equality: substitution old/new exclude prefix", () => {
  const src = '{author="Claude"~~old~>new~~}';
  const r = parse(src);
  const n = r.nodes[0];
  assert.equal(n.kind, "substitution");
  assert.equal(n.raw, src);
  assert.equal(n.metaRaw, 'author="Claude"');
  assert.equal(n.metaAuthor, "Claude");
  assert.equal(n.metaDate, null); // date omitted
  assert.equal(n.oldText, "old");
  assert.equal(n.newText, "new");
  assert.equal(src.slice(n.innerFrom, n.innerTo), "old");
  assertNoPrefixBleed(n);
});

test("byte-equality: comment body excludes prefix", () => {
  const src = '{author="Claude">>a comment<<}';
  const r = parse(src);
  const n = r.nodes[0];
  assert.equal(n.kind, "comment");
  assert.equal(n.raw, src);
  assert.equal(n.metaRaw, 'author="Claude"');
  assert.equal(n.metaAuthor, "Claude");
  assert.equal(n.text, "a comment");
  assert.equal(src.slice(n.innerFrom, n.innerTo), "a comment");
  assertNoPrefixBleed(n);
});

test("byte-equality: highlight body excludes prefix", () => {
  const src = '{author="Claude"==a highlight==}';
  const r = parse(src);
  const n = r.nodes[0];
  assert.equal(n.kind, "highlight");
  assert.equal(n.raw, src);
  assert.equal(n.metaRaw, 'author="Claude"');
  assert.equal(n.metaAuthor, "Claude");
  assert.equal(n.text, "a highlight");
  assert.equal(src.slice(n.innerFrom, n.innerTo), "a highlight");
  assertNoPrefixBleed(n);
});

// ---------------------------------------------------------------------------
// Corruption guards (the central R1/R2 vectors).
// ---------------------------------------------------------------------------

test("CORRUPTION GUARD: --inside-date must NOT span across marks", () => {
  const src = '{author="X" date="2026--bad">>c<<} and {--realdel--}';
  const r = parse(src);
  // No single mark may straddle the comment and the genuine deletion.
  for (const n of r.nodes) {
    const spansBoth = n.raw.includes(">>c<<") && n.raw.includes("realdel");
    assert.ok(!spansBoth, `mark straddles both: ${JSON.stringify(n.raw)}`);
  }
  // The genuine deletion must survive intact.
  const del = r.nodes.find((n) => n.kind === "deletion" && n.text === "realdel");
  assert.ok(del, "the real {--realdel--} deletion was lost");
  assert.equal(del.raw, "{--realdel--}");
  assert.equal(del.metaRaw, "");
});

test("CORRUPTION GUARD: malformed short date never forms a straddle", () => {
  // Unterminated quote: no closing `"` before the sigil/brace, so the pair fails,
  // the prefix collapses to "", and the mark fails to form locally — the
  // value-class corruption defense, not an incidental dangling sigil.
  const src = '{date="2026--6--deleted--}';
  const r = parse(src);
  // Whatever degradation happens, no node may restore "6--deleted" as user
  // prose on reject — i.e. there must be no deletion whose text is the
  // malformed-date interior.
  for (const n of r.nodes) {
    if (n.kind === "deletion") {
      assert.ok(
        n.text !== "6--deleted" && !n.text.includes("6--deleted"),
        `deletion would restore malformed date interior: ${JSON.stringify(n.text)}`,
      );
    }
  }
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

test("brace in value degrades to no mark", () => {
  const r = parse('{author="Claude{nested}">>x<<}');
  assert.equal(r.nodes.length, 0);
});

// ---------------------------------------------------------------------------
// Five canonical examples (§4.7).
// ---------------------------------------------------------------------------

test("canonical: addition with author+date", () => {
  const r = parse('{author="Claude" date="2026-06-14"++added text++}');
  const n = r.nodes[0];
  assert.equal(n.kind, "addition");
  assert.equal(n.metaAuthor, "Claude");
  assert.equal(n.metaDate, "2026-06-14");
  assert.equal(n.text, "added text");
});

test("canonical: deletion with author+date", () => {
  const r = parse('{author="Claude" date="2026-06-14"--deleted text--}');
  const n = r.nodes[0];
  assert.equal(n.kind, "deletion");
  assert.equal(n.metaAuthor, "Claude");
  assert.equal(n.metaDate, "2026-06-14");
  assert.equal(n.text, "deleted text");
});

test("canonical: substitution with author, no date", () => {
  const r = parse('{author="Claude"~~old~>new~~}');
  const n = r.nodes[0];
  assert.equal(n.kind, "substitution");
  assert.equal(n.metaAuthor, "Claude");
  assert.equal(n.metaDate, null);
  assert.equal(n.oldText, "old");
  assert.equal(n.newText, "new");
});

test("canonical: comment with author", () => {
  const r = parse('{author="Claude">>a comment<<}');
  const n = r.nodes[0];
  assert.equal(n.kind, "comment");
  assert.equal(n.metaAuthor, "Claude");
  assert.equal(n.text, "a comment");
});

test("canonical: highlight with author", () => {
  const r = parse('{author="Claude"==a highlight==}');
  const n = r.nodes[0];
  assert.equal(n.kind, "highlight");
  assert.equal(n.metaAuthor, "Claude");
  assert.equal(n.text, "a highlight");
});

// ---------------------------------------------------------------------------
// Date handling: ISO datetime, timezone offset, slash dates.
// ---------------------------------------------------------------------------

test("ISO datetime with colons and Z parses, prefix captured whole", () => {
  const src = '{author="Claude" date="2026-06-14T13:45:00Z">>c<<}';
  const r = parse(src);
  assert.equal(r.nodes.length, 1);
  const n = r.nodes[0];
  assert.equal(n.kind, "comment");
  assert.equal(n.text, "c");
  assert.equal(n.metaAuthor, "Claude");
  assert.equal(n.metaDate, "2026-06-14T13:45:00Z");
  assert.equal(n.metaRaw, 'author="Claude" date="2026-06-14T13:45:00Z"');
});

test("numeric timezone offset now parses (quotes allow `+`/`:`)", () => {
  // The quoted value class permits `+` and `:`, so a full offset timestamp now
  // forms a mark (it was a known limitation under the old `;`-grammar).
  const r = parse('{author="Claude" date="2026-06-14T13:45:00+02:00">>c<<}');
  assert.equal(r.nodes.length, 1);
  const n = r.nodes[0];
  assert.equal(n.kind, "comment");
  assert.equal(n.metaDate, "2026-06-14T13:45:00+02:00");
  assert.equal(n.text, "c");
});

test("slash date kept verbatim (display-only, lenient)", () => {
  const r = parse('{author="Bob" date="2026/06/14">>c<<}');
  const n = r.nodes[0];
  assert.equal(n.kind, "comment");
  assert.equal(n.metaAuthor, "Bob");
  assert.equal(n.metaDate, "2026/06/14");
  assert.equal(n.text, "c");
});

// ---------------------------------------------------------------------------
// Author values: spaces, both-present precedence.
// ---------------------------------------------------------------------------

test("author with a space is allowed and trimmed", () => {
  const r = parse('{author="Jean Dupont">>spaces<<}');
  const n = r.nodes[0];
  assert.equal(n.kind, "comment");
  assert.equal(n.metaAuthor, "Jean Dupont");
  assert.equal(n.text, "spaces");
});

test("both-present: metaAuthor wins for attribution + hue, legacy stripped from text", () => {
  const r = parse('{author="A">>B: hi<<}');
  const n = r.nodes[0];
  assert.equal(n.kind, "comment");
  assert.equal(n.metaAuthor, "A");
  // The legacy <Name>: is still captured for the legacy path,
  assert.equal(n.authorName, "B");
  // but it is stripped from the displayed text regardless of metaAuthor.
  assert.equal(n.text, "hi");
  // Hue resolves on the winning author.
  assert.equal(authorHueIndex(n.metaAuthor), authorHueIndex("A"));
});

// ---------------------------------------------------------------------------
// Malformed prefixes degrade safely (§4.6).
// ---------------------------------------------------------------------------

test("empty key => no mark", () => {
  assert.equal(parse('{="x">>x<<}').nodes.length, 0);
});

test("unquoted value before sigil => no mark", () => {
  // A bare value with no quotes is not a valid pair, so no prefix forms and the
  // comment degrades to nothing.
  assert.equal(parse("{author=A>>x<<}").nodes.length, 0);
});

test("missing closing quote before sigil => no mark", () => {
  // The value never closes, so no pair matches and the mark degrades to nothing.
  assert.equal(parse('{author="A>>x<<}').nodes.length, 0);
});

test("empty quoted value => comment with metaAuthor null, prefix consumed", () => {
  const r = parse('{author="">>x<<}');
  assert.equal(r.nodes.length, 1);
  const n = r.nodes[0];
  assert.equal(n.kind, "comment");
  assert.equal(n.metaAuthor, null);
  assert.equal(n.text, "x");
  // The empty-value pair still matches the grammar and is consumed into metaRaw.
  assert.equal(n.metaRaw, 'author=""');
});

test("leading space before key => no mark", () => {
  assert.equal(parse('{ author="Claude" ++a++}').nodes.length, 0);
});

// ---------------------------------------------------------------------------
// Unknown keys, adjacency, equals-adjacency, substitution inner re-match.
// ---------------------------------------------------------------------------

test("unknown single key ignored, mark still parses", () => {
  const r = parse('{unknown="key"++a++}');
  assert.equal(r.nodes.length, 1);
  const n = r.nodes[0];
  assert.equal(n.kind, "addition");
  assert.equal(n.text, "a");
  assert.equal(n.metaAuthor, null);
  assert.equal(n.metaDate, null);
  // Prefix is consumed and surfaced on metaAttrs even though author/date drop.
  assert.equal(n.metaRaw, 'unknown="key"');
  assert.deepEqual(n.metaAttrs, { unknown: "key" });
  assertNoPrefixBleed(n);
});

test("adjacent mixed kinds => two independent marks", () => {
  const r = parse('{author="A"++x++}{author="B"==y==}');
  assert.equal(r.nodes.length, 2);
  const kinds = r.nodes.map((n) => n.kind);
  assert.deepEqual(kinds, ["addition", "highlight"]);
  assert.equal(r.nodes[0].metaAuthor, "A");
  assert.equal(r.nodes[1].metaAuthor, "B");
  // Non-overlapping.
  assert.ok(r.nodes[1].from >= r.nodes[0].to);
});

test("adjacent same-kind comments => two comments", () => {
  const r = parse('{author="A">>one<<}{author="B">>two<<}');
  assert.equal(r.nodes.length, 2);
  assert.equal(r.nodes[0].metaAuthor, "A");
  assert.equal(r.nodes[0].text, "one");
  assert.equal(r.nodes[1].metaAuthor, "B");
  assert.equal(r.nodes[1].text, "two");
});

test("equals-adjacency: {a===x==} is NOT a mark (no quoted pair)", () => {
  // The quoted grammar requires `key="value"`; a bare `a=` is not a valid pair,
  // so there is no prefix and the highlight never forms.
  assert.equal(parse("{a===x==}").nodes.length, 0);
});

test("equals-adjacency: {a==x==} is NOT a mark", () => {
  assert.equal(parse("{a==x==}").nodes.length, 0);
});

test("substitution inner re-match is dropped", () => {
  const r = parse('{author="X"~~a~>b==c==d~~}');
  assert.equal(r.nodes.length, 1);
  const n = r.nodes[0];
  assert.equal(n.kind, "substitution");
  assert.equal(n.metaAuthor, "X");
  assert.equal(n.oldText, "a");
  assert.equal(n.newText, "b==c==d");
  assertNoPrefixBleed(n);
});

// ---------------------------------------------------------------------------
// Code-region interaction, whitespace trimming.
// ---------------------------------------------------------------------------

test("prefixed mark immediately after inline code parses cleanly", () => {
  const r = parse('`x`{author="Y"++z++}');
  // The backtick span is a code region; the mark sits clear of it.
  const add = r.nodes.find((n) => n.kind === "addition");
  assert.ok(add, "addition after inline code was lost");
  assert.equal(add.metaAuthor, "Y");
  assert.equal(add.text, "z");
});

test("value with surrounding space is trimmed for display", () => {
  const r = parse('{author=" Claude "++a++}');
  assert.equal(r.nodes.length, 1);
  const n = r.nodes[0];
  assert.equal(n.kind, "addition");
  assert.equal(n.metaAuthor, "Claude"); // trimmed
  assert.equal(n.text, "a");
});

test("space before the first key kills the match", () => {
  assert.equal(parse('{ author="Claude"++a++}').nodes.length, 0);
});

// ---------------------------------------------------------------------------
// Quoted-attribute grammar (the genuinely new behavior).
// ---------------------------------------------------------------------------

test("quoted prefix: all five kinds parse author + date", () => {
  const cases = [
    ['{author="Claude" date="2026-06-14"++add++}', "addition", "add", "Claude"],
    ['{author="Codex" date="2026-06-14"--del--}', "deletion", "del", "Codex"],
    ['{author="Gemini" date="2026-06-14"==hi==}', "highlight", "hi", "Gemini"],
    ['{author="Claude" date="2026-06-14">>note<<}', "comment", "note", "Claude"],
  ];
  for (const [src, kind, body, author] of cases) {
    const { nodes } = parse(src);
    assert.equal(nodes.length, 1, src);
    assert.equal(nodes[0].kind, kind);
    assert.equal(nodes[0].metaAuthor, author);
    assert.equal(nodes[0].metaDate, "2026-06-14");
    assert.equal(nodes[0].text, body);
    assertNoPrefixBleed(nodes[0]);
  }
});

test("quoted substitution parses author/date and old/new", () => {
  const { nodes } = parse('{author="Claude" date="2026-06-14"~~old~>new~~}');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, "substitution");
  assert.equal(nodes[0].metaAuthor, "Claude");
  assert.equal(nodes[0].oldText, "old");
  assert.equal(nodes[0].newText, "new");
});

test("metaAttrs surfaces every key incl. unknown future keys", () => {
  const { nodes } = parse('{author="Claude" date="2026-06-14" status="open">>c<<}');
  assert.deepEqual(nodes[0].metaAttrs, {
    author: "Claude",
    date: "2026-06-14",
    status: "open",
  });
  assert.equal(nodes[0].metaAuthor, "Claude");
  assert.equal(nodes[0].metaDate, "2026-06-14");
});

test("quoted values hold spaces and punctuation", () => {
  // Backtick literal so the apostrophe and the `"` markup chars need no escaping.
  const { nodes } = parse(`{author="J. O'Reilly, Jr." date="2026-06-14T12:23:46Z"++x++}`);
  assert.equal(nodes[0].metaAuthor, "J. O'Reilly, Jr.");
  assert.equal(nodes[0].metaDate, "2026-06-14T12:23:46Z");
});

test("prefix-free marks parse byte-identically (empty metaAttrs)", () => {
  const { nodes } = parse("{++plain++}");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].metaRaw, "");
  assert.deepEqual(nodes[0].metaAttrs, {});
  assert.equal(nodes[0].metaAuthor, null);
  assert.equal(nodes[0].text, "plain");
});

test("first occurrence of a duplicate key wins; empty values dropped", () => {
  const { nodes } = parse('{author="First" author="Second" date="">>c<<}');
  assert.equal(nodes[0].metaAuthor, "First");
  assert.equal(nodes[0].metaDate, null);
  assert.equal("date" in nodes[0].metaAttrs, false);
});

test("keys are lowercased on lookup; metaRaw preserves original casing", () => {
  const { nodes } = parse('{Author="Claude" DATE="2026-06-14"++a++}');
  assert.equal(nodes.length, 1);
  assert.deepEqual(nodes[0].metaAttrs, { author: "Claude", date: "2026-06-14" });
  assert.equal(nodes[0].metaAuthor, "Claude");
  assert.equal(nodes[0].metaDate, "2026-06-14");
  // metaRaw is the exact consumed prefix — original casing intact.
  assert.equal(nodes[0].metaRaw, 'Author="Claude" DATE="2026-06-14"');
});

test("a tab may separate pairs (grammar is space/tab-separated)", () => {
  const { nodes } = parse('{author="Claude"\tdate="2026-06-14"++a++}');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].metaAuthor, "Claude");
  assert.equal(nodes[0].metaDate, "2026-06-14");
});

test("an all-whitespace value is dropped from metaAttrs", () => {
  const { nodes } = parse('{author="   "++a++}');
  assert.equal(nodes.length, 1);
  assert.deepEqual(nodes[0].metaAttrs, {});
  assert.equal(nodes[0].metaAuthor, null);
  assert.equal(nodes[0].text, "a");
});

test("value class admits ; = : together (no terminator regression)", () => {
  const { nodes } = parse('{author="a;b=c:d"++x++}');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].metaAuthor, "a;b=c:d");
  assert.equal(nodes[0].text, "x");
});

console.log("done.");
