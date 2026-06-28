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
  // Descending order: sorted[i+1].from < sorted[i].from. Non-overlap requires
  // sorted[i+1].to <= sorted[i].from. Catch contract violations early — silent
  // overlap would corrupt the source via the slice/splice loop below.
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i + 1].to > sorted[i].from) {
      throw new Error("applyEdits: overlapping edits");
    }
  }
  let out = source;
  for (const e of sorted) {
    out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  }
  return out;
}

/**
 * Rebase an edit against the current document. If the edit's `from..to` still
 * matches `expected` (and `before` if provided), the edit is returned as-is.
 * If the original range no longer matches, only edits with an explicit `before`
 * anchor may relocate. Plain `expected` edits intentionally fail closed: a raw
 * CriticMarkup block like `{++x++}` is too weak to safely distinguish from an
 * identical nearby block.
 *
 * If `expected` and `before` are both undefined, we trust the offsets and
 * return as-is (backwards-compatible default).
 */
const REBASE_WINDOW = 200;

export function rebaseEdit(currentDoc: string, edit: SourceEdit): SourceEdit | null {
  if (edit.expected === undefined && edit.before === undefined) return edit;

  const expected = edit.expected ?? "";
  const before = edit.before ?? "";
  const currentExpected = currentDoc.slice(edit.from, edit.to);
  const currentBefore =
    before === "" ? "" : currentDoc.slice(Math.max(0, edit.from - before.length), edit.from);
  if (currentExpected === expected && currentBefore === before) return edit;

  if (edit.before === undefined) return null;

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

  // Ambiguous (zero or multiple) — refuse. Relocation must be uniquely anchored
  // by context, otherwise a stale action could edit an identical nearby block.
  if (matches.length !== 1) return null;

  const newFrom = matches[0] + before.length;
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

/** Remove an AI-added-text mark: strip the {=+…+=} wrapper, keep the inner text. */
export function removeAiText(node: CriticNode): SourceEdit {
  if (node.kind !== "aitext") throw new Error("removeAiText: wrong node kind");
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
 * Strip characters that could break the quoted metadata prefix or its
 * rendering: control / line-separator chars (newline, NUL, U+2028/9) and the
 * three structural chars the quoted-value class forbids \u2014 `"`, `{`, `}`.
 * Everything else (spaces, `;`, `=`, `-`, \u2026) is safe inside the quotes, so a
 * name like `J. O'Reilly-Smith, Jr.` survives intact.
 */
export function sanitizeAuthorName(name: string): string {
  return name
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\x00-\x1f\x7f\u2028\u2029]/g, "")
    .replace(/["{}]/g, "");
}

export type ReplyDateStyle = "date" | "datetime";

// Real-clock stamp. "date" → YYYY-MM-DD (local); "datetime" → second-precision
// UTC ISO. The bare "date" form has no zone marker, so it reflects the user's
// local calendar day — UTC would read a day ahead in negative-offset zones near
// midnight. "datetime" keeps Z because it carries an explicit zone.
function formatReplyDate(style: ReplyDateStyle): string {
  const d = new Date();
  if (style === "datetime") {
    return `${d.toISOString().slice(0, 19)}Z`;
  }
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Insert a human reply adjacent to the last message of a thread, stamped with
 * the new metadata prefix. The reply ALWAYS carries `date=<today>`; if
 * `localAuthorName` is non-empty it also carries `author=<sanitized name>`
 * (otherwise no `author=`, so the parser resolves it to "You"). `localAuthorName`
 * is passed in from the panel/host — operations never reads settings directly.
 */
export function appendReply(
  _source: string,
  thread: Thread,
  parsed: ParseResult,
  text: string,
  localAuthorName = "",
  dateStyle: ReplyDateStyle = "date",
): SourceEdit {
  const validationError = validateReplyText(text);
  if (validationError) throw new Error(validationError);

  const lastIdx =
    thread.replyIndexes.length > 0
      ? thread.replyIndexes[thread.replyIndexes.length - 1]
      : thread.rootIndex;
  const last = parsed.nodes[lastIdx] as CommentNode;

  // Pairs are space-separated and the closing quote abuts the `>>` sigil — no
  // trailing `;`. A reply with no author= (or the user's own name) is "You".
  const date = formatReplyDate(dateStyle);
  const author = sanitizeAuthorName((localAuthorName ?? "").trim());
  const prefix = author ? `author="${author}" date="${date}"` : `date="${date}"`;
  const reply = `{${prefix}>>${text}<<}`;
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
  /** Also strip AI-added-text marks, keeping their text (default true). */
  stripAiText: boolean;
}

export const DEFAULT_FINALIZE: FinalizeOptions = {
  additions: "accept",
  deletions: "reject",
  substitutions: "reject",
  stripHighlights: true,
  stripAiText: true,
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
      case "aitext":
        if (opts.stripAiText) edits.push(removeAiText(n));
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
  aiText: number;
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
    aiText: 0,
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
    } else if (n.kind === "aitext") {
      s.aiText++;
    }
  }
  return s;
}
