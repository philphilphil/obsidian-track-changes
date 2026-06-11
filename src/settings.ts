import { App, PluginSettingTab, Setting } from "obsidian";
import type TrackChangesCriticMarkupPlugin from "./main";
import { DEFAULT_FINALIZE, type FinalizeOptions } from "./operations";

export interface TrackChangesCriticMarkupSettings {
  /**
   * Show comment icons in reading mode. On by default — each thread renders
   * as a single inline icon; hovering reveals the full thread. Turn off for
   * a clean publish preview with no review artifacts.
   */
  readingShowComments: boolean;
  /**
   * When jumping to a comment from the panel, also select the raw markup so
   * Live Preview unrenders the chip and exposes the `{>>…<<}` source. Off by
   * default — most users prefer the chip to stay rendered after the jump.
   */
  revealMarkupOnCommentJump: boolean;
  clickMarksToOpenPanel: boolean;
  /**
   * Ask for confirmation before deleting a comment message or thread from the
   * panel. On by default. Turn off if you rely on undo / version control and
   * find the dialog gets in the way.
   */
  confirmBeforeDelete: boolean;
  /** Defaults that pre-populate the Finalize dialog. */
  finalize: FinalizeOptions;
}

export const DEFAULT_SETTINGS: TrackChangesCriticMarkupSettings = {
  readingShowComments: true,
  revealMarkupOnCommentJump: false,
  clickMarksToOpenPanel: false,
  confirmBeforeDelete: true,
  finalize: { ...DEFAULT_FINALIZE },
};

export class TrackChangesCriticMarkupSettingsTab extends PluginSettingTab {
  plugin: TrackChangesCriticMarkupPlugin;

  constructor(app: App, plugin: TrackChangesCriticMarkupPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Show comments in reading view")
      .setDesc(
        "When on (default), each comment thread renders as a small icon — hover to see the full thread. Turn off for a clean publish preview with no review artifacts. Suggestions (additions, deletions, substitutions, highlights) are always shown in their accepted form.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.readingShowComments).onChange(async (v) => {
          this.plugin.settings.readingShowComments = v;
          await this.plugin.saveSettings();
          this.plugin.rerenderReadingViews();
        }),
      );

    new Setting(containerEl)
      .setName("Reveal CriticMarkup on comment jump")
      .setDesc(
        "When clicking a comment card, also select the markup so its raw {>>…<<} source is shown. Off by default — the chip stays rendered.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.revealMarkupOnCommentJump).onChange(async (v) => {
          this.plugin.settings.revealMarkupOnCommentJump = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Click highlighted text to open in panel")
      .setDesc(
        "When ON, a plain click on inline additions, deletions, highlights, or substitution halves opens the review panel. When OFF (default), the click places the cursor inside the inner text for in-place editing. Cmd/Ctrl-click always opens the panel; comment chips always open the panel.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.clickMarksToOpenPanel).onChange(async (v) => {
          this.plugin.settings.clickMarksToOpenPanel = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Confirm before deleting")
      .setDesc(
        "When ON (default), deleting a comment message or thread from the panel asks for confirmation. Turn off to delete immediately — useful if you rely on undo or version control.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.confirmBeforeDelete).onChange(async (v) => {
          this.plugin.settings.confirmBeforeDelete = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Finalize for publish — defaults").setHeading();

    new Setting(containerEl)
      .setName("Additions")
      .addDropdown((d) =>
        d
          .addOption("accept", "Accept (keep new text)")
          .addOption("reject", "Reject (remove)")
          .setValue(this.plugin.settings.finalize.additions)
          .onChange(async (v) => {
            this.plugin.settings.finalize.additions = v as "accept" | "reject";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Deletions")
      .addDropdown((d) =>
        d
          .addOption("accept", "Accept (remove)")
          .addOption("reject", "Reject (keep original)")
          .setValue(this.plugin.settings.finalize.deletions)
          .onChange(async (v) => {
            this.plugin.settings.finalize.deletions = v as "accept" | "reject";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Substitutions")
      .addDropdown((d) =>
        d
          .addOption("accept", "Accept (use new)")
          .addOption("reject", "Reject (keep old)")
          .setValue(this.plugin.settings.finalize.substitutions)
          .onChange(async (v) => {
            this.plugin.settings.finalize.substitutions = v as "accept" | "reject";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Strip highlights")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.finalize.stripHighlights).onChange(async (v) => {
          this.plugin.settings.finalize.stripHighlights = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}
