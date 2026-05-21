// Pure planning helpers used by the reading-mode post-processor. Kept in
// their own module so they can be unit-tested in Node without an `obsidian`
// import.

import type { ParseResult, CriticNode } from "./parser";

/**
 * Compute the [from, to) character offsets in `source` corresponding to the
 * inclusive line range [lineStart..lineEnd]. The trailing newline of the
 * last line is excluded.
 */
export function sectionCharRange(
  source: string,
  lineStart: number,
  lineEnd: number,
): [number, number] {
  let pos = 0;
  let line = 0;
  while (line < lineStart && pos <= source.length) {
    const nl = source.indexOf("\n", pos);
    if (nl === -1) return [source.length, source.length];
    pos = nl + 1;
    line++;
  }
  const from = pos;
  while (line <= lineEnd && pos < source.length) {
    const nl = source.indexOf("\n", pos);
    if (nl === -1) {
      pos = source.length;
      break;
    }
    pos = nl + 1;
    line++;
  }
  const to = pos > from && source[pos - 1] === "\n" ? pos - 1 : pos;
  return [from, to];
}

export interface IntersectingOp {
  node: CriticNode;
  /** Opening brace is inside this section. */
  openIn: boolean;
  /** Closing brace is inside this section. */
  closeIn: boolean;
}

export function intersectingOps(
  parsed: ParseResult,
  secFrom: number,
  secTo: number,
): IntersectingOp[] {
  const out: IntersectingOp[] = [];
  for (const n of parsed.nodes) {
    if (n.to <= secFrom || n.from >= secTo) continue;
    out.push({
      node: n,
      openIn: n.from >= secFrom && n.from < secTo,
      closeIn: n.to > secFrom && n.to <= secTo,
    });
  }
  return out;
}

/**
 * Decide which comment indices in `parsed.nodes` should render an icon for
 * this section. A thread renders exactly one icon document-wide, anchored
 * at the root comment. So a section emits an icon iff it contains the
 * thread root; replies (or sections containing only replies of a thread
 * rooted earlier) emit none.
 */
export function commentsToIcon(
  parsed: ParseResult,
  secFrom: number,
  secTo: number,
): Set<number> {
  const icons = new Set<number>();
  for (const thread of parsed.threads) {
    const root = parsed.nodes[thread.rootIndex];
    if (root.from >= secFrom && root.from < secTo) {
      icons.add(thread.rootIndex);
    }
  }
  return icons;
}
