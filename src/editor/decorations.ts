// Decorations live in a StateField, not a ViewPlugin: replace decorations
// that span line breaks are rejected when the facet value is a function
// (the ViewPlugin form). A multi-line `{>>…<<}` would throw a RangeError
// inside CM6's view build and break the editor.

import { EditorView, Decoration, DecorationSet, WidgetType } from "@codemirror/view";
import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { editorLivePreviewField } from "obsidian";

import { parse, type CriticNode, type CommentNode, type Thread } from "../parser";
import { authorHueIndex } from "../authors";
import { diffChars } from "../diff";

export interface DecorationCallbacks {
  onOpenPanel: (sourceOffset: number) => void;
  shouldOpenPanel: (event: MouseEvent) => boolean;
  /** Whether to highlight the changed characters inside a substitution. */
  highlightChangedChars: () => boolean;
  /**
   * The local user's display name (settings `localAuthorName`). Used as the
   * author fallback when a mark carries no `author=` prefix and (for comments)
   * no legacy `<Name>:`. Empty / unset falls through to the "You" sentinel.
   */
  localAuthorName?: () => string;
}

/**
 * Resolve the display author for a node per the precedence chain (§5.2):
 * metaAuthor → legacy authorName (comments only) → localAuthorName → "You".
 * Returns the resolved label plus the underlying named author (null when it
 * falls through to "You") so callers can decide whether to apply a hue.
 */
function resolveAuthor(
  node: CriticNode,
  localAuthorName: string,
): { label: string; named: string | null } {
  const legacy = node.kind === "comment" ? node.authorName : null;
  const local = localAuthorName.trim();
  const named = node.metaAuthor ?? legacy ?? (local !== "" ? local : null);
  return { label: named ?? "You", named };
}

/** Tooltip text for a marked span: "author · date" (date omitted if absent). */
function metaLabel(node: CriticNode, localAuthorName: string): string {
  const { label } = resolveAuthor(node, localAuthorName);
  return node.metaDate ? `${label} · ${node.metaDate}` : label;
}

/** Build the shared `attributes` object for a marked span. */
function markAttrs(node: CriticNode, localAuthorName: string): Record<string, string> {
  const attrs: Record<string, string> = {
    "data-tc-offset": String(node.from),
    title: metaLabel(node, localAuthorName),
  };
  const { named } = resolveAuthor(node, localAuthorName);
  if (named) attrs["data-author-hue"] = String(authorHueIndex(named));
  return attrs;
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
  const source = state.doc.toString();
  const parsed = parse(source);
  const builder = new RangeSetBuilder<Decoration>();
  const localAuthor = callbacks.localAuthorName ? callbacks.localAuthorName() : "";

  if (!state.field(editorLivePreviewField, false)) {
    // Source Mode: keep raw markup visible, but tint comments (per author) so
    // they stand out from prose, and mark substitution halves so the strike-
    // suppression CSS applies — otherwise Obsidian's `~~…~~` rendering draws
    // a line across `new` too, hiding what's being added.
    for (const n of parsed.nodes) {
      const hue = resolveAuthor(n, localAuthor).named;
      const tip = metaLabel(n, localAuthor);
      const authorAttrs = (extra: Record<string, string> = {}): Record<string, string> => {
        const a: Record<string, string> = { title: tip, ...extra };
        if (hue) a["data-author-hue"] = String(authorHueIndex(hue));
        return a;
      };
      if (n.kind === "comment") {
        const cls = n.authorName ? "tc-raw-comment tc-raw-comment-named" : "tc-raw-comment tc-raw-comment-you";
        builder.add(n.from, n.to, Decoration.mark({ class: cls, attributes: authorAttrs() }));
      } else if (n.kind === "addition") {
        builder.add(n.innerFrom, n.innerTo, Decoration.mark({ class: "tc-addition", attributes: authorAttrs() }));
      } else if (n.kind === "deletion") {
        builder.add(n.innerFrom, n.innerTo, Decoration.mark({ class: "tc-deletion", attributes: authorAttrs() }));
      } else if (n.kind === "highlight") {
        builder.add(n.innerFrom, n.innerTo, Decoration.mark({ class: "tc-highlight", attributes: authorAttrs() }));
      } else if (n.kind === "substitution") {
        // innerFrom/innerTo bound the `old` half; `new` runs from after `~>`
        // to just before the closing `~~}` (always 3 chars, prefix-free).
        const oldFrom = n.innerFrom;
        const oldTo = n.innerTo;
        const newFrom = oldTo + 2;
        const newTo = n.to - 3;
        builder.add(oldFrom, oldTo, Decoration.mark({ class: "tc-sub-raw-old", attributes: authorAttrs() }));
        builder.add(newFrom, newTo, Decoration.mark({ class: "tc-sub-raw-new", attributes: authorAttrs() }));
      }
    }
    return builder.finish();
  }

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
      const innerFrom = n.innerFrom;
      const innerTo = n.innerTo;
      const inRange = rangeTouchesSelection(state, n.from, n.to);
      // Hide `{<prefix>++` up to the body — covers the prefix for free.
      if (!inRange) builder.add(n.from, innerFrom, hiddenDecoration());
      builder.add(
        innerFrom,
        innerTo,
        Decoration.mark({
          class: "tc-addition",
          attributes: markAttrs(n, localAuthor),
        }),
      );
      if (!inRange) builder.add(innerTo, n.to, hiddenDecoration());
    } else if (n.kind === "deletion") {
      const innerFrom = n.innerFrom;
      const innerTo = n.innerTo;
      const inRange = rangeTouchesSelection(state, n.from, n.to);
      if (!inRange) builder.add(n.from, innerFrom, hiddenDecoration());
      builder.add(
        innerFrom,
        innerTo,
        Decoration.mark({
          class: "tc-deletion",
          attributes: markAttrs(n, localAuthor),
        }),
      );
      if (!inRange) builder.add(innerTo, n.to, hiddenDecoration());
    } else if (n.kind === "substitution") {
      // innerFrom/innerTo bound the `old` half; `new` runs from after `~>`
      // to just before the closing `~~}` (always 3 chars, prefix-free).
      const oldFrom = n.innerFrom;
      const oldTo = n.innerTo;
      const newFrom = oldTo + 2;
      const newTo = n.to - 3;
      const inRange = rangeTouchesSelection(state, n.from, n.to);
      if (!inRange) {
        const charRuns = callbacks.highlightChangedChars()
          ? diffChars(n.oldText, n.newText)
          : null;
        // Hide `{<prefix>~~` (the prefix + open sigil) before `old`.
        builder.add(n.from, oldFrom, hiddenDecoration());
        builder.add(
          oldFrom,
          oldTo,
          Decoration.mark({
            class: "tc-sub-old",
            attributes: markAttrs(n, localAuthor),
          }),
        );
        if (charRuns) {
          let oldRunOffset = 0;
          for (const run of charRuns.oldRuns) {
            if (run.changed) {
              builder.add(
                oldFrom + oldRunOffset,
                oldFrom + oldRunOffset + run.text.length,
                Decoration.mark({
                  class: "tc-sub-old-changed",
                  attributes: { "data-tc-offset": String(n.from) },
                }),
              );
            }
            oldRunOffset += run.text.length;
          }
        }
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
            attributes: markAttrs(n, localAuthor),
          }),
        );
        if (charRuns) {
          let newRunOffset = 0;
          for (const run of charRuns.newRuns) {
            if (run.changed) {
              builder.add(
                newFrom + newRunOffset,
                newFrom + newRunOffset + run.text.length,
                Decoration.mark({
                  class: "tc-sub-new-changed",
                  attributes: { "data-tc-offset": String(n.from) },
                }),
              );
            }
            newRunOffset += run.text.length;
          }
        }
        builder.add(newTo, n.to, hiddenDecoration());
      } else {
        builder.add(
          oldFrom,
          oldTo,
          Decoration.mark({
            class: "tc-sub-raw-old",
            attributes: markAttrs(n, localAuthor),
          }),
        );
        builder.add(
          newFrom,
          newTo,
          Decoration.mark({
            class: "tc-sub-raw-new",
            attributes: markAttrs(n, localAuthor),
          }),
        );
      }
    } else if (n.kind === "highlight") {
      const innerFrom = n.innerFrom;
      const innerTo = n.innerTo;
      const inRange = rangeTouchesSelection(state, n.from, n.to);
      if (!inRange) builder.add(n.from, innerFrom, hiddenDecoration());
      builder.add(
        innerFrom,
        innerTo,
        Decoration.mark({
          class: "tc-highlight",
          attributes: markAttrs(n, localAuthor),
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
      // Source Mode decorations don't depend on the selection.
      if (!isLP) return deco;
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
      const panelEl = target.closest("[data-tc-offset]");
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
