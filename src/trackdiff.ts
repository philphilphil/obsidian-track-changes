// Session diff → CriticMarkup marks (issue #36). Pure module: tokenize both
// texts (marks and code regions atomic, words/whitespace elsewhere), diff the
// token streams with jsdiff, and emit SourceEdits that wrap the changes in
// markup. No Obsidian imports.

import { parse, findCodeRegions } from "./parser";

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
