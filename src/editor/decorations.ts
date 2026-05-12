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
// The decorations are recomputed in `update()` when the document or
// selection changes.

import { EditorView, ViewPlugin, Decoration, DecorationSet, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type { ViewUpdate, PluginValue } from "@codemirror/view";

import { parse, type CriticNode, type CommentNode, type Thread } from "../parser";

export interface DecorationCallbacks {
  /** User clicked the inline rendering for the markup at this source offset. */
  onClick: (sourceOffset: number) => void;
  /** Configured AI-author prefix; passed through to parse() so author detection is consistent. */
  getAiPrefix: () => string;
}

class ThreadChipWidget extends WidgetType {
  constructor(
    readonly index: number,
    readonly count: number,
    readonly author: "ai" | "human",
    readonly label: string,
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
      other.author === this.author &&
      other.label === this.label &&
      other.offset === this.offset &&
      other.tooltip === this.tooltip
    );
  }

  toDOM(): HTMLElement {
    const chip = document.createElement("span");
    chip.className = `kcm-chip kcm-chip-${this.author}`;
    chip.setAttr("role", "button");
    chip.setAttr("aria-label", `Open comment #${this.index} in panel`);
    chip.setAttr("title", this.tooltip);

    const icon = chip.createSpan({ cls: "kcm-chip-icon" });
    icon.setText(this.author === "ai" ? this.label : "💬");

    chip.createSpan({ cls: "kcm-chip-num", text: `#${this.index}` });

    if (this.count > 1) {
      chip.createSpan({ cls: "kcm-chip-badge", text: String(this.count) });
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

function threadTooltip(thread: Thread, nodes: CriticNode[], aiPrefix: string): string {
  const ids = [thread.rootIndex, ...thread.replyIndexes];
  return ids
    .map((i) => nodes[i] as CommentNode)
    .map((c) => `${c.author === "ai" ? aiPrefix : "You"}: ${c.text.trim()}`)
    .join("\n\n");
}

function rangeTouchesSelection(view: EditorView, from: number, to: number): boolean {
  for (const range of view.state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

function buildDecorations(view: EditorView, callbacks: DecorationCallbacks): DecorationSet {
  const source = view.state.doc.toString();
  const aiPrefix = callbacks.getAiPrefix();
  const parsed = parse(source, { aiPrefix });
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
      if (rangeTouchesSelection(view, t.from, t.to)) continue;
      const root = parsed.nodes[t.rootIndex] as CommentNode;
      const count = 1 + t.replyIndexes.length;
      const widget = new ThreadChipWidget(
        threadIndex,
        count,
        root.author,
        aiPrefix,
        t.from,
        threadTooltip(t, parsed.nodes, aiPrefix),
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
    if (rangeTouchesSelection(view, n.from, n.to)) continue;

    if (n.kind === "addition") {
      const innerFrom = n.from + 3; // length of "{++"
      const innerTo = n.to - 3; // length of "++}"
      // Hide wrappers
      builder.add(n.from, innerFrom, hiddenDecoration());
      builder.add(
        innerFrom,
        innerTo,
        Decoration.mark({
          class: "kcm-addition",
          attributes: { "data-kcm-offset": String(n.from) },
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
          class: "kcm-deletion",
          attributes: { "data-kcm-offset": String(n.from) },
        }),
      );
      builder.add(innerTo, n.to, hiddenDecoration());
    } else if (n.kind === "substitution") {
      // {~~old~>new~~}
      const openLen = 3; // "{~~"
      const closeLen = 3; // "~~}"
      const oldFrom = n.from + openLen;
      const oldTo = oldFrom + n.oldText.length;
      const sepFrom = oldTo;
      const sepTo = sepFrom + 2; // "~>"
      const newFrom = sepTo;
      const newTo = newFrom + n.newText.length;
      const closeFrom = n.to - closeLen;

      builder.add(n.from, oldFrom, hiddenDecoration());
      builder.add(
        oldFrom,
        oldTo,
        Decoration.mark({
          class: "kcm-sub-old",
          attributes: { "data-kcm-offset": String(n.from) },
        }),
      );
      builder.add(sepFrom, sepTo, hiddenDecoration());
      builder.add(
        newFrom,
        newTo,
        Decoration.mark({
          class: "kcm-sub-new",
          attributes: { "data-kcm-offset": String(n.from) },
        }),
      );
      builder.add(closeFrom, n.to, hiddenDecoration());
    } else if (n.kind === "highlight") {
      const innerFrom = n.from + 3;
      const innerTo = n.to - 3;
      builder.add(n.from, innerFrom, hiddenDecoration());
      builder.add(innerFrom, innerTo, Decoration.mark({ class: "kcm-highlight" }));
      builder.add(innerTo, n.to, hiddenDecoration());
    }
  }

  return builder.finish();
}

function hiddenDecoration(): Decoration {
  return Decoration.replace({});
}

export function criticDecorationsExtension(callbacks: DecorationCallbacks) {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, callbacks);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet) {
          this.decorations = buildDecorations(update.view, callbacks);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(event, _view) {
          const target = event.target as HTMLElement | null;
          if (!target) return false;
          const offsetAttr = target.closest("[data-kcm-offset]")?.getAttribute("data-kcm-offset");
          if (offsetAttr != null) {
            const offset = Number(offsetAttr);
            if (!Number.isNaN(offset)) {
              event.preventDefault();
              event.stopPropagation();
              callbacks.onClick(offset);
              return true;
            }
          }
          return false;
        },
      },
    },
  );
}
