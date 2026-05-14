// CodeMirror 6 inline rendering for CriticMarkup.
//
// Behaviour:
//   - Comment threads become a single chip (Decoration.replace) showing the
//     thread number (matches the side panel) and a message count badge.
//     Hovering shows the full text of the thread; clicking opens the panel.
//   - Additions/deletions/substitutions: wrapper syntax is hidden (replace
//     empty) and the inner content gets a class (mark). Substitutions show
//     old (strike) followed by new (underline).
//   - When the cursor / selection touches a markup range, we leave it raw so
//     the user can edit it directly. (Standard Obsidian live-preview trick.)
//
// Decorations are supplied through a StateField rather than a ViewPlugin so
// that replace decorations are allowed to cover line breaks. CM6 forbids
// line-break-spanning replaces when the facet value is a function (the form a
// ViewPlugin produces); a StateField resolves to a DecorationSet directly, so
// the restriction doesn't apply. Without this a multi-line `{>>…<<}` (e.g. an
// LLM-authored comment containing a numbered list) would throw a RangeError
// inside CM6's view build and break the editor.

import { EditorView, Decoration, DecorationSet, WidgetType } from "@codemirror/view";
import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";

import { parse, type CriticNode, type CommentNode, type Thread } from "../parser";
import { authorHueIndex } from "../authors";

export interface DecorationCallbacks {
  /** User clicked the inline rendering for the markup at this source offset. */
  onClick: (sourceOffset: number) => void;
}

class ThreadChipWidget extends WidgetType {
  constructor(
    readonly index: number,
    readonly count: number,
    readonly authorName: string | null,
    readonly offset: number,
    readonly tooltip: string,
    readonly onClick: (offset: number) => void,
  ) {
    super();
  }

  eq(other: ThreadChipWidget): boolean {
    return (
      other.index === this.index &&
      other.count === this.count &&
      other.authorName === this.authorName &&
      other.offset === this.offset &&
      other.tooltip === this.tooltip
    );
  }

  toDOM(): HTMLElement {
    const chip = activeDocument.createElement("span");
    chip.className = `tc-chip tc-chip-${this.authorName ? "named" : "you"}`;
    if (this.authorName) {
      chip.setAttr("data-author-hue", String(authorHueIndex(this.authorName)));
    }
    chip.setAttr("role", "button");
    chip.setAttr("aria-label", `Open comment #${this.index} in panel`);
    chip.setAttr("title", this.tooltip);

    const icon = chip.createSpan({ cls: "tc-chip-icon" });
    if (this.authorName) {
      const label = this.authorName.length > 12 ? this.authorName.slice(0, 11) + "…" : this.authorName;
      icon.setText(label);
    } else {
      icon.setText("💬");
    }

    chip.createSpan({ cls: "tc-chip-num", text: `#${this.index}` });

    if (this.count > 1) {
      chip.createSpan({ cls: "tc-chip-badge", text: String(this.count) });
    }

    chip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onClick(this.offset);
    });
    return chip;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class SubstitutionWidget extends WidgetType {
  constructor(
    readonly oldText: string,
    readonly newText: string,
    readonly offset: number,
  ) {
    super();
  }

  eq(other: SubstitutionWidget): boolean {
    return (
      other.oldText === this.oldText &&
      other.newText === this.newText &&
      other.offset === this.offset
    );
  }

  toDOM(): HTMLElement {
    const wrap = activeDocument.createElement("span");
    wrap.className = "tc-substitution-widget";
    wrap.setAttr("data-tc-offset", String(this.offset));

    wrap.createSpan({ cls: "tc-sub-old", text: this.oldText });
    wrap.createSpan({ cls: "tc-sub-arrow", text: " → " });
    wrap.createSpan({ cls: "tc-sub-new", text: this.newText });
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function threadTooltip(thread: Thread, nodes: CriticNode[]): string {
  const ids = [thread.rootIndex, ...thread.replyIndexes];
  return ids
    .map((i) => nodes[i] as CommentNode)
    .map((c) => `${c.authorName ?? "You"}: ${c.text.trim()}`)
    .join("\n\n");
}

function rangeTouchesSelection(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

function buildDecorations(state: EditorState, callbacks: DecorationCallbacks): DecorationSet {
  const source = state.doc.toString();
  const parsed = parse(source);
  const builder = new RangeSetBuilder<Decoration>();

  // Walk threads in order, but we also need to emit decorations for non-comment
  // nodes interleaved. Build a sequence of "things to decorate" sorted by from.
  type Item =
    | { kind: "thread"; thread: Thread }
    | { kind: "node"; node: CriticNode };

  const items: Item[] = [];
  const threadOfNode = parsed.nodeThread;
  const consumedThreads = new Set<number>();
  for (let i = 0; i < parsed.nodes.length; i++) {
    const n = parsed.nodes[i];
    if (n.kind === "comment") {
      const t = threadOfNode[i];
      if (consumedThreads.has(t)) continue;
      consumedThreads.add(t);
      items.push({ kind: "thread", thread: parsed.threads[t] });
    } else {
      items.push({ kind: "node", node: n });
    }
  }
  items.sort((a, b) => {
    const af = a.kind === "thread" ? a.thread.from : a.node.from;
    const bf = b.kind === "thread" ? b.thread.from : b.node.from;
    return af - bf;
  });

  let threadIndex = 0;
  for (const item of items) {
    if (item.kind === "thread") {
      const t = item.thread;
      threadIndex++;
      if (rangeTouchesSelection(state, t.from, t.to)) continue;
      const root = parsed.nodes[t.rootIndex] as CommentNode;
      const count = 1 + t.replyIndexes.length;
      const widget = new ThreadChipWidget(
        threadIndex,
        count,
        root.authorName,
        t.from,
        threadTooltip(t, parsed.nodes),
        callbacks.onClick,
      );
      builder.add(
        t.from,
        t.to,
        Decoration.replace({ widget, inclusive: false }),
      );
      continue;
    }

    const n = item.node;
    if (rangeTouchesSelection(state, n.from, n.to)) continue;

    if (n.kind === "addition") {
      const innerFrom = n.from + 3; // length of "{++"
      const innerTo = n.to - 3; // length of "++}"
      builder.add(n.from, innerFrom, hiddenDecoration());
      builder.add(
        innerFrom,
        innerTo,
        Decoration.mark({
          class: "tc-addition",
          attributes: { "data-tc-offset": String(n.from) },
        }),
      );
      builder.add(innerTo, n.to, hiddenDecoration());
    } else if (n.kind === "deletion") {
      const innerFrom = n.from + 3;
      const innerTo = n.to - 3;
      builder.add(n.from, innerFrom, hiddenDecoration());
      builder.add(
        innerFrom,
        innerTo,
        Decoration.mark({
          class: "tc-deletion",
          attributes: { "data-tc-offset": String(n.from) },
        }),
      );
      builder.add(innerTo, n.to, hiddenDecoration());
    } else if (n.kind === "substitution") {
      builder.add(
        n.from,
        n.to,
        Decoration.replace({
          widget: new SubstitutionWidget(n.oldText, n.newText, n.from),
          inclusive: false,
        }),
      );
    } else if (n.kind === "highlight") {
      const innerFrom = n.from + 3;
      const innerTo = n.to - 3;
      builder.add(n.from, innerFrom, hiddenDecoration());
      builder.add(innerFrom, innerTo, Decoration.mark({ class: "tc-highlight" }));
      builder.add(innerTo, n.to, hiddenDecoration());
    }
  }

  return builder.finish();
}

function hiddenDecoration(): Decoration {
  return Decoration.replace({});
}

export function criticDecorationsExtension(callbacks: DecorationCallbacks): Extension {
  const field = StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state, callbacks);
    },
    update(deco, tr) {
      // Recompute when the doc or selection actually changed — matches the
      // gate the old ViewPlugin used, avoids rebuilding on every keystroke
      // that doesn't move the cursor or alter the doc.
      if (!tr.docChanged && !tr.selection) return deco;
      return buildDecorations(tr.state, callbacks);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  const clickHandler = EditorView.domEventHandlers({
    mousedown(event) {
      const target = event.target as HTMLElement | null;
      if (!target) return false;
      const offsetAttr = target.closest("[data-tc-offset]")?.getAttribute("data-tc-offset");
      if (offsetAttr == null) return false;
      const offset = Number(offsetAttr);
      if (Number.isNaN(offset)) return false;
      event.preventDefault();
      event.stopPropagation();
      callbacks.onClick(offset);
      return true;
    },
  });

  return [field, clickHandler];
}
