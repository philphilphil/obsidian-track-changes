// Vault-wide pending work: what one file still holds for review, and how a
// list of such files is ordered and filtered. Pure functions — no Obsidian
// imports — so the overview view and the status bar share one definition of
// "pending" and the test suite can pin it.
//
// The counts mirror the review panel's header exactly (same parse, same
// anchor rules): a thread anchored on a change is part of that suggestion,
// not a comment of its own; a highlight anchoring a thread is part of the
// thread; `aitext` marks are visual-only and never count.

import { anchorNodeIndexes, changeThreads, isChangeNode, parse } from "./parser";

export interface FileSummary {
  /** Additions, deletions and substitutions awaiting accept/reject. */
  suggestions: number;
  /** Comment threads not anchored on a suggestion. */
  comments: number;
  /** Highlights that are not a thread's anchor. */
  highlights: number;
}

export interface FileRow extends FileSummary {
  path: string;
}

export const EMPTY_SUMMARY: FileSummary = { suggestions: 0, comments: 0, highlights: 0 };

/** Total review items in a summary. */
export function pendingCount(s: FileSummary): number {
  return s.suggestions + s.comments + s.highlights;
}

/**
 * Count the review items in one file's source. The cheap pre-check skips the
 * parser for the common case — most notes in a vault hold no braces at all.
 */
export function summarizeSource(source: string): FileSummary {
  if (!source.includes("{")) return { ...EMPTY_SUMMARY };
  const parsed = parse(source);
  if (parsed.nodes.length === 0) return { ...EMPTY_SUMMARY };
  const anchored = anchorNodeIndexes(parsed);
  const onChange = changeThreads(parsed);
  let suggestions = 0;
  let highlights = 0;
  parsed.nodes.forEach((n, i) => {
    if (isChangeNode(n)) suggestions++;
    else if (n.kind === "highlight" && !anchored.has(i)) highlights++;
  });
  return {
    suggestions,
    comments: parsed.threads.length - onChange.size,
    highlights,
  };
}

/**
 * Files with the most to review first: suggestions outrank comments, which
 * outrank highlights; ties fall back to path order so the list is stable
 * across refreshes.
 */
export function sortRows(rows: FileRow[]): FileRow[] {
  return [...rows].sort(
    (a, b) =>
      b.suggestions - a.suggestions ||
      b.comments - a.comments ||
      b.highlights - a.highlights ||
      a.path.localeCompare(b.path),
  );
}

/** Case-insensitive substring match on the path; every space-separated term must match. */
export function filterRows(rows: FileRow[], query: string): FileRow[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return rows;
  return rows.filter((r) => {
    const p = r.path.toLowerCase();
    return terms.every((t) => p.includes(t));
  });
}

export interface Totals extends FileSummary {
  files: number;
}

export function totals(rows: FileRow[]): Totals {
  const out: Totals = { files: rows.length, suggestions: 0, comments: 0, highlights: 0 };
  for (const r of rows) {
    out.suggestions += r.suggestions;
    out.comments += r.comments;
    out.highlights += r.highlights;
  }
  return out;
}

/** "3 suggestions · 1 comment · 2 highlights" (highlights only when non-zero). */
export function describeSummary(s: FileSummary): string {
  const parts = [
    `${s.suggestions} ${s.suggestions === 1 ? "suggestion" : "suggestions"}`,
    `${s.comments} ${s.comments === 1 ? "comment" : "comments"}`,
  ];
  if (s.highlights > 0) {
    parts.push(`${s.highlights} ${s.highlights === 1 ? "highlight" : "highlights"}`);
  }
  return parts.join(" · ");
}
