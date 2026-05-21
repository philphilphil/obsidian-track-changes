// Reading-mode markdown post-processor.
//
// Strategy: source-aware. Obsidian gives us a rendered HTML block plus the
// file source via `ctx.getSectionInfo(el)`. We parse the source (cached
// across sections of the same render), find which CriticMarkup nodes
// intersect this section's line range, then locate each node's open/close
// tokens in the DOM and rewrite them. This is robust against markup that
// spans multiple text nodes (caused by inline formatting like **bold**,
// links, inline code, soft `<br>`) or that crosses block boundaries — the
// per-text-node regex this used to use could never handle either case.
//
// Per kind, in "accepted" form (reading mode is treated as a publish
// preview):
//   {++…++}     -> remove the {++ and ++} tokens, keep the body
//   {--…--}     -> remove tokens AND body (deletion is accepted)
//   {~~old~>new~~} -> remove {~~old~>  and ~~}, keep new
//   {==…==}     -> remove the { and } braces; the body is already inside
//                  Obsidian's own <mark> (it eats == itself)
//   {>>…<<}     -> remove tokens AND body; if readingShowComments is on,
//                  emit one icon per thread with a hover preview

import { setIcon, setTooltip, type MarkdownPostProcessorContext } from "obsidian";
import {
  parse,
  type ParseResult,
  type CriticNode,
  type CommentNode,
  type SubstitutionNode,
} from "./parser";
import {
  sectionCharRange,
  intersectingOps,
  commentsToIcon,
  type IntersectingOp,
} from "./reading-plan";
import { AUTHOR_RE } from "./authors";

export interface ReadingOptions {
  showComments: boolean;
}

export function makeReadingPostProcessor(getOpts: () => ReadingOptions) {
  const cache = new ParseCache();
  return (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
    const opts = getOpts();
    const info = ctx.getSectionInfo(el);
    if (info) {
      try {
        const parsed = cache.get(info.text);
        const [secFrom, secTo] = sectionCharRange(info.text, info.lineStart, info.lineEnd);
        applyToSection(el, parsed, secFrom, secTo, opts);
      } catch {
        // Defensive: fall through to the safety net rather than leak raw
        // markup if anything in the source-aware path throws.
      }
    }
    // Safety net. Idempotent after a successful source-aware pass — nothing
    // left to find. Saves us when section info is unavailable (e.g., some
    // rerender paths return null) or when source-aware silently failed.
    safetyNetClean(el, opts);
  };
}

// ---------- ParseCache ----------

class ParseCache {
  private map = new Map<string, ParseResult>();
  private readonly limit = 8;
  get(source: string): ParseResult {
    const hit = this.map.get(source);
    if (hit) {
      this.map.delete(source);
      this.map.set(source, hit);
      return hit;
    }
    const fresh = parse(source);
    this.map.set(source, fresh);
    if (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return fresh;
  }
}

// ---------- DOM application ----------

type TextPos = { node: Text; offset: number };
type DomRange = { start: TextPos; end: TextPos };

interface LocatedOp {
  op: IntersectingOp;
  openRange?: DomRange;
  closeRange?: DomRange;
  /**
   * Set when Obsidian's renderer ate the markup's own delimiters because
   * they're also markdown syntax — `==` for highlights (<mark>) and `~~` for
   * substitutions (<del> or <s>). Substitution then needs unwrapping after
   * we delete `old~>` so "new" doesn't keep the strikethrough styling.
   */
  wrapEl?: Element;
  /** For substitutions, the `~>` separator position when it falls in this section. */
  arrowRange?: DomRange;
}

function applyToSection(
  el: HTMLElement,
  parsed: ParseResult,
  secFrom: number,
  secTo: number,
  opts: ReadingOptions,
): void {
  const ops = intersectingOps(parsed, secFrom, secTo);
  if (ops.length === 0) return;

  // A markup that fully wraps this section (open and close both outside) is
  // by parser invariant the only one intersecting — markup nodes are
  // non-overlapping post-dedup. Hide or keep wholesale.
  if (ops.length === 1 && !ops[0].openIn && !ops[0].closeIn) {
    handleFullyInterior(el, ops[0].node);
    return;
  }

  const iconTargets = commentsToIcon(parsed, secFrom, secTo);

  const located = locateAll(el, ops, secFrom, secTo);
  // Mutate in reverse source order so earlier-located positions stay valid.
  for (let i = located.length - 1; i >= 0; i--) {
    applyLocated(el, located[i], parsed, iconTargets, opts);
  }
}

function handleFullyInterior(el: HTMLElement, node: CriticNode): void {
  // Addition body or highlighted body: render the section as-is.
  // Deletion / comment / substitution: nothing of this section should appear.
  if (node.kind === "addition" || node.kind === "highlight") return;
  el.style.display = "none";
}

function locateAll(
  el: HTMLElement,
  ops: IntersectingOp[],
  secFrom: number,
  secTo: number,
): LocatedOp[] {
  const out: LocatedOp[] = [];
  let cursor: TextPos | null = firstWalkableText(el);
  if (!cursor) return out;
  for (const op of ops) {
    const loc: LocatedOp = { op };
    if (op.openIn) {
      const found = locateOpen(el, op.node, cursor);
      if (found) {
        loc.openRange = found.range;
        if (found.wrapEl) loc.wrapEl = found.wrapEl;
        cursor = found.range.end;
      }
    }
    if (op.node.kind === "substitution") {
      // The `~>` separator survives Obsidian's renderer verbatim. Only locate
      // it if its source offset falls inside this section; otherwise the
      // arrow lives in another section and would be searched there.
      const sub = op.node as SubstitutionNode;
      const arrowSrcStart = sub.from + 3 + sub.oldText.length;
      if (arrowSrcStart >= secFrom && arrowSrcStart < secTo) {
        const arrow = locateLiteral(el, cursor, "~>");
        if (arrow) {
          loc.arrowRange = arrow.range;
          cursor = arrow.range.end;
        }
      }
    }
    if (op.closeIn) {
      const found = locateClose(el, op.node, cursor);
      if (found) {
        loc.closeRange = found.range;
        cursor = found.range.end;
      }
    }
    // Body-removing kinds need both expected endpoints — using
    // startOfElement/endOfElement as fallback would over-delete surrounding
    // content. For token-only kinds (addition, highlight) and substitution,
    // applyLocated handles any subset of located ranges safely.
    const bodyRemoving = op.node.kind === "deletion" || op.node.kind === "comment";
    if (bodyRemoving && op.openIn && !loc.openRange) continue;
    if (bodyRemoving && op.closeIn && !loc.closeRange) continue;
    if (!loc.openRange && !loc.closeRange && !loc.arrowRange) continue;
    out.push(loc);
  }
  return out;
}

function locateOpen(
  el: HTMLElement,
  node: CriticNode,
  cursor: TextPos,
): { range: DomRange; wrapEl?: Element } | null {
  if (node.kind === "highlight") {
    return locateBracedWrapper(el, cursor, "{==", ["MARK"]);
  }
  if (node.kind === "substitution") {
    return locateBracedWrapper(el, cursor, "{~~", ["DEL", "S"]);
  }
  const tok = openLiteral(node.kind);
  const r = locateLiteral(el, cursor, tok);
  return r ? { range: r.range } : null;
}

function locateClose(
  el: HTMLElement,
  node: CriticNode,
  cursor: TextPos,
): { range: DomRange } | null {
  if (node.kind === "highlight") {
    return locateBracedCloser(el, cursor, "==}");
  }
  if (node.kind === "substitution") {
    return locateBracedCloser(el, cursor, "~~}");
  }
  const tok = closeLiteral(node.kind);
  return locateLiteral(el, cursor, tok);
}

function openLiteral(kind: CriticNode["kind"]): string {
  switch (kind) {
    case "addition": return "{++";
    case "deletion": return "{--";
    case "substitution": return "{~~";
    case "comment": return "{>>";
    case "highlight": return "{==";
  }
}

function closeLiteral(kind: CriticNode["kind"]): string {
  switch (kind) {
    case "addition": return "++}";
    case "deletion": return "--}";
    case "substitution": return "~~}";
    case "comment": return "<<}";
    case "highlight": return "==}";
  }
}

function locateLiteral(
  el: HTMLElement,
  cursor: TextPos,
  tok: string,
): { range: DomRange } | null {
  let node: Text | null = cursor.node;
  let offset = cursor.offset;
  while (node) {
    const text = node.nodeValue ?? "";
    const idx = text.indexOf(tok, offset);
    if (idx >= 0) {
      return {
        range: {
          start: { node, offset: idx },
          end: { node, offset: idx + tok.length },
        },
      };
    }
    node = nextWalkableText(el, node);
    offset = 0;
  }
  return null;
}

/**
 * Locate the open token of a markup whose internal delimiters are also
 * native markdown (`==` → <mark>, `~~` → <del>/<s>). Try the literal token
 * first (in case Obsidian didn't eat them — e.g., leading/trailing space
 * inside disqualifies the syntax); otherwise look for `{` immediately
 * followed by an element with one of `tags`.
 */
function locateBracedWrapper(
  el: HTMLElement,
  cursor: TextPos,
  literalToken: string,
  tags: string[],
): { range: DomRange; wrapEl?: Element } | null {
  const lit = locateLiteral(el, cursor, literalToken);
  if (lit) return { range: lit.range };

  let node: Text | null = cursor.node;
  let offset = cursor.offset;
  while (node) {
    const text = node.nodeValue ?? "";
    let idx = text.indexOf("{", offset);
    while (idx >= 0) {
      const tail = text.substring(idx + 1);
      if (/^\s*$/.test(tail)) {
        const wrap = nextMatchingElement(node, el, tags);
        if (wrap) {
          return {
            range: {
              start: { node, offset: idx },
              end: { node, offset: idx + 1 },
            },
            wrapEl: wrap,
          };
        }
      }
      idx = text.indexOf("{", idx + 1);
    }
    node = nextWalkableText(el, node);
    offset = 0;
  }
  return null;
}

/**
 * Walk forward in document order from `from`, skipping whitespace-only text
 * nodes, and return the next element whose tagName is in `tags`. Returns
 * null if anything else is encountered first — we only treat `<mark>` etc.
 * as the wrapper if it's the next significant node.
 */
function nextMatchingElement(
  from: Text,
  root: HTMLElement,
  tags: string[],
): Element | null {
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  );
  walker.currentNode = from;
  let n = walker.nextNode();
  while (n) {
    if (n.nodeType === 3) {
      if (!/^\s*$/.test((n as Text).nodeValue ?? "")) return null;
    } else if (n.nodeType === 1) {
      return tags.includes((n as Element).tagName) ? (n as Element) : null;
    }
    n = walker.nextNode();
  }
  return null;
}

function locateBracedCloser(
  el: HTMLElement,
  cursor: TextPos,
  literalToken: string,
): { range: DomRange } | null {
  const lit = locateLiteral(el, cursor, literalToken);
  if (lit) return lit;
  return locateLiteral(el, cursor, "}");
}

// ---------- Mutation ----------

function applyLocated(
  el: HTMLElement,
  loc: LocatedOp,
  parsed: ParseResult,
  iconTargets: Set<number>,
  opts: ReadingOptions,
): void {
  const { op, openRange, closeRange, arrowRange } = loc;
  const { node } = op;
  const doc = el.ownerDocument;

  switch (node.kind) {
    case "addition":
    case "highlight": {
      if (closeRange) deleteRange(doc, closeRange);
      if (openRange) deleteRange(doc, openRange);
      return;
    }
    case "deletion": {
      removeSpan(doc, el, openRange ?? null, closeRange ?? null);
      return;
    }
    case "substitution": {
      // Accepted form keeps only "new" — content between `~>` and `~~}`.
      // - If both arrow and close are in this section: delete close, then
      //   delete from open (or section start) up to and including arrow.
      // - If only arrow is in this section but close is later: delete from
      //   open (or section start) through arrow; leave the trailing content
      //   alone (it's part of "new", will be cleaned up in a later section
      //   when we hit its `~~}`).
      // - If close is in this section but arrow is in an earlier section:
      //   delete only the closing `~~}`. Content from section start to the
      //   close is part of "new" and stays visible.
      // - If neither arrow nor close is here: section is body. For "old"
      //   content (no arrow yet seen) the wrapping section is handled by
      //   handleFullyInterior elsewhere; here we conservatively drop the
      //   leading part up to section end if open is present.
      if (arrowRange && closeRange) {
        deleteRange(doc, closeRange);
        const start: TextPos | null = openRange ? openRange.start : startOfElement(el);
        if (start) deleteSpan(doc, { start, end: arrowRange.end });
      } else if (arrowRange) {
        const start: TextPos | null = openRange ? openRange.start : startOfElement(el);
        if (start) deleteSpan(doc, { start, end: arrowRange.end });
      } else if (closeRange) {
        deleteRange(doc, closeRange);
      } else if (openRange) {
        const endPos = endOfElement(el);
        if (endPos) deleteSpan(doc, { start: openRange.start, end: endPos });
      }
      // If Obsidian rendered the `~~…~~` as strikethrough, the leftover
      // wrapper would keep "new" struck-through. Unwrap it.
      if (loc.wrapEl) unwrapElement(loc.wrapEl);
      return;
    }
    case "comment": {
      const idx = op.nodeIndex;
      const wantIcon = opts.showComments && iconTargets.has(idx);
      const insertion = removeSpan(doc, el, openRange ?? null, closeRange ?? null);
      if (wantIcon && insertion) {
        const icon = makeCommentIcon(doc, parsed, idx);
        if (icon) insertion.insertNode(icon);
      }
      return;
    }
  }
}

function deleteRange(doc: Document, r: DomRange): void {
  const range = doc.createRange();
  range.setStart(r.start.node, r.start.offset);
  range.setEnd(r.end.node, r.end.offset);
  range.deleteContents();
}

function deleteSpan(doc: Document, r: DomRange): void {
  const range = doc.createRange();
  range.setStart(r.start.node, r.start.offset);
  range.setEnd(r.end.node, r.end.offset);
  range.deleteContents();
}

/**
 * Delete the content spanned by open/close, plus the markup body in between.
 * Missing endpoints are clamped to the start or end of `el`. Returns a Range
 * positioned at the deletion point (collapsed) so the caller can insert a
 * replacement (e.g., a comment icon) there.
 */
function removeSpan(
  doc: Document,
  el: HTMLElement,
  openRange: DomRange | null,
  closeRange: DomRange | null,
): Range | null {
  const start = openRange ? openRange.start : startOfElement(el);
  const end = closeRange ? closeRange.end : endOfElement(el);
  if (!start || !end) return null;
  const range = doc.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  range.deleteContents();
  return range;
}

function unwrapElement(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function startOfElement(el: HTMLElement): TextPos | null {
  const first = firstWalkableText(el);
  return first ? { node: first.node, offset: 0 } : null;
}

function endOfElement(el: HTMLElement): TextPos | null {
  const last = lastWalkableText(el);
  if (!last) return null;
  return { node: last, offset: (last.nodeValue ?? "").length };
}

// ---------- Comment icon ----------

function makeCommentIcon(
  doc: Document,
  parsed: ParseResult,
  rootCommentIdx: number,
): HTMLElement | null {
  const root = parsed.nodes[rootCommentIdx] as CommentNode | undefined;
  if (!root || root.kind !== "comment") return null;
  const threadIdx = parsed.nodeThread[rootCommentIdx];
  const thread = threadIdx >= 0 ? parsed.threads[threadIdx] : null;

  const span = doc.createElement("span");
  span.className = "tc-rm-comment";
  setIcon(span, "message-square-text");

  const tooltip = renderThreadTooltip(parsed, thread, root);
  setTooltip(span, tooltip, { placement: "top" });
  span.setAttribute("aria-label", tooltip);
  return span;
}

function renderThreadTooltip(
  parsed: ParseResult,
  thread: { rootIndex: number; replyIndexes: number[] } | null,
  fallback: CommentNode,
): string {
  if (!thread) return formatComment(fallback);
  const out: string[] = [];
  out.push(formatComment(parsed.nodes[thread.rootIndex] as CommentNode));
  for (const idx of thread.replyIndexes) {
    out.push(formatComment(parsed.nodes[idx] as CommentNode));
  }
  return out.join("\n\n");
}

function formatComment(c: CommentNode): string {
  const author = c.authorName ?? "You";
  const body = c.text.trim();
  return `${author}: ${body}`;
}

// ---------- TreeWalker helpers ----------

function isSkippedElement(el: Element): boolean {
  const tag = el.tagName;
  if (tag === "CODE" || tag === "PRE") return true;
  // Math containers (MathJax/KaTeX). Includes Obsidian's `.math` and `.math-block`.
  if (el.classList && (el.classList.contains("math") || el.classList.contains("math-block"))) {
    return true;
  }
  return false;
}

function isInsideSkipped(n: Node, root: Node): boolean {
  let cur: Node | null = n.parentNode;
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && isSkippedElement(cur as Element)) return true;
    cur = cur.parentNode;
  }
  return false;
}

function makeWalker(root: HTMLElement): TreeWalker {
  return root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (isInsideSkipped(n, root)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
}

function firstWalkableText(root: HTMLElement): TextPos | null {
  const w = makeWalker(root);
  const n = w.nextNode() as Text | null;
  return n ? { node: n, offset: 0 } : null;
}

function lastWalkableText(root: HTMLElement): Text | null {
  const w = makeWalker(root);
  let n: Text | null = null;
  let cur = w.nextNode();
  while (cur) {
    n = cur as Text;
    cur = w.nextNode();
  }
  return n;
}

function nextWalkableText(root: HTMLElement, after: Text): Text | null {
  const w = makeWalker(root);
  w.currentNode = after;
  return w.nextNode() as Text | null;
}

// ---------- Safety-net DOM cleanup ----------

const LITERAL_MARKUP_RE =
  /\{>>([\s\S]*?)<<\}|\{\+\+([\s\S]*?)\+\+\}|\{--([\s\S]*?)--\}|\{~~([\s\S]*?)~>([\s\S]*?)~~\}|\{==([\s\S]*?)==\}/g;

/**
 * Best-effort DOM-only cleanup that doesn't need source-of-truth from
 * `getSectionInfo`. Two passes:
 *  1. Structural: any <mark>, <del>, or <s> wrapped by literal `{`…`}`
 *     braces is treated as a CriticMarkup highlight or substitution.
 *  2. Text-node regex: any literal `{++…++}` / `{--…--}` / `{>>…<<}` /
 *     `{==…==}` / `{~~…~>…~~}` that survived Obsidian's renderer.
 *
 * Idempotent — after a successful source-aware pass there's nothing left
 * to find. Doesn't know about threads (so each comment gets its own icon
 * here), and can't span multiple text nodes / blocks — but it never
 * leaves the user looking at raw markup, which is the contract that
 * matters when `getSectionInfo` is unavailable.
 */
function safetyNetClean(el: HTMLElement, opts: ReadingOptions): void {
  cleanBraceWrapped(el, "mark", false);
  cleanBraceWrapped(el, "del", true);
  cleanBraceWrapped(el, "s", true);
  cleanLiteralTokens(el, opts);
}

function cleanBraceWrapped(el: HTMLElement, tag: string, unwrapAfter: boolean): void {
  const wrappers = Array.from(el.querySelectorAll(tag));
  for (const wrap of wrappers) {
    const prev = wrap.previousSibling;
    const next = wrap.nextSibling;
    if (!prev || prev.nodeType !== 3) continue;
    if (!next || next.nodeType !== 3) continue;
    const prevText = (prev as Text).nodeValue ?? "";
    const nextText = (next as Text).nodeValue ?? "";
    if (!prevText.endsWith("{")) continue;
    if (!nextText.startsWith("}")) continue;
    (prev as Text).nodeValue = prevText.slice(0, -1);
    (next as Text).nodeValue = nextText.slice(1);
    if (unwrapAfter) {
      // Substitution: drop the leading "old~>" inside the wrapper, then
      // unwrap so "new" isn't left struck-through.
      stripSubstitutionOld(wrap);
      unwrapElement(wrap);
    }
  }
}

function stripSubstitutionOld(wrap: Element): void {
  const walker = wrap.ownerDocument.createTreeWalker(wrap, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode() as Text | null;
  while (n) {
    const text = n.nodeValue ?? "";
    const idx = text.indexOf("~>");
    if (idx >= 0) {
      const doc = wrap.ownerDocument;
      const range = doc.createRange();
      range.setStartBefore(wrap.firstChild ?? wrap);
      range.setEnd(n, idx + 2);
      range.deleteContents();
      return;
    }
    n = walker.nextNode() as Text | null;
  }
}

function cleanLiteralTokens(el: HTMLElement, opts: ReadingOptions): void {
  const doc = el.ownerDocument;
  const walker = makeWalker(el);
  const targets: Text[] = [];
  let n = walker.nextNode();
  while (n) {
    const v = (n as Text).nodeValue ?? "";
    if (v.includes("{")) {
      LITERAL_MARKUP_RE.lastIndex = 0;
      if (LITERAL_MARKUP_RE.test(v)) targets.push(n as Text);
    }
    n = walker.nextNode();
  }

  for (const t of targets) {
    const src = t.nodeValue ?? "";
    const frag = doc.createDocumentFragment();
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    LITERAL_MARKUP_RE.lastIndex = 0;
    while ((m = LITERAL_MARKUP_RE.exec(src)) !== null) {
      if (m.index > lastIndex) frag.appendChild(doc.createTextNode(src.slice(lastIndex, m.index)));
      const replacement = renderLiteralMatch(doc, m, opts);
      if (replacement) frag.appendChild(replacement);
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < src.length) frag.appendChild(doc.createTextNode(src.slice(lastIndex)));
    t.replaceWith(frag);
  }
}

function renderLiteralMatch(
  doc: Document,
  m: RegExpExecArray,
  opts: ReadingOptions,
): Node | null {
  const comment = m[1];
  const addition = m[2];
  const deletion = m[3];
  const subNew = m[5];
  const highlight = m[6];
  if (comment !== undefined) {
    if (!opts.showComments) return null;
    return makeFallbackIcon(doc, comment);
  }
  if (addition !== undefined) return doc.createTextNode(addition);
  if (deletion !== undefined) return null;
  if (subNew !== undefined) return doc.createTextNode(subNew);
  if (highlight !== undefined) {
    const mark = doc.createElement("mark");
    mark.textContent = highlight;
    return mark;
  }
  return null;
}

function makeFallbackIcon(doc: Document, body: string): HTMLElement {
  // No parser context here — emit a single icon per comment with the body
  // as its tooltip. Thread grouping needs the parser; the source-aware
  // path handles that. This is the degraded mode.
  const am = body.match(AUTHOR_RE);
  const authorName = am ? am[1] : null;
  const text = am ? body.slice(am[0].length).trim() : body.trim();
  const span = doc.createElement("span");
  span.className = "tc-rm-comment";
  setIcon(span, "message-square-text");
  const tip = `${authorName ?? "You"}: ${text}`;
  setTooltip(span, tip, { placement: "top" });
  span.setAttribute("aria-label", tip);
  return span;
}
