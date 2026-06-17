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
  /** raw source text from `from` to `to`, INCLUDING any metadata prefix */
  raw: string;
  /** Resolved `author=` value from the prefix (trimmed), or null if absent/empty. */
  metaAuthor: string | null;
  /** `date=` value from the prefix (trimmed), or null if absent/empty. Display-only. */
  metaDate: string | null;
  /** Exact prefix substring consumed (e.g. `author=Claude;date=2026-06-14`), "" if none. */
  metaRaw: string;
  /** Body start offset, after the prefix + sigil. */
  innerFrom: number;
  /** Body end offset, before the closing sigil. */
  innerTo: number;
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

// Optional metadata prefix between the outer `{` and the mark sigil: a run of
// `key=value;` pairs — each pair, INCLUDING the last, terminated by `;`, with no
// leading whitespace. The mandatory trailing `;` is load-bearing: it guarantees a
// value can never sit directly against a sigil, so a truncated value (e.g. a
// malformed date `date=2026--…`) can never hand its `--` to the deletion sigil and
// straddle — such input simply fails to form a mark instead of corrupting on reject.
//   KEY = [A-Za-z][\w.-]*     ASCII token (legacy AUTHOR_RE flavor)
//   VAL = (?:[^;{}=<>+~*`\-]|-(?!-))*   allowed chars + a lone `-` (ISO dates).
//   `*` and backtick are excluded too, so a value can't smuggle markdown that
//   would split text nodes and leak the prefix in reading view.
// PFX is a SINGLE capturing group so payload group indices are fixed: prefix m[1],
// body/oldText m[2], newText m[3]. PFX matches "" for standard prefix-free marks,
// so those parse byte-identically to the legacy regexes.
const PFX = "((?:[A-Za-z][\\w.-]*=(?:[^;{}=<>+~*`\\-]|-(?!-))*;)*)";
const COMMENT_RE = new RegExp(`\\{${PFX}>>([\\s\\S]*?)<<\\}`, "g");
const ADDITION_RE = new RegExp(`\\{${PFX}\\+\\+([\\s\\S]*?)\\+\\+\\}`, "g");
const DELETION_RE = new RegExp(`\\{${PFX}--([\\s\\S]*?)--\\}`, "g");
const SUBSTITUTION_RE = new RegExp(`\\{${PFX}~~([\\s\\S]*?)~>([\\s\\S]*?)~~\\}`, "g");
const HIGHLIGHT_RE = new RegExp(`\\{${PFX}==([\\s\\S]*?)==\\}`, "g");

// Used by the post-match nesting guard: detects an inner `{` that opens a
// parseable mark of any kind, so straddling matches (e.g. a `--`-in-date date
// swallowing a downstream deletion) can be dropped rather than corrupt the doc.
const INNER_MARK_RE = new RegExp(
  `\\{${PFX}(?:>>[\\s\\S]*?<<|\\+\\+[\\s\\S]*?\\+\\+|--[\\s\\S]*?--|~~[\\s\\S]*?~~|==[\\s\\S]*?==)\\}`,
);

interface MetaPrefix {
  author: string | null;
  date: string | null;
}

// Pure: split PFX on `;`, split each pair on the FIRST `=`, lowercase key for
// comparison, keep only author/date, trim values, empty value => null. Unknown
// keys ignored. VAL forbids `=`, so the first-`=` split is lossless.
function parseMetaPrefix(prefix: string): MetaPrefix {
  const meta: MetaPrefix = { author: null, date: null };
  if (!prefix) return meta;
  for (const pair of prefix.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).toLowerCase();
    if (key !== "author" && key !== "date") continue;
    const value = pair.slice(eq + 1).trim();
    meta[key] = value === "" ? null : value;
  }
  return meta;
}

// Nesting guard support: does `raw` contain an inner `{` (past the outer one)
// that begins a parseable mark? A plain `{foo}` in prose is fine; only an inner
// brace that opens a real mark indicates a straddling match to drop.
function hasNestedMark(raw: string): boolean {
  for (let i = 1; i < raw.length; i++) {
    if (raw.charCodeAt(i) !== 0x7b /* { */) continue;
    INNER_MARK_RE.lastIndex = 0;
    const m = INNER_MARK_RE.exec(raw.slice(i));
    if (m && m.index === 0) return true;
  }
  return false;
}

// Insert into a list kept sorted ascending by `from` (re-admitting recovered marks).
function insertSorted(list: CriticNode[], node: CriticNode): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].from < node.from) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, node);
}

/**
 * Find ranges of source covered by Markdown code (fenced blocks, indented
 * blocks, and inline backtick spans). CriticMarkup-looking text inside code
 * should remain literal — it's an example, not a real annotation. Returned
 * ranges are sorted and non-overlapping.
 */
function findCodeRegions(source: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  // Fenced blocks: ``` or ~~~ starting a line, terminated by the same fence on its own line.
  // Opener and closer may each be indented 0–3 spaces, independently of one another —
  // CommonMark treats 4+ spaces (or a leading tab) as indented code, not a fence. Capping
  // the closer at ` {0,3}` matters: a fence line indented ≥4 inside a block is content, not
  // a close; accepting it would close the block early, leaking the markup that follows and
  // letting the real closer open a second unterminated region. `\r?\n` in the trailing
  // lookahead tolerates CRLF documents, where a bare `(?=\n|$)` would never match
  // (the `\r` sits between the fence and the newline) and the block would run to EOF.
  const fenceRe = /(^|\n)( {0,3})(```+|~~~+)[^\n]*\n[\s\S]*?(?:\n {0,3}\3[ \t]*(?=\r?\n|$)|$)/g;
  for (const m of source.matchAll(fenceRe)) {
    const from = (m.index ?? 0) + m[1].length;
    regions.push([from, from + m[0].length - m[1].length]);
  }
  // Indented code blocks (CommonMark): a 4-space- or tab-indented run that
  // starts after a blank line (or at the doc start) and ends at the next
  // non-blank, non-indented line.
  regions.push(...findIndentedCodeRegions(source, regions));
  // Inline code spans: single-backtick spans on a single line. Skip any whose
  // start sits inside a fenced or indented region (where backticks are literal).
  const inlineRe = /`[^`\n]+`/g;
  const inExisting = (idx: number) => regions.some(([a, b]) => idx >= a && idx < b);
  for (const m of source.matchAll(inlineRe)) {
    const from = m.index ?? 0;
    if (inExisting(from)) continue;
    regions.push([from, from + m[0].length]);
  }
  regions.sort((a, b) => a[0] - b[0]);
  return regions;
}

function findIndentedCodeRegions(
  source: string,
  existing: Array<[number, number]>,
): Array<[number, number]> {
  const inExisting = (idx: number) => existing.some(([a, b]) => idx >= a && idx < b);
  const regions: Array<[number, number]> = [];
  let pos = 0;
  let prevBlank = true; // doc start counts as "previous line blank"
  let blockStart = -1;

  while (pos <= source.length) {
    const nl = source.indexOf("\n", pos);
    const lineEnd = nl === -1 ? source.length : nl;
    const lineStart = pos;
    const line = source.slice(lineStart, lineEnd);

    if (inExisting(lineStart)) {
      if (blockStart >= 0) {
        regions.push([blockStart, lineStart]);
        blockStart = -1;
      }
      prevBlank = false;
    } else {
      const isBlank = /^[ \t]*$/.test(line);
      const isIndented = !isBlank && /^( {4,}|\t)/.test(line);
      if (blockStart < 0) {
        if (isIndented && prevBlank) blockStart = lineStart;
      } else if (!isIndented && !isBlank) {
        regions.push([blockStart, lineStart]);
        blockStart = -1;
      }
      prevBlank = isBlank;
    }

    if (nl === -1) break;
    pos = nl + 1;
  }

  if (blockStart >= 0) regions.push([blockStart, source.length]);
  return regions;
}

function endpointInRegion(pos: number, regions: Array<[number, number]>): boolean {
  for (const [a, b] of regions) {
    if (pos < a) return false;
    if (pos < b) return true;
  }
  return false;
}

// A CriticMarkup span is "in code" iff one of its delimiters sits inside a
// code region. This catches both the wholly-contained case (sample inside a
// fence) and malformed crossings (open in prose, close inside a fence), while
// preserving real markup that simply *wraps* an inline backtick span
// (`{++ The function `foo` is good ++}` — issue #8).
function rangeEndpointInCode(from: number, to: number, regions: Array<[number, number]>): boolean {
  return endpointInRegion(from, regions) || endpointInRegion(to - 1, regions);
}

export interface ParseOptions {
  /** Skip markup that falls inside fenced code blocks or inline code spans. Defaults to true. */
  skipCode?: boolean;
}

// Run the five regexes over `text` and return candidate nodes with offsets
// shifted by `base` (so a re-scan of a dropped straddle's interior maps back to
// absolute document offsets). Group indices are fixed: prefix = m[1]; body /
// oldText = m[2]; newText = m[3]. The prefix occupies `{` + metaRaw; the sigil
// follows. innerFrom/innerTo bound the payload, excluding the prefix and sigils.
function collectCandidates(text: string, base: number): CriticNode[] {
  const out: CriticNode[] = [];
  // Substitutions first — their {~~...~~} could otherwise be confused with highlights.
  for (const m of text.matchAll(SUBSTITUTION_RE)) {
    const meta = parseMetaPrefix(m[1]);
    const from = base + m.index;
    const innerFrom = from + 1 + m[1].length + 2; // {<prefix>~~
    out.push({
      kind: "substitution",
      from,
      to: from + m[0].length,
      raw: m[0],
      metaAuthor: meta.author,
      metaDate: meta.date,
      metaRaw: m[1],
      innerFrom,
      innerTo: innerFrom + m[2].length,
      oldText: m[2],
      newText: m[3],
    });
  }
  for (const m of text.matchAll(ADDITION_RE)) {
    const meta = parseMetaPrefix(m[1]);
    const from = base + m.index;
    const innerFrom = from + 1 + m[1].length + 2; // {<prefix>++
    out.push({
      kind: "addition",
      from,
      to: from + m[0].length,
      raw: m[0],
      metaAuthor: meta.author,
      metaDate: meta.date,
      metaRaw: m[1],
      innerFrom,
      innerTo: innerFrom + m[2].length,
      text: m[2],
    });
  }
  for (const m of text.matchAll(DELETION_RE)) {
    const meta = parseMetaPrefix(m[1]);
    const from = base + m.index;
    const innerFrom = from + 1 + m[1].length + 2; // {<prefix>--
    out.push({
      kind: "deletion",
      from,
      to: from + m[0].length,
      raw: m[0],
      metaAuthor: meta.author,
      metaDate: meta.date,
      metaRaw: m[1],
      innerFrom,
      innerTo: innerFrom + m[2].length,
      text: m[2],
    });
  }
  for (const m of text.matchAll(HIGHLIGHT_RE)) {
    const meta = parseMetaPrefix(m[1]);
    const from = base + m.index;
    const innerFrom = from + 1 + m[1].length + 2; // {<prefix>==
    out.push({
      kind: "highlight",
      from,
      to: from + m[0].length,
      raw: m[0],
      metaAuthor: meta.author,
      metaDate: meta.date,
      metaRaw: m[1],
      innerFrom,
      innerTo: innerFrom + m[2].length,
      text: m[2],
    });
  }
  for (const m of text.matchAll(COMMENT_RE)) {
    const raw = m[0];
    const meta = parseMetaPrefix(m[1]);
    const body = m[2];
    const from = base + m.index;
    const bodyStart = from + 1 + m[1].length + 2; // {<prefix>>>
    // Strip a legacy <Name>: from the body text regardless of metaAuthor; the
    // prefix author wins for attribution, the legacy capture is kept on
    // authorName for the legacy path and used as text cleanup here.
    const authorMatch = body.match(AUTHOR_RE);
    const authorName = authorMatch ? authorMatch[1] : null;
    const cleanText = authorMatch ? body.slice(authorMatch[0].length) : body;
    out.push({
      kind: "comment",
      from,
      to: from + raw.length,
      raw,
      // Precedence: prefix author wins; else fall back to the legacy <Name>:.
      metaAuthor: meta.author ?? authorName,
      metaDate: meta.date,
      metaRaw: m[1],
      innerFrom: bodyStart,
      innerTo: bodyStart + body.length,
      text: cleanText,
      authorName,
    });
  }
  return out;
}

export function parse(source: string, options: ParseOptions = {}): ParseResult {
  const skipCode = options.skipCode !== false;
  const codeRegions = skipCode ? findCodeRegions(source) : [];
  const nodes: CriticNode[] = collectCandidates(source, 0);

  nodes.sort((a, b) => a.from - b.from);

  // Drop overlaps: a substitution match's interior could re-match as a smaller
  // form. Keep the earliest-starting / longest node; discard anything fully
  // contained by an already-accepted node. Also drop anything that falls
  // inside a code region — CriticMarkup-looking text in code samples is
  // literal, not real annotation.
  //
  // Use a sorted work queue (not a fixed list) so the nesting guard can re-scan
  // a dropped straddle's interior and re-admit any legit inner marks it swallowed.
  const pending = nodes; // already sorted by `from`
  const accepted: CriticNode[] = [];
  let lastEnd = -1;
  while (pending.length > 0) {
    const n = pending.shift() as CriticNode;
    if (n.from < lastEnd) continue; // overlap with previous accepted node
    if (skipCode && rangeEndpointInCode(n.from, n.to, codeRegions)) continue;
    // Nesting guard (§4.6): a mark whose raw contains an inner `{` that opens a
    // parseable mark of any kind is a straddle (e.g. a `--`-in-a-malformed-date
    // date swallowing a downstream real deletion). Drop the outer straddle, then
    // re-scan its interior so a genuine inner mark survives.
    //
    // GATED on a non-empty prefix: the straddle only arises when a metadata value
    // truncates and hands a sigil/brace to the match, which requires a prefix. A
    // PREFIX-FREE mark that simply contains an inner mark — `{--remove {>>note<<}
    // too--}` — is ordinary legacy CriticMarkup and MUST collapse to the outer
    // mark (the inner is part of the deleted/added text), exactly as before this
    // feature. Without this gate, such legacy marks would be silently re-parsed
    // (regression + corruption of pre-existing docs). A legit single brace in
    // prose — `{--remove the {foo} placeholder--}` — is untouched either way,
    // because `{foo}` does not open a mark.
    if (n.metaRaw !== "" && hasNestedMark(n.raw)) {
      const recovered = collectCandidates(n.raw.slice(1), n.from + 1)
        .filter((c) => c.from >= lastEnd && c.to <= n.to);
      if (recovered.length > 0) {
        for (const c of recovered) insertSorted(pending, c);
      }
      continue;
    }
    accepted.push(n);
    lastEnd = n.to;
  }

  // Thread grouping: walk accepted nodes, collect comments, merge if the gap
  // between the previous comment's end and this comment's start contains only
  // inline whitespace (no newline).
  const threads: Thread[] = [];
  const nodeThread: number[] = new Array<number>(accepted.length).fill(-1);
  let currentThread: Thread | null = null;
  let prevCommentIdx = -1;

  for (let i = 0; i < accepted.length; i++) {
    const n = accepted[i];
    if (n.kind !== "comment") continue;

    if (prevCommentIdx >= 0 && currentThread) {
      const prev = accepted[prevCommentIdx] as CommentNode;
      const gap = source.slice(prev.to, n.from);
      // Adjacent = only inline whitespace (spaces/tabs) between the two
      // markers. Any prose or newline between them means it's a separate
      // comment, not a reply — otherwise the live-preview chip widget would
      // replace the prose range and visually swallow the text.
      if (/^[ \t]*$/.test(gap)) {
        currentThread.replyIndexes.push(i);
        currentThread.to = n.to;
        nodeThread[i] = threads.length - 1;
        prevCommentIdx = i;
        continue;
      }
    }

    // start new thread
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

/** Find the thread index whose range contains the given offset, or -1. */
export function threadAtOffset(result: ParseResult, offset: number): number {
  for (let i = 0; i < result.threads.length; i++) {
    const t = result.threads[i];
    if (offset >= t.from && offset <= t.to) return i;
  }
  return -1;
}

/** Find the node index whose range contains the given offset, or -1. */
export function nodeAtOffset(result: ParseResult, offset: number): number {
  for (let i = 0; i < result.nodes.length; i++) {
    const n = result.nodes[i];
    if (offset >= n.from && offset <= n.to) return i;
  }
  return -1;
}

/** Extract a short snippet of context surrounding a range, for the panel. */
export function contextSnippet(source: string, from: number, to: number, radius = 40): string {
  const start = Math.max(0, from - radius);
  const end = Math.min(source.length, to + radius);
  let snippet = source.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = "…" + snippet;
  if (end < source.length) snippet = snippet + "…";
  return snippet;
}
