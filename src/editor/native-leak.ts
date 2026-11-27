// Obsidian's own Markdown syntax reads `==text==` as a highlight and
// `~~text~~` as a strikethrough, so the sigils of a CriticMarkup `{==…==}` or
// `{~~old~>new~~}` double as Obsidian delimiters. When something stops
// Obsidian from closing at the mark's end (a bare URL that swallows the
// closing sigil, an `x==y` or `a~~b` in the paragraph or inside a comment, an
// unclosed backtick), its native `.cm-highlight` / `.cm-strikethrough` runs on
// to the end of the paragraph. This module finds the native runs that a mark's
// sigil opened or closed (see `leakRanges`), and tags their stray parts so
// styles.css can switch the native styling off there. Native highlights and
// strikethroughs opened and closed in prose are left alone, even when they
// wrap a mark.

import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";

import { parse, type CriticNode } from "../parser";

export type Span = [number, number];
/** A native run: its range, and whether it ends on a closing delimiter token. */
export type Run = [from: number, to: number, closed: boolean];

/**
 * Pure. `runs`: native runs of one kind; `marks`: every CriticMarkup mark
 * (outer brace to outer brace); `keep`: the marks whose inside should keep the
 * native styling (highlight marks for `==`, substitutions for `~~`, where the
 * plugin's own CSS already handles it). All three sorted and non-overlapping.
 *
 * A run is hijacked when a mark's sigil opened or closed it: it starts inside
 * a mark, or ends on a closing delimiter inside a mark, without staying inside
 * a single one. A run inside one mark is Obsidian closing where the mark says;
 * a run that merely wraps a mark (`~~struck {++added++} text~~`), or stops
 * inside one without a closer (an unclosed strike reaching the paragraph end,
 * a partial tree's parse frontier), is not. Returns each hijacked run minus
 * the `keep` spans. One forward sweep.
 */
export function leakRanges(runs: Run[], marks: Span[], keep: Span[]): Span[] {
  const out: Span[] = [];
  let j = 0;
  let k = 0;
  for (const [a, b, closed] of runs) {
    while (j < marks.length && marks[j][1] <= a) j++;
    if (j === marks.length || marks[j][0] >= b) continue; // touches no mark
    const first = marks[j];
    if (first[0] <= a && first[1] >= b) continue; // stays inside one mark
    let q = j;
    while (q + 1 < marks.length && marks[q + 1][0] < b) q++;
    const startsInside = first[0] <= a;
    const endsInside = closed && marks[q][1] >= b;
    if (!startsInside && !endsInside) continue; // opened in prose, not closed by a mark
    while (k < keep.length && keep[k][1] <= a) k++;
    let pos = a;
    for (let q = k; q < keep.length && keep[q][0] < b; q++) {
      if (keep[q][0] > pos) out.push([pos, keep[q][0]]);
      pos = Math.max(pos, keep[q][1]);
    }
    if (pos < b) out.push([pos, b]);
  }
  return out;
}

/**
 * Pure: the blank-line-delimited paragraph ranges that intersect any mark
 * (`marks` sorted by `from`), merged so a mark spanning several paragraphs
 * covers all of them. One linear pass over the source.
 */
export function markedParagraphs(source: string, marks: Span[]): Span[] {
  const paragraphs: Span[] = [];
  let start = 0;
  for (const m of source.matchAll(/\n[ \t]*\n/g)) {
    const idx = m.index ?? 0;
    paragraphs.push([start, idx]);
    start = idx + m[0].length;
  }
  paragraphs.push([start, source.length]);

  const out: Span[] = [];
  let p = 0;
  for (const [f, t] of marks) {
    while (p < paragraphs.length - 1 && paragraphs[p][1] <= f) p++;
    let q = p;
    while (q < paragraphs.length - 1 && paragraphs[q][1] < t) q++;
    const span: Span = [paragraphs[p][0], paragraphs[q][1]];
    const last = out[out.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else out.push(span);
  }
  return out;
}

interface NativeKind {
  /** Class in Obsidian's `_`-joined stream-token names, e.g. `highlight_url`. */
  token: string;
  /** Class we tag the stray parts with; styles.css keys on it. */
  cls: string;
  /** Which CriticMarkup marks keep the native styling inside them. */
  keeps: (n: CriticNode) => boolean;
}

const KINDS: NativeKind[] = [
  { token: "highlight", cls: "tc-native-hl-leak", keeps: (n) => n.kind === "highlight" },
  { token: "strikethrough", cls: "tc-native-strike-leak", keeps: (n) => n.kind === "substitution" },
];

interface Scan {
  source: string;
  marks: Span[];
  /** Per kind (parallel to KINDS): the spans of the marks it keeps. */
  keep: Span[][];
  /** Only paragraphs that hold a CriticMarkup mark can leak. */
  paragraphs: Span[];
}

function scanDoc(state: EditorState): Scan {
  const source = state.doc.toString();
  const nodes = parse(source).nodes;
  const marks = nodes.map((n): Span => [n.from, n.to]);
  return {
    source,
    marks,
    keep: KINDS.map((kind) => nodes.filter(kind.keeps).map((n): Span => [n.from, n.to])),
    paragraphs: markedParagraphs(source, marks),
  };
}

export interface Token {
  name: string;
  from: number;
  to: number;
}

/**
 * Pure: group Obsidian's stream tokens (in document order) into native runs
 * of one kind (`highlight` / `strikethrough`). Obsidian marks the delimiters:
 * an opener carries `formatting-<kind>`, a closer also `formatting-<kind>-end`.
 * A closer ends its run and an opener always starts a new one, so a run closed
 * at a line end never absorbs a fresh `==…==` on the next line. Other tokens
 * of the kind continue the open run when contiguous or separated only by a
 * soft line break (the run continues onto the next line); a plain space gap
 * never joins. Each run records whether it ended on a closer.
 */
export function collectRuns(tokens: Token[], source: string, kind: string): Run[] {
  const runs: Run[] = [];
  let open = false;
  for (const t of tokens) {
    const classes = t.name.split("_");
    if (!classes.includes(kind)) continue;
    const opener = classes.includes(`formatting-${kind}`) && !classes.includes(`formatting-${kind}-end`);
    const closer = classes.includes(`formatting-${kind}-end`);
    const last = runs[runs.length - 1];
    const gap = last ? source.slice(last[1], t.from) : "";
    if (open && !opener && last && (gap === "" || /^[ \t]*\r?\n[ \t]*$/.test(gap))) {
      last[1] = Math.max(last[1], t.to);
      last[2] = closer;
    } else {
      runs.push([t.from, t.to, closer]);
    }
    open = !closer;
  }
  return runs;
}

function buildLeakDecorations(state: EditorState, scan: Scan): DecorationSet {
  if (scan.marks.length === 0) return Decoration.none;
  const tree = syntaxTree(state);
  const tokens: Token[] = [];
  for (const [from, to] of scan.paragraphs) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (KINDS.some((kind) => node.name.split("_").includes(kind.token))) {
          tokens.push({ name: node.name, from: node.from, to: node.to });
        }
      },
    });
  }
  const ranges: Range<Decoration>[] = [];
  for (const [i, kind] of KINDS.entries()) {
    const deco = Decoration.mark({ class: kind.cls });
    const runs = collectRuns(tokens, scan.source, kind.token);
    for (const [a, b] of leakRanges(runs, scan.marks, scan.keep[i])) ranges.push(deco.range(a, b));
  }
  return Decoration.set(ranges, true);
}

/**
 * Tags stray native highlight / strikethrough runs. The marks are every
 * CriticMarkup kind: a `==` inside a comment body (`{>>does a==b hold?<<}`)
 * opens a native highlight just as well, and is never meant as one since the
 * comment renders as a chip. Obsidian's native span always wraps ours, so
 * styles.css switches the parent's styling off with `:has()`. A ViewPlugin, not
 * part of the main StateField: Obsidian's syntax tree is parsed lazily, so this
 * must also rebuild when the tree advances without a document change.
 */
export const nativeMarkupLeakGuard = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    // Parse and paragraph scan depend only on the text: redo them on document
    // changes, not on every tree advance.
    scan: Scan;

    constructor(view: EditorView) {
      this.scan = scanDoc(view.state);
      this.decorations = buildLeakDecorations(view.state, this.scan);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) this.scan = scanDoc(update.state);
      if (update.docChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) {
        this.decorations = buildLeakDecorations(update.state, this.scan);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
