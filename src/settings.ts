import { App, PluginSettingTab, Setting } from "obsidian";
import type TrackChangesCriticMarkupPlugin from "./main";
import { DEFAULT_FINALIZE, type FinalizeOptions } from "./operations";

export interface TrackChangesCriticMarkupSettings {
  /** Where to open the review panel by default. */
  panelSide: "left" | "right";
  /** How reading mode renders suggestions. */
  readingMode: "accepted" | "raw";
  /** Defaults that pre-populate the Finalize dialog. */
  finalize: FinalizeOptions;
}

export const DEFAULT_SETTINGS: TrackChangesCriticMarkupSettings = {
  panelSide: "right",
  readingMode: "accepted",
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
      .setName("Panel side")
      .setDesc("Which sidebar the review panel opens in by default.")
      .addDropdown((d) =>
        d
          .addOption("right", "Right")
          .addOption("left", "Left")
          .setValue(this.plugin.settings.panelSide)
          .onChange(async (v) => {
            this.plugin.settings.panelSide = v as "left" | "right";
            await this.plugin.saveSettings();
          }),
      );

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
