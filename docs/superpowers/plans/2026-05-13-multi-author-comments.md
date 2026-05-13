# Multi-author comments — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single configured `aiPrefix` with auto-detected `Name:` prefixes so multiple distinct authors (Claude, GPT, Gemini, the user, …) each render with their own label and color.

**Architecture:** A new `src/authors.ts` module owns the detection regex and the name-to-hue mapping (with hardcoded overrides for well-known LLMs). The parser stops taking an `aiPrefix` option and emits `authorName: string | null` instead of `author: "ai" | "human"`. All renderers (panel, inline chip, reading-mode) derive label and hue from `authorName`. The `aiPrefix` setting is removed. The resolved-thread sweep stops requiring `null` authorship.

**Tech Stack:** TypeScript (strict, ES2018, CJS bundle for Obsidian), esbuild, plain Node `.mjs` test scripts.

**Spec:** `docs/superpowers/specs/2026-05-13-multi-author-comments-design.md`

---

## File Structure

| File | Role | Status |
|---|---|---|
| `src/authors.ts` | New — `AUTHOR_RE`, `KNOWN_AUTHORS`, `authorHueIndex()` | Create |
| `test/authors.test.mjs` | New — hue helper tests | Create |
| `src/parser.ts` | Use `AUTHOR_RE`; drop `aiPrefix`; `authorName: string \| null` | Modify |
| `test/parser.test.mjs` | Replace `aiPrefix`/`author` assertions | Modify |
| `test/parser.edge.test.mjs` | Update one `author` assertion | Modify |
| `test/operations.test.mjs` | Update one `author` assertion | Modify |
| `src/settings.ts` | Drop `aiPrefix` setting + UI row | Modify |
| `src/finalize.ts` | Drop `aiPrefix` parameter | Modify |
| `src/panel/view.ts` | Render from `authorName`; use `authorHueIndex` | Modify |
| `src/editor/decorations.ts` | Chip from `authorName`; use `authorHueIndex` | Modify |
| `src/reading.ts` | Chip from `authorName`; drop `aiPrefix` option | Modify |
| `src/main.ts` | Drop `getAiPrefix`; relax resolved-thread sweep | Modify |
| `styles.css` | Add `--kcm-author-hue-N` vars + `[data-author-hue]` selectors; drop `kcm-*-ai`/`-human` AI/human variants | Modify |
| `examples/CLAUDE.md` | Update guidance: agents prefix with `<Name>:` | Modify |
| `CLAUDE.md` | Update "Threading" + "Settings" notes | Modify |

---

## Task 1: Create `src/authors.ts` with regex, known-authors map, and hue helper

**Files:**
- Create: `src/authors.ts`
- Test: `test/authors.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/authors.test.mjs`:

```js
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = await build({
  entryPoints: [resolve(__dirname, "../src/authors.ts")],
  bundle: false,
  format: "esm",
  target: "es2018",
  write: false,
  platform: "neutral",
});
const code = out.outputFiles[0].text;
const mod = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const { AUTHOR_RE, authorHueIndex } = mod;

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

console.log("authors:");

test("AUTHOR_RE matches Claude:", () => {
  const m = "Claude: hello".match(AUTHOR_RE);
  assert.ok(m);
  assert.equal(m[1], "Claude");
});

test("AUTHOR_RE matches GPT-4:", () => {
  const m = "GPT-4: hi".match(AUTHOR_RE);
  assert.ok(m);
  assert.equal(m[1], "GPT-4");
});

test("AUTHOR_RE matches lowercased gpt:", () => {
  const m = "gpt: hi".match(AUTHOR_RE);
  assert.ok(m);
  assert.equal(m[1], "gpt");
});

test("AUTHOR_RE allows leading whitespace", () => {
  const m = "  Claude: hello".match(AUTHOR_RE);
  assert.ok(m);
  assert.equal(m[1], "Claude");
});

test("AUTHOR_RE rejects multi-word strings", () => {
  assert.equal("asdjak adakjds : oops".match(AUTHOR_RE), null);
  assert.equal("see line 4 : bad".match(AUTHOR_RE), null);
});

test("AUTHOR_RE rejects empty name", () => {
  assert.equal(": oops".match(AUTHOR_RE), null);
});

test("AUTHOR_RE rejects digit-leading name", () => {
  assert.equal("4chan: hi".match(AUTHOR_RE), null);
});

test("AUTHOR_RE accepts TODO: as a false positive (documented)", () => {
  const m = "TODO: fix".match(AUTHOR_RE);
  assert.ok(m);
  assert.equal(m[1], "TODO");
});

test("authorHueIndex pins Claude to 7 (red)", () => {
  assert.equal(authorHueIndex("Claude"), 7);
  assert.equal(authorHueIndex("claude"), 7);
  assert.equal(authorHueIndex("CLAUDE"), 7);
});

test("authorHueIndex pins GPT variants to 2 (green)", () => {
  assert.equal(authorHueIndex("gpt"), 2);
  assert.equal(authorHueIndex("GPT"), 2);
  assert.equal(authorHueIndex("gpt-4"), 2);
  assert.equal(authorHueIndex("gpt-4o"), 2);
  assert.equal(authorHueIndex("ChatGPT"), 2);
});

test("authorHueIndex pins Gemini to 0 (blue)", () => {
  assert.equal(authorHueIndex("Gemini"), 0);
  assert.equal(authorHueIndex("gemini-pro"), 0);
});

test("authorHueIndex hashes unknown names deterministically into 0..7", () => {
  const a = authorHueIndex("Phil");
  const b = authorHueIndex("Phil");
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 8);
  assert.ok(authorHueIndex("SomeNewModel") >= 0);
  assert.ok(authorHueIndex("SomeNewModel") < 8);
});

console.log("done.");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/authors.test.mjs`
Expected: FAIL because `src/authors.ts` doesn't exist yet (esbuild will throw "Could not resolve").

- [ ] **Step 3: Write the implementation**

Create `src/authors.ts`:

```ts
// Author detection and per-author color assignment.
//
// A CriticMarkup comment is "named" if its body starts with `<Name>:` where
// `<Name>` is a single token (alpha-leading, \w/./- body, max 30 chars).
// Otherwise it's unnamed — the local user, rendered as "You".
//
// Each named author gets a hue from a small palette. Well-known LLM names
// (Claude, GPT, Gemini, …) are pinned to specific palette indices so the
// same model gets the same color across documents. Unknown names fall
// through to a hash. The palette itself lives in `styles.css` as
// `--kcm-author-hue-N` CSS variables.

export const AUTHOR_RE = /^\s*([A-Za-z][\w.\-]{0,29})\s*:\s*/;

const KNOWN_AUTHORS: Record<string, number> = {
  // index → hue defined in styles.css
  claude: 7,            // red
  gpt: 2,
  "gpt-4": 2,
  "gpt-4o": 2,
  "gpt-5": 2,
  chatgpt: 2,
  openai: 2,            // green
  gemini: 0,
  "gemini-pro": 0,
  bard: 0,              // blue
  copilot: 1,
  "github-copilot": 1,  // purple
  mistral: 3,
  mixtral: 3,           // orange
  llama: 5,             // teal
};

export function authorHueIndex(name: string): number {
  const lower = name.toLowerCase();
  if (lower in KNOWN_AUTHORS) return KNOWN_AUTHORS[lower];
  let h = 0;
  for (let i = 0; i < lower.length; i++) h = (h * 31 + lower.charCodeAt(i)) >>> 0;
  return h % 8;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/authors.test.mjs`
Expected: all 12 tests print `  ok  - …` and the script exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/authors.ts test/authors.test.mjs
git commit -m "Add author detection regex and hue helper

New src/authors.ts owns AUTHOR_RE (single-token Name: prefix) and
authorHueIndex(), which pins well-known LLM names (Claude=red,
GPT=green, Gemini=blue, Copilot=purple, Mistral=orange, Llama=teal)
to specific palette indices and falls back to a hash for unknown
names. Test coverage at test/authors.test.mjs."
```

---

## Task 2: Switch parser to `authorName`, drop `aiPrefix` option

**Files:**
- Modify: `src/parser.ts`
- Modify: `test/parser.test.mjs`
- Modify: `test/parser.edge.test.mjs`
- Modify: `test/operations.test.mjs`

- [ ] **Step 1: Update `test/parser.test.mjs` to use the new shape**

Replace the entire file with this content:

```js
// Smoke tests for the parser. Run with: node test/parser.test.mjs
//
// Uses a tiny inline compile step so we don't need ts-node.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = await build({
  entryPoints: [resolve(__dirname, "../src/parser.ts")],
  bundle: true,
  format: "esm",
  target: "es2018",
  write: false,
  platform: "neutral",
});
const code = out.outputFiles[0].text;
const mod = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const { parse, threadAtOffset, nodeAtOffset } = mod;

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

console.log("parser:");

test("recognises a Name: prefix as the author", () => {
  const r = parse("hello {>>AI: nice<<} world");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "comment");
  assert.equal(r.nodes[0].authorName, "AI");
  assert.equal(r.nodes[0].text, "nice");
  assert.equal(r.threads.length, 1);
});

test("preserves original casing of the captured name", () => {
  const r = parse("{>>Claude: nice<<}");
  assert.equal(r.nodes[0].authorName, "Claude");
  const r2 = parse("{>>claude: nice<<}");
  assert.equal(r2.nodes[0].authorName, "claude");
});

test("accepts hyphenated names like GPT-4", () => {
  const r = parse("{>>GPT-4: hi<<}");
  assert.equal(r.nodes[0].authorName, "GPT-4");
  assert.equal(r.nodes[0].text, "hi");
});

test("unprefixed comment has null authorName", () => {
  const r = parse("hello {>>done<<} world");
  assert.equal(r.nodes[0].authorName, null);
  assert.equal(r.nodes[0].text, "done");
});

test("multi-word fake prefix is not an author", () => {
  // The whole body becomes the comment text; authorName is null.
  const r = parse("{>>asdjak adakjds ajksdjads : oops<<}");
  assert.equal(r.nodes[0].authorName, null);
  assert.equal(r.nodes[0].text, "asdjak adakjds ajksdjads : oops");
});

test("digit-leading prefix is not an author", () => {
  const r = parse("{>>4chan: hi<<}");
  assert.equal(r.nodes[0].authorName, null);
});

test("empty name with bare colon is not an author", () => {
  const r = parse("{>>: oops<<}");
  assert.equal(r.nodes[0].authorName, null);
});

test("TODO: is an accepted false positive (documented)", () => {
  // Cosmetically a faux author chip; not a bug.
  const r = parse("{>>TODO: fix<<}");
  assert.equal(r.nodes[0].authorName, "TODO");
});

test("adjacent comments form one thread", () => {
  const r = parse("x {>>Claude: a<<}{>>done<<} y");
  assert.equal(r.threads.length, 1);
  assert.equal(r.threads[0].replyIndexes.length, 1);
});

test("comments on different lines are separate threads", () => {
  const r = parse("x {>>Claude: a<<}\ny {>>Claude: b<<}");
  assert.equal(r.threads.length, 2);
});

test("inline whitespace between adjacent comments still threads", () => {
  const r = parse("x {>>Claude: a<<}  {>>done<<} y");
  assert.equal(r.threads.length, 1);
  assert.equal(r.threads[0].replyIndexes.length, 1);
});

test("comments separated by prose on the same line are separate threads", () => {
  const r = parse("foo {>>Claude: a<<} bar baz {>>Claude: b<<} qux");
  assert.equal(r.threads.length, 2);
  assert.equal(r.threads[0].replyIndexes.length, 0);
  assert.equal(r.threads[1].replyIndexes.length, 0);
});

test("multi-author thread (Claude root, GPT reply) preserves both names", () => {
  const r = parse("{>>Claude: hi<<}{>>GPT: agreed<<}");
  assert.equal(r.threads.length, 1);
  assert.equal(r.threads[0].replyIndexes.length, 1);
  assert.equal(r.nodes[r.threads[0].rootIndex].authorName, "Claude");
  assert.equal(r.nodes[r.threads[0].replyIndexes[0]].authorName, "GPT");
});

test("parses addition", () => {
  const r = parse("x {++hello++} y");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "addition");
  assert.equal(r.nodes[0].text, "hello");
});

test("parses deletion", () => {
  const r = parse("x {--gone--} y");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "deletion");
  assert.equal(r.nodes[0].text, "gone");
});

test("parses substitution", () => {
  const r = parse("x {~~old~>new~~} y");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "substitution");
  assert.equal(r.nodes[0].oldText, "old");
  assert.equal(r.nodes[0].newText, "new");
});

test("parses highlight", () => {
  const r = parse("x {==look==} y");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "highlight");
});

test("mixed forms in document order", () => {
  const r = parse("a {++ins++} b {--del--} c {~~o~>n~~} d {>>Claude: c<<}");
  const kinds = r.nodes.map((n) => n.kind);
  assert.deepEqual(kinds, ["addition", "deletion", "substitution", "comment"]);
});

test("multi-message thread retains correct ranges", () => {
  const src = "x {>>Claude: a<<}{>>done<<} y";
  const r = parse(src);
  const t = r.threads[0];
  assert.equal(src.slice(t.from, t.to), "{>>Claude: a<<}{>>done<<}");
});

test("threadAtOffset finds the right thread", () => {
  const src = "x {>>Claude: a<<}\ny {>>Claude: b<<}";
  const r = parse(src);
  const off = src.indexOf("{>>Claude: b");
  const t = threadAtOffset(r, off);
  assert.equal(t, 1);
});

test("nodeAtOffset finds the right node", () => {
  const src = "x {++ins++} y";
  const r = parse(src);
  const off = src.indexOf("{++");
  assert.equal(nodeAtOffset(r, off), 0);
});

test("prefix is whitespace-tolerant", () => {
  const r = parse("{>>  AI:hi<<}");
  assert.equal(r.nodes[0].authorName, "AI");
  assert.equal(r.nodes[0].text, "hi");
});

test("no overlap with neighbouring forms", () => {
  const r = parse("{~~x++y~>z--w~~}");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "substitution");
});

test("empty source", () => {
  const r = parse("");
  assert.equal(r.nodes.length, 0);
  assert.equal(r.threads.length, 0);
});

console.log("done.");
```

Note: the original `bundle: false` flag is changed to `bundle: true` because `src/parser.ts` will now import from `src/authors.ts`. esbuild needs to resolve the import.

- [ ] **Step 2: Update `test/parser.edge.test.mjs`**

Two changes:

1. Find the line `bundle: false,` (line 11) and replace with `bundle: true,`. This is required because `src/parser.ts` will now import from `src/authors.ts` and esbuild needs to resolve the import.
2. Find the line `assert.equal(r.nodes[0].author, "human");` (line 39) and replace with `assert.equal(r.nodes[0].authorName, null);`.

- [ ] **Step 3: Update `test/operations.test.mjs`**

Find the line `assert.equal(r2.nodes[1].author, "human");` (line 126) and replace with `assert.equal(r2.nodes[1].authorName, null);`.

- [ ] **Step 4: Run tests to verify they fail**

Run: `node test/parser.test.mjs`
Expected: FAIL — most tests will fail because `authorName` is undefined on the current node type.

- [ ] **Step 5: Update `src/parser.ts`**

Replace the file with:

```ts
// CriticMarkup parser — the five recognized forms plus thread grouping.
//
// Forms:
//   {>>text<<}        comment (Name: prefix => named author; otherwise => "You")
//   {++text++}        addition
//   {--text--}        deletion
//   {~~old~>new~~}    substitution
//   {==text==}        highlight (review-panel card offers "Remove highlight")
//
// Thread rule: consecutive {>>...<<} blocks with only inline whitespace
// (no blank line) between them in the same paragraph form a thread.
// First block = root; subsequent = replies.

import { AUTHOR_RE } from "./authors";

export type NodeKind = "comment" | "addition" | "deletion" | "substitution" | "highlight";

export interface BaseNode {
  kind: NodeKind;
  /** character offset of the opening brace */
  from: number;
  /** character offset just past the closing brace */
  to: number;
  /** raw source text from `from` to `to` */
  raw: string;
}

export interface CommentNode extends BaseNode {
  kind: "comment";
  text: string;
  /** Captured `<Name>:` prefix (original casing), or null if unprefixed. */
  authorName: string | null;
}

export interface AdditionNode extends BaseNode {
  kind: "addition";
  text: string;
}

export interface DeletionNode extends BaseNode {
  kind: "deletion";
  text: string;
}

export interface SubstitutionNode extends BaseNode {
  kind: "substitution";
  oldText: string;
  newText: string;
}

export interface HighlightNode extends BaseNode {
  kind: "highlight";
  text: string;
}

export type CriticNode =
  | CommentNode
  | AdditionNode
  | DeletionNode
  | SubstitutionNode
  | HighlightNode;

export interface Thread {
  /** indexes into the parsed comments array */
  rootIndex: number;
  replyIndexes: number[];
  /** range covering the whole thread (root.from .. last.to) */
  from: number;
  to: number;
}

export interface ParseResult {
  nodes: CriticNode[];
  /** Each comment belongs to exactly one thread; threads are in document order. */
  threads: Thread[];
  /** For each node index, the thread index it belongs to (comments only); -1 otherwise. */
  nodeThread: number[];
}

const COMMENT_RE = /\{>>([\s\S]*?)<<\}/g;
const ADDITION_RE = /\{\+\+([\s\S]*?)\+\+\}/g;
const DELETION_RE = /\{--([\s\S]*?)--\}/g;
const SUBSTITUTION_RE = /\{~~([\s\S]*?)~>([\s\S]*?)~~\}/g;
const HIGHLIGHT_RE = /\{==([\s\S]*?)==\}/g;

function findCodeRegions(source: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  const fenceRe = /(^|\n)([ \t]*)(```+|~~~+)[^\n]*\n[\s\S]*?(?:\n\2\3[ \t]*(?=\n|$)|$)/g;
  for (const m of source.matchAll(fenceRe)) {
    const from = (m.index ?? 0) + m[1].length;
    regions.push([from, from + m[0].length - m[1].length]);
  }
  const inlineRe = /`[^`\n]+`/g;
  const inFence = (idx: number) => regions.some(([a, b]) => idx >= a && idx < b);
  for (const m of source.matchAll(inlineRe)) {
    const from = m.index ?? 0;
    if (inFence(from)) continue;
    regions.push([from, from + m[0].length]);
  }
  regions.sort((a, b) => a[0] - b[0]);
  return regions;
}

function offsetInRegions(offset: number, regions: Array<[number, number]>): boolean {
  for (const [a, b] of regions) {
    if (offset >= a && offset < b) return true;
    if (offset < a) return false;
  }
  return false;
}

export interface ParseOptions {
  /** Skip markup that falls inside fenced code blocks or inline code spans. Defaults to true. */
  skipCode?: boolean;
}

export function parse(source: string, options: ParseOptions = {}): ParseResult {
  const skipCode = options.skipCode !== false;
  const codeRegions = skipCode ? findCodeRegions(source) : [];
  const nodes: CriticNode[] = [];

  for (const m of source.matchAll(SUBSTITUTION_RE)) {
    nodes.push({
      kind: "substitution",
      from: m.index!,
      to: m.index! + m[0].length,
      raw: m[0],
      oldText: m[1],
      newText: m[2],
    });
  }
  for (const m of source.matchAll(ADDITION_RE)) {
    nodes.push({
      kind: "addition",
      from: m.index!,
      to: m.index! + m[0].length,
      raw: m[0],
      text: m[1],
    });
  }
  for (const m of source.matchAll(DELETION_RE)) {
    nodes.push({
      kind: "deletion",
      from: m.index!,
      to: m.index! + m[0].length,
      raw: m[0],
      text: m[1],
    });
  }
  for (const m of source.matchAll(HIGHLIGHT_RE)) {
    nodes.push({
      kind: "highlight",
      from: m.index!,
      to: m.index! + m[0].length,
      raw: m[0],
      text: m[1],
    });
  }
  for (const m of source.matchAll(COMMENT_RE)) {
    const raw = m[0];
    const body = m[1];
    const authorMatch = body.match(AUTHOR_RE);
    const authorName = authorMatch ? authorMatch[1] : null;
    const text = authorMatch ? body.slice(authorMatch[0].length) : body;
    nodes.push({
      kind: "comment",
      from: m.index!,
      to: m.index! + raw.length,
      raw,
      text,
      authorName,
    });
  }

  nodes.sort((a, b) => a.from - b.from);

  const accepted: CriticNode[] = [];
  let lastEnd = -1;
  for (const n of nodes) {
    if (n.from < lastEnd) continue;
    if (skipCode && offsetInRegions(n.from, codeRegions)) continue;
    accepted.push(n);
    lastEnd = n.to;
  }

  const threads: Thread[] = [];
  const nodeThread: number[] = new Array(accepted.length).fill(-1);
  let currentThread: Thread | null = null;
  let prevCommentIdx = -1;

  for (let i = 0; i < accepted.length; i++) {
    const n = accepted[i];
    if (n.kind !== "comment") continue;

    if (prevCommentIdx >= 0 && currentThread) {
      const prev = accepted[prevCommentIdx] as CommentNode;
      const gap = source.slice(prev.to, n.from);
      if (/^[ \t]*$/.test(gap)) {
        currentThread.replyIndexes.push(i);
        currentThread.to = n.to;
        nodeThread[i] = threads.length - 1;
        prevCommentIdx = i;
        continue;
      }
    }

    currentThread = {
      rootIndex: i,
      replyIndexes: [],
      from: n.from,
      to: n.to,
    };
    threads.push(currentThread);
    nodeThread[i] = threads.length - 1;
    prevCommentIdx = i;
  }

  return { nodes: accepted, threads, nodeThread };
}

export function threadAtOffset(result: ParseResult, offset: number): number {
  for (let i = 0; i < result.threads.length; i++) {
    const t = result.threads[i];
    if (offset >= t.from && offset <= t.to) return i;
  }
  return -1;
}

export function nodeAtOffset(result: ParseResult, offset: number): number {
  for (let i = 0; i < result.nodes.length; i++) {
    const n = result.nodes[i];
    if (offset >= n.from && offset <= n.to) return i;
  }
  return -1;
}

export function contextSnippet(source: string, from: number, to: number, radius = 40): string {
  const start = Math.max(0, from - radius);
  const end = Math.min(source.length, to + radius);
  let snippet = source.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = "…" + snippet;
  if (end < source.length) snippet = snippet + "…";
  return snippet;
}
```

- [ ] **Step 6: Run all parser-touching tests**

Run: `node test/parser.test.mjs && node test/parser.edge.test.mjs && node test/operations.test.mjs`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/parser.ts test/parser.test.mjs test/parser.edge.test.mjs test/operations.test.mjs
git commit -m "Parser: switch to authorName from AUTHOR_RE; drop aiPrefix

CommentNode.author (\"ai\"|\"human\") becomes authorName (string|null).
ParseOptions.aiPrefix removed; the parser now uses the strict regex
from src/authors.ts. Existing tests retained where structural; author
assertions updated to the new shape. Adds a multi-author-thread test."
```

---

## Task 3: Drop `aiPrefix` from settings

**Files:**
- Modify: `src/settings.ts`

- [ ] **Step 1: Edit `src/settings.ts`**

Remove these lines from the `KissCriticMarkupSettings` interface (lines 10–15):

```
  /**
   * Prefix that marks a comment as AI-authored. Case-insensitive. A comment
   * starting with `<prefix>:` is treated as AI; everything else is treated as
   * a human reply. Example values: "AI", "Claude", "GPT", "Gemini".
   */
  aiPrefix: string;
```

Remove from `DEFAULT_SETTINGS` (line 23):

```
  aiPrefix: "AI",
```

Remove the "AI author prefix" `Setting` block from the `display()` method (lines 53–66):

```
    new Setting(containerEl)
      .setName("AI author prefix")
      .setDesc(
        "Comments starting with `<prefix>:` are treated as AI-authored; others are treated as human replies. Case-insensitive. Tell your agent to use the same prefix.",
      )
      .addText((t) =>
        t
          .setPlaceholder("AI")
          .setValue(this.plugin.settings.aiPrefix)
          .onChange(async (v) => {
            this.plugin.settings.aiPrefix = v.trim() || "AI";
            await this.plugin.saveSettings();
          }),
      );
```

No migration code is required — `loadSettings` in `main.ts` does a shallow merge over `DEFAULT_SETTINGS`, so a stale `aiPrefix` key from a previous install is silently retained on disk but no longer read or written meaningfully. (It will eventually be overwritten by `saveSettings`, which writes the current settings object.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: TypeScript errors in `src/main.ts`, `src/finalize.ts`, `src/panel/view.ts`, `src/reading.ts` because they still reference `settings.aiPrefix`. **Leave them — Tasks 4–9 fix them.** This task is committed independently because the surface change is small and easy to revert.

- [ ] **Step 3: Commit**

```bash
git add src/settings.ts
git commit -m "Settings: remove aiPrefix

Author detection is now automatic from the Name: prefix on each
comment; no per-vault configuration is needed. A stale aiPrefix value
left over from a previous install is harmlessly ignored."
```

---

## Task 4: Drop `aiPrefix` from finalize

**Files:**
- Modify: `src/finalize.ts`

- [ ] **Step 1: Edit `src/finalize.ts`**

In `FinalizeModal`:

- Remove `private aiPrefix: string;` (line 18).
- Remove the `aiPrefix: string,` parameter from the constructor (line 25).
- Remove `this.aiPrefix = aiPrefix;` (line 31).
- Change `summarizeFinalize(parse(source, { aiPrefix }), this.opts)` (line 34) to `summarizeFinalize(parse(source), this.opts)`.
- Change `finalizeEdits(parse(this.source, { aiPrefix: this.aiPrefix }), this.opts)` (line 107) to `finalizeEdits(parse(this.source), this.opts)`.
- Change `summarizeFinalize(parse(this.source, { aiPrefix: this.aiPrefix }), this.opts)` (line 123) to `summarizeFinalize(parse(this.source), this.opts)`.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: errors remain in `main.ts`, `panel/view.ts`, `reading.ts`. The error count should be smaller than before this task.

- [ ] **Step 3: Commit**

```bash
git add src/finalize.ts
git commit -m "Finalize: drop aiPrefix parameter

Finalize logic never used authorship for decisions — it passed
aiPrefix to parse() purely to keep call-sites consistent. With the
option gone from parse(), the parameter is removed end to end."
```

---

## Task 5: Update panel view to use `authorName` and per-hue styling

**Files:**
- Modify: `src/panel/view.ts`

- [ ] **Step 1: Add the authors import**

At the top of `src/panel/view.ts`, alongside the existing parser import (around line 23-32), add:

```ts
import { authorHueIndex } from "../authors";
```

- [ ] **Step 2: Update `PanelHost` interface**

Remove `getAiPrefix(): string;` from the `PanelHost` interface (line 58) and the docstring above it (line 57).

- [ ] **Step 3: Update `refresh()` to drop the aiPrefix parse option**

In `refresh()` (line 180), change:

```ts
const parsed = parse(source, { aiPrefix: this.host.getAiPrefix() });
```

to:

```ts
const parsed = parse(source);
```

- [ ] **Step 4: Update message rendering to use authorName**

In `renderThreadCard()` (around lines 270–289), replace the message rendering block:

```ts
    for (const idx of ids) {
      const c = parsed.nodes[idx] as CommentNode;
      const msg = messages.createDiv({
        cls: `kcm-message kcm-message-${c.author}`,
      });
      const meta = msg.createDiv({ cls: "kcm-message-meta" });
      meta.createSpan({
        cls: "kcm-message-author",
        text: c.author === "ai" ? this.host.getAiPrefix() : "You",
      });
```

with:

```ts
    for (const idx of ids) {
      const c = parsed.nodes[idx] as CommentNode;
      const msg = messages.createDiv({
        cls: `kcm-message kcm-message-${c.authorName ? "named" : "you"}`,
      });
      if (c.authorName) {
        msg.setAttr("data-author-hue", String(authorHueIndex(c.authorName)));
      }
      const meta = msg.createDiv({ cls: "kcm-message-meta" });
      meta.createSpan({
        cls: "kcm-message-author",
        text: c.authorName ?? "You",
      });
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: errors remain only in `main.ts` (which still passes `getAiPrefix` into the `PanelHost`) and `reading.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/panel/view.ts
git commit -m "Panel: render messages from authorName with per-hue accent

Display label is the captured Name: prefix (or \"You\" for unnamed
comments). CSS classes split into kcm-message-named / kcm-message-you,
with a data-author-hue attribute on named messages so the stylesheet
can color them by the palette index from authorHueIndex()."
```

---

## Task 6: Update inline chip decoration to use `authorName`

**Files:**
- Modify: `src/editor/decorations.ts`

- [ ] **Step 1: Update imports**

At the top of `src/editor/decorations.ts`, replace:

```ts
import { parse, type CriticNode, type CommentNode, type Thread } from "../parser";
```

with:

```ts
import { parse, type CriticNode, type CommentNode, type Thread } from "../parser";
import { authorHueIndex } from "../authors";
```

- [ ] **Step 2: Update `DecorationCallbacks`**

Replace the `DecorationCallbacks` interface (lines 22-27):

```ts
export interface DecorationCallbacks {
  /** User clicked the inline rendering for the markup at this source offset. */
  onClick: (sourceOffset: number) => void;
  /** Configured AI-author prefix; passed through to parse() so author detection is consistent. */
  getAiPrefix: () => string;
}
```

with:

```ts
export interface DecorationCallbacks {
  /** User clicked the inline rendering for the markup at this source offset. */
  onClick: (sourceOffset: number) => void;
}
```

- [ ] **Step 3: Replace `ThreadChipWidget`**

Replace the entire `ThreadChipWidget` class (lines 29-80) with:

```ts
class ThreadChipWidget extends WidgetType {
  constructor(
    readonly index: number,
    readonly count: number,
    readonly authorName: string | null,
    readonly offset: number,
    readonly tooltip: string,
    readonly onClick: (offset: number) => void,
  ) {
    super();
  }

  eq(other: ThreadChipWidget): boolean {
    return (
      other.index === this.index &&
      other.count === this.count &&
      other.authorName === this.authorName &&
      other.offset === this.offset &&
      other.tooltip === this.tooltip
    );
  }

  toDOM(): HTMLElement {
    const chip = document.createElement("span");
    chip.className = `kcm-chip kcm-chip-${this.authorName ? "named" : "you"}`;
    if (this.authorName) {
      chip.setAttr("data-author-hue", String(authorHueIndex(this.authorName)));
    }
    chip.setAttr("role", "button");
    chip.setAttr("aria-label", `Open comment #${this.index} in panel`);
    chip.setAttr("title", this.tooltip);

    const icon = chip.createSpan({ cls: "kcm-chip-icon" });
    if (this.authorName) {
      const label = this.authorName.length > 12 ? this.authorName.slice(0, 11) + "…" : this.authorName;
      icon.setText(label);
    } else {
      icon.setText("💬");
    }

    chip.createSpan({ cls: "kcm-chip-num", text: `#${this.index}` });

    if (this.count > 1) {
      chip.createSpan({ cls: "kcm-chip-badge", text: String(this.count) });
    }

    chip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onClick(this.offset);
    });
    return chip;
  }

  ignoreEvent(): boolean {
    return false;
  }
}
```

- [ ] **Step 4: Replace `threadTooltip`**

Replace the `threadTooltip` function (lines 82-88) with:

```ts
function threadTooltip(thread: Thread, nodes: CriticNode[]): string {
  const ids = [thread.rootIndex, ...thread.replyIndexes];
  return ids
    .map((i) => nodes[i] as CommentNode)
    .map((c) => `${c.authorName ?? "You"}: ${c.text.trim()}`)
    .join("\n\n");
}
```

- [ ] **Step 5: Update `buildDecorations`**

Find lines 99-100:

```ts
  const aiPrefix = callbacks.getAiPrefix();
  const parsed = parse(source, { aiPrefix });
```

Replace with:

```ts
  const parsed = parse(source);
```

Then find the `ThreadChipWidget` constructor call (lines 137-145):

```ts
      const widget = new ThreadChipWidget(
        threadIndex,
        count,
        root.author,
        aiPrefix,
        t.from,
        threadTooltip(t, parsed.nodes, aiPrefix),
        callbacks.onClick,
      );
```

Replace with:

```ts
      const widget = new ThreadChipWidget(
        threadIndex,
        count,
        root.authorName,
        t.from,
        threadTooltip(t, parsed.nodes),
        callbacks.onClick,
      );
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: errors only in `main.ts` and `reading.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/editor/decorations.ts
git commit -m "Inline chip: render from authorName with per-hue styling

Chip class splits into kcm-chip-named / kcm-chip-you with a
data-author-hue attribute on named chips. The chip icon shows the
author name (truncated to 12 chars) for named comments and a speech
bubble for unnamed. DecorationCallbacks.getAiPrefix is removed."
```

---

## Task 7: Update reading-mode post-processor

**Files:**
- Modify: `src/reading.ts`

- [ ] **Step 1: Replace the file**

Overwrite `src/reading.ts` with:

```ts
// Reading-mode markdown post-processor.
//
// Reading mode is the rendered HTML view. We walk text nodes, find any
// CriticMarkup syntax, and replace it with appropriate inline elements:
//   - Comments: tiny icon — name initial for named authors, speech-bubble
//     for unnamed. Clicking does nothing (user switches to edit mode).
//   - Additions: depending on settings, show accepted form or styled.
//   - Deletions: hidden (accepted), or styled strikethrough (raw).
//   - Substitutions: show the new text (accepted), or both sides (raw).
//   - Highlights: render content with highlight styling regardless.

import type { MarkdownPostProcessorContext } from "obsidian";
import { AUTHOR_RE, authorHueIndex } from "./authors";

export interface ReadingOptions {
  /** How to render suggestions: accepted form (publish preview) or raw markup. */
  suggestions: "accepted" | "raw";
}

const COMBINED_RE = /\{>>([\s\S]*?)<<\}|\{\+\+([\s\S]*?)\+\+\}|\{--([\s\S]*?)--\}|\{~~([\s\S]*?)~>([\s\S]*?)~~\}|\{==([\s\S]*?)==\}/g;

function isInsideCode(node: Node): boolean {
  let cur: Node | null = node.parentNode;
  while (cur) {
    if (cur.nodeType === Node.ELEMENT_NODE) {
      const tag = (cur as Element).tagName;
      if (tag === "CODE" || tag === "PRE") return true;
    }
    cur = cur.parentNode;
  }
  return false;
}

export function makeReadingPostProcessor(getOpts: () => ReadingOptions) {
  return function processor(el: HTMLElement, _ctx: MarkdownPostProcessorContext) {
    const opts = getOpts();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const textNodes: Text[] = [];
    let node = walker.nextNode();
    while (node) {
      if (node.nodeValue && !isInsideCode(node) && COMBINED_RE.test(node.nodeValue)) {
        textNodes.push(node as Text);
      }
      COMBINED_RE.lastIndex = 0;
      node = walker.nextNode();
    }
    for (const t of textNodes) replaceInTextNode(t, opts);
  };
}

function replaceInTextNode(text: Text, opts: ReadingOptions): void {
  const src = text.nodeValue ?? "";
  COMBINED_RE.lastIndex = 0;
  const frag = document.createDocumentFragment();
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMBINED_RE.exec(src)) !== null) {
    if (m.index > lastIndex) {
      frag.appendChild(document.createTextNode(src.slice(lastIndex, m.index)));
    }
    const replacement = renderMatch(m, opts);
    frag.appendChild(replacement);
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < src.length) {
    frag.appendChild(document.createTextNode(src.slice(lastIndex)));
  }
  text.replaceWith(frag);
}

function renderMatch(m: RegExpExecArray, opts: ReadingOptions): Node {
  const [full, comment, addition, deletion, subOld, subNew, highlight] = m;

  if (comment !== undefined) {
    const authorMatch = comment.match(AUTHOR_RE);
    const authorName = authorMatch ? authorMatch[1] : null;
    const body = authorMatch ? comment.slice(authorMatch[0].length) : comment;
    const span = document.createElement("span");
    span.className = `kcm-rm-comment kcm-rm-comment-${authorName ? "named" : "you"}`;
    if (authorName) {
      span.setAttribute("data-author-hue", String(authorHueIndex(authorName)));
    }
    span.setAttribute("aria-label", "Comment (switch to edit mode to review)");
    span.title = authorName ? `${authorName}: ${body}` : body;
    span.textContent = authorName ? "ⓘ" : "💬";
    return span;
  }
  if (addition !== undefined) {
    if (opts.suggestions === "accepted") {
      return document.createTextNode(addition);
    }
    const span = document.createElement("span");
    span.className = "kcm-rm-addition";
    span.textContent = addition;
    return span;
  }
  if (deletion !== undefined) {
    if (opts.suggestions === "accepted") {
      return document.createTextNode("");
    }
    const span = document.createElement("span");
    span.className = "kcm-rm-deletion";
    span.textContent = deletion;
    return span;
  }
  if (subOld !== undefined && subNew !== undefined) {
    if (opts.suggestions === "accepted") {
      return document.createTextNode(subNew);
    }
    const wrap = document.createElement("span");
    wrap.className = "kcm-rm-substitution";
    const o = document.createElement("span");
    o.className = "kcm-rm-deletion";
    o.textContent = subOld;
    const n = document.createElement("span");
    n.className = "kcm-rm-addition";
    n.textContent = subNew;
    wrap.appendChild(o);
    wrap.appendChild(document.createTextNode(" → "));
    wrap.appendChild(n);
    return wrap;
  }
  if (highlight !== undefined) {
    const span = document.createElement("span");
    span.className = "kcm-rm-highlight";
    span.textContent = highlight;
    return span;
  }
  return document.createTextNode(full);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: errors only in `main.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/reading.ts
git commit -m "Reading mode: detect author per-comment, drop aiPrefix option

The post-processor now runs AUTHOR_RE against each {>>...<<} match
directly, producing kcm-rm-comment-named (with data-author-hue) or
kcm-rm-comment-you. ReadingOptions.aiPrefix is removed."
```

---

## Task 8: Add per-hue CSS, drop AI/human variants

**Files:**
- Modify: `styles.css`

- [ ] **Step 1: Add hue palette variables**

At the top of `styles.css`, just after the comment header (after line 8), insert:

```css
/* ---------- Author hue palette ----------
 *
 * Per-author tinting for chips and panel messages. The hue is set by JS
 * on the wrapping element via data-author-hue="0..7" (see src/authors.ts).
 * Saturation/lightness are fixed so the result is legible across themes.
 */

.kcm-chip[data-author-hue],
.kcm-message[data-author-hue],
.kcm-rm-comment[data-author-hue] {
  --kcm-hue: 210;
  border-color: hsla(var(--kcm-hue), 70%, 55%, 0.4);
  background: hsla(var(--kcm-hue), 70%, 55%, 0.08);
}
.kcm-message[data-author-hue] {
  border-left: 3px solid hsla(var(--kcm-hue), 70%, 55%, 0.5);
  background: hsla(var(--kcm-hue), 70%, 55%, 0.08);
}
.kcm-rm-comment[data-author-hue] {
  color: hsla(var(--kcm-hue), 70%, 50%, 0.9);
  background: transparent;
  border: none;
}

.kcm-chip[data-author-hue="0"], .kcm-message[data-author-hue="0"], .kcm-rm-comment[data-author-hue="0"] { --kcm-hue: 210; } /* blue */
.kcm-chip[data-author-hue="1"], .kcm-message[data-author-hue="1"], .kcm-rm-comment[data-author-hue="1"] { --kcm-hue: 280; } /* purple */
.kcm-chip[data-author-hue="2"], .kcm-message[data-author-hue="2"], .kcm-rm-comment[data-author-hue="2"] { --kcm-hue: 150; } /* green */
.kcm-chip[data-author-hue="3"], .kcm-message[data-author-hue="3"], .kcm-rm-comment[data-author-hue="3"] { --kcm-hue: 30; }  /* orange */
.kcm-chip[data-author-hue="4"], .kcm-message[data-author-hue="4"], .kcm-rm-comment[data-author-hue="4"] { --kcm-hue: 340; } /* pink */
.kcm-chip[data-author-hue="5"], .kcm-message[data-author-hue="5"], .kcm-rm-comment[data-author-hue="5"] { --kcm-hue: 190; } /* teal */
.kcm-chip[data-author-hue="6"], .kcm-message[data-author-hue="6"], .kcm-rm-comment[data-author-hue="6"] { --kcm-hue: 50; }  /* yellow */
.kcm-chip[data-author-hue="7"], .kcm-message[data-author-hue="7"], .kcm-rm-comment[data-author-hue="7"] { --kcm-hue: 0; }   /* red — Claude */

```

- [ ] **Step 2: Replace the old AI/human chip selectors**

Find these blocks (lines 31-38):

```css
.kcm-chip-ai {
  border-color: rgba(124, 92, 255, 0.4);
  background: rgba(124, 92, 255, 0.08);
}
.kcm-chip-human {
  border-color: rgba(0, 122, 204, 0.4);
  background: rgba(0, 122, 204, 0.08);
}
```

Replace with:

```css
.kcm-chip-you {
  border-color: rgba(0, 122, 204, 0.4);
  background: rgba(0, 122, 204, 0.08);
}
.kcm-chip-named {
  /* hue/background come from [data-author-hue="N"] selectors above */
}
```

- [ ] **Step 3: Replace the old AI/human message selectors**

Find these blocks (lines 216-223):

```css
.kcm-message-ai {
  background: rgba(124, 92, 255, 0.08);
  border-left: 3px solid rgba(124, 92, 255, 0.5);
}
.kcm-message-human {
  background: rgba(0, 122, 204, 0.08);
  border-left: 3px solid rgba(0, 122, 204, 0.5);
}
```

Replace with:

```css
.kcm-message-you {
  background: rgba(0, 122, 204, 0.08);
  border-left: 3px solid rgba(0, 122, 204, 0.5);
}
.kcm-message-named {
  /* hue/background come from [data-author-hue="N"] selectors above */
}
```

- [ ] **Step 4: Replace the old reading-mode AI/human selectors**

Find these blocks (lines 372-377):

```css
.kcm-rm-comment-ai {
  color: rgba(124, 92, 255, 0.85);
}
.kcm-rm-comment-human {
  color: rgba(0, 122, 204, 0.85);
}
```

Replace with:

```css
.kcm-rm-comment-you {
  color: rgba(0, 122, 204, 0.85);
}
.kcm-rm-comment-named {
  /* color comes from [data-author-hue="N"] selectors above */
}
```

- [ ] **Step 5: Commit**

```bash
git add styles.css
git commit -m "Styles: per-hue author palette, drop AI/human variants

Adds 8 hue presets selected by data-author-hue=\"N\" so chips, messages,
and reading-mode markers tint themselves from the author's palette
index. Existing .kcm-*-ai / .kcm-*-human selectors are renamed to
.kcm-*-you (unnamed = the local user) and .kcm-*-named (named author,
hue from the data attribute)."
```

---

## Task 9: Update `src/main.ts` (remove `getAiPrefix`, relax resolved-thread sweep)

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Drop `getAiPrefix` from the decoration extension wiring**

Find lines 32-37:

```ts
    this.registerEditorExtension(
      criticDecorationsExtension({
        onClick: (offset) => this.handleInlineClick(offset),
        getAiPrefix: () => this.settings.aiPrefix,
      }),
    );
```

Replace with:

```ts
    this.registerEditorExtension(
      criticDecorationsExtension({
        onClick: (offset) => this.handleInlineClick(offset),
      }),
    );
```

- [ ] **Step 2: Drop `aiPrefix` from the reading post-processor wiring**

Find lines 40-45:

```ts
    this.registerMarkdownPostProcessor(
      makeReadingPostProcessor(() => ({
        suggestions: this.settings.readingMode,
        aiPrefix: this.settings.aiPrefix,
      })),
    );
```

Replace with:

```ts
    this.registerMarkdownPostProcessor(
      makeReadingPostProcessor(() => ({
        suggestions: this.settings.readingMode,
      })),
    );
```

- [ ] **Step 3: Drop `getAiPrefix` from the panel host**

Find lines 108-119 (the `host` object inside `makeReviewView`):

```ts
  private makeReviewView(leaf: WorkspaceLeaf): ReviewPanelView {
    const host: PanelHost = {
      app: this.app,
      getActiveFile: () => {
        const file = this.app.workspace.getActiveFile();
        return file && file.extension === "md" ? file : null;
      },
      applyEdits: async (file, edits) => this.applyEditsToFile(file, edits),
      revealOffset: (file, offset, length) => this.revealOffsetInEditor(file, offset, length),
      getAiPrefix: () => this.settings.aiPrefix,
    };
    return new ReviewPanelView(leaf, host);
  }
```

Replace with:

```ts
  private makeReviewView(leaf: WorkspaceLeaf): ReviewPanelView {
    const host: PanelHost = {
      app: this.app,
      getActiveFile: () => {
        const file = this.app.workspace.getActiveFile();
        return file && file.extension === "md" ? file : null;
      },
      applyEdits: async (file, edits) => this.applyEditsToFile(file, edits),
      revealOffset: (file, offset, length) => this.revealOffsetInEditor(file, offset, length),
    };
    return new ReviewPanelView(leaf, host);
  }
```

- [ ] **Step 4: Drop the `aiPrefix` argument from `FinalizeModal`**

Find line 251-261 (`runFinalize`):

```ts
  private async runFinalize(file: TFile): Promise<void> {
    const source = await this.app.vault.read(file);
    new FinalizeModal(
      this.app,
      file,
      source,
      this.settings.finalize,
      this.settings.aiPrefix,
      async (edits) => this.applyEditsToFile(file, edits),
    ).open();
  }
```

Replace with:

```ts
  private async runFinalize(file: TFile): Promise<void> {
    const source = await this.app.vault.read(file);
    new FinalizeModal(
      this.app,
      file,
      source,
      this.settings.finalize,
      async (edits) => this.applyEditsToFile(file, edits),
    ).open();
  }
```

- [ ] **Step 5: Relax the resolved-thread sweep**

Find `deleteResolvedThreads` (lines 265-294):

```ts
  private async deleteResolvedThreads(file: TFile): Promise<void> {
    const source = await this.app.vault.read(file);
    const { parse } = await import("./parser");
    const parsed = parse(source, { aiPrefix: this.settings.aiPrefix });
    const edits: SourceEdit[] = [];
    for (const t of parsed.threads) {
      // A thread is "resolved" if it has at least one reply whose text is
      // a recognised resolution marker. The reply is human-authored.
      const replies = t.replyIndexes.map((i) => parsed.nodes[i]);
      const resolved = replies.some((r) => {
        if (r.kind !== "comment") return false;
        if (r.author !== "human") return false;
        return /^(ignore|won['’]?t fix|wontfix|done|resolved)$/i.test(r.text.trim());
      });
```

Replace with:

```ts
  private async deleteResolvedThreads(file: TFile): Promise<void> {
    const source = await this.app.vault.read(file);
    const { parse } = await import("./parser");
    const parsed = parse(source);
    const edits: SourceEdit[] = [];
    for (const t of parsed.threads) {
      // A thread is "resolved" if any reply's text is a recognised
      // resolution marker, regardless of who wrote it. (A self-tagged
      // reply like {>>Phil: ignore<<} still resolves.)
      const replies = t.replyIndexes.map((i) => parsed.nodes[i]);
      const resolved = replies.some((r) => {
        if (r.kind !== "comment") return false;
        return /^(ignore|won['’]?t fix|wontfix|done|resolved)$/i.test(r.text.trim());
      });
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: every `.mjs` file under `test/` passes. There should be five test files: `parser.test.mjs`, `parser.edge.test.mjs`, `operations.test.mjs`, `rebase.test.mjs`, `finalize.test.mjs`, plus the new `authors.test.mjs` (six total).

If `finalize.test.mjs` fails because it imports `FinalizeModal` with the old signature, fix the test to drop the `aiPrefix` argument and commit that fix as part of this task.

- [ ] **Step 8: Production build**

Run: `npm run build`
Expected: completes without errors; `main.js` is emitted.

- [ ] **Step 9: Commit**

```bash
git add src/main.ts
git commit -m "Main: wire up multi-author; relax resolved-thread sweep

Drops getAiPrefix from the decoration extension, reading
post-processor, and panel host; drops the aiPrefix argument to
FinalizeModal. The 'delete resolved threads' command now accepts a
resolution marker (ignore / done / etc.) from any author, not only
unprefixed replies — so users who tag their own replies still
resolve threads."
```

---

## Task 10: Update documentation (`examples/CLAUDE.md` and `CLAUDE.md`)

**Files:**
- Modify: `examples/CLAUDE.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `examples/CLAUDE.md`**

Find the "Prefix" paragraph near the top:

```
**Prefix**: the examples below use `AI:` because that's the plugin's default. If you've configured a different prefix in the Track Changes settings (e.g. `Claude:`, `GPT:`, your model's name), search-and-replace `AI:` here to match. The prefix is the only signal of authorship — keep it consistent.
```

Replace with:

```
**Prefix**: every comment you write must start with `<Name>:` where `<Name>` is your model's identifier (e.g. `Claude:`, `GPT:`, `Gemini:`). The plugin auto-detects whichever name you use and colors your comments distinctly from other authors. The user's replies are *unprefixed* — that's how the plugin recognises them. Pick a name and stay consistent within a document. Well-known names (Claude, GPT, Gemini, Copilot, Mistral, Llama) get brand-ish colors; anything else gets a stable hash-derived color.
```

Find this block in the "How to insert comments" section:

```
- **Prefix every comment with `AI:`** (or whatever prefix the plugin is configured for). The Track Changes plugin uses the prefix as the *only* signal of authorship — comments without it are treated as human replies. Never omit it.
```

Replace with:

```
- **Prefix every comment with `<Name>:`** (use your model's name — `Claude:`, `GPT:`, etc.). The plugin uses the prefix as the *only* signal of authorship — comments without it are treated as the user's own replies. Never omit it.
```

Find every occurrence of `AI:` in the file (there are a few more in the Reply threads section and elsewhere) and replace with `Claude:` for consistency with the new guidance — search-and-replace `AI:` → `Claude:` across the file.

- [ ] **Step 2: Update the project `CLAUDE.md`**

In the root `CLAUDE.md`, find the "Threading" subsection (the paragraph mentioning `aiPrefix`):

```
A thread is a run of `{>>…<<}` blocks with only inline whitespace (no blank line) between them in the same paragraph. First is root, rest are replies. The `aiPrefix` (default `AI:`) is the *only* authorship signal — prefixed = AI, unprefixed = human reply. Treat this as a hard contract; don't add other heuristics.

The "delete all resolved threads" command sweeps threads whose human reply matches `/^(ignore|won't fix|wontfix|done|resolved)$/i`.
```

Replace with:

```
A thread is a run of `{>>…<<}` blocks with only inline whitespace (no blank line) between them in the same paragraph. First is root, rest are replies. Authorship is detected from a `<Name>:` prefix on each comment (single token, alpha-leading, ≤30 chars — see `src/authors.ts`). Comments without a recognised prefix render as "You" (the local user). Treat this as a hard contract; don't add other heuristics.

The "delete all resolved threads" command sweeps threads whose reply matches `/^(ignore|won't fix|wontfix|done|resolved)$/i`, regardless of who wrote it.
```

In the "Data flow: parse → edits → rebase → apply" subsection, find the bullet:

```
- `src/parser.ts` scans source text and emits a `ParseResult` with `nodes` (the five CriticMarkup kinds) and `threads` (adjacent `{>>…<<}` blocks group). Comments are tagged `author: "ai" | "human"` based on the configurable AI prefix. **Code blocks are skipped** — markup inside fences is left alone.
```

Replace with:

```
- `src/parser.ts` scans source text and emits a `ParseResult` with `nodes` (the five CriticMarkup kinds) and `threads` (adjacent `{>>…<<}` blocks group). Comments expose `authorName: string | null` — the captured `<Name>:` prefix (original casing) or `null` if unprefixed. **Code blocks are skipped** — markup inside fences is left alone.
```

- [ ] **Step 3: Commit**

```bash
git add examples/CLAUDE.md CLAUDE.md
git commit -m "Docs: update for auto-detected Name: prefix

examples/CLAUDE.md tells the agent to prefix with its model name
(Claude:, GPT:, etc.) and notes that well-known names get brand-ish
colors. The project CLAUDE.md's Threading and parser sections describe
the new authorName field and the relaxed resolved-thread sweep."
```

---

## Task 11: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Test suite**

Run: `npm test`
Expected: all six test files (`authors`, `parser`, `parser.edge`, `operations`, `rebase`, `finalize`) pass with no failures.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: completes, emits `main.js`.

- [ ] **Step 4: Grep for stale references**

Run: `grep -rn "aiPrefix\|kcm-message-ai\|kcm-message-human\|kcm-chip-ai\|kcm-chip-human\|kcm-rm-comment-ai\|kcm-rm-comment-human" src/ styles.css 2>/dev/null || echo "clean"`

Expected: `clean` (no matches). If anything matches, fix it before declaring done.

- [ ] **Step 5: Manual smoke test (Obsidian)**

If a development vault is available, copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/track-changes/`, reload Obsidian, and verify on `examples/sample-blogpost.md` (or any sample doc):

1. A `{>>Claude: ...<<}` comment renders with a red-ish chip.
2. A `{>>GPT: ...<<}` comment renders with a green-ish chip.
3. An unprefixed `{>>just my reply<<}` renders as "You" / speech bubble.
4. The settings tab no longer shows "AI author prefix".
5. A `{>>Claude: ...<<}{>>ignore<<}` thread is swept by "Delete all resolved threads".
6. A `{>>Claude: ...<<}{>>Phil: ignore<<}` thread is also swept (new behavior).

If no dev vault is set up, skip this step and note that in the commit message of any follow-up.

- [ ] **Step 6: No-op commit if needed**

If steps 1–4 all pass and no changes were required, there is nothing to commit. Otherwise, commit the fixes:

```bash
git add -A
git commit -m "Final fixes after verification"
```
