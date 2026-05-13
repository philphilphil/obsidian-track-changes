// Write operations on the markdown source. All operations return one or more
// SourceEdits; the caller writes them back via the Obsidian Vault API.
//
// Every SourceEdit can carry an optional `expected` (the substring currently
// at [from, to)) and an optional `before` (the substring immediately preceding
// `from`). These act as anchors so an edit produced from a stale parse can be
// safely rebased against the current document content via `rebaseEdit` before
// being dispatched. Without this, a doc that drifted between parse-time and
// apply-time (because the user typed, or the AI re-edited the file) would be
// corrupted by stale offsets.

import type { CriticNode, Thread, ParseResult, CommentNode } from "./parser";

export interface SourceEdit {
  from: number;
  to: number;
  insert: string;
  /** Substring expected at [from, to) in the doc. Used by rebaseEdit to verify and re-locate. */
  expected?: string;
  /** Substring expected immediately preceding `from`. Used to anchor insertions (where expected==""). */
  before?: string;
}

const COMMENT_CLOSE = "<<}";

export function validateReplyText(text: string): string | null {
  if (text.includes(COMMENT_CLOSE)) {
    return "Replies cannot contain the CriticMarkup comment closing marker <<}.";
  }
  return null;
}

/** Apply a list of edits to a source string. Edits must be non-overlapping. */
export function applyEdits(source: string, edits: SourceEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.from - a.from);
  let out = source;
  for (const e of sorted) {
    out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  }
  return out;
}

/**
 * Rebase an edit against the current document. If the edit's `from..to` still
 * matches `expected` (and `before` if provided), the edit is returned as-is.
 * Otherwise we search a ±200 char window for the anchor `before + expected`;
 * if it occurs exactly once there, we return the edit with adjusted offsets.
 * If it can't be uniquely located, we return null — the caller should refuse.
 *
 * If `expected` and `before` are both undefined, we trust the offsets and
 * return as-is (backwards-compatible default).
 */
const REBASE_WINDOW = 200;

export function rebaseEdit(currentDoc: string, edit: SourceEdit): SourceEdit | null {
  if (edit.expected === undefined && edit.before === undefined) return edit;

  const expected = edit.expected ?? "";
  const before = edit.before ?? "";
  const needle = before + expected;
  if (needle === "") return null;

  const searchStart = Math.max(0, edit.from - before.length - REBASE_WINDOW);
  const searchEnd = Math.min(
    currentDoc.length,
    edit.from + REBASE_WINDOW + needle.length,
  );
  const window = currentDoc.slice(searchStart, searchEnd);

  const matches: number[] = [];
  let idx = window.indexOf(needle);
  while (idx !== -1) {
    matches.push(searchStart + idx);
    idx = window.indexOf(needle, idx + 1);
  }

  // Ambiguous (zero or multiple) — refuse. A coincidental in-place match isn't
  // enough to be confident the offset is still semantically correct.
  if (matches.length !== 1) return null;

  const newFrom = matches[0] + before.length;
  if (newFrom === edit.from && newFrom + expected.length === edit.to) return edit;
  return {
    ...edit,
    from: newFrom,
    to: newFrom + expected.length,
  };
}

/** Rebase a list of edits; returns the survivors and the count that couldn't be rebased. */
export function rebaseEdits(
  currentDoc: string,
  edits: SourceEdit[],
): { edits: SourceEdit[]; dropped: number } {
  const out: SourceEdit[] = [];
  let dropped = 0;
  for (const e of edits) {
    const r = rebaseEdit(currentDoc, e);
    if (r) out.push(r);
    else dropped++;
  }
  return { edits: out, dropped };
}

/** Accept an addition: keep the inner text, strip the markup. */
export function acceptAddition(node: CriticNode): SourceEdit {
  if (node.kind !== "addition") throw new Error("acceptAddition: wrong node kind");
  return { from: node.from, to: node.to, insert: node.text, expected: node.raw };
}

/** Reject an addition: remove the whole block. */
export function rejectAddition(node: CriticNode): SourceEdit {
  if (node.kind !== "addition") throw new Error("rejectAddition: wrong node kind");
  return { from: node.from, to: node.to, insert: "", expected: node.raw };
}

/** Accept a deletion: remove the whole block. */
export function acceptDeletion(node: CriticNode): SourceEdit {
  if (node.kind !== "deletion") throw new Error("acceptDeletion: wrong node kind");
  return { from: node.from, to: node.to, insert: "", expected: node.raw };
}

/** Reject a deletion: keep the inner text, strip the markup. */
export function rejectDeletion(node: CriticNode): SourceEdit {
  if (node.kind !== "deletion") throw new Error("rejectDeletion: wrong node kind");
  return { from: node.from, to: node.to, insert: node.text, expected: node.raw };
}

/** Accept a substitution: replace with the new text. */
export function acceptSubstitution(node: CriticNode): SourceEdit {
  if (node.kind !== "substitution") throw new Error("acceptSubstitution: wrong node kind");
  return { from: node.from, to: node.to, insert: node.newText, expected: node.raw };
}

/** Reject a substitution: replace with the old text. */
export function rejectSubstitution(node: CriticNode): SourceEdit {
  if (node.kind !== "substitution") throw new Error("rejectSubstitution: wrong node kind");
  return { from: node.from, to: node.to, insert: node.oldText, expected: node.raw };
}

/** Remove a highlight: strip the {==…==} wrapper, keep the inner text. */
export function removeHighlight(node: CriticNode): SourceEdit {
  if (node.kind !== "highlight") throw new Error("removeHighlight: wrong node kind");
  return { from: node.from, to: node.to, insert: node.text, expected: node.raw };
}

/** Delete a single comment node (one message within a thread). */
export function deleteCommentNode(node: CriticNode): SourceEdit {
  if (node.kind !== "comment") throw new Error("deleteCommentNode: wrong node kind");
  return { from: node.from, to: node.to, insert: "", expected: node.raw };
}

/**
 * Delete an entire thread (root + all replies). Range from thread.from to
 * thread.to covers the contiguous markup; surrounding text is untouched.
 */
export function deleteThread(source: string, thread: Thread): SourceEdit {
  return {
    from: thread.from,
    to: thread.to,
    insert: "",
    expected: source.slice(thread.from, thread.to),
  };
}

/**
 * Insert a human reply adjacent to the last message of a thread. The reply
 * carries no `Claude:` prefix — the parser uses absence of the prefix as the
 * signal that this is from the user.
 */
export function appendReply(
  _source: string,
  thread: Thread,
  parsed: ParseResult,
  text: string,
): SourceEdit {
  const validationError = validateReplyText(text);
  if (validationError) throw new Error(validationError);

  const lastIdx =
    thread.replyIndexes.length > 0
      ? thread.replyIndexes[thread.replyIndexes.length - 1]
      : thread.rootIndex;
  const last = parsed.nodes[lastIdx] as CommentNode;
  const reply = `{>>${text}<<}`;
  // Insert with no whitespace so the threading parser groups it.
  return {
    from: last.to,
    to: last.to,
    insert: reply,
    expected: "",
    before: last.raw,
  };
}

/**
 * Finalize for publish: resolve every remaining suggestion and strip every
 * comment thread. Returns the edits in document order (they don't overlap
 * because nodes don't overlap).
 *
 * Defaults match the spec's conservative recommendation: accept additions,
 * reject deletions (keep original prose), accept substitutions to their old
 * value (keep original). User can override via settings.
 */
export interface FinalizeOptions {
  additions: "accept" | "reject";
  deletions: "accept" | "reject";
  substitutions: "accept" | "reject";
  /** Also strip highlights (default true; they are non-semantic visual marks). */
  stripHighlights: boolean;
}

export const DEFAULT_FINALIZE: FinalizeOptions = {
  additions: "accept",
  deletions: "reject",
  substitutions: "reject",
  stripHighlights: true,
};

export function finalizeEdits(
  parsed: ParseResult,
  opts: FinalizeOptions = DEFAULT_FINALIZE,
): SourceEdit[] {
  const edits: SourceEdit[] = [];
  for (const n of parsed.nodes) {
    switch (n.kind) {
      case "comment":
        edits.push({ from: n.from, to: n.to, insert: "", expected: n.raw });
        break;
      case "addition":
        edits.push(opts.additions === "accept" ? acceptAddition(n) : rejectAddition(n));
        break;
      case "deletion":
        edits.push(opts.deletions === "accept" ? acceptDeletion(n) : rejectDeletion(n));
        break;
      case "substitution":
        edits.push(
          opts.substitutions === "accept" ? acceptSubstitution(n) : rejectSubstitution(n),
        );
        break;
      case "highlight":
        if (opts.stripHighlights) edits.push(removeHighlight(n));
        break;
    }
  }
  return edits;
}

/**
 * Summary describing what finalize will do — for the confirmation dialog.
 */
export interface FinalizeSummary {
  comments: number;
  additionsAccepted: number;
  additionsRejected: number;
  deletionsAccepted: number;
  deletionsRejected: number;
  substitutionsAccepted: number;
  substitutionsRejected: number;
  highlights: number;
}

export function summarizeFinalize(
  parsed: ParseResult,
  opts: FinalizeOptions = DEFAULT_FINALIZE,
): FinalizeSummary {
  const s: FinalizeSummary = {
    comments: 0,
    additionsAccepted: 0,
    additionsRejected: 0,
    deletionsAccepted: 0,
    deletionsRejected: 0,
    substitutionsAccepted: 0,
    substitutionsRejected: 0,
    highlights: 0,
  };
  for (const n of parsed.nodes) {
    if (n.kind === "comment") s.comments++;
    else if (n.kind === "addition") {
      if (opts.additions === "accept") s.additionsAccepted++;
      else s.additionsRejected++;
    } else if (n.kind === "deletion") {
      if (opts.deletions === "accept") s.deletionsAccepted++;
      else s.deletionsRejected++;
    } else if (n.kind === "substitution") {
      if (opts.substitutions === "accept") s.substitutionsAccepted++;
      else s.substitutionsRejected++;
    } else if (n.kind === "highlight") {
      s.highlights++;
    }
  }
  return s;
}
