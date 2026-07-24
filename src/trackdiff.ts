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

  // Cluster the hunks, then process each cluster against its own wrap pool.
  // jsdiff emits a removed part immediately before the added part it pairs
  // with; the pairing below relies on that ordering. If a future jsdiff
  // reversed it, hunks would degrade to separate del/add marks — still
  // round-trip safe, just less tidy.
  for (const cluster of buildClusters(parts, lenOf)) {
    const wrapPool = wrappedBaselineWords(cluster.hunks);
    const renders = cluster.hunks.map((h) =>
      renderHunk(h.removed, h.added, h.hunkStart, current, attribution, counts, wrapPool),
    );
    creditFreedSpaces(renders);
    if (selfCheckFailsClosed(cluster, renders, attribution, counts)) {
      // Degraded: session deletions dropped. Emit only what survived.
    }
    for (const r of renders) {
      const insert = r.deletion + r.addition;
      if (insert === r.expected) continue; // nothing markable survived
      edits.push({
        from: r.hunkStart,
        to: r.hunkEnd,
        insert,
        expected: r.expected,
        before: current.slice(Math.max(0, r.hunkStart - BEFORE_ANCHOR), r.hunkStart),
      });
    }
  }
  return { edits, counts, tooManyChanges: false };
}

/**
 * Structural safety net (fail-closed). Only clusters carrying a pass-through
 * mark can be corrupted by an adverse jsdiff seam — pure-prose clusters
 * round-trip by construction. For those, project the cluster's rendered output
 * through reject semantics and compare against the baseline text the cluster
 * spans (removed tokens + the common whitespace between hunks). On mismatch the
 * rendered deletions would merge/reorder words on reject, so we DROP every
 * session deletion in the cluster (its removed text is simply unrestorable —
 * the documented unsafe-skip category) and keep the pass-through marks and
 * session additions/substitutions, whose accept side is exact by construction.
 * Returns true when a degrade happened. Never throws: worst case some deletions
 * go unmarked, which the tracking Notice already surfaces via unsafeSkipped.
 */
function selfCheckFailsClosed(
  cluster: Cluster,
  renders: HunkRender[],
  attribution: string,
  counts: TrackCounts,
): boolean {
  if (!cluster.hunks.some((h) => h.added.some((t) => t.kind === "mark"))) return false;

  const rendered = joinCluster(renders, cluster.interWs, (r) => r.deletion + r.addition);
  if (rejectResolve(rendered) === clusterSpan(cluster, (h) => h.removed)) return false;

  const deletionMark = `{${attribution}--`;
  for (const r of renders) {
    if (r.deletion === "") continue;
    const dropped = r.deletion.split(deletionMark).length - 1;
    counts.unsafeSkipped += dropped;
    counts.deletions -= dropped;
    r.deletion = "";
  }

  // Dropping session deletions removes the only corruption source (additions
  // reject-to-nothing, substitutions swap in place, pass-through marks are
  // already in `current`). Belt-and-suspenders: if the surviving output no
  // longer accepts back to the current text (never expected — additions/subs
  // wrap current text in place), neutralize the whole cluster (emit nothing,
  // leaving current untouched) so we can never corrupt.
  const degraded = joinCluster(renders, cluster.interWs, (r) => r.deletion + r.addition);
  if (acceptResolve(degraded) !== acceptResolve(clusterSpan(cluster, (h) => h.added))) {
    const additionMark = `{${attribution}++`;
    for (const r of renders) {
      counts.unsafeSkipped += r.addition.split(additionMark).length - 1;
      counts.additions -= r.addition.split(additionMark).length - 1;
      r.deletion = "";
      r.addition = r.expected; // insert === expected ⇒ no edit for this hunk
    }
  }
  return true;
}

/** Concatenate a per-hunk string with the common whitespace kept between hunks. */
function joinCluster(
  renders: HunkRender[],
  interWs: string[],
  pick: (r: HunkRender) => string,
): string {
  let s = "";
  for (let i = 0; i < renders.length; i++) {
    s += pick(renders[i]);
    if (i < interWs.length) s += interWs[i];
  }
  return s;
}

/** Baseline/current text the cluster spans: `pick` tokens plus inter-hunk whitespace. */
function clusterSpan(cluster: Cluster, pick: (h: Hunk) => Token[]): string {
  let s = "";
  for (let i = 0; i < cluster.hunks.length; i++) {
    s += pick(cluster.hunks[i]).map((t) => t.text).join("");
    if (i < cluster.interWs.length) s += cluster.interWs[i];
  }
  return s;
}

// Reject/accept resolution of every CriticMarkup mark (session + pass-through) —
// the single source of truth for the cluster self-check. Mirrors finalize
// semantics: reject keeps deletion/highlight/aitext bodies and substitution old
// sides and drops additions/comments.
function rejectResolve(s: string): string {
  return s
    .replace(/\{[^{}]*?~~([\s\S]*?)~>[\s\S]*?~~\}/g, "$1")
    .replace(/\{[^{}]*?\+\+[\s\S]*?\+\+\}/g, "")
    .replace(/\{[^{}]*?--([\s\S]*?)--\}/g, "$1")
    .replace(/\{[^{}]*?=\+([\s\S]*?)\+=\}/g, "$1")
    .replace(/\{[^{}]*?==([\s\S]*?)==\}/g, "$1")
    .replace(/\{[^{}]*?>>[\s\S]*?<<\}/g, "");
}

/** Accept resolution: keep addition/highlight/aitext bodies and substitution new sides, drop deletions/comments. */
function acceptResolve(s: string): string {
  return s
    .replace(/\{[^{}]*?~~[\s\S]*?~>([\s\S]*?)~~\}/g, "$1")
    .replace(/\{[^{}]*?\+\+([\s\S]*?)\+\+\}/g, "$1")
    .replace(/\{[^{}]*?--[\s\S]*?--\}/g, "")
    .replace(/\{[^{}]*?=\+([\s\S]*?)\+=\}/g, "$1")
    .replace(/\{[^{}]*?==([\s\S]*?)==\}/g, "$1")
    .replace(/\{[^{}]*?>>[\s\S]*?<<\}/g, "");
}

interface HunkRender {
  hunkStart: number;
  hunkEnd: number;
  expected: string;
  deletion: string; // session deletion marks (renderRemoved), placed ahead of addition
  addition: string; // pass-through marks + session additions (renderAdded), or a substitution
  /**
   * True when this hunk suppressed a leading wrapped word and dropped the
   * following space that separated it from a survivor in an EARLIER hunk of the
   * same cluster. jsdiff can keep that survivor and its separating space in
   * different hunks, so the space must be credited back to the earlier
   * deletion or reject-all would merge the two words.
   */
  freedLeadingSpace: boolean;
}

/**
 * Repair spacing across a cluster: when a hunk freed the space that a survivor
 * deletion in an earlier hunk still needs (see HunkRender.freedLeadingSpace),
 * append that space inside the nearest preceding deletion body so reject-all
 * restores the exact baseline spacing.
 */
function creditFreedSpaces(renders: HunkRender[]): void {
  for (let k = 0; k < renders.length; k++) {
    if (!renders[k].freedLeadingSpace) continue;
    for (let j = k - 1; j >= 0; j--) {
      if (renders[j].deletion === "") continue;
      if (!/ --\}$/.test(renders[j].deletion)) {
        renders[j].deletion = renders[j].deletion.replace(/--\}$/, " --}");
      }
      break;
    }
  }
}

interface Hunk {
  removed: Token[];
  added: Token[];
  hunkStart: number; // offset into `current` where the added text begins
}

interface Cluster {
  hunks: Hunk[];
  /** Common whitespace kept between hunk[i] and hunk[i+1]; length hunks.length-1. */
  interWs: string[];
}

/**
 * Partition the diff into clusters of change-hunks. A cluster is a maximal run
 * of hunks whose intervening common (unchanged) parts are all whitespace-only;
 * a common part carrying any word/mark/code token is a hard boundary. jsdiff
 * only ever scatters a mid-session wrap-mark's baseline fragments across such
 * whitespace-separated hunks, so a wrap payload and the baseline text it
 * accounts for always share a cluster — while an identical word genuinely
 * deleted elsewhere sits behind a word-bearing common run, in its own cluster,
 * and is never suppressed. The inter-hunk whitespace is retained so the
 * self-check can reconstruct the exact baseline text the cluster spans.
 */
function buildClusters(
  parts: Array<{ added?: boolean; removed?: boolean; value: Token[] }>,
  lenOf: (t: Token[]) => number,
): Cluster[] {
  const clusters: Cluster[] = [];
  let hunks: Hunk[] = [];
  let interWs: string[] = [];
  let pendingWs = ""; // ws-common seen since the last hunk (candidate inter-hunk gap)
  let breakBeforeNext = false;
  let cur = 0; // offset into `current`
  const flush = (): void => {
    if (hunks.length > 0) clusters.push({ hunks, interWs });
    hunks = [];
    interWs = [];
    pendingWs = "";
  };
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      if (part.value.every((t) => t.kind === "space")) {
        pendingWs += part.value.map((t) => t.text).join("");
      } else {
        breakBeforeNext = true;
      }
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
    if (breakBeforeNext) {
      flush();
      breakBeforeNext = false;
    }
    if (hunks.length > 0) interWs.push(pendingWs);
    pendingWs = "";
    hunks.push({ removed, added, hunkStart: cur });
    cur += lenOf(added);
  }
  flush();
  return clusters;
}

/**
 * Words of the old-side payloads of the cluster's added pass-through marks —
 * the baseline text a mark authored mid-session already wraps (deletion body,
 * substitution old side, highlight body; additions/comments/aitext have no old
 * side). A removed word matching this pool is suppressed rather than re-marked
 * as a session deletion, so reject-all restores the baseline through the
 * pass-through mark alone. Scoped per cluster (see buildClusters).
 */
function wrappedBaselineWords(hunks: Hunk[]): string[] {
  const pool: string[] = [];
  const add = (payload: string): void => {
    for (const w of payload.match(/\S+/g) ?? []) pool.push(w);
  };
  for (const h of hunks) {
    for (const t of h.added) {
      if (t.kind !== "mark") continue;
      const node = parse(t.text).nodes[0];
      if (!node) continue;
      if (node.kind === "deletion" || node.kind === "highlight") add(node.text);
      else if (node.kind === "substitution") add(node.oldText);
    }
  }
  return pool;
}

function renderHunk(
  removed: Token[],
  added: Token[],
  hunkStart: number,
  current: string,
  attribution: string,
  counts: TrackCounts,
  wrapPool: string[],
): HunkRender {
  const hunkEnd = hunkStart + added.reduce((n, t) => n + t.text.length, 0);
  const expected = current.slice(hunkStart, hunkEnd);
  const removedText = removed.map((t) => t.text).join("");
  const addedText = added.map((t) => t.text).join("");
  const base: HunkRender = {
    hunkStart,
    hunkEnd,
    expected,
    deletion: "",
    addition: "",
    freedLeadingSpace: false,
  };

  // Whitespace-only hunk: the change stands unmarked (addition === expected).
  if (/^\s*$/.test(removedText) && /^\s*$/.test(addedText)) {
    return { ...base, addition: addedText };
  }

  const atomics = removed.concat(added).filter((t) => t.kind === "mark" || t.kind === "code");
  const noAtomics = atomics.length === 0;

  if (
    noAtomics &&
    isOneChunk(removedText) &&
    isOneChunk(addedText) &&
    !hasDelimiter(removedText) &&
    !hasDelimiter(addedText)
  ) {
    base.addition = `{${attribution}~~${removedText}~>${addedText}~~}`;
    counts.substitutions++;
  } else {
    const rr = renderRemoved(removed, attribution, counts, wrapPool);
    base.deletion = rr.text;
    base.freedLeadingSpace = rr.freedLeadingSpace;
    base.addition = renderAdded(added, attribution, counts);
  }

  // Count one changed code block per hunk, not once per side (a swapped fenced
  // block is one removed + one added code token, but a single change).
  const removedCode = removed.filter((t) => t.kind === "code").length;
  const addedCode = added.filter((t) => t.kind === "code").length;
  counts.codeChanged += Math.max(removedCode, addedCode);

  return base;
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
 * suggestion); removed code tokens vanish (counted per-hunk in renderHunk);
 * plain text is block-split, chunks wrapped, interior separators kept so a
 * reject restores structure, edge separators dropped. A removed word whose
 * text a pass-through mark in the same cluster already wraps (its word is in
 * `wrapPool`) is dropped — along with one adjacent whitespace token so the gap
 * closes without orphaning a leading/trailing space inside a deletion body —
 * so we never double-mark text a mid-session mark accounts for. When the run
 * begins with such a suppressed word whose following space is dropped, the
 * result reports `freedLeadingSpace` so the caller can credit that space to a
 * survivor deletion in an earlier hunk (see creditFreedSpaces). Removed code
 * tokens and unsafe (delimiter-bearing) dropped chunks are NOT restorable by
 * reject-all — by design.
 */
function renderRemoved(
  removed: Token[],
  attribution: string,
  counts: TrackCounts,
  wrapPool: string[],
): { text: string; freedLeadingSpace: boolean } {
  const skip = new Set<number>();
  for (let k = 0; k < removed.length; k++) {
    if (removed[k].kind !== "word") continue;
    const idx = wrapPool.indexOf(removed[k].text);
    if (idx === -1) continue;
    wrapPool.splice(idx, 1);
    skip.add(k);
    // Drop one adjacent space so suppression never leaves an orphaned space at
    // a chunk edge. Prefer the following space; fall back to the preceding one
    // only when everything before it is also suppressed — otherwise that space
    // is the trailing separator a surviving deletion still needs.
    if (removed[k + 1]?.kind === "space") {
      skip.add(k + 1);
    } else if (removed[k - 1]?.kind === "space") {
      let allBeforeSkipped = true;
      for (let j = 0; j < k - 1; j++) if (!skip.has(j)) { allBeforeSkipped = false; break; }
      if (allBeforeSkipped) skip.add(k - 1);
    }
  }

  // The run leads with a suppressed word whose following space was dropped:
  // that space was the separator to a survivor in an earlier hunk (jsdiff kept
  // them apart), so signal the caller to credit it back.
  const freedLeadingSpace =
    removed[0]?.kind === "word" && skip.has(0) && removed[1]?.kind === "space" && skip.has(1);

  const plain: string[] = [];
  let buf = "";
  for (let k = 0; k < removed.length; k++) {
    if (skip.has(k)) continue;
    const t = removed[k];
    if (t.kind === "mark") {
      counts.marksPassedThrough++;
      continue;
    }
    if (t.kind === "code") continue;
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
  return { text: out, freedLeadingSpace };
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
