// Decorations live in a StateField, not a ViewPlugin: replace decorations
// that span line breaks are rejected when the facet value is a function
// (the ViewPlugin form). A multi-line `{>>…<<}` would throw a RangeError
// inside CM6's view build and break the editor.

import { EditorView, Decoration, DecorationSet, WidgetType } from "@codemirror/view";
import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { editorLivePreviewField } from "obsidian";

import { parse, type CriticNode, type CommentNode, type Thread } from "../parser";
import { authorHueIndex } from "../authors";

export interface DecorationCallbacks {
  onOpenPanel: (sourceOffset: number) => void;
  shouldOpenPanel: (event: MouseEvent) => boolean;
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
    chip.setAttr("data-tc-offset", String(this.offset));
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

    // Chips always open the panel — no underlying prose for a cursor.
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

class SubArrowWidget extends WidgetType {
  constructor(
    readonly offset: number,
    readonly onClick: (offset: number) => void,
  ) {
    super();
  }

  eq(other: SubArrowWidget): boolean {
    return other.offset === this.offset;
  }

  toDOM(): HTMLElement {
    const span = activeDocument.createElement("span");
    span.className = "tc-sub-arrow";
    span.setText(" → ");
    span.setAttr("data-tc-offset", String(this.offset));
    span.setAttr("role", "button");
    span.setAttr("aria-label", "Open substitution in panel");
    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onClick(this.offset);
    });
    return span;
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
  if (!state.field(editorLivePreviewField, false)) return Decoration.none;

  const source = state.doc.toString();
  const parsed = parse(source);
  const builder = new RangeSetBuilder<Decoration>();

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
        callbacks.onOpenPanel,
      );
      builder.add(
        t.from,
        t.to,
        Decoration.replace({ widget, inclusive: false }),
      );
      continue;
    }

    const n = item.node;

    if (n.kind === "addition") {
      const innerFrom = n.from + 3;
      const innerTo = n.to - 3;
      const inRange = rangeTouchesSelection(state, n.from, n.to);
      if (!inRange) builder.add(n.from, innerFrom, hiddenDecoration());
      builder.add(
        innerFrom,
        innerTo,
        Decoration.mark({
          class: "tc-addition",
          attributes: { "data-tc-offset": String(n.from) },
        }),
      );
      if (!inRange) builder.add(innerTo, n.to, hiddenDecoration());
    } else if (n.kind === "deletion") {
      const innerFrom = n.from + 3;
      const innerTo = n.to - 3;
      const inRange = rangeTouchesSelection(state, n.from, n.to);
      if (!inRange) builder.add(n.from, innerFrom, hiddenDecoration());
      builder.add(
        innerFrom,
        innerTo,
        Decoration.mark({
          class: "tc-deletion",
          attributes: { "data-tc-offset": String(n.from) },
        }),
      );
      if (!inRange) builder.add(innerTo, n.to, hiddenDecoration());
    } else if (n.kind === "substitution") {
      const oldFrom = n.from + 3;
      const oldTo = oldFrom + n.oldText.length;
      const newFrom = oldTo + 2;
      const newTo = n.to - 3;
      const inRange = rangeTouchesSelection(state, n.from, n.to);
      if (!inRange) {
        builder.add(n.from, oldFrom, hiddenDecoration());
        builder.add(
          oldFrom,
          oldTo,
          Decoration.mark({
            class: "tc-sub-old",
            attributes: { "data-tc-offset": String(n.from) },
          }),
        );
        builder.add(
          oldTo,
          newFrom,
          Decoration.replace({
            widget: new SubArrowWidget(n.from, callbacks.onOpenPanel),
            inclusive: false,
          }),
        );
        builder.add(
          newFrom,
          newTo,
          Decoration.mark({
            class: "tc-sub-new",
            attributes: { "data-tc-offset": String(n.from) },
          }),
        );
        builder.add(newTo, n.to, hiddenDecoration());
      } else {
        builder.add(
          oldFrom,
          oldTo,
          Decoration.mark({
            class: "tc-sub-raw-old",
            attributes: { "data-tc-offset": String(n.from) },
          }),
        );
        builder.add(
          newFrom,
          newTo,
          Decoration.mark({
            class: "tc-sub-raw-new",
            attributes: { "data-tc-offset": String(n.from) },
          }),
        );
      }
    } else if (n.kind === "highlight") {
      const innerFrom = n.from + 3;
      const innerTo = n.to - 3;
      const inRange = rangeTouchesSelection(state, n.from, n.to);
      if (!inRange) builder.add(n.from, innerFrom, hiddenDecoration());
      builder.add(
        innerFrom,
        innerTo,
        Decoration.mark({
          attributes: { "data-tc-offset": String(n.from) },
        }),
      );
      if (!inRange) builder.add(innerTo, n.to, hiddenDecoration());
    }
  }

  return builder.finish();
}

function hiddenDecoration(): Decoration {
  return Decoration.replace({});
}

export function criticDecorationsExtension(callbacks: DecorationCallbacks): Extension {
  // Mirror Obsidian's `livePreviewState.mousedown` gate: while a pointer drag is
  // in progress, skip rebuilding decorations on selection changes. Obsidian's
  // own `==` / `~~` formatting-marker hides do the same, so this keeps our
  // wrapper hide in sync with theirs — both drop on the mouseup transaction
  // Obsidian dispatches once the drag settles, in the same frame.
  const dragState = { mousedown: false };

  const dragTracker = EditorView.domEventHandlers({
    mousedown(event) {
      if (event.button !== 0) return false;
      dragState.mousedown = true;
      const doc = (event.view ?? window).document;
      const handler = (e: MouseEvent): void => {
        if (e.button !== 0) return;
        doc.removeEventListener("mouseup", handler);
        dragState.mousedown = false;
      };
      doc.addEventListener("mouseup", handler);
      return false;
    },
  });

  const field = StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state, callbacks);
    },
    update(deco, tr) {
      if (tr.docChanged) return buildDecorations(tr.state, callbacks);
      const wasLP = tr.startState.field(editorLivePreviewField, false);
      const isLP = tr.state.field(editorLivePreviewField, false);
      if (wasLP !== isLP) return buildDecorations(tr.state, callbacks);
      if (!tr.selection) return deco;
      // During an active mouse drag, defer the rebuild. Obsidian dispatches a
      // mouseup transaction (with selection set) once the drag ends; that
      // transaction will land here with `dragState.mousedown === false` and
      // drive a single combined rebuild.
      if (dragState.mousedown) return deco;
      return buildDecorations(tr.state, callbacks);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  const clickHandler = EditorView.domEventHandlers({
    mousedown(event) {
      const target = event.target as HTMLElement | null;
      if (!target) return false;
      const panelEl = target.closest("[data-tc-offset]") as HTMLElement | null;
      if (!panelEl) return false;
      const panelOffset = Number(panelEl.getAttribute("data-tc-offset"));
      if (Number.isNaN(panelOffset)) return false;
      if (callbacks.shouldOpenPanel(event)) {
        event.preventDefault();
        event.stopPropagation();
        callbacks.onOpenPanel(panelOffset);
        return true;
      }
      return false;
    },
  });

  return [field, dragTracker, clickHandler];
}
