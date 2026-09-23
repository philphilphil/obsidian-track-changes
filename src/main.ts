import {
  Plugin,
  MarkdownView,
  WorkspaceLeaf,
  TFile,
  Notice,
  Editor,
  Menu,
  MenuItem,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

import { criticDecorationsExtension } from "./editor/decorations";
import { REVIEW_VIEW_TYPE, ReviewPanelView, type PanelHost } from "./panel/view";
import {
  applyEdits,
  rebaseEdits,
  buildAttributionPrefix,
  findChangeAt,
  acceptChange,
  rejectChange,
  type ChangeNode,
  type SourceEdit,
} from "./operations";
import { parse } from "./parser";
import { makeReadingPostProcessor } from "./reading";
import { FinalizeModal } from "./finalize";
import { buildMark, checkGuards, type AuthoringKind } from "./authoring";
import {
  DEFAULT_SETTINGS,
  TrackChangesCriticMarkupSettingsTab,
  type TrackChangesCriticMarkupSettings,
} from "./settings";

const AUTHORING_COMMANDS: ReadonlyArray<{
  id: string;
  name: string;
  kind: AuthoringKind;
  icon: string;
}> = [
  { id: "insert-addition", name: "Insert addition", kind: "addition", icon: "plus" },
  { id: "mark-deletion", name: "Mark selection as deletion", kind: "deletion", icon: "minus" },
  { id: "mark-substitution", name: "Mark selection for substitution", kind: "substitution", icon: "pencil" },
  { id: "mark-highlight", name: "Highlight selection", kind: "highlight", icon: "highlighter" },
  { id: "insert-comment", name: "Insert comment", kind: "comment", icon: "message-square" },
];

export default class TrackChangesCriticMarkupPlugin extends Plugin {
  settings!: TrackChangesCriticMarkupSettings;

  // Mutable so a settings toggle can swap the decoration extension and force a
  // rebuild via workspace.updateOptions() (the field is otherwise only rebuilt
  // on doc changes).
  private editorExtensions: Extension[] = [];

  async onload(): Promise<void> {
    await this.loadSettings();

    // Right-panel view registration.
    this.registerView(REVIEW_VIEW_TYPE, (leaf) => this.makeReviewView(leaf));

    // CodeMirror 6 inline decorations.
    this.editorExtensions.push(this.makeDecorationExtension());
    this.registerEditorExtension(this.editorExtensions);

    // Reading-mode post-processor.
    this.registerMarkdownPostProcessor(
      makeReadingPostProcessor(() => ({
        showComments: this.settings.readingShowComments,
      })),
    );

    // Commands.
    this.addCommand({
      id: "open-review-panel",
      name: "Open review panel",
      callback: () => this.openReviewPanel(),
    });
    this.addCommand({
      id: "finalize-for-publish",
      name: "Finalize for publish",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.runFinalize(file);
        return true;
      },
    });

    // Manual authoring commands (issue #26). No default hotkeys — users bind
    // their own via the Hotkeys pane.
    for (const c of AUTHORING_COMMANDS) {
      this.addCommand({
        id: c.id,
        name: c.name,
        icon: c.icon,
        // Enabled for any markdown editor regardless of selection state: a
        // hotkey pressed in the wrong state should explain itself through the
        // Notice from insertAuthoredMark, not silently do nothing.
        editorCheckCallback: (checking, editor, view) => {
          if (!(view instanceof MarkdownView) || view.file?.extension !== "md") return false;
          if (!checking) this.insertAuthoredMark(editor, c.kind);
          return true;
        },
      });
    }

    this.addCommand({
      id: "accept-change-at-cursor",
      name: "Accept change at cursor",
      icon: "check",
      editorCheckCallback: (checking, editor, view) => {
        if (!(view instanceof MarkdownView) || view.file?.extension !== "md") return false;
        if (!checking) void this.applyChangeAtCursor(editor, view, "accept");
        return true;
      },
    });
    this.addCommand({
      id: "reject-change-at-cursor",
      name: "Reject change at cursor",
      icon: "x",
      editorCheckCallback: (checking, editor, view) => {
        if (!(view instanceof MarkdownView) || view.file?.extension !== "md") return false;
        if (!checking) void this.applyChangeAtCursor(editor, view, "reject");
        return true;
      },
    });

    // Right-click menu: a "Track changes" submenu with only the actions valid
    // for the current selection state. MenuItem.setSubmenu is not in the
    // public typings but exists at runtime on desktop; flat items otherwise.
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        if (!(view instanceof MarkdownView) || view.file?.extension !== "md") return;
        const hasSelection = editor.somethingSelected();
        const valid = AUTHORING_COMMANDS.filter((c) =>
          c.kind === "comment" ? true : c.kind === "addition" ? !hasSelection : hasSelection,
        );
        const change = this.resolveChangeAtCursor(editor);
        const addItems = (target: Menu): void => {
          if (typeof change !== "string") {
            target.addItem((item) =>
              item
                .setTitle("Accept change")
                .setIcon("check")
                .onClick(() => void this.applyChangeAtCursor(editor, view, "accept")),
            );
            target.addItem((item) =>
              item
                .setTitle("Reject change")
                .setIcon("x")
                .onClick(() => void this.applyChangeAtCursor(editor, view, "reject")),
            );
            target.addSeparator();
          }
          for (const c of valid) {
            target.addItem((item) =>
              item
                .setTitle(c.name)
                .setIcon(c.icon)
                .onClick(() => this.insertAuthoredMark(editor, c.kind)),
            );
          }
        };
        menu.addSeparator();
        const hasSubmenu =
          typeof (MenuItem.prototype as { setSubmenu?: unknown }).setSubmenu === "function";
        if (hasSubmenu) {
          menu.addItem((item) => {
            const submenu = (item as MenuItem & { setSubmenu: () => Menu })
              .setTitle("Track changes")
              .setIcon("message-square")
              .setSubmenu();
            addItems(submenu);
          });
        } else {
          addItems(menu);
        }
      }),
    );

    // Ribbon for quick access.
    this.addRibbonIcon("message-square", "Open CriticMarkup review panel", () =>
      this.openReviewPanel(),
    );

    // Settings tab.
    this.addSettingTab(new TrackChangesCriticMarkupSettingsTab(this.app, this));

    // Open panel automatically after layout is ready, if not already.
    this.app.workspace.onLayoutReady(() => {
      // Don't force-open on first run; user can use the ribbon/command.
    });
  }

  onunload(): void {
    // Leaves of our view type are detached automatically when their root is.
    // (Obsidian guidance: do NOT call detachLeavesOfType in onunload.)
  }

  async loadSettings(): Promise<void> {
    const stored = ((await this.loadData()) ?? {}) as Partial<TrackChangesCriticMarkupSettings>;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      // Coerce the persisted enum so a hand-edited / future-renamed value can't
      // leak an invalid style downstream; anything but "datetime" means "date".
      replyDateStyle: stored.replyDateStyle === "datetime" ? "datetime" : "date",
      finalize: { ...DEFAULT_SETTINGS.finalize, ...(stored.finalize ?? {}) },
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Force open reading-mode previews to re-run post-processors. */
  rerenderReadingViews(): void {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof MarkdownView) view.previewMode?.rerender(true);
    });
  }

  private makeDecorationExtension(): Extension {
    return criticDecorationsExtension({
      onOpenPanel: (offset) => this.handleInlineClick(offset),
      shouldOpenPanel: (event) =>
        this.settings.clickMarksToOpenPanel || event.metaKey || event.ctrlKey,
      highlightChangedChars: () => this.settings.highlightChangedChars,
      localAuthorName: () => this.settings.localAuthorName ?? "",
    });
  }

  /** Repaint the per-character substitution highlight in open editors and the
   * panel after the `highlightChangedChars` setting toggled. */
  refreshCharHighlighting(): void {
    this.editorExtensions.length = 0;
    this.editorExtensions.push(this.makeDecorationExtension());
    this.app.workspace.updateOptions();
    this.getReviewView()?.rebuildCards();
  }

  /**
   * Refresh every render surface after a settings change that affects display
   * (e.g. localAuthorName). Re-runs reading-view post-processors and forces the
   * open review panel to repaint so the "You"-fallback author/hue updates live.
   */
  refreshAfterSettingsChange(): void {
    this.rerenderReadingViews();
    this.getReviewView()?.rebuildCards();
  }

  // ---- host implementation for the panel ----

  private makeReviewView(leaf: WorkspaceLeaf): ReviewPanelView {
    const host: PanelHost = {
      app: this.app,
      getActiveFile: () => {
        const file = this.app.workspace.getActiveFile();
        return file && file.extension === "md" ? file : null;
      },
      getCurrentSource: (file) => {
        const editor = this.findEditorForFile(file);
        if (!editor) return null;
        const cm = (editor as unknown as { cm?: EditorView }).cm;
        return cm ? cm.state.doc.toString() : editor.getValue();
      },
      applyEdits: async (file, edits) => {
        await this.applyEditsToFile(file, edits);
      },
      revealOffset: (file, offset, length, flashChip) =>
        this.revealOffsetInEditor(file, offset, length, flashChip ?? false),
      isFileOpen: (file) => this.findEditorForFile(file) !== null,
      confirmBeforeDelete: () => this.settings.confirmBeforeDelete,
      highlightChangedChars: () => this.settings.highlightChangedChars,
      localAuthorName: () => this.settings.localAuthorName ?? "",
      replyDateStyle: () => this.settings.replyDateStyle,
    };
    return new ReviewPanelView(leaf, host);
  }

  private async openReviewPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("Could not open review panel.");
      return;
    }
    await leaf.setViewState({ type: REVIEW_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private getReviewView(): ReviewPanelView | null {
    const leaves = this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof ReviewPanelView) return leaf.view;
    }
    return null;
  }

  // ---- inline-click handler ----

  private handleInlineClick(offset: number): void {
    void (async () => {
      await this.openReviewPanel();
      const file = this.app.workspace.getActiveFile();
      const view = this.getReviewView();
      if (file && view) view.focusOffset(file, offset);
    })();
  }

  // ---- manual authoring (issue #26) ----

  private insertAuthoredMark(editor: Editor, kind: AuthoringKind): void {
    if (editor.listSelections().length > 1) {
      new Notice("Multiple cursors are not supported; collapse to a single selection.");
      return;
    }
    const from = editor.posToOffset(editor.getCursor("from"));
    const to = editor.posToOffset(editor.getCursor("to"));
    const selection = editor.getSelection();

    const attribution = buildAttributionPrefix(
      this.settings.localAuthorName ?? "",
      this.settings.replyDateStyle,
    );
    const built = buildMark(kind, selection, attribution);
    if (!built.ok) {
      new Notice(built.refusal);
      return;
    }
    const guard = checkGuards(editor.getValue(), from, to, kind);
    if (guard) {
      new Notice(guard);
      return;
    }

    // Insert and place the cursor in ONE dispatch. Done as two steps, Live
    // Preview sees the intermediate state, hides the mark's `~~`/`==` as
    // strikethrough/highlight formatting, and a cursor then set at the start
    // of that hidden token gets pushed past it — into `~~}` instead of the
    // replacement slot.
    const cursor = from + built.cursorOffset;
    const cm = (editor as unknown as { cm?: EditorView }).cm;
    if (cm) {
      cm.dispatch({
        changes: { from, to, insert: built.text },
        selection: { anchor: cursor },
        scrollIntoView: true,
      });
    } else {
      editor.transaction({
        changes: [{ from: editor.offsetToPos(from), to: editor.offsetToPos(to), text: built.text }],
        selection: { from: editor.offsetToPos(cursor) },
      });
    }
  }

  // ---- accept/reject at cursor (issue #44) ----

  /** The suggestion under the cursor, or the Notice text explaining why none. */
  private resolveChangeAtCursor(editor: Editor): ChangeNode | string {
    if (editor.listSelections().length > 1) {
      return "Multiple cursors are not supported; collapse to a single selection.";
    }
    const cm = (editor as unknown as { cm?: EditorView }).cm;
    const source = cm ? cm.state.doc.toString() : editor.getValue();
    const offset = editor.posToOffset(editor.getCursor("head"));
    return findChangeAt(parse(source).nodes, offset) ?? "No change at cursor.";
  }

  private async applyChangeAtCursor(
    editor: Editor,
    view: MarkdownView,
    action: "accept" | "reject",
  ): Promise<void> {
    const node = this.resolveChangeAtCursor(editor);
    if (typeof node === "string") {
      new Notice(node);
      return;
    }
    if (!view.file) return;
    const edit = action === "accept" ? acceptChange(node) : rejectChange(node);
    await this.applyEditsToFile(view.file, [edit], {
      cursorAfter: node.from + edit.insert.length,
    });
  }

  // ---- editor edit application ----

  /**
   * Apply edits to a file. If the file is open in an active editor, route
   * through the editor's CM6 transaction so undo coalesces with the user's
   * normal undo stack. Otherwise fall back to Vault.process for an atomic
   * background-file rewrite.
   */
  private async applyEditsToFile(
    file: TFile,
    edits: SourceEdit[],
    options: ApplyEditsOptions = {},
  ): Promise<boolean> {
    if (edits.length === 0) return true;
    const editor = this.findEditorForFile(file);
    // `editor.cm` is undocumented but stable across Obsidian releases; it
    // exposes the underlying CM6 EditorView so our dispatch coalesces with
    // the user's normal undo stack.
    const cm = editor ? (editor as unknown as { cm?: EditorView }).cm : undefined;
    const currentSource = cm ? cm.state.doc.toString() : editor ? editor.getValue() : null;

    // Rebase against the current doc so stale offsets (from a re-parse the
    // panel did some ms ago, while the user was typing or the AI was editing
    // through another channel) can't corrupt unrelated text.
    if (currentSource !== null) {
      const prepared = this.prepareEdits(currentSource, edits, options);
      if (!prepared.ok) {
        this.showEditFailure(prepared.reason, options);
        return false;
      }
      this.showDroppedEdits(prepared.dropped);

      if (cm) {
        cm.dispatch({
          changes: prepared.edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })),
          selection:
            options.cursorAfter !== undefined ? { anchor: options.cursorAfter } : undefined,
        });
        this.getReviewView()?.refreshFromSource(file, cm.state.doc.toString());
        return true;
      }
      if (editor) {
        const next = applyEdits(currentSource, prepared.edits);
        editor.setValue(next);
        this.getReviewView()?.refreshFromSource(file, next);
        return true;
      }
    }

    let processOk = false;
    let processDropped = edits.length;
    let processReason: EditFailureReason = "moved";
    const next = await this.app.vault.process(file, (latestSource) => {
      const result = this.prepareEdits(latestSource, edits, options);
      if (!result.ok) {
        processOk = false;
        processDropped = result.dropped;
        processReason = result.reason;
        return latestSource;
      }
      const nextSource = applyEdits(latestSource, result.edits);
      processOk = true;
      processDropped = result.dropped;
      return nextSource;
    });
    if (!processOk) {
      this.showEditFailure(processReason, options);
      return false;
    }
    this.showDroppedEdits(processDropped);
    new Notice("Updated file outside the editor undo history.");
    this.getReviewView()?.refreshFromSource(file, next);
    return true;
  }

  private prepareEdits(
    currentSource: string,
    edits: SourceEdit[],
    options: ApplyEditsOptions,
  ): PreparedEdits {
    if (options.expectedSource !== undefined && currentSource !== options.expectedSource) {
      return { ok: false, reason: "stale", dropped: edits.length };
    }

    const { edits: rebased, dropped } = rebaseEdits(currentSource, edits);
    if (rebased.length === 0 || (options.requireAll && dropped > 0)) {
      return { ok: false, reason: "moved", dropped };
    }
    return { ok: true, edits: rebased, dropped };
  }

  private showEditFailure(reason: EditFailureReason, options: ApplyEditsOptions): void {
    if (reason === "stale") {
      new Notice("Edit canceled — the file changed. Reopen the dialog and try again.");
    } else if (options.requireAll) {
      new Notice("Edit canceled — one or more targets moved or changed.");
    } else {
      new Notice("Edit could not be applied — the text moved or was changed.");
    }
  }

  private showDroppedEdits(dropped: number): void {
    if (dropped > 0) {
      new Notice(`Skipped ${dropped} edit(s) — the target text moved or was changed.`);
    }
  }

  private findEditorForFile(file: TFile): Editor | null {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file === file) {
        return view.editor;
      }
    }
    return null;
  }

  // ---- reveal/scroll ----

  private revealOffsetInEditor(
    file: TFile,
    offset: number,
    length: number,
    flashChip: boolean,
  ): void {
    const editor = this.findEditorForFile(file);
    if (!editor) {
      // Open the file in a new leaf if not visible, then reveal.
      void this.app.workspace.openLinkText(file.path, "", false).then(() => {
        const ed = this.findEditorForFile(file);
        if (ed) this.scrollEditor(ed, offset, length, flashChip);
      });
      return;
    }
    this.scrollEditor(editor, offset, length, flashChip);
  }

  private scrollEditor(
    editor: Editor,
    offset: number,
    length: number,
    flashChip: boolean,
  ): void {
    // See applyEditsToFile for the rationale on accessing `editor.cm`.
    // By default we do NOT move the selection: placing the cursor inside a
    // CriticMarkup range causes Live Preview to unrender the decoration and
    // expose the raw `{>>…<<}` syntax. The `revealMarkupOnCommentJump` setting
    // lets users opt into that behavior — useful for those who want to edit
    // the markup source directly after jumping.
    const revealMarkup = flashChip && this.settings.revealMarkupOnCommentJump;
    const cm = (editor as unknown as { cm?: EditorView }).cm;
    if (cm) {
      cm.dispatch({
        selection: revealMarkup ? { anchor: offset, head: offset + length } : undefined,
        effects: EditorView.scrollIntoView(offset, { y: "center" }),
      });
      if (flashChip) this.flashChipAt(cm, offset, length);
      return;
    }
    const from = editor.offsetToPos(offset);
    const to = editor.offsetToPos(offset + length);
    if (revealMarkup) editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, true);
  }

  /**
   * Flash the comment chip inside the revealed range. The range start isn't
   * always the chip itself: an anchored thread reveals from its `{==…==}`
   * highlight, so the chip sits further in — hence the scan over the range
   * rather than an exact-offset lookup.
   */
  private flashChipAt(cm: EditorView, offset: number, length = 0): void {
    // The chip may not be in the rendered viewport yet — CM6 renders
    // decorations lazily, and the scrollIntoView effect above triggers a
    // viewport update on the next measure cycle. Wait one frame so the chip
    // element exists in the DOM before we add the flash class.
    window.requestAnimationFrame(() => {
      const chips = cm.dom.querySelectorAll<HTMLElement>(".tc-chip[data-tc-offset]");
      let chip: HTMLElement | null = null;
      for (const c of Array.from(chips)) {
        const at = Number(c.getAttribute("data-tc-offset"));
        if (at >= offset && at <= offset + length) {
          chip = c;
          break;
        }
      }
      if (!chip) return;
      chip.removeClass("tc-chip-flash");
      // Force a reflow so re-adding the class restarts the animation if the
      // user clicks the same card twice in quick succession.
      void chip.offsetWidth;
      chip.addClass("tc-chip-flash");
      window.setTimeout(() => chip.removeClass("tc-chip-flash"), 1500);
    });
  }

  // ---- finalize ----

  private async runFinalize(file: TFile): Promise<void> {
    const source = await this.app.vault.cachedRead(file);
    new FinalizeModal(
      this.app,
      file,
      source,
      this.settings.finalize,
      async (edits) => {
        await this.applyEditsToFile(file, edits, {
          expectedSource: source,
          requireAll: true,
        });
      },
    ).open();
  }
}

interface ApplyEditsOptions {
  /** Refuse to apply if the document source changed since the action was prepared. */
  expectedSource?: string;
  /** Refuse partial success if any edit cannot be rebased. */
  requireAll?: boolean;
  /** Where to put the cursor after a live-editor apply, in post-edit offsets. */
  cursorAfter?: number;
}

type EditFailureReason = "stale" | "moved";

type PreparedEdits =
  | { ok: true; edits: SourceEdit[]; dropped: number }
  | { ok: false; reason: EditFailureReason; dropped: number };
