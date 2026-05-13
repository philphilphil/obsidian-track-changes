// Right-side review panel. ItemView registered on a workspace leaf.
//
// Responsibilities:
//   - Show one card per thread and per suggestion, in document order.
//   - For threads: render messages, allow reply, allow delete (per message
//     and whole thread).
//   - For suggestions: show diff + accept/reject buttons.
//   - Stay in sync with the active file (debounced re-render on modify).
//   - Clicking a card scrolls the editor to the anchor and flashes a
//     highlight.

import {
  ItemView,
  WorkspaceLeaf,
  MarkdownRenderer,
  TFile,
  debounce,
  Component,
  setIcon,
  type App,
} from "obsidian";

import {
  parse,
  type CommentNode,
  type AdditionNode,
  type DeletionNode,
  type SubstitutionNode,
  type Thread,
  type ParseResult,
} from "../parser";
import {
  acceptAddition,
  acceptDeletion,
  acceptSubstitution,
  rejectAddition,
  rejectDeletion,
  rejectSubstitution,
  appendReply,
  deleteCommentNode,
  deleteThread,
  type SourceEdit,
} from "../operations";

export const REVIEW_VIEW_TYPE = "kcm-review-panel";

export interface PanelHost {
  app: App;
  /** Get the file the panel should display, or null if none. */
  getActiveFile(): TFile | null;
  /** Apply a list of edits to a file, preserving undo history when possible. */
  applyEdits(file: TFile, edits: SourceEdit[]): Promise<void>;
  /** Scroll the editor to a source offset and flash a highlight. */
  revealOffset(file: TFile, offset: number, length: number): void;
  /** Configured AI-author prefix. Used both for parsing and for the display label. */
  getAiPrefix(): string;
}

export class ReviewPanelView extends ItemView {
  private host: PanelHost;
  private currentFile: TFile | null = null;
  private currentSource = "";
  private rerender = debounce(() => this.refresh(), 200, true);
  private replyDrafts = new Map<number, string>(); // thread.from -> draft text
  private markdownChildren: Component[] = [];
  // Bumped on every refresh() entry. Lets an in-flight refresh detect that a
  // newer one started while it was awaiting the file read, and bail before
  // touching the DOM — otherwise overlapping refreshes append duplicate cards.
  private refreshSeq = 0;

  constructor(leaf: WorkspaceLeaf, host: PanelHost) {
    super(leaf);
    this.host = host;
  }

  getViewType(): string {
    return REVIEW_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "CriticMarkup review";
  }
  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("kcm-panel");
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.onActiveFileChanged()),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file === this.currentFile) {
          this.rerender();
        }
      }),
    );
    this.onActiveFileChanged();
  }

  async onClose(): Promise<void> {
    this.disposeMarkdownChildren();
    this.contentEl.empty();
  }

  /** Called by the host when the user clicks an inline chip/mark. */
  focusOffset(file: TFile, offset: number): void {
    if (file !== this.currentFile) return;
    const card = this.contentEl.querySelector(
      `[data-kcm-card-offset="${offset}"]`,
    ) as HTMLElement | null;
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.addClass("kcm-card-flash");
      setTimeout(() => card.removeClass("kcm-card-flash"), 1200);
    }
  }

  private onActiveFileChanged(): void {
    const file = this.host.getActiveFile();
    if (file !== this.currentFile) {
      this.currentFile = file;
      this.replyDrafts.clear();
    }
    this.refresh();
  }

  /**
   * Refresh the panel immediately using a known-current source string. Called
   * by the host right after it dispatches edits into the editor, so the panel
   * doesn't have to wait for Obsidian's editor->vault autosave (which can be
   * ~2s) to repaint the cards.
   */
  refreshFromSource(file: TFile, source: string): void {
    if (file !== this.currentFile) return;
    void this.refresh(source);
  }

  private async refresh(preloadedSource?: string): Promise<void> {
    const seq = ++this.refreshSeq;
    const file = this.currentFile;

    if (!file) {
      this.disposeMarkdownChildren();
      this.contentEl.empty();
      this.contentEl.createEl("p", {
        cls: "kcm-empty",
        text: "Open a markdown file to review its comments and suggestions.",
      });
      return;
    }

    let source: string;
    if (preloadedSource !== undefined) {
      source = preloadedSource;
    } else {
      try {
        source = await this.app.vault.read(file);
      } catch {
        if (seq !== this.refreshSeq) return;
        this.disposeMarkdownChildren();
        this.contentEl.empty();
        this.contentEl.createEl("p", { cls: "kcm-empty", text: "Could not read file." });
        return;
      }
      if (seq !== this.refreshSeq) return;
    }

    // Skip the rebuild if nothing changed — e.g. the delayed vault `modify`
    // event after we already refreshed via refreshFromSource.
    if (source === this.currentSource && this.contentEl.querySelector(".kcm-card-list, .kcm-empty")) {
      return;
    }

    this.currentSource = source;
    const parsed = parse(source, { aiPrefix: this.host.getAiPrefix() });

    this.disposeMarkdownChildren();
    this.contentEl.empty();

    this.renderHeader(file, parsed);

    if (parsed.nodes.length === 0) {
      this.contentEl.createEl("p", {
        cls: "kcm-empty",
        text: "No comments or suggestions in this file.",
      });
      return;
    }

    const list = this.contentEl.createDiv({ cls: "kcm-card-list" });

    // Emit cards in document order. One card per thread (rooted at root
    // index); one card per non-comment node.
    const seenThreads = new Set<number>();
    let threadNumber = 0;
    for (let i = 0; i < parsed.nodes.length; i++) {
      const n = parsed.nodes[i];
      if (n.kind === "comment") {
        const tIdx = parsed.nodeThread[i];
        if (seenThreads.has(tIdx)) continue;
        seenThreads.add(tIdx);
        threadNumber++;
        this.renderThreadCard(list, file, source, parsed, parsed.threads[tIdx], threadNumber);
      } else if (n.kind === "addition") {
        this.renderAdditionCard(list, file, source, n);
      } else if (n.kind === "deletion") {
        this.renderDeletionCard(list, file, source, n);
      } else if (n.kind === "substitution") {
        this.renderSubstitutionCard(list, file, source, n);
      }
      // highlights: not surfaced as cards
    }
  }

  private renderHeader(file: TFile, parsed: ParseResult): void {
    const header = this.contentEl.createDiv({ cls: "kcm-header" });
    header.createEl("div", { cls: "kcm-header-title", text: file.basename });
    const counts = {
      threads: parsed.threads.length,
      suggestions: parsed.nodes.filter(
        (n) => n.kind === "addition" || n.kind === "deletion" || n.kind === "substitution",
      ).length,
    };
    const parts: string[] = [];
    parts.push(`${counts.threads} ${counts.threads === 1 ? "comment" : "comments"}`);
    parts.push(`${counts.suggestions} ${counts.suggestions === 1 ? "suggestion" : "suggestions"}`);
    header.createEl("div", { cls: "kcm-header-counts", text: parts.join(" · ") });
  }

  private renderThreadCard(
    list: HTMLElement,
    file: TFile,
    source: string,
    parsed: ParseResult,
    thread: Thread,
    threadNumber: number,
  ): void {
    const card = list.createDiv({ cls: "kcm-card kcm-card-thread" });
    card.setAttr("data-kcm-card-offset", String(thread.from));

    card.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".kcm-card-actions, .kcm-message, .kcm-reply, button, textarea, input"))
        return;
      this.host.revealOffset(file, thread.from, thread.to - thread.from);
    });

    this.renderLineRef(card, source, thread.from, `#${threadNumber}`);

    const messages = card.createDiv({ cls: "kcm-messages" });
    const ids: number[] = [thread.rootIndex, ...thread.replyIndexes];
    for (const idx of ids) {
      const c = parsed.nodes[idx] as CommentNode;
      const msg = messages.createDiv({
        cls: `kcm-message kcm-message-${c.author}`,
      });
      const meta = msg.createDiv({ cls: "kcm-message-meta" });
      meta.createSpan({
        cls: "kcm-message-author",
        text: c.author === "ai" ? this.host.getAiPrefix() : "You",
      });
      const del = meta.createEl("button", { cls: "kcm-icon-btn", attr: { "aria-label": "Delete message" } });
      setIcon(del, "trash-2");
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.host.applyEdits(file, [deleteCommentNode(c)]);
      });

      const body = msg.createDiv({ cls: "kcm-message-body" });
      this.renderMarkdownInto(body, c.text, file.path);
    }

    const reply = card.createDiv({ cls: "kcm-reply" });
    const ta = reply.createEl("textarea", {
      cls: "kcm-reply-input",
      attr: { placeholder: "Reply…", rows: "2" },
    });
    ta.value = this.replyDrafts.get(thread.from) ?? "";
    ta.addEventListener("input", () => {
      this.replyDrafts.set(thread.from, ta.value);
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    });
    const submit = async () => {
      const text = ta.value.trim();
      if (!text) return;
      this.replyDrafts.delete(thread.from);
      const edit = appendReply(this.currentSource, thread, parsed, text);
      await this.host.applyEdits(file, [edit]);
    };
    const actions = reply.createDiv({ cls: "kcm-reply-actions" });
    const submitBtn = actions.createEl("button", { cls: "kcm-btn-primary", text: "Reply" });
    submitBtn.addEventListener("click", submit);
    const deleteThreadBtn = actions.createEl("button", {
      cls: "kcm-btn-danger",
      text: "Delete thread",
    });
    deleteThreadBtn.addEventListener("click", async () => {
      await this.host.applyEdits(file, [deleteThread(this.currentSource, thread)]);
    });
  }

  private renderAdditionCard(
    list: HTMLElement,
    file: TFile,
    source: string,
    n: AdditionNode,
  ): void {
    const card = list.createDiv({ cls: "kcm-card kcm-card-suggestion" });
    card.setAttr("data-kcm-card-offset", String(n.from));
    card.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("button")) return;
      this.host.revealOffset(file, n.from, n.to - n.from);
    });
    this.renderLineRef(card, source, n.from);
    const diff = card.createDiv({ cls: "kcm-diff" });
    diff.createSpan({ cls: "kcm-diff-label", text: "Insert" });
    const added = diff.createDiv({ cls: "kcm-diff-added" });
    this.renderMarkdownInto(added, n.text, file.path);
    this.renderAcceptReject(
      card,
      file,
      () => acceptAddition(n),
      () => rejectAddition(n),
    );
  }

  private renderDeletionCard(
    list: HTMLElement,
    file: TFile,
    source: string,
    n: DeletionNode,
  ): void {
    const card = list.createDiv({ cls: "kcm-card kcm-card-suggestion" });
    card.setAttr("data-kcm-card-offset", String(n.from));
    card.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("button")) return;
      this.host.revealOffset(file, n.from, n.to - n.from);
    });
    this.renderLineRef(card, source, n.from);
    const diff = card.createDiv({ cls: "kcm-diff" });
    diff.createSpan({ cls: "kcm-diff-label", text: "Delete" });
    const removed = diff.createDiv({ cls: "kcm-diff-removed" });
    this.renderMarkdownInto(removed, n.text, file.path);
    this.renderAcceptReject(
      card,
      file,
      () => acceptDeletion(n),
      () => rejectDeletion(n),
    );
  }

  private renderSubstitutionCard(
    list: HTMLElement,
    file: TFile,
    source: string,
    n: SubstitutionNode,
  ): void {
    const card = list.createDiv({ cls: "kcm-card kcm-card-suggestion" });
    card.setAttr("data-kcm-card-offset", String(n.from));
    card.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("button")) return;
      this.host.revealOffset(file, n.from, n.to - n.from);
    });
    this.renderLineRef(card, source, n.from);
    const diff = card.createDiv({ cls: "kcm-diff" });
    diff.createSpan({ cls: "kcm-diff-label", text: "Replace" });
    const removed = diff.createDiv({ cls: "kcm-diff-removed" });
    this.renderMarkdownInto(removed, n.oldText, file.path);
    const arrow = diff.createDiv({ cls: "kcm-diff-arrow" });
    arrow.setText("→");
    const added = diff.createDiv({ cls: "kcm-diff-added" });
    this.renderMarkdownInto(added, n.newText, file.path);
    this.renderAcceptReject(
      card,
      file,
      () => acceptSubstitution(n),
      () => rejectSubstitution(n),
    );
  }

  private renderAcceptReject(
    card: HTMLElement,
    file: TFile,
    accept: () => SourceEdit,
    reject: () => SourceEdit,
  ): void {
    const actions = card.createDiv({ cls: "kcm-card-actions" });
    const acceptBtn = actions.createEl("button", { cls: "kcm-btn-accept", text: "Accept" });
    acceptBtn.addEventListener("click", async () => {
      await this.host.applyEdits(file, [accept()]);
    });
    const rejectBtn = actions.createEl("button", { cls: "kcm-btn-reject", text: "Reject" });
    rejectBtn.addEventListener("click", async () => {
      await this.host.applyEdits(file, [reject()]);
    });
  }

  private renderLineRef(
    card: HTMLElement,
    source: string,
    offset: number,
    prefix?: string,
  ): void {
    let line = 1;
    for (let i = 0; i < offset && i < source.length; i++) {
      if (source.charCodeAt(i) === 10) line++;
    }
    const text = prefix ? `${prefix} · Line ${line}` : `Line ${line}`;
    card.createDiv({ cls: "kcm-line-ref", text });
  }

  private renderMarkdownInto(el: HTMLElement, text: string, sourcePath: string): void {
    const child = new Component();
    child.load();
    this.markdownChildren.push(child);
    // MarkdownRenderer.render is async but we don't need to await — the panel
    // doesn't depend on the rendering being complete.
    void MarkdownRenderer.render(this.app, text, el, sourcePath, child);
  }

  private disposeMarkdownChildren(): void {
    for (const c of this.markdownChildren) c.unload();
    this.markdownChildren = [];
  }
}
