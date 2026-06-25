import {
  Plugin,
  MarkdownView,
  WorkspaceLeaf,
  TFile,
  Notice,
  Editor,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

import { criticDecorationsExtension } from "./editor/decorations";
import { REVIEW_VIEW_TYPE, ReviewPanelView, type PanelHost } from "./panel/view";
import { applyEdits, rebaseEdits, type SourceEdit } from "./operations";
import { makeReadingPostProcessor } from "./reading";
import { FinalizeModal } from "./finalize";
import {
  DEFAULT_SETTINGS,
  TrackChangesCriticMarkupSettingsTab,
  type TrackChangesCriticMarkupSettings,
} from "./settings";

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
      if (flashChip) this.flashChipAt(cm, offset);
      return;
    }
    const from = editor.offsetToPos(offset);
    const to = editor.offsetToPos(offset + length);
    if (revealMarkup) editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, true);
  }

  private flashChipAt(cm: EditorView, offset: number): void {
    // The chip may not be in the rendered viewport yet — CM6 renders
    // decorations lazily, and the scrollIntoView effect above triggers a
    // viewport update on the next measure cycle. Wait one frame so the chip
    // element exists in the DOM before we add the flash class.
    window.requestAnimationFrame(() => {
      const chip = cm.dom.querySelector<HTMLElement>(
        `.tc-chip[data-tc-offset="${offset}"]`,
      );
      if (!chip) return;
      chip.removeClass("tc-chip-flash");
      // Force a reflow so re-adding the class restarts the animation if the
      // user clicks the same card twice in quick succession.
      void chip.offsetWidth;
      chip.addClass("tc-chip-flash");
      this.registerInterval(
        window.setTimeout(() => chip.removeClass("tc-chip-flash"), 1500),
      );
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
}

type EditFailureReason = "stale" | "moved";

type PreparedEdits =
  | { ok: true; edits: SourceEdit[]; dropped: number }
  | { ok: false; reason: EditFailureReason; dropped: number };
