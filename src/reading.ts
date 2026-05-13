// Reading-mode markdown post-processor.
//
// Reading mode is the rendered HTML view. We walk text nodes, find any
// CriticMarkup syntax, and replace it with appropriate inline elements:
//   - Comments: tiny icon — ⓘ tinted by the author's hue for named
//     authors, speech-bubble for unnamed. Clicking does nothing (user
//     switches to edit mode).
//   - Additions: depending on settings, show accepted form or styled.
//   - Deletions: hidden (accepted), or styled strikethrough (raw).
//   - Substitutions: show the new text (accepted), or both sides (raw).
//   - Highlights: render content with highlight styling regardless.

import type { MarkdownPostProcessorContext } from "obsidian";
import { AUTHOR_RE, authorHueIndex } from "./authors";

export interface ReadingOptions {
  /** How to render suggestions: accepted form (publish preview) or raw markup. */
  suggestions: "accepted" | "raw";
}

const COMBINED_RE = /\{>>([\s\S]*?)<<\}|\{\+\+([\s\S]*?)\+\+\}|\{--([\s\S]*?)--\}|\{~~([\s\S]*?)~>([\s\S]*?)~~\}|\{==([\s\S]*?)==\}/g;

function isInsideCode(node: Node): boolean {
  let cur: Node | null = node.parentNode;
  while (cur) {
    if (cur.nodeType === Node.ELEMENT_NODE) {
      const tag = (cur as Element).tagName;
      if (tag === "CODE" || tag === "PRE") return true;
    }
    cur = cur.parentNode;
  }
  return false;
}

export function makeReadingPostProcessor(getOpts: () => ReadingOptions) {
  return function processor(el: HTMLElement, _ctx: MarkdownPostProcessorContext) {
    const opts = getOpts();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const textNodes: Text[] = [];
    let node = walker.nextNode();
    while (node) {
      if (node.nodeValue && !isInsideCode(node) && COMBINED_RE.test(node.nodeValue)) {
        textNodes.push(node as Text);
      }
      COMBINED_RE.lastIndex = 0;
      node = walker.nextNode();
    }
    for (const t of textNodes) replaceInTextNode(t, opts);
  };
}

function replaceInTextNode(text: Text, opts: ReadingOptions): void {
  const src = text.nodeValue ?? "";
  COMBINED_RE.lastIndex = 0;
  const frag = document.createDocumentFragment();
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMBINED_RE.exec(src)) !== null) {
    if (m.index > lastIndex) {
      frag.appendChild(document.createTextNode(src.slice(lastIndex, m.index)));
    }
    const replacement = renderMatch(m, opts);
    frag.appendChild(replacement);
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < src.length) {
    frag.appendChild(document.createTextNode(src.slice(lastIndex)));
  }
  text.replaceWith(frag);
}

function renderMatch(m: RegExpExecArray, opts: ReadingOptions): Node {
  const [full, comment, addition, deletion, subOld, subNew, highlight] = m;

  if (comment !== undefined) {
    const authorMatch = comment.match(AUTHOR_RE);
    const authorName = authorMatch ? authorMatch[1] : null;
    const body = authorMatch ? comment.slice(authorMatch[0].length) : comment;
    const span = document.createElement("span");
    span.className = `tc-rm-comment tc-rm-comment-${authorName ? "named" : "you"}`;
    if (authorName) {
      span.setAttribute("data-author-hue", String(authorHueIndex(authorName)));
    }
    span.setAttribute("aria-label", "Comment (switch to edit mode to review)");
    span.title = authorName ? `${authorName}: ${body}` : body;
    span.textContent = authorName ? "ⓘ" : "💬";
    return span;
  }
  if (addition !== undefined) {
    if (opts.suggestions === "accepted") {
      return document.createTextNode(addition);
    }
    const span = document.createElement("span");
    span.className = "tc-rm-addition";
    span.textContent = addition;
    return span;
  }
  if (deletion !== undefined) {
    if (opts.suggestions === "accepted") {
      return document.createTextNode("");
    }
    const span = document.createElement("span");
    span.className = "tc-rm-deletion";
    span.textContent = deletion;
    return span;
  }
  if (subOld !== undefined && subNew !== undefined) {
    if (opts.suggestions === "accepted") {
      return document.createTextNode(subNew);
    }
    const wrap = document.createElement("span");
    wrap.className = "tc-rm-substitution";
    const o = document.createElement("span");
    o.className = "tc-rm-deletion";
    o.textContent = subOld;
    const n = document.createElement("span");
    n.className = "tc-rm-addition";
    n.textContent = subNew;
    wrap.appendChild(o);
    wrap.appendChild(document.createTextNode(" → "));
    wrap.appendChild(n);
    return wrap;
  }
  if (highlight !== undefined) {
    const span = document.createElement("span");
    span.className = "tc-rm-highlight";
    span.textContent = highlight;
    return span;
  }
  return document.createTextNode(full);
}
