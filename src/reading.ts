// Reading-mode markdown post-processor.
//
// Reading mode is the rendered HTML view. We walk text nodes, find any
// CriticMarkup syntax, and replace it with appropriate inline elements:
//   - Comments: tiny icon (clicking does nothing for now — user can switch
//     to editing mode to open the panel).
//   - Additions: depending on settings, show accepted form (the inserted
//     text, plain) or the markup styled.
//   - Deletions: hidden (accepted), or styled strikethrough (raw).
//   - Substitutions: show the new text (accepted), or both sides (raw).
//   - Highlights: render content with highlight styling regardless.

import type { MarkdownPostProcessorContext } from "obsidian";

export interface ReadingOptions {
  /** How to render suggestions: as their accepted form (publish preview) or raw markup. */
  suggestions: "accepted" | "raw";
  /** AI-author prefix; comments starting with `<prefix>:` render with the AI style. Case-insensitive. */
  aiPrefix: string;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
      // Reset regex state — `test` is stateful with the `g` flag.
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
    const prefixRe = new RegExp(`^\\s*${escapeForRegex(opts.aiPrefix)}\\s*:\\s*`, "i");
    const isAi = prefixRe.test(comment);
    const span = document.createElement("span");
    span.className = `kcm-rm-comment kcm-rm-comment-${isAi ? "ai" : "human"}`;
    span.setAttribute("aria-label", "Comment (switch to edit mode to review)");
    span.title = comment.replace(prefixRe, "");
    span.textContent = isAi ? "ⓘ" : "💬";
    return span;
  }
  if (addition !== undefined) {
    if (opts.suggestions === "accepted") {
      return document.createTextNode(addition);
    }
    const span = document.createElement("span");
    span.className = "kcm-rm-addition";
    span.textContent = addition;
    return span;
  }
  if (deletion !== undefined) {
    if (opts.suggestions === "accepted") {
      return document.createTextNode("");
    }
    const span = document.createElement("span");
    span.className = "kcm-rm-deletion";
    span.textContent = deletion;
    return span;
  }
  if (subOld !== undefined && subNew !== undefined) {
    if (opts.suggestions === "accepted") {
      return document.createTextNode(subNew);
    }
    const wrap = document.createElement("span");
    wrap.className = "kcm-rm-substitution";
    const o = document.createElement("span");
    o.className = "kcm-rm-deletion";
    o.textContent = subOld;
    const n = document.createElement("span");
    n.className = "kcm-rm-addition";
    n.textContent = subNew;
    wrap.appendChild(o);
    wrap.appendChild(document.createTextNode(" → "));
    wrap.appendChild(n);
    return wrap;
  }
  if (highlight !== undefined) {
    const span = document.createElement("span");
    span.className = "kcm-rm-highlight";
    span.textContent = highlight;
    return span;
  }
  // Fallback: leave as-is.
  return document.createTextNode(full);
}
