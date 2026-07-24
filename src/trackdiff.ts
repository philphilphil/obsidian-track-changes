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
 * CRLF is not handled — callers pass LF vault text.
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
  /** True when the diff exceeded MAX_EDIT_LENGTH; edits is empty, caller should keep the session. */
  tooManyChanges: boolean;
}

// jsdiff's diffArrays is O(edit-distance²); a huge rewrite can freeze the UI
// for tens of seconds. Cap the edit distance and bail (undefined result) past it.
const MAX_EDIT_LENGTH = 5000;

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
    maxEditLength: MAX_EDIT_LENGTH,
  });
  if (!parts) return { edits, counts, tooManyChanges: true };

  const lenOf = (tokens: Token[]): number => tokens.reduce((n, t) => n + t.text.length, 0);
  const wrapPool = wrappedBaselineWords(parts);
  let cur = 0; // offset into `current`

  // jsdiff emits a removed part immediately before the added part it pairs
  // with; the walk relies on that ordering to pair del+add into one hunk. If a
  // future jsdiff reversed it, hunks would degrade to separate del/add marks —
  // still round-trip safe, just less tidy.
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
    cur = emitHunk(removed, added, cur, current, attribution, edits, counts, wrapPool);
  }
  return { edits, counts, tooManyChanges: false };
}

/**
 * Words of the old-side payloads of every added-side pass-through mark — the
 * baseline text a mark authored mid-session already wraps (deletion body,
 * substitution old side, highlight body; additions/comments/aitext have no old
 * side). Built globally across the whole diff because jsdiff can scatter a
 * wrapped run's baseline words across several hunks. A removed word matching
 * this pool is suppressed rather than re-marked as a session deletion, so
 * reject-all restores the baseline through the pass-through mark alone.
 */
function wrappedBaselineWords(parts: Array<{ added?: boolean; value: Token[] }>): string[] {
  const pool: string[] = [];
  const add = (payload: string): void => {
    for (const w of payload.match(/\S+/g) ?? []) pool.push(w);
  };
  for (const p of parts) {
    if (!p.added) continue;
    for (const t of p.value) {
      if (t.kind !== "mark") continue;
      const node = parse(t.text).nodes[0];
      if (!node) continue;
      if (node.kind === "deletion" || node.kind === "highlight") add(node.text);
      else if (node.kind === "substitution") add(node.oldText);
    }
  }
  return pool;
}

function emitHunk(
  removed: Token[],
  added: Token[],
  hunkStart: number,
  current: string,
  attribution: string,
  edits: SourceEdit[],
  counts: TrackCounts,
  wrapPool: string[],
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
    insert = renderRemoved(removed, attribution, counts, wrapPool) + renderAdded(added, attribution, counts);
  }

  // Count one changed code block per hunk, not once per side (a swapped fenced
  // block is one removed + one added code token, but a single change).
  const removedCode = removed.filter((t) => t.kind === "code").length;
  const addedCode = added.filter((t) => t.kind === "code").length;
  counts.codeChanged += Math.max(removedCode, addedCode);

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
 * suggestion); removed code tokens vanish (counted per-hunk in emitHunk);
 * plain text is block-split, chunks wrapped, interior separators kept so a
 * reject restores structure, edge separators dropped. A removed word whose
 * text a pass-through mark on the added side already wraps (its word is in
 * `wrapPool`) is dropped, so we never double-mark text a mid-session mark
 * accounts for. Removed code tokens and unsafe (delimiter-bearing) dropped
 * chunks are NOT restorable by reject-all — by design.
 */
function renderRemoved(
  removed: Token[],
  attribution: string,
  counts: TrackCounts,
  wrapPool: string[],
): string {
  const plain: string[] = [];
  let buf = "";
  for (const t of removed) {
    if (t.kind === "mark") {
      counts.marksPassedThrough++;
      continue;
    }
    if (t.kind === "code") continue;
    if (t.kind === "word") {
      const idx = wrapPool.indexOf(t.text);
      if (idx !== -1) {
        // A mid-session mark on the added side already wraps this baseline word.
        wrapPool.splice(idx, 1);
        continue;
      }
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
      out += t.text; // code counted per-hunk in emitHunk
    } else {
      buf += t.text;
    }
  }
  flush();
  return out;
}
