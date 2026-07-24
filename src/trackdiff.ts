// Session diff → CriticMarkup marks (issue #36). Pure module: tokenize both
// texts (marks and code regions atomic, words/whitespace elsewhere), diff the
// token streams with jsdiff, and emit SourceEdits that wrap the changes in
// markup. No Obsidian imports.

import { diffArrays } from "diff";
import { parse, findCodeRegions } from "./parser";
import { BLOCK_MARKER_RE } from "./authoring";
import type { SourceEdit } from "./operations";

export type TokenKind = "mark" | "code" | "word" | "space";

export interface Token {
  text: string;
  kind: TokenKind;
}

export function tokenize(source: string): Token[] {
  const atomic: Array<{ from: number; to: number; kind: TokenKind }> = [];
  const marks = parse(source).nodes;
  for (const n of marks) atomic.push({ from: n.from, to: n.to, kind: "mark" });
  for (const [a, b] of findCodeRegions(source)) {
    // A mark that wraps an inline code span owns that range (issue #8).
    if (marks.some((m) => m.from < b && a < m.to)) continue;
    atomic.push({ from: a, to: b, kind: "code" });
  }
  atomic.sort((x, y) => x.from - y.from);

  const out: Token[] = [];
  let pos = 0;
  for (const r of atomic) {
    if (r.from > pos) pushPlain(out, source.slice(pos, r.from));
    out.push({ text: source.slice(r.from, r.to), kind: r.kind });
    pos = r.to;
  }
  if (pos < source.length) pushPlain(out, source.slice(pos));
  return out;
}

function pushPlain(out: Token[], text: string): void {
  for (const m of text.matchAll(/\s+|\S+/g)) {
    out.push({ text: m[0], kind: /\s/.test(m[0][0]) ? "space" : "word" });
  }
}

export interface BlockPiece {
  text: string;
  sep: boolean;
}

/**
 * Split text into single-block chunks and separators, losslessly. Chunks
 * never contain a blank line, never have a non-first line that opens a block,
 * and a block-marker line is always its own chunk. Every mark the emitter
 * writes wraps exactly one chunk, keeping generated markup single-block.
 */
export function blockSplit(text: string): BlockPiece[] {
  const pieces: BlockPiece[] = [];
  const push = (t: string, sep: boolean): void => {
    if (t === "") return;
    const last = pieces[pieces.length - 1];
    if (last && last.sep === sep) last.text += t;
    else pieces.push({ text: t, sep });
  };

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hasNewline = i < lines.length - 1;
    const isBlank = /^[ \t]*$/.test(line);
    const isMarker = !isBlank && BLOCK_MARKER_RE.test(line);

    if (isBlank) {
      push(line + (hasNewline ? "\n" : ""), true);
      continue;
    }
    push(line, false);
    if (hasNewline) {
      const next = lines[i + 1];
      const nextBlank = /^[ \t]*$/.test(next);
      const nextMarker = !nextBlank && BLOCK_MARKER_RE.test(next);
      // The newline is a separator when it borders a blank line or when
      // either neighbor is a block-marker line (markers chunk alone).
      push("\n", nextBlank || nextMarker || isMarker);
    }
  }
  return pieces;
}

export interface TrackCounts {
  additions: number;
  deletions: number;
  substitutions: number;
  codeChanged: number;
  marksPassedThrough: number;
  unsafeSkipped: number;
}

export interface TrackDiffResult {
  edits: SourceEdit[];
  counts: TrackCounts;
}

const DELIMITER_FRAGMENTS = [
  "{++", "++}", "{--", "--}", "{~~", "~>", "~~}",
  "{==", "==}", "{>>", "<<}", "{=+", "+=}",
];
const hasDelimiter = (t: string): boolean => DELIMITER_FRAGMENTS.some((d) => t.includes(d));
const BEFORE_ANCHOR = 30;

export function computeTrackEdits(
  baseline: string,
  current: string,
  attribution: string,
): TrackDiffResult {
  const counts: TrackCounts = {
    additions: 0,
    deletions: 0,
    substitutions: 0,
    codeChanged: 0,
    marksPassedThrough: 0,
    unsafeSkipped: 0,
  };
  const edits: SourceEdit[] = [];
  const parts = diffArrays(tokenize(baseline), tokenize(current), {
    comparator: (a, b) => a.text === b.text,
  });

  const lenOf = (tokens: Token[]): number => tokens.reduce((n, t) => n + t.text.length, 0);
  let cur = 0; // offset into `current`

  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      cur += lenOf(part.value);
      i++;
      continue;
    }
    let removed: Token[] = [];
    let added: Token[] = [];
    if (part.removed) {
      removed = part.value;
      i++;
      if (i < parts.length && parts[i].added) {
        added = parts[i].value;
        i++;
      }
    } else {
      added = part.value;
      i++;
    }
    cur = emitHunk(removed, added, cur, current, attribution, edits, counts);
  }
  return { edits, counts };
}

function emitHunk(
  removed: Token[],
  added: Token[],
  hunkStart: number,
  current: string,
  attribution: string,
  edits: SourceEdit[],
  counts: TrackCounts,
): number {
  const hunkEnd = hunkStart + added.reduce((n, t) => n + t.text.length, 0);
  const removedText = removed.map((t) => t.text).join("");
  const addedText = added.map((t) => t.text).join("");

  // Whitespace-only hunk: the change stands unmarked.
  if (/^\s*$/.test(removedText) && /^\s*$/.test(addedText)) return hunkEnd;

  const atomics = removed.concat(added).filter((t) => t.kind === "mark" || t.kind === "code");
  const noAtomics = atomics.length === 0;

  let insert: string;
  if (
    noAtomics &&
    isOneChunk(removedText) &&
    isOneChunk(addedText) &&
    !hasDelimiter(removedText) &&
    !hasDelimiter(addedText)
  ) {
    insert = `{${attribution}~~${removedText}~>${addedText}~~}`;
    counts.substitutions++;
  } else {
    insert = renderRemoved(removed, attribution, counts) + renderAdded(added, attribution, counts);
  }

  const expected = current.slice(hunkStart, hunkEnd);
  if (insert === expected) return hunkEnd; // nothing markable survived
  edits.push({
    from: hunkStart,
    to: hunkEnd,
    insert,
    expected,
    before: current.slice(Math.max(0, hunkStart - BEFORE_ANCHOR), hunkStart),
  });
  return hunkEnd;
}

/** Non-empty, non-whitespace text that blockSplit keeps as a single chunk. */
function isOneChunk(text: string): boolean {
  if (/^\s*$/.test(text)) return false;
  const pieces = blockSplit(text);
  return pieces.length === 1 && !pieces[0].sep;
}

/**
 * Render the removed side as deletion marks placed ahead of the hunk's added
 * output. Removed mark tokens vanish (the user resolved/deleted that
 * suggestion); removed code tokens vanish uncounted as marks (codeChanged++);
 * plain text is block-split, chunks wrapped, interior separators kept so a
 * reject restores structure, edge separators dropped.
 */
function renderRemoved(removed: Token[], attribution: string, counts: TrackCounts): string {
  const plain: string[] = [];
  let buf = "";
  for (const t of removed) {
    if (t.kind === "mark") {
      counts.marksPassedThrough++;
      continue;
    }
    if (t.kind === "code") {
      counts.codeChanged++;
      continue;
    }
    buf += t.text;
  }
  if (buf !== "") plain.push(buf);

  let out = "";
  for (const segment of plain) {
    const pieces = blockSplit(segment);
    const rendered: string[] = [];
    let sawChunk = false;
    for (const p of pieces) {
      if (p.sep) {
        rendered.push(p.text);
        continue;
      }
      if (hasDelimiter(p.text)) {
        counts.unsafeSkipped++;
        continue;
      }
      rendered.push(`{${attribution}--${p.text}--}`);
      counts.deletions++;
      sawChunk = true;
    }
    if (!sawChunk) continue; // only separators/unsafe chunks — insert nothing
    // Drop leading/trailing separators so we never inject stray whitespace.
    let s = 0;
    let e = rendered.length;
    while (s < e && !rendered[s].startsWith(`{${attribution}--`)) s++;
    while (e > s && !rendered[e - 1].startsWith(`{${attribution}--`)) e--;
    out += rendered.slice(s, e).join("");
  }
  return out;
}

/**
 * Render the added side in place. Mark and code tokens pass through verbatim
 * (never wrapped); plain runs are block-split and chunks wrapped as
 * additions, separators bare; delimiter-bearing chunks stay bare.
 */
function renderAdded(added: Token[], attribution: string, counts: TrackCounts): string {
  let out = "";
  let buf = "";
  const flush = (): void => {
    if (buf === "") return;
    for (const p of blockSplit(buf)) {
      if (p.sep || hasDelimiter(p.text)) {
        if (!p.sep) counts.unsafeSkipped++;
        out += p.text;
        continue;
      }
      out += `{${attribution}++${p.text}++}`;
      counts.additions++;
    }
    buf = "";
  };
  for (const t of added) {
    if (t.kind === "mark") {
      flush();
      out += t.text;
      counts.marksPassedThrough++;
    } else if (t.kind === "code") {
      flush();
      out += t.text;
      counts.codeChanged++;
    } else {
      buf += t.text;
    }
  }
  flush();
  return out;
}
