// Keeps a per-file FileSummary for every markdown file in the vault, kept
// current from vault events. One instance per plugin; the pending-changes
// overview and the status-bar count both read from it.
//
// The initial scan reads every markdown file once (cachedRead, so it is the
// metadata cache's copy when available) in small batches, yielding to the
// event loop between batches so a large vault does not freeze the UI at
// startup. After that only the files that change are re-read.

import { TFile, TAbstractFile, type App, type Plugin } from "obsidian";

import { pendingCount, summarizeSource, type FileRow, type FileSummary } from "./pending";

const BATCH_SIZE = 25;

export class VaultIndex {
  private summaries = new Map<string, FileSummary>();
  private listeners = new Set<() => void>();
  /** True once the first full scan has finished. */
  ready = false;
  /** True while a full scan is running. */
  scanning = false;
  private scanSeq = 0;

  constructor(private app: App) {}

  /** Subscribe to vault events for the plugin's lifetime. */
  register(plugin: Plugin): void {
    const vault = this.app.vault;
    plugin.registerEvent(vault.on("modify", (f) => void this.onFileChanged(f)));
    plugin.registerEvent(vault.on("create", (f) => void this.onFileChanged(f)));
    plugin.registerEvent(vault.on("delete", (f) => this.onFileRemoved(f.path)));
    plugin.registerEvent(
      vault.on("rename", (f, oldPath) => {
        this.onFileRemoved(oldPath);
        void this.onFileChanged(f);
      }),
    );
  }

  /** Called whenever any summary changes or a full scan finishes. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  /** Re-read every markdown file. A scan started while one is running supersedes it. */
  async scanAll(): Promise<void> {
    const seq = ++this.scanSeq;
    this.scanning = true;
    this.notify();
    const next = new Map<string, FileSummary>();
    const files = this.app.vault.getMarkdownFiles();
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (file) => {
          const summary = await this.summarize(file);
          if (summary && pendingCount(summary) > 0) next.set(file.path, summary);
        }),
      );
      if (seq !== this.scanSeq) return;
      // Yield so the UI stays responsive between batches.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      if (seq !== this.scanSeq) return;
    }
    this.summaries = next;
    this.ready = true;
    this.scanning = false;
    this.notify();
  }

  /** Update one file from its current contents, or a given source string. */
  async refreshFile(file: TFile, source?: string): Promise<void> {
    const summary = source !== undefined ? summarizeSource(source) : await this.summarize(file);
    if (!summary) return;
    this.setSummary(file.path, summary);
  }

  private setSummary(path: string, summary: FileSummary): void {
    const prev = this.summaries.get(path);
    if (pendingCount(summary) === 0) {
      if (!prev) return;
      this.summaries.delete(path);
    } else {
      if (
        prev &&
        prev.suggestions === summary.suggestions &&
        prev.comments === summary.comments &&
        prev.highlights === summary.highlights
      ) {
        return;
      }
      this.summaries.set(path, summary);
    }
    this.notify();
  }

  private async summarize(file: TFile): Promise<FileSummary | null> {
    try {
      return summarizeSource(await this.app.vault.cachedRead(file));
    } catch {
      return null;
    }
  }

  private async onFileChanged(f: TAbstractFile): Promise<void> {
    if (!(f instanceof TFile) || f.extension !== "md") return;
    await this.refreshFile(f);
  }

  private onFileRemoved(path: string): void {
    if (this.summaries.delete(path)) this.notify();
  }

  /** Every file with at least one pending item, unordered. */
  rows(): FileRow[] {
    return Array.from(this.summaries, ([path, s]) => ({ path, ...s }));
  }

  summaryFor(path: string): FileSummary | undefined {
    return this.summaries.get(path);
  }
}
