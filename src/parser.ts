// CriticMarkup parser — the five recognized forms plus thread grouping.
//
// Forms:
//   {>>text<<}        comment (Claude: prefix => AI; otherwise => human reply)
//   {++text++}        addition
//   {--text--}        deletion
//   {~~old~>new~~}    substitution
//   {==text==}        highlight (parsed but not surfaced in UI; tolerated)
//
// Thread rule: consecutive {>>...<<} blocks with only inline whitespace
// (no blank line) between them in the same paragraph form a thread.
// First block = root; subsequent = replies.

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
  author: "ai" | "human";
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

const DEFAULT_AI_PREFIX = "AI";

function buildPrefixRe(prefix: string): RegExp {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${escaped}\\s*:\\s*`, "i");
}

/**
 * Find ranges of source covered by Markdown code (fenced blocks and inline
 * backtick spans). CriticMarkup-looking text inside code should remain literal
 * — it's an example, not a real annotation. Returned ranges are sorted and
 * non-overlapping.
 */
function findCodeRegions(source: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  // Fenced blocks: ``` or ~~~ starting a line, terminated by the same fence on its own line.
  const fenceRe = /(^|\n)([ \t]*)(```+|~~~+)[^\n]*\n[\s\S]*?(?:\n\2\3[ \t]*(?=\n|$)|$)/g;
  for (const m of source.matchAll(fenceRe)) {
    const from = (m.index ?? 0) + m[1].length;
    regions.push([from, from + m[0].length - m[1].length]);
  }
  // Subtract fenced regions before searching inline; inline backticks inside fences are meaningless.
  // Inline code spans: single-backtick spans on a single line. Double-backtick spans are rare; we keep this simple.
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
  // Binary search would be nicer; linear is fine for typical doc sizes.
  for (const [a, b] of regions) {
    if (offset >= a && offset < b) return true;
    if (offset < a) return false;
  }
  return false;
}

export interface ParseOptions {
  /** Skip markup that falls inside fenced code blocks or inline code spans. Defaults to true. */
  skipCode?: boolean;
  /** Prefix marking AI-authored comments. Case-insensitive. Defaults to "AI". */
  aiPrefix?: string;
}

export function parse(source: string, options: ParseOptions = {}): ParseResult {
  const skipCode = options.skipCode !== false;
  const codeRegions = skipCode ? findCodeRegions(source) : [];
  const prefixRe = buildPrefixRe(options.aiPrefix ?? DEFAULT_AI_PREFIX);
  const nodes: CriticNode[] = [];

  // Substitutions first — their {~~...~~} could otherwise be confused with highlights.
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
    const isAi = prefixRe.test(body);
    const text = isAi ? body.replace(prefixRe, "") : body;
    nodes.push({
      kind: "comment",
      from: m.index!,
      to: m.index! + raw.length,
      raw,
      text,
      author: isAi ? "ai" : "human",
    });
  }

  nodes.sort((a, b) => a.from - b.from);

  // Drop overlaps: a substitution match's interior could re-match as a smaller
  // form. Keep the earliest-starting / longest node; discard anything fully
  // contained by an already-accepted node. Also drop anything that falls
  // inside a code region — CriticMarkup-looking text in code samples is
  // literal, not real annotation.
  const accepted: CriticNode[] = [];
  let lastEnd = -1;
  for (const n of nodes) {
    if (n.from < lastEnd) continue; // overlap with previous accepted node
    if (skipCode && offsetInRegions(n.from, codeRegions)) continue;
    accepted.push(n);
    lastEnd = n.to;
  }

  // Thread grouping: walk accepted nodes, collect comments, merge if the gap
  // between the previous comment's end and this comment's start contains only
  // inline whitespace (no newline).
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
      if (!/\n/.test(gap)) {
        // adjacent — append as reply
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
