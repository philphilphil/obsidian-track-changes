// Session diff → CriticMarkup marks (issue #36). Pure module: tokenize both
// texts (marks and code regions atomic, words/whitespace elsewhere), diff the
// token streams with jsdiff, and emit SourceEdits that wrap the changes in
// markup. No Obsidian imports.

import { parse, findCodeRegions } from "./parser";
import { BLOCK_MARKER_RE } from "./authoring";

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
