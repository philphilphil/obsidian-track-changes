import { App, PluginSettingTab, Setting } from "obsidian";
import type TrackChangesCriticMarkupPlugin from "./main";
import { DEFAULT_FINALIZE, type FinalizeOptions } from "./operations";

export interface TrackChangesCriticMarkupSettings {
  /** How reading mode renders suggestions. */
  readingMode: "accepted" | "raw";
  /**
   * When jumping to a comment from the panel, also select the raw markup so
   * Live Preview unrenders the chip and exposes the `{>>…<<}` source. Off by
   * default — most users prefer the chip to stay rendered after the jump.
   */
  revealMarkupOnCommentJump: boolean;
  /**
   * When ON, a plain click on any mark opens the review panel (legacy).
   * When OFF (default):
   *  - addition/deletion/highlight: plain click places the cursor in the
   *    inner text;
   *  - substitution: plain click on the "old" or "new" half drops the
   *    cursor into that half of the raw `{~~old~>new~~}` for inline
   *    editing, click on the arrow opens the panel;
   *  - comment chip: any click opens the panel (it's a button).
   *  Cmd/Ctrl-click always opens the panel. Issue #7.
   */
  clickMarksToOpenPanel: boolean;
  /** Defaults that pre-populate the Finalize dialog. */
  finalize: FinalizeOptions;
}

export const DEFAULT_SETTINGS: TrackChangesCriticMarkupSettings = {
  readingMode: "accepted",
  revealMarkupOnCommentJump: false,
  clickMarksToOpenPanel: false,
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
      .setName("Reading mode for suggestions")
      .setDesc(
        "How suggestions render in reading mode. 'Accepted' previews the post-publish version; 'Raw' shows old/new side by side.",
      )
      .addDropdown((d) =>
        d
          .addOption("accepted", "Accepted form")
          .addOption("raw", "Raw (both sides)")
          .setValue(this.plugin.settings.readingMode)
          .onChange(async (v) => {
            this.plugin.settings.readingMode = v as "accepted" | "raw";
            await this.plugin.saveSettings();
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
        "When ON, clicking any mark opens the review panel. When OFF (default), plain click on an addition/deletion/highlight places the cursor in its text; clicking the 'old' or 'new' half of a substitution exposes the raw markup so you can refine that half in place; comment chips always open the panel. Cmd/Ctrl-click always opens the panel.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.clickMarksToOpenPanel).onChange(async (v) => {
          this.plugin.settings.clickMarksToOpenPanel = v;
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
