import {
  Plugin,
  MarkdownView,
  WorkspaceLeaf,
  TFile,
  Notice,
  Editor,
} from "obsidian";
import { EditorView } from "@codemirror/view";

import { criticDecorationsExtension } from "./editor/decorations";
import { REVIEW_VIEW_TYPE, ReviewPanelView, type PanelHost } from "./panel/view";
import { applyEdits, rebaseEdits, type SourceEdit } from "./operations";
import { makeReadingPostProcessor } from "./reading";
import { FinalizeModal } from "./finalize";
import {
  DEFAULT_SETTINGS,
  KissCriticMarkupSettingsTab,
  type KissCriticMarkupSettings,
} from "./settings";

export default class KissCriticMarkupPlugin extends Plugin {
  settings!: KissCriticMarkupSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Right-panel view registration.
    this.registerView(REVIEW_VIEW_TYPE, (leaf) => this.makeReviewView(leaf));

    // CodeMirror 6 inline decorations.
    this.registerEditorExtension(
      criticDecorationsExtension({
        onClick: (offset) => this.handleInlineClick(offset),
      }),
    );

    // Reading-mode post-processor.
    this.registerMarkdownPostProcessor(
      makeReadingPostProcessor(() => ({
        suggestions: this.settings.readingMode,
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
    this.addCommand({
      id: "delete-all-resolved-threads",
      name: "Delete all resolved (ignore/done) threads",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.deleteResolvedThreads(file);
        return true;
      },
    });

    // Ribbon for quick access.
    this.addRibbonIcon("message-square", "Open CriticMarkup review panel", () =>
      this.openReviewPanel(),
    );

    // Settings tab.
    this.addSettingTab(new KissCriticMarkupSettingsTab(this.app, this));

    // Open panel automatically after layout is ready, if not already.
    this.app.workspace.onLayoutReady(() => {
      // Don't force-open on first run; user can use the ribbon/command.
    });
  }

  async onunload(): Promise<void> {
    // Leaves of our view type are detached automatically when their root is.
    // (Obsidian guidance: do NOT call detachLeavesOfType in onunload.)
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) ?? {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      finalize: { ...DEFAULT_SETTINGS.finalize, ...(stored.finalize ?? {}) },
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ---- host implementation for the panel ----

  private makeReviewView(leaf: WorkspaceLeaf): ReviewPanelView {
    const host: PanelHost = {
      app: this.app,
      getActiveFile: () => {
        const file = this.app.workspace.getActiveFile();
        return file && file.extension === "md" ? file : null;
      },
      applyEdits: async (file, edits) => this.applyEditsToFile(file, edits),
      revealOffset: (file, offset, length) => this.revealOffsetInEditor(file, offset, length),
    };
    return new ReviewPanelView(leaf, host);
  }

  private async openReviewPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf =
      this.settings.panelSide === "left"
        ? this.app.workspace.getLeftLeaf(false)
        : this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("Could not open review panel.");
      return;
    }
    await leaf.setViewState({ type: REVIEW_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
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
   * normal undo stack. Otherwise fall back to vault.modify, which is a
   * vault-level operation and lands in Obsidian's persistent history.
   */
  private async applyEditsToFile(file: TFile, edits: SourceEdit[]): Promise<void> {
    if (edits.length === 0) return;
    const editor = this.findEditorForFile(file);
    const cm = editor ? (editor as unknown as { cm?: EditorView }).cm : undefined;
    const currentSource = cm
      ? cm.state.doc.toString()
      : editor
        ? editor.getValue()
        : await this.app.vault.read(file);

    // Rebase against the current doc so stale offsets (from a re-parse the
    // panel did some ms ago, while the user was typing or the AI was editing
    // through another channel) can't corrupt unrelated text.
    const { edits: rebased, dropped } = rebaseEdits(currentSource, edits);
    if (rebased.length === 0) {
      new Notice("Edit could not be applied — the text moved or was changed.");
      return;
    }
    if (dropped > 0) {
      new Notice(`Skipped ${dropped} edit(s) — the target text moved or was changed.`);
    }

    if (cm) {
      cm.dispatch({
        changes: rebased.map((e) => ({ from: e.from, to: e.to, insert: e.insert })),
      });
      this.getReviewView()?.refreshFromSource(file, cm.state.doc.toString());
      return;
    }
    if (editor) {
      const next = applyEdits(currentSource, rebased);
      editor.setValue(next);
      this.getReviewView()?.refreshFromSource(file, next);
      return;
    }
    const next = applyEdits(currentSource, rebased);
    await this.app.vault.modify(file, next);
    this.getReviewView()?.refreshFromSource(file, next);
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

  private revealOffsetInEditor(file: TFile, offset: number, length: number): void {
    const editor = this.findEditorForFile(file);
    if (!editor) {
      // Open the file in a new leaf if not visible, then reveal.
      void this.app.workspace.openLinkText(file.path, "", false).then(() => {
        const ed = this.findEditorForFile(file);
        if (ed) this.scrollEditor(ed, offset, length);
      });
      return;
    }
    this.scrollEditor(editor, offset, length);
  }

  private scrollEditor(editor: Editor, offset: number, length: number): void {
    const cm = (editor as unknown as { cm?: EditorView }).cm;
    if (cm) {
      cm.dispatch({
        selection: { anchor: offset, head: offset + length },
        scrollIntoView: true,
        effects: EditorView.scrollIntoView(offset, { y: "center" }),
      });
      return;
    }
    const from = editor.offsetToPos(offset);
    const to = editor.offsetToPos(offset + length);
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, true);
  }

  // ---- finalize ----

  private async runFinalize(file: TFile): Promise<void> {
    const source = await this.app.vault.read(file);
    new FinalizeModal(
      this.app,
      file,
      source,
      this.settings.finalize,
      async (edits) => this.applyEditsToFile(file, edits),
    ).open();
  }

  // ---- delete all "ignore"/"done" threads ----

  private async deleteResolvedThreads(file: TFile): Promise<void> {
    const source = await this.app.vault.read(file);
    const { parse } = await import("./parser");
    const parsed = parse(source);
    const edits: SourceEdit[] = [];
    for (const t of parsed.threads) {
      // A thread is "resolved" if any reply's text is a recognised
      // resolution marker, regardless of who wrote it. (A self-tagged
      // reply like {>>Phil: ignore<<} still resolves.)
      const replies = t.replyIndexes.map((i) => parsed.nodes[i]);
      const resolved = replies.some((r) => {
        if (r.kind !== "comment") return false;
        return /^(ignore|won['’]?t fix|wontfix|done|resolved)$/i.test(r.text.trim());
      });
      if (resolved) {
        edits.push({
          from: t.from,
          to: t.to,
          insert: "",
          expected: source.slice(t.from, t.to),
        });
      }
    }
    if (edits.length === 0) {
      new Notice("No resolved threads found.");
      return;
    }
    await this.applyEditsToFile(file, edits);
    new Notice(`Deleted ${edits.length} resolved thread(s).`);
  }
}
