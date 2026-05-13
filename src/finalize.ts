// "Finalize for publish" command + confirmation modal.

import { App, Modal, Setting, TFile, Notice } from "obsidian";
import { parse } from "./parser";
import {
  finalizeEdits,
  summarizeFinalize,
  type FinalizeOptions,
  type FinalizeSummary,
  type SourceEdit,
} from "./operations";

export class FinalizeModal extends Modal {
  private opts: FinalizeOptions;
  private summary: FinalizeSummary;
  private onConfirm: (edits: SourceEdit[]) => Promise<void>;
  private source: string;

  constructor(
    app: App,
    file: TFile,
    source: string,
    defaults: FinalizeOptions,
    onConfirm: (edits: SourceEdit[]) => Promise<void>,
  ) {
    super(app);
    this.source = source;
    this.opts = { ...defaults };
    this.onConfirm = onConfirm;
    this.titleEl.setText(`Finalize "${file.basename}" for publish`);
    this.summary = summarizeFinalize(parse(source), this.opts);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("kcm-finalize-modal");

    contentEl.createEl("p", {
      text: "Strip all comment threads and resolve every remaining suggestion. Default actions are listed below. The file is rewritten in one step; you can undo from the editor.",
    });

    new Setting(contentEl)
      .setName("Additions")
      .setDesc("How to handle {++text++} blocks.")
      .addDropdown((d) =>
        d
          .addOption("accept", "Accept (keep new text)")
          .addOption("reject", "Reject (remove)")
          .setValue(this.opts.additions)
          .onChange((v) => {
            this.opts.additions = v as "accept" | "reject";
            this.refreshSummary();
          }),
      );

    new Setting(contentEl)
      .setName("Deletions")
      .setDesc("How to handle {--text--} blocks.")
      .addDropdown((d) =>
        d
          .addOption("accept", "Accept (remove)")
          .addOption("reject", "Reject (keep original)")
          .setValue(this.opts.deletions)
          .onChange((v) => {
            this.opts.deletions = v as "accept" | "reject";
            this.refreshSummary();
          }),
      );

    new Setting(contentEl)
      .setName("Substitutions")
      .setDesc("How to handle {~~old~>new~~} blocks.")
      .addDropdown((d) =>
        d
          .addOption("accept", "Accept (use new)")
          .addOption("reject", "Reject (keep old)")
          .setValue(this.opts.substitutions)
          .onChange((v) => {
            this.opts.substitutions = v as "accept" | "reject";
            this.refreshSummary();
          }),
      );

    new Setting(contentEl)
      .setName("Strip highlights")
      .setDesc("Remove {==…==} markers, keep their content.")
      .addToggle((t) =>
        t.setValue(this.opts.stripHighlights).onChange((v) => {
          this.opts.stripHighlights = v;
          this.refreshSummary();
        }),
      );

    new Setting(contentEl).setName("Summary").setHeading();
    const summaryEl = contentEl.createDiv({ cls: "kcm-finalize-summary" });
    this.renderSummary(summaryEl);

    const buttons = contentEl.createDiv({ cls: "kcm-finalize-buttons" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const apply = buttons.createEl("button", { cls: "mod-cta", text: "Apply" });
    apply.addEventListener("click", async () => {
      const edits = finalizeEdits(parse(this.source), this.opts);
      this.close();
      try {
        await this.onConfirm(edits);
      } catch (err) {
        console.error("Finalize failed", err);
        new Notice("Finalize failed; see console.");
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private refreshSummary(): void {
    this.summary = summarizeFinalize(parse(this.source), this.opts);
    const target = this.contentEl.querySelector(".kcm-finalize-summary");
    if (target instanceof HTMLElement) {
      target.empty();
      this.renderSummary(target);
    }
  }

  private renderSummary(el: HTMLElement): void {
    const s = this.summary;
    const lines = [
      `Strip ${s.comments} comment ${s.comments === 1 ? "block" : "blocks"}.`,
    ];
    if (s.additionsAccepted) lines.push(`Accept ${s.additionsAccepted} addition(s).`);
    if (s.additionsRejected) lines.push(`Reject ${s.additionsRejected} addition(s).`);
    if (s.deletionsAccepted) lines.push(`Accept ${s.deletionsAccepted} deletion(s).`);
    if (s.deletionsRejected) lines.push(`Reject ${s.deletionsRejected} deletion(s).`);
    if (s.substitutionsAccepted) lines.push(`Accept ${s.substitutionsAccepted} substitution(s).`);
    if (s.substitutionsRejected) lines.push(`Reject ${s.substitutionsRejected} substitution(s).`);
    if (s.highlights && this.opts.stripHighlights) lines.push(`Strip ${s.highlights} highlight(s).`);
    const ul = el.createEl("ul");
    for (const line of lines) ul.createEl("li", { text: line });
  }
}
