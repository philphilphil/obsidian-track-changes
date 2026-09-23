// Right-side review panel. ItemView registered on a workspace leaf.
//
// Responsibilities:
//   - Show one card per thread and per suggestion, in document order; a
//     thread anchored on a suggestion renders inside the suggestion's card.
//   - For threads: render messages, allow reply, allow delete (per message
//     and whole thread).
//   - For suggestions: show diff + accept/reject/comment buttons.
//   - Stay in sync with the active file (debounced re-render on modify).
//   - Clicking a card scrolls the editor to the anchor and flashes a
//     highlight.

import {
  ItemView,
  Modal,
  Notice,
  WorkspaceLeaf,
  TFile,
  debounce,
  setIcon,
  type App,
} from "obsidian";

import {
  parse,
  anchorNodeIndexes,
  changeThreads,
  isChangeNode,
  type ChangeNode,
  type CommentNode,
  type HighlightNode,
  type Thread,
  type ParseResult,
} from "../parser";
import { authorHueIndex } from "../authors";
import { diffChars, type DiffRun } from "../diff";
import {
  appendComment,
  appendReply,
  deleteCommentNode,
  deleteThread,
  removeHighlight,
  resolveChange,
  validateReplyText,
  type SourceEdit,
  type ReplyDateStyle,
} from "../operations";

export const REVIEW_VIEW_TYPE = "tc-review-panel";

export interface PanelHost {
  app: App;
  /** Get the file the panel should display, or null if none. */
  getActiveFile(): TFile | null;
  /**
   * Get the current source for a file from the live editor if one is open,
   * else null. The panel prefers this over `vault.cachedRead` because the
   * cache can briefly return pre-edit content immediately after the host
   * dispatches a CM transaction (Obsidian's editor→vault sync is debounced).
   */
  getCurrentSource(file: TFile): string | null;
  /** Apply a list of edits to a file, preserving undo history when possible. */
  applyEdits(file: TFile, edits: SourceEdit[]): Promise<void>;
  /**
   * Scroll the editor to a source offset. If `flashChip` is true, the target
   * is treated as a comment chip: the chip blinks briefly so it's easier to
   * spot after the scroll. The `revealMarkupOnCommentJump` setting controls
   * whether the cursor also selects the markup (revealing its raw source).
   */
  revealOffset(file: TFile, offset: number, length: number, flashChip?: boolean): void;
  /** True if the file is currently open in any markdown leaf. */
  isFileOpen(file: TFile): boolean;
  /**
   * Whether destructive panel actions (delete message / thread) should prompt
   * for confirmation. Reads the live setting so it reflects changes made while
   * the panel is open.
   */
  confirmBeforeDelete(): boolean;
  /**
   * Whether substitution cards highlight the changed characters. Reads the live
   * setting so the panel reflects changes made while it is open.
   */
  highlightChangedChars(): boolean;
  /**
   * The local user's display name (the `localAuthorName` setting). Empty string
   * is the sentinel for "You". Used both as the author display fallback and to
   * stamp replies the panel writes. Read live so settings changes apply at once.
   */
  localAuthorName(): string;
  /**
   * How replies the panel writes stamp the date ("date" or "datetime"). Read
   * live so settings changes apply at once.
   */
  replyDateStyle(): ReplyDateStyle;
}

export class ReviewPanelView extends ItemView {
  private host: PanelHost;
  private currentFile: TFile | null = null;
  private currentSource = "";
  private rerender = debounce(() => this.refresh(), 200, true);
  private replyDrafts = new Map<number, string>(); // thread.from -> draft text
  private commentDrafts = new Map<number, string>(); // change.from -> open comment box draft
  private collapsedCards = new Set<number>(); // card-offset values that are collapsed
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
    this.contentEl.addClass("tc-panel");
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
    this.contentEl.empty();
  }

  /** Called by the host when the user clicks an inline chip/mark. */
  focusOffset(file: TFile, offset: number): void {
    if (file !== this.currentFile) return;
    const card = this.contentEl.querySelector<HTMLElement>(
      `[data-tc-card-offset="${offset}"], [data-tc-card-anchor="${offset}"]`,
    );
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.addClass("tc-card-flash");
      this.registerInterval(
        window.setTimeout(() => card.removeClass("tc-card-flash"), 1200),
      );
    }
  }

  private onActiveFileChanged(): void {
    const file = this.host.getActiveFile();
    // If no markdown file is active but the last one is still open in a tab,
    // keep showing it. The Terminal plugin's xterm canvas grabs focus inside
    // its leaf without always going through Obsidian's leaf-focus path, so
    // clicking back into the markdown pane may not fire another
    // active-leaf-change — without this guard the panel would stay blank.
    if (file === null && this.currentFile && this.host.isFileOpen(this.currentFile)) {
      return;
    }
    if (file !== this.currentFile) {
      this.currentFile = file;
      this.replyDrafts.clear();
      this.commentDrafts.clear();
      this.collapsedCards.clear();
    }
    void this.refresh();
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

  /** Rebuild the cards even if the source is unchanged — e.g. after a display
   * or author setting (highlightChangedChars / localAuthorName) toggled. */
  rebuildCards(): void {
    void this.refresh(undefined, true);
  }

  private async refresh(preloadedSource?: string, force = false): Promise<void> {
    const seq = ++this.refreshSeq;
    const file = this.currentFile;

    if (!file) {
      this.contentEl.empty();
      this.contentEl.createEl("p", {
        cls: "tc-empty",
        text: "Open a markdown file to review its comments and suggestions.",
      });
      return;
    }

    let source: string;
    if (preloadedSource !== undefined) {
      source = preloadedSource;
    } else {
      // Prefer the live editor over vault.cachedRead. The cache can briefly
      // return pre-edit content right after we dispatch a CM transaction,
      // which would re-render a card we just removed (visible flicker).
      const live = this.host.getCurrentSource(file);
      if (live !== null) {
        source = live;
      } else {
        try {
          source = await this.app.vault.cachedRead(file);
        } catch {
          if (seq !== this.refreshSeq) return;
          this.contentEl.empty();
          this.contentEl.createEl("p", { cls: "tc-empty", text: "Could not read file." });
          return;
        }
        if (seq !== this.refreshSeq) return;
      }
    }

    // Skip the rebuild if nothing changed — e.g. the delayed vault `modify`
    // event after we already refreshed via refreshFromSource.
    if (!force && source === this.currentSource && this.contentEl.querySelector(".tc-card-list, .tc-empty")) {
      return;
    }

    this.currentSource = source;
    const parsed = parse(source);
    // Offsets shift as earlier marks resolve; an open draft keyed to a stale
    // offset would otherwise reopen on whichever card lands there.
    const changeFroms = new Set(parsed.nodes.filter(isChangeNode).map((n) => n.from));
    for (const k of this.commentDrafts.keys()) {
      if (!changeFroms.has(k)) this.commentDrafts.delete(k);
    }

    this.contentEl.empty();

    this.renderHeader(file, parsed);

    // `aitext` marks render no card (visual-only), so a file with only those
    // would otherwise leave an empty card list — show the empty state instead.
    if (parsed.nodes.every((n) => n.kind === "aitext")) {
      this.contentEl.createEl("p", {
        cls: "tc-empty",
        text: "No comments or suggestions in this file.",
      });
      return;
    }

    const list = this.contentEl.createDiv({ cls: "tc-card-list" });

    // Emit cards in document order. One card per thread (rooted at root
    // index); one card per non-comment node. A thread anchored on a change
    // renders inside that change's card; the numbering still counts it so it
    // matches the inline chips.
    const seenThreads = new Set<number>();
    const anchored = anchorNodeIndexes(parsed);
    const onChange = changeThreads(parsed);
    let threadNumber = 0;
    for (let i = 0; i < parsed.nodes.length; i++) {
      const n = parsed.nodes[i];
      if (n.kind === "comment") {
        const tIdx = parsed.nodeThread[i];
        if (seenThreads.has(tIdx)) continue;
        seenThreads.add(tIdx);
        threadNumber++;
        this.renderThreadCard(list, file, source, parsed, parsed.threads[tIdx], threadNumber);
      } else if (isChangeNode(n)) {
        const tIdx = onChange.get(i);
        if (tIdx === undefined) {
          this.renderSuggestionCard(list, file, source, parsed, n, null, 0);
        } else {
          seenThreads.add(tIdx);
          threadNumber++;
          this.renderSuggestionCard(list, file, source, parsed, n, parsed.threads[tIdx], threadNumber);
        }
      } else if (n.kind === "highlight") {
        // An anchored highlight is rendered by its thread's card.
        if (!anchored.has(i)) this.renderHighlightCard(list, file, source, n);
      }
    }
  }

  private renderHeader(file: TFile, parsed: ParseResult): void {
    const header = this.contentEl.createDiv({ cls: "tc-header" });
    const anchors = anchorNodeIndexes(parsed);
    header.createDiv({ cls: "tc-header-title", text: file.basename });
    const counts = {
      threads: parsed.threads.length - changeThreads(parsed).size,
      suggestions: parsed.nodes.filter(isChangeNode).length,
      highlights: parsed.nodes.filter(
        (n, i) => n.kind === "highlight" && !anchors.has(i),
      ).length,
    };
    const parts: string[] = [];
    parts.push(`${counts.threads} ${counts.threads === 1 ? "comment" : "comments"}`);
    parts.push(`${counts.suggestions} ${counts.suggestions === 1 ? "suggestion" : "suggestions"}`);
    if (counts.highlights > 0) {
      parts.push(`${counts.highlights} ${counts.highlights === 1 ? "highlight" : "highlights"}`);
    }
    header.createDiv({ cls: "tc-header-counts", text: parts.join(" · ") });
  }

  private renderThreadCard(
    list: HTMLElement,
    file: TFile,
    source: string,
    parsed: ParseResult,
    thread: Thread,
    threadNumber: number,
  ): void {
    const anchorNode = thread.anchorIndex !== null ? parsed.nodes[thread.anchorIndex] : null;
    const anchor = anchorNode?.kind === "highlight" ? anchorNode : null;
    const card = list.createDiv({ cls: "tc-card tc-card-thread" });
    card.setAttr("data-tc-card-offset", String(thread.from));
    // Clicking the anchored span inline focuses this card, not a highlight card.
    if (anchor) card.setAttr("data-tc-card-anchor", String(anchor.from));
    const isCollapsed = this.collapsedCards.has(thread.from);
    if (isCollapsed) card.addClass("tc-card-collapsed");

    card.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".tc-card-toggle")) return;
      if (this.collapsedCards.has(thread.from)) {
        this.toggleCardCollapsed(thread.from);
        return;
      }
      if (target.closest(".tc-card-actions, .tc-reply, button, textarea, input"))
        return;
      // With an anchor, jump to the commented span rather than the chip.
      const from = anchor ? anchor.from : thread.from;
      this.host.revealOffset(file, from, thread.to - from, true);
    });

    const root = parsed.nodes[thread.rootIndex] as CommentNode;
    this.renderThreadHeader(card, source, thread, threadNumber, root, () => {
      void (async () => {
        const confirmed = await this.confirmDestructiveAction(
          "Delete thread",
          anchor
            ? "Remove this entire comment thread from the note and unhighlight the text it points at."
            : "Remove this entire comment thread from the note.",
          "Delete thread",
        );
        if (!confirmed) return;
        // Render-time source, so a doc change while the dialog was open makes
        // rebaseEdits fail closed instead of matching whatever text moved here.
        const edits = [deleteThread(source, thread)];
        if (anchor) edits.unshift(removeHighlight(anchor));
        await this.host.applyEdits(file, edits);
      })();
    });

    if (anchor) {
      const quote = card.createDiv({ cls: "tc-thread-anchor" });
      this.renderTextInto(quote, anchor.text);
    }

    this.renderMessages(card, file, parsed, thread, anchor);
    this.renderComposer(card, file, "Reply…", "Reply", this.replyDrafts, thread.from, (text) =>
      appendReply(
        this.currentSource,
        thread,
        parsed,
        text,
        this.host.localAuthorName(),
        this.host.replyDateStyle(),
      ),
    );
  }

  /**
   * The thread's messages, each with a delete button. Deleting the last one
   * also unhighlights `highlightAnchor`; a change anchor is never touched.
   */
  private renderMessages(
    card: HTMLElement,
    file: TFile,
    parsed: ParseResult,
    thread: Thread,
    highlightAnchor: HighlightNode | null,
  ): void {
    const messages = card.createDiv({ cls: "tc-messages" });
    const ids: number[] = [thread.rootIndex, ...thread.replyIndexes];
    for (const idx of ids) {
      const c = parsed.nodes[idx] as CommentNode;
      const resolved = this.resolveAuthor(c.metaAuthor, c.authorName);
      const msg = messages.createDiv({
        cls: `tc-message tc-message-${resolved.named !== null ? "named" : "you"}`,
      });
      if (resolved.named !== null) {
        msg.setAttr("data-author-hue", String(authorHueIndex(resolved.named)));
      }
      const meta = msg.createDiv({ cls: "tc-message-meta" });
      meta.createSpan({
        cls: "tc-message-author",
        text: resolved.label,
      });
      if (c.metaDate !== null) {
        meta.createSpan({ cls: "tc-message-date", text: c.metaDate });
      }
      this.iconButton(meta, "trash-2", "Delete message", () => {
        void (async () => {
          const unhighlight = highlightAnchor !== null && thread.replyIndexes.length === 0;
          const confirmed = await this.confirmDestructiveAction(
            "Delete message",
            unhighlight
              ? "Remove this comment from the note and unhighlight the text it points at."
              : "Remove this comment message from the note.",
            "Delete",
          );
          if (!confirmed) return;
          // Dropping the last message would leave the anchor as an orphan
          // highlight card, so it goes with it.
          const edits = unhighlight
            ? [removeHighlight(highlightAnchor), deleteCommentNode(c)]
            : [deleteCommentNode(c)];
          await this.host.applyEdits(file, edits);
        })();
      });

      const body = msg.createDiv({ cls: "tc-message-body" });
      this.renderTextInto(body, c.text);
    }
  }

  private renderComposer(
    parent: HTMLElement,
    file: TFile,
    placeholder: string,
    submitText: string,
    drafts: Map<number, string>,
    key: number,
    buildEdit: (text: string) => SourceEdit,
  ): HTMLElement {
    const box = parent.createDiv({ cls: "tc-reply" });
    const ta = box.createEl("textarea", {
      cls: "tc-reply-input",
      attr: { placeholder, rows: "2" },
    });
    ta.value = drafts.get(key) ?? "";
    ta.addEventListener("input", () => {
      drafts.set(key, ta.value);
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submit();
      }
    });
    const submit = async (): Promise<void> => {
      const text = ta.value.trim();
      if (!text) return;
      const validationError = validateReplyText(text);
      if (validationError) {
        new Notice(validationError);
        return;
      }
      drafts.delete(key);
      await this.host.applyEdits(file, [buildEdit(text)]);
    };
    const actions = box.createDiv({ cls: "tc-reply-actions" });
    const submitBtn = actions.createEl("button", { cls: "tc-btn-primary", text: submitText });
    submitBtn.addEventListener("click", () => void submit());
    return box;
  }

  /**
   * A suggestion card. With `thread` (a thread anchored on the change) the
   * card also carries the thread's messages and a reply box; resolving the
   * change removes the thread.
   */
  private renderSuggestionCard(
    list: HTMLElement,
    file: TFile,
    source: string,
    parsed: ParseResult,
    n: ChangeNode,
    thread: Thread | null,
    threadNumber: number,
  ): void {
    const card = list.createDiv({ cls: "tc-card tc-card-suggestion" });
    card.setAttr("data-tc-card-offset", String(n.from));
    // Clicking the thread's chip inline focuses this card.
    if (thread) card.setAttr("data-tc-card-anchor", String(thread.from));
    card.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".tc-reply, button, textarea, input")) return;
      if (thread) this.host.revealOffset(file, n.from, thread.to - n.from, true);
      else this.host.revealOffset(file, n.from, n.to - n.from);
    });

    const header = card.createDiv({ cls: "tc-card-header" });
    this.renderLineRef(header, source, n.from, thread ? `#${threadNumber}` : undefined);
    const actions = header.createDiv({ cls: "tc-card-actions" });
    this.iconButton(
      actions,
      "check",
      "Accept",
      () => void this.host.applyEdits(file, resolveChange(source, parsed, n, "accept")),
      "tc-icon-accept",
    );
    this.iconButton(
      actions,
      "x",
      "Reject",
      () => void this.host.applyEdits(file, resolveChange(source, parsed, n, "reject")),
      "tc-icon-reject",
    );
    let commentBox: HTMLElement | null = null;
    const openCommentBox = (): HTMLElement =>
      this.renderComposer(card, file, "Comment…", "Comment", this.commentDrafts, n.from, (text) =>
        appendComment(source, n, text, this.host.localAuthorName(), this.host.replyDateStyle()),
      );
    if (!thread) {
      this.iconButton(
        actions,
        "message-square-plus",
        "Comment",
        () => {
          if (commentBox) {
            commentBox.remove();
            commentBox = null;
            this.commentDrafts.delete(n.from);
          } else {
            this.commentDrafts.set(n.from, "");
            commentBox = openCommentBox();
            commentBox.querySelector("textarea")?.focus();
          }
        },
        "tc-icon-neutral",
      );
    }

    this.renderMetaRow(card, card, n.metaAuthor, null, n.metaDate, "tc-card-meta");
    this.renderDiff(card, n);

    if (thread) {
      this.renderMessages(card, file, parsed, thread, null);
      this.renderComposer(card, file, "Reply…", "Reply", this.replyDrafts, thread.from, (text) =>
        appendReply(
          this.currentSource,
          thread,
          parsed,
          text,
          this.host.localAuthorName(),
          this.host.replyDateStyle(),
        ),
      );
    } else if (this.commentDrafts.has(n.from)) {
      commentBox = openCommentBox();
    }
  }

  private renderDiff(card: HTMLElement, n: ChangeNode): void {
    const diff = card.createDiv({ cls: "tc-diff" });
    if (n.kind === "addition") {
      diff.createSpan({ cls: "tc-diff-label", text: "Insert" });
      this.renderTextInto(diff.createDiv({ cls: "tc-diff-added" }), n.text);
      return;
    }
    if (n.kind === "deletion") {
      diff.createSpan({ cls: "tc-diff-label", text: "Delete" });
      this.renderTextInto(diff.createDiv({ cls: "tc-diff-removed" }), n.text);
      return;
    }
    diff.createSpan({ cls: "tc-diff-label", text: "Replace" });
    const removed = diff.createDiv({ cls: "tc-diff-removed" });
    const arrow = diff.createDiv({ cls: "tc-diff-arrow" });
    arrow.setText("→");
    const added = diff.createDiv({ cls: "tc-diff-added" });
    if (this.host.highlightChangedChars()) {
      const { oldRuns, newRuns } = diffChars(n.oldText, n.newText);
      this.renderDiffRuns(removed, oldRuns);
      this.renderDiffRuns(added, newRuns);
    } else {
      this.renderTextInto(removed, n.oldText);
      this.renderTextInto(added, n.newText);
    }
  }

  private renderHighlightCard(
    list: HTMLElement,
    file: TFile,
    source: string,
    n: HighlightNode,
  ): void {
    const card = list.createDiv({ cls: "tc-card tc-card-highlight" });
    card.setAttr("data-tc-card-offset", String(n.from));
    const isCollapsed = this.collapsedCards.has(n.from);
    if (isCollapsed) card.addClass("tc-card-collapsed");

    card.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".tc-card-toggle")) return;
      if (this.collapsedCards.has(n.from)) {
        this.toggleCardCollapsed(n.from);
        return;
      }
      if (target.closest("button")) return;
      this.host.revealOffset(file, n.from, n.to - n.from);
    });

    const header = card.createDiv({ cls: "tc-card-header" });
    let line = 1;
    for (let i = 0; i < n.from && i < source.length; i++) {
      if (source.charCodeAt(i) === 10) line++;
    }
    header.createDiv({ cls: "tc-line-ref", text: `Highlight · Line ${line}` });
    const actions = header.createDiv({ cls: "tc-card-actions" });
    this.iconButton(actions, "eraser", "Remove highlight", () => {
      void this.host.applyEdits(file, [removeHighlight(n)]);
    });
    const toggle = header.createEl("button", {
      cls: "clickable-icon tc-card-toggle tc-icon-btn",
      attr: { "aria-label": "Toggle highlight" },
    });
    setIcon(toggle, isCollapsed ? "chevron-right" : "chevron-down");
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleCardCollapsed(n.from);
    });

    const previewText = n.text.split(/\r?\n/, 1)[0].trim();
    const preview = card.createDiv({ cls: "tc-card-preview" });
    preview.setText(previewText || "(empty)");

    const body = card.createDiv({ cls: "tc-card-body" });
    this.renderMetaRow(body, card, n.metaAuthor, null, n.metaDate, "tc-card-meta");
    const diff = body.createDiv({ cls: "tc-diff" });
    const diffBody = diff.createDiv({ cls: "tc-diff-highlight" });
    this.renderTextInto(diffBody, n.text);
  }

  private iconButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
    cls = "",
  ): HTMLButtonElement {
    const btn = parent.createEl("button", {
      cls: `clickable-icon tc-icon-btn ${cls}`.trim(),
      attr: { "aria-label": label },
    });
    setIcon(btn, icon);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  private renderLineRef(
    parent: HTMLElement,
    source: string,
    offset: number,
    prefix?: string,
  ): void {
    let line = 1;
    for (let i = 0; i < offset && i < source.length; i++) {
      if (source.charCodeAt(i) === 10) line++;
    }
    const text = prefix ? `${prefix} · Line ${line}` : `Line ${line}`;
    parent.createDiv({ cls: "tc-line-ref", text });
  }

  private renderThreadHeader(
    card: HTMLElement,
    source: string,
    thread: Thread,
    threadNumber: number,
    root: CommentNode,
    onDelete: () => void,
  ): void {
    const header = card.createDiv({ cls: "tc-thread-header" });

    let line = 1;
    for (let i = 0; i < thread.from && i < source.length; i++) {
      if (source.charCodeAt(i) === 10) line++;
    }
    header.createDiv({ cls: "tc-line-ref", text: `#${threadNumber} · Line ${line}` });

    const replyCount = thread.replyIndexes.length;
    if (replyCount > 0) {
      header.createSpan({
        cls: "tc-thread-reply-count",
        text: `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`,
      });
    }

    const actions = header.createDiv({ cls: "tc-card-actions" });
    this.iconButton(actions, "trash-2", "Delete thread", onDelete);

    const toggle = header.createEl("button", {
      cls: "clickable-icon tc-card-toggle tc-thread-toggle tc-icon-btn",
      attr: { "aria-label": "Toggle thread" },
    });
    const isCollapsed = this.collapsedCards.has(thread.from);
    setIcon(toggle, isCollapsed ? "chevron-right" : "chevron-down");
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleCardCollapsed(thread.from);
    });

    const previewText = root.text.split(/\r?\n/, 1)[0].trim();
    const preview = card.createDiv({ cls: "tc-thread-preview" });
    preview.setText(previewText || "(empty)");
  }

  private toggleCardCollapsed(offset: number): void {
    const willCollapse = !this.collapsedCards.has(offset);
    if (willCollapse) this.collapsedCards.add(offset);
    else this.collapsedCards.delete(offset);
    const card = this.contentEl.querySelector<HTMLElement>(
      `[data-tc-card-offset="${offset}"]`,
    );
    if (!card) return;
    card.toggleClass("tc-card-collapsed", willCollapse);
    const toggle = card.querySelector<HTMLElement>(".tc-card-toggle");
    if (toggle) setIcon(toggle, willCollapse ? "chevron-right" : "chevron-down");
  }

  /**
   * Resolve the display author for a node per the precedence chain
   * (§5.2): metaAuthor → legacy authorName (comments only) → localAuthorName
   * setting → "You". Returns the resolved label plus the underlying named
   * author (null when it falls through to the "You" sentinel) so callers can
   * decide whether to apply a hue.
   */
  private resolveAuthor(
    metaAuthor: string | null,
    legacyAuthorName: string | null,
  ): { label: string; named: string | null } {
    const local = this.host.localAuthorName().trim();
    const named = metaAuthor ?? legacyAuthorName ?? (local !== "" ? local : null);
    return { label: named ?? "You", named };
  }

  /**
   * Render an author/date meta row onto a card or message. `named` drives the
   * hue; when both the resolved name and date are absent the row is omitted.
   * `target` receives `data-author-hue` for the color border/tint.
   */
  private renderMetaRow(
    parent: HTMLElement,
    target: HTMLElement,
    metaAuthor: string | null,
    legacyAuthorName: string | null,
    metaDate: string | null,
    cls: string,
  ): void {
    const { label, named } = this.resolveAuthor(metaAuthor, legacyAuthorName);
    if (named !== null) target.setAttr("data-author-hue", String(authorHueIndex(named)));
    // Hide the row entirely only when there is neither a real author nor a date.
    if (named === null && metaDate === null) return;
    const row = parent.createDiv({ cls });
    row.createSpan({ cls: "tc-meta-author", text: label });
    if (metaDate !== null) row.createSpan({ cls: "tc-meta-date", text: metaDate });
  }

  private renderTextInto(el: HTMLElement, text: string): void {
    el.setText(text);
  }

  private renderDiffRuns(el: HTMLElement, runs: DiffRun[]): void {
    for (const run of runs) {
      if (run.changed) el.createSpan({ cls: "tc-diff-changed", text: run.text });
      else el.appendText(run.text);
    }
  }

  private confirmDestructiveAction(
    title: string,
    message: string,
    confirmText: string,
  ): Promise<boolean> {
    if (!this.host.confirmBeforeDelete()) return Promise.resolve(true);
    return new Promise((resolve) => {
      new ConfirmActionModal(this.app, title, message, confirmText, resolve).open();
    });
  }
}

class ConfirmActionModal extends Modal {
  private didResolve = false;

  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    private readonly confirmText: string,
    private readonly resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(this.title);
    contentEl.createEl("p", { text: this.message });

    const buttons = contentEl.createDiv({ cls: "tc-confirm-buttons" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => {
      this.finish(false);
    });

    const confirm = buttons.createEl("button", {
      cls: "mod-warning",
      text: this.confirmText,
    });
    confirm.addEventListener("click", () => {
      this.finish(true);
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.didResolve) this.resolve(false);
  }

  private finish(confirmed: boolean): void {
    this.didResolve = true;
    this.resolve(confirmed);
    this.close();
  }
}
