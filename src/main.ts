import {
  Plugin,
  MarkdownView,
  FileView,
  View,
  WorkspaceLeaf,
  TFile,
  Notice,
  Editor,
  Menu,
  MenuItem,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import type { Extension } from "@codemirror/state";

import { criticDecorationsExtension } from "./editor/decorations";
import {
  REVIEW_VIEW_TYPE,
  ConfirmActionModal,
  ReviewPanelView,
  type PanelHost,
} from "./panel/view";
import { OVERVIEW_VIEW_TYPE, PendingOverviewView, type OverviewHost } from "./panel/overview";
import { VaultIndex } from "./vault-index";
import { describeSummary, totals } from "./pending";
import {
  applyEdits,
  rebaseEdits,
  buildAttributionPrefix,
  editsAtCursor,
  resolveAllChanges,
  type CursorAction,
  type SourceEdit,
} from "./operations";
import { parse, type ParseResult } from "./parser";
import { makeReadingPostProcessor } from "./reading";
import { FinalizeModal } from "./finalize";
import {
  DEFAULT_MARK_INTENSITY,
  EMPTY_MARK_COLORS,
  MAX_MARK_INTENSITY,
  MIN_MARK_INTENSITY,
  colorCssProps,
  isHexColor,
  type MarkColorKey,
} from "./colors";
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

const CURSOR_COMMANDS: ReadonlyArray<{
  id: string;
  name: string;
  menuTitle: string;
  action: CursorAction;
  icon: string;
}> = [
  {
    id: "accept-change-at-cursor",
    name: "Accept change at cursor",
    menuTitle: "Accept change",
    action: "accept",
    icon: "check",
  },
  {
    id: "reject-change-at-cursor",
    name: "Reject change at cursor",
    menuTitle: "Reject change",
    action: "reject",
    icon: "x",
  },
  {
    id: "remove-highlight-at-cursor",
    name: "Remove highlight at cursor",
    menuTitle: "Remove highlight",
    action: "remove-highlight",
    icon: "eraser",
  },
  {
    id: "delete-comment-at-cursor",
    name: "Delete comment at cursor",
    menuTitle: "Delete comment",
    action: "delete-comment",
    icon: "trash-2",
  },
];

export default class TrackChangesCriticMarkupPlugin extends Plugin {
  settings!: TrackChangesCriticMarkupSettings;

  // Mutable so a settings toggle can swap the decoration extension and force a
  // rebuild via workspace.updateOptions() (the field is otherwise only rebuilt
  // on doc changes).
  private editorExtensions: Extension[] = [];

  /** Per-file pending counts for the whole vault (overview view + status bar). */
  index!: VaultIndex;
  private statusBarEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Vault-wide index of pending review items. Events are registered now;
    // the first full scan waits for the layout so startup isn't slowed.
    this.index = new VaultIndex(this.app);
    this.index.register(this);
    this.index.onChange(() => this.updateStatusBar());
    this.registerView(OVERVIEW_VIEW_TYPE, (leaf) => this.makeOverviewView(leaf));

    // Colour overrides live as inline CSS variables on each window's body.
    this.applyColors();
    this.registerEvent(
      this.app.workspace.on("window-open", (_w, win) => {
        win.document.body.setCssProps(this.colorProps());
      }),
    );

    // Per-window review panel registration.
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
      id: "open-pending-overview",
      name: "Open pending changes overview",
      callback: () => this.openOverview(),
    });
    this.addCommand({
      id: "rescan-pending-changes",
      name: "Rescan vault for pending changes",
      callback: () => void this.index.scanAll(),
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
    for (const [action, name, icon] of [
      ["accept", "Accept all changes", "check-check"],
      ["reject", "Reject all changes", "x"],
    ] as const) {
      this.addCommand({
        id: `${action}-all-changes`,
        name,
        icon,
        checkCallback: (checking) => {
          const file = this.app.workspace.getActiveFile();
          if (!file || file.extension !== "md") return false;
          if (!checking) void this.resolveAllInActiveFile(file, action);
          return true;
        },
      });
    }

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

    for (const c of CURSOR_COMMANDS) {
      this.addCommand({
        id: c.id,
        name: c.name,
        icon: c.icon,
        editorCheckCallback: (checking, editor, view) => {
          if (!(view instanceof MarkdownView) || view.file?.extension !== "md") return false;
          if (!checking) void this.applyAtCursor(editor, view, c.action);
          return true;
        },
      });
    }

    // Right-click menu: a "Track changes" submenu with only the actions that
    // would succeed. On a mark (inside or touching) that is the mark's own
    // actions; elsewhere the authoring actions the guards allow.
    // MenuItem.setSubmenu is not in the public typings but exists at runtime
    // on desktop; flat items otherwise.
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        if (!(view instanceof MarkdownView) || view.file?.extension !== "md") return;
        const ctx = this.cursorContext(editor);
        if (typeof ctx === "string") return;
        const items: { title: string; icon: string; run: () => void }[] = CURSOR_COMMANDS.filter(
          (c) => typeof editsAtCursor(ctx.source, ctx.parsed, ctx.offset, c.action) !== "string",
        ).map((c) => ({
          title: c.menuTitle,
          icon: c.icon,
          run: () => void this.applyAtCursor(editor, view, c.action),
        }));
        if (items.length === 0) {
          const from = editor.posToOffset(editor.getCursor("from"));
          const to = editor.posToOffset(editor.getCursor("to"));
          for (const c of AUTHORING_COMMANDS) {
            const fitsSelection = c.kind === "comment" || (c.kind === "addition") === (from === to);
            if (!fitsSelection || checkGuards(ctx.source, from, to, c.kind) !== null) continue;
            items.push({
              title: c.name,
              icon: c.icon,
              run: () => this.insertAuthoredMark(editor, c.kind),
            });
          }
        }
        if (items.length === 0) return;
        const addItems = (target: Menu): void => {
          for (const it of items) {
            target.addItem((item) => item.setTitle(it.title).setIcon(it.icon).onClick(it.run));
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

    this.addRibbonIcon("list-checks", "Open pending changes overview", () =>
      this.openOverview(),
    );

    // Status bar: vault-wide pending count, click to open the overview.
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("tc-status", "mod-clickable");
    this.statusBarEl.addEventListener("click", () => void this.openOverview());
    this.updateStatusBar();

    // Settings tab.
    this.addSettingTab(new TrackChangesCriticMarkupSettingsTab(this.app, this));

    // Don't force-open the panel on first run; user can use the ribbon/command.
    // The vault scan waits for the layout so it never competes with startup.
    this.app.workspace.onLayoutReady(() => {
      void this.index.scanAll();
    });
  }

  // ---- vault-wide pending overview ----

  private makeOverviewView(leaf: WorkspaceLeaf): PendingOverviewView {
    const host: OverviewHost = {
      index: this.index,
      openFileForReview: (path) => this.openFileForReview(path),
      activeFilePath: () => this.app.workspace.getActiveFile()?.path ?? null,
    };
    return new PendingOverviewView(leaf, host);
  }

  private async openOverview(): Promise<void> {
    const workspace = this.app.workspace;
    const existing = workspace.getLeavesOfType(OVERVIEW_VIEW_TYPE)[0];
    if (existing) {
      await workspace.revealLeaf(existing);
      return;
    }
    // Left sidebar: Obsidian's convention puts vault-wide navigation (file
    // explorer, search, tags) on the left and per-note context (outline,
    // backlinks, the review panel) on the right.
    const leaf = workspace.getLeftLeaf(false);
    if (!leaf) {
      new Notice("Could not open the pending changes overview.");
      return;
    }
    await leaf.setViewState({ type: OVERVIEW_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
  }

  /** Open a note in the main area and show the review panel for it. */
  private async openFileForReview(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) {
      new Notice("File not found: " + path);
      return;
    }
    const workspace = this.app.workspace;
    // Reuse a tab that already shows the file; otherwise open a new one.
    const open = workspace.getLeavesOfType("markdown").find(
      (leaf) => leaf.view instanceof MarkdownView && leaf.view.file === file,
    );
    let leaf: WorkspaceLeaf;
    if (open) {
      leaf = open;
      await workspace.revealLeaf(leaf);
    } else {
      leaf = workspace.getLeaf("tab");
      await leaf.openFile(file);
    }
    workspace.setActiveLeaf(leaf, { focus: true });
    await this.openReviewPanel(leaf);
  }

  /** Repaint the status-bar count from the index. Hidden when nothing is pending. */
  updateStatusBar(): void {
    const el = this.statusBarEl;
    if (!el) return;
    if (!this.settings.showPendingStatusBar) {
      el.hide();
      return;
    }
    const sum = totals(this.index.rows());
    if (sum.files === 0) {
      el.hide();
      return;
    }
    el.show();
    const items = sum.suggestions + sum.comments + sum.highlights;
    el.setText(`${items} to review · ${sum.files} ${sum.files === 1 ? "file" : "files"}`);
    el.setAttr("aria-label", `Track changes: ${describeSummary(sum)} across ${sum.files} ${sum.files === 1 ? "file" : "files"}. Click to open the overview.`);
    el.setAttr("data-tooltip-position", "top");
  }

  onunload(): void {
    // Leaves of our view type are detached automatically when their root is.
    // (Obsidian guidance: do NOT call detachLeavesOfType in onunload.)
    const cleared = Object.fromEntries(Object.keys(this.colorProps()).map((k) => [k, ""]));
    for (const doc of this.allDocuments()) doc.body.setCssProps(cleared);
  }

  async loadSettings(): Promise<void> {
    const stored = ((await this.loadData()) ?? {}) as Partial<TrackChangesCriticMarkupSettings>;
    const colors = { ...EMPTY_MARK_COLORS };
    for (const k of Object.keys(colors) as MarkColorKey[]) {
      const v = stored.colors?.[k];
      if (isHexColor(v)) colors[k] = v.toLowerCase();
    }
    const intensity = Number(stored.markIntensity);
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      // Coerce the persisted enum so a hand-edited / future-renamed value can't
      // leak an invalid style downstream; anything but "datetime" means "date".
      replyDateStyle: stored.replyDateStyle === "datetime" ? "datetime" : "date",
      panelLocation: stored.panelLocation === "split" ? "split" : "sidebar",
      showPendingStatusBar: stored.showPendingStatusBar !== false,
      colors,
      markIntensity: Number.isFinite(intensity)
        ? Math.min(MAX_MARK_INTENSITY, Math.max(MIN_MARK_INTENSITY, intensity))
        : DEFAULT_MARK_INTENSITY,
      finalize: { ...DEFAULT_SETTINGS.finalize, ...(stored.finalize ?? {}) },
    };
  }

  private colorProps(): Record<string, string> {
    return colorCssProps(this.settings.colors, this.settings.markIntensity);
  }

  /** The main window's document plus every pop-out window's. */
  private allDocuments(): Set<Document> {
    const docs = new Set<Document>([document]);
    this.app.workspace.iterateAllLeaves((leaf) => docs.add(leaf.view.containerEl.doc));
    return docs;
  }

  applyColors(): void {
    const props = this.colorProps();
    for (const doc of this.allDocuments()) doc.body.setCssProps(props);
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
   * panels after the `highlightChangedChars` setting toggled. */
  refreshCharHighlighting(): void {
    this.editorExtensions.length = 0;
    this.editorExtensions.push(this.makeDecorationExtension());
    this.app.workspace.updateOptions();
    this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE).forEach((leaf) => {
      if (leaf.view instanceof ReviewPanelView) leaf.view.rebuildCards();
    });
  }

  /**
   * Refresh every render surface after a settings change that affects display
   * (e.g. localAuthorName). Re-runs reading-view post-processors and forces the
   * open review panels to repaint so the "You"-fallback author/hue updates live.
   */
  refreshAfterSettingsChange(): void {
    this.rerenderReadingViews();
    this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE).forEach((leaf) => {
      if (leaf.view instanceof ReviewPanelView) leaf.view.rebuildCards();
    });
  }

  // Any view, not just FileView: a focused review panel or canvas still tells
  // us which window the command came from. Capture it before revealing a panel
  // changes focus.
  private getActiveLeaf(): WorkspaceLeaf | null {
    return this.app.workspace.getActiveViewOfType(View)?.leaf ?? null;
  }

  // ---- host implementation for the panel ----

  private makeReviewView(leaf: WorkspaceLeaf): ReviewPanelView {
    const host: PanelHost = {
      app: this.app,
      getActiveFile: () => {
        const document = leaf.view.containerEl.ownerDocument;
        let activeLeaf = this.getActiveLeaf();
        if (
          !activeLeaf || activeLeaf.view.containerEl.ownerDocument !== document ||
          !(activeLeaf.view instanceof FileView) || !activeLeaf.view.file
        ) {
          const leaves = this.app.workspace.getLeavesOfType("markdown").filter(
            (candidate) => candidate.view.containerEl.ownerDocument === document,
          );
          const currentFile = leaf.view instanceof ReviewPanelView
            ? leaf.view.getCurrentFile() : null;
          activeLeaf = leaves.find(
            (candidate) => candidate.view instanceof MarkdownView && candidate.view.file === currentFile,
          ) ?? leaves[0] ?? null;
        }
        const file = activeLeaf?.view instanceof FileView ? activeLeaf.view.file : null;
        return file && file.extension === "md" ? file : null;
      },
      getCurrentSource: (file) => {
        const editor = this.findEditorForFile(file, leaf);
        if (!editor) return null;
        const cm = (editor as unknown as { cm?: EditorView }).cm;
        return cm ? cm.state.doc.toString() : editor.getValue();
      },
      applyEdits: async (file, edits) => {
        await this.applyEditsToFile(file, edits, {}, leaf);
      },
      revealOffset: (file, offset, length, flashChip) =>
        this.revealOffsetInEditor(file, offset, length, flashChip ?? false, leaf),
      isFileOpen: (file) => this.app.workspace.getLeavesOfType("markdown").some(
        (candidate) => candidate.view instanceof MarkdownView && candidate.view.file === file &&
          candidate.view.containerEl.ownerDocument === leaf.view.containerEl.ownerDocument,
      ),
      confirmBeforeDelete: () => this.settings.confirmBeforeDelete,
      highlightChangedChars: () => this.settings.highlightChangedChars,
      localAuthorName: () => this.settings.localAuthorName ?? "",
      replyDateStyle: () => this.settings.replyDateStyle,
      resolveAll: (file, action) => this.resolveAll(file, action, leaf),
    };
    return new ReviewPanelView(leaf, host);
  }

  private async openReviewPanel(targetLeaf = this.getActiveLeaf()): Promise<void> {
    const workspace = this.app.workspace;
    const file = targetLeaf?.view instanceof FileView ? targetLeaf.view.file : null;
    // The root's container exists at runtime but is absent from public typings.
    const mainDocument = (workspace.rootSplit as typeof workspace.rootSplit & {
      containerEl: HTMLElement;
    }).containerEl.ownerDocument;
    const document = targetLeaf?.view.containerEl.ownerDocument ?? mainDocument;
    const existing = workspace.getLeavesOfType(REVIEW_VIEW_TYPE).find(
      (leaf) => leaf.view.containerEl.ownerDocument === document,
    );
    if (existing) {
      if (file?.extension === "md" && existing.view instanceof ReviewPanelView) {
        existing.view.onActiveFileChanged(file);
      }
      await workspace.revealLeaf(existing);
      return;
    }
    // Pop-out windows have no sidebar. Split beside the originating leaf;
    // main-window leaves (including sidebar leaves) follow panelLocation.
    const leaf = targetLeaf && targetLeaf.getRoot() !== workspace.rootSplit &&
      document !== mainDocument
      ? workspace.createLeafBySplit(targetLeaf, "vertical")
      : this.settings.panelLocation === "split"
        ? workspace.getLeaf("split", "vertical")
        : workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("Could not open review panel.");
      return;
    }
    await leaf.setViewState({ type: REVIEW_VIEW_TYPE, active: true });
    if (file?.extension === "md" && leaf.view instanceof ReviewPanelView) {
      leaf.view.onActiveFileChanged(file);
    }
    await workspace.revealLeaf(leaf);
  }

  private getReviewView(targetLeaf = this.getActiveLeaf()): ReviewPanelView | null {
    const leaves = this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE);
    let fallback: ReviewPanelView | null = null;
    for (const leaf of leaves) {
      if (leaf.view instanceof ReviewPanelView) {
        if (leaf.view.containerEl.ownerDocument === targetLeaf?.view.containerEl.ownerDocument) {
          return leaf.view;
        }
        fallback ??= leaf.view;
      }
    }
    return fallback;
  }

  // ---- inline-click handler ----

  private handleInlineClick(offset: number): void {
    const leaf = this.getActiveLeaf();
    const file = leaf?.view instanceof FileView ? leaf.view.file : null;
    void (async () => {
      await this.openReviewPanel(leaf);
      const view = this.getReviewView(leaf);
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

  // ---- actions at cursor (issue #44) ----

  private cursorContext(
    editor: Editor,
  ): { source: string; parsed: ParseResult; offset: number } | string {
    if (editor.listSelections().length > 1) {
      return "Multiple cursors are not supported; collapse to a single selection.";
    }
    const cm = (editor as unknown as { cm?: EditorView }).cm;
    const source = cm ? cm.state.doc.toString() : editor.getValue();
    return {
      source,
      parsed: parse(source),
      offset: editor.posToOffset(editor.getCursor("head")),
    };
  }

  private async applyAtCursor(
    editor: Editor,
    view: MarkdownView,
    action: CursorAction,
  ): Promise<void> {
    const ctx = this.cursorContext(editor);
    const edits =
      typeof ctx === "string" ? ctx : editsAtCursor(ctx.source, ctx.parsed, ctx.offset, action);
    if (typeof edits === "string") {
      new Notice(edits);
      return;
    }
    if (!view.file) return;
    // Cursor lands after the last edit's replacement, in post-edit offsets.
    const last = edits[edits.length - 1];
    const shift = edits.reduce((d, e) => d + e.insert.length - (e.to - e.from), 0);
    await this.applyEditsToFile(view.file, edits, { editor, cursorAfter: last.to + shift });
  }

  // ---- accept / reject all (issue #57) ----

  /** Scoped to the editor's selection when the active editor shows `file` and has one. */
  private async resolveAllInActiveFile(file: TFile, action: "accept" | "reject"): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file !== file) return this.resolveAll(file, action);
    const editor = view.editor;
    if (editor.listSelections().length > 1) {
      new Notice("Multiple cursors are not supported; collapse to a single selection.");
      return;
    }
    const from = editor.posToOffset(editor.getCursor("from"));
    const to = editor.posToOffset(editor.getCursor("to"));
    return this.resolveAll(file, action, view.leaf, from < to ? { from, to } : undefined);
  }

  private async resolveAll(
    file: TFile,
    action: "accept" | "reject",
    targetLeaf = this.getActiveLeaf(),
    range?: { from: number; to: number },
  ): Promise<void> {
    // Read fresh: the panel's render-time source can lag the editor.
    const editor = this.findEditorForFile(file, targetLeaf);
    const cm = editor ? (editor as unknown as { cm?: EditorView }).cm : undefined;
    const source = cm
      ? cm.state.doc.toString()
      : editor ? editor.getValue() : await this.app.vault.read(file);
    const { edits, threads } = resolveAllChanges(source, parse(source), action, range);
    const verb = action === "accept" ? "Accept" : "Reject";
    if (edits.length === 0) {
      new Notice(range ? "No changes in the selection." : `No changes to ${action}.`);
      return;
    }
    const changes = `${edits.length} ${edits.length === 1 ? "change" : "changes"}`;
    let message = range
      ? `${verb} ${changes} in the selection?`
      : `${verb} ${changes} in "${file.basename}"?`;
    if (threads > 0) {
      message += ` This also removes ${threads} comment ${threads === 1 ? "thread" : "threads"} on these suggestions.`;
    }
    const confirmed = await new Promise<boolean>((resolve) => {
      new ConfirmActionModal(
        this.app,
        `${verb} all changes`,
        message,
        `${verb} ${edits.length}`,
        resolve,
      ).open();
    });
    if (!confirmed) return;
    await this.applyEditsToFile(
      file,
      edits,
      { editor: editor ?? undefined, expectedSource: source, requireAll: true },
      targetLeaf,
    );
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
    targetLeaf = this.getActiveLeaf(),
  ): Promise<boolean> {
    if (edits.length === 0) return true;
    const editor = options.editor ?? this.findEditorForFile(file, targetLeaf);
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
          annotations: isolateHistory.of("full"),
        });
        this.refreshReviewViews(file, cm.state.doc.toString());
        return true;
      }
      if (editor) {
        const next = applyEdits(currentSource, prepared.edits);
        editor.setValue(next);
        this.refreshReviewViews(file, next);
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
    this.refreshReviewViews(file, next);
    return true;
  }

  private refreshReviewViews(file: TFile, source: string): void {
    this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE).forEach((leaf) => {
      if (leaf.view instanceof ReviewPanelView) leaf.view.refreshFromSource(file, source);
    });
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

  private findEditorForFile(file: TFile, targetLeaf = this.getActiveLeaf()): Editor | null {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    let fallback: Editor | null = null;
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file === file) {
        if (view.containerEl.ownerDocument === targetLeaf?.view.containerEl.ownerDocument) {
          return view.editor;
        }
        fallback ??= view.editor;
      }
    }
    return fallback;
  }

  // ---- reveal/scroll ----

  private revealOffsetInEditor(
    file: TFile,
    offset: number,
    length: number,
    flashChip: boolean,
    targetLeaf = this.getActiveLeaf(),
  ): void {
    const editor = this.findEditorForFile(file, targetLeaf);
    if (!editor) {
      // Open the file in a new leaf if not visible, then reveal.
      void this.app.workspace.openLinkText(file.path, "", false).then(() => {
        const ed = this.findEditorForFile(file, targetLeaf);
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
   * always the chip itself: an anchored thread reveals from its anchor, so the
   * chip sits further in — hence the scan over the range rather than an
   * exact-offset lookup.
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
  /** Editor to apply through; defaults to the first pane showing the file. */
  editor?: Editor;
  /** Where to put the cursor after a live-editor apply, in post-edit offsets. */
  cursorAfter?: number;
}

type EditFailureReason = "stale" | "moved";

type PreparedEdits =
  | { ok: true; edits: SourceEdit[]; dropped: number }
  | { ok: false; reason: EditFailureReason; dropped: number };
