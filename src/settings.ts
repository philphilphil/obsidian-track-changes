import { App, PluginSettingTab, debounce, type SettingDefinitionItem } from "obsidian";
import type TrackChangesCriticMarkupPlugin from "./main";
import { DEFAULT_FINALIZE, type FinalizeOptions } from "./operations";
import type { ReplyDateStyle } from "./operations";

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
  /**
   * Within a substitution's old→new text, emphasize the specific characters
   * that changed (in the panel's Replace card and inline in Live Preview). On
   * by default; when off, the old and new text show without per-character
   * emphasis.
   */
  highlightChangedChars: boolean;
  /**
   * The local user's display name for authored marks. Two roles, both optional:
   *   1. Display fallback — a mark with no `author=` and no legacy `<Name>:`
   *      renders as this name. Empty string is the sentinel for "You".
   *   2. Reply stamping — when non-empty, replies the plugin writes carry
   *      `author=<name>`; empty ⇒ replies carry only `date=` and render as "You".
   */
  localAuthorName: string;
  /** Whether plugin-written replies stamp a date ("date", default) or a full
   *  second-precision ISO timestamp ("datetime"). Display-only either way. */
  replyDateStyle: ReplyDateStyle;
  /** Defaults that pre-populate the Finalize dialog. */
  finalize: FinalizeOptions;
}

export const DEFAULT_SETTINGS: TrackChangesCriticMarkupSettings = {
  readingShowComments: true,
  revealMarkupOnCommentJump: false,
  clickMarksToOpenPanel: false,
  confirmBeforeDelete: true,
  highlightChangedChars: true,
  localAuthorName: "",
  replyDateStyle: "date",
  finalize: { ...DEFAULT_FINALIZE },
};

const FINALIZE_PREFIX = "finalize.";

export class TrackChangesCriticMarkupSettingsTab extends PluginSettingTab {
  plugin: TrackChangesCriticMarkupPlugin;

  // Keep the in-memory value fresh every keystroke, but debounce the disk
  // write + full re-render (all reading views + panel rebuild) so typing a
  // name doesn't thrash the UI.
  // resetTimer=true: each keystroke restarts the 500ms window, so the
  // write + re-render fire once after typing settles, not periodically
  // mid-input (matches the panel's rerender debounce in view.ts).
  private persistAuthorName = debounce(
    async () => {
      await this.plugin.saveSettings();
      this.plugin.refreshAfterSettingsChange();
    },
    500,
    true,
  );

  constructor(app: App, plugin: TrackChangesCriticMarkupPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: "group",
        heading: "Editing & display",
        items: [
          {
            name: "Show comments in reading view",
            desc: "Render comment threads as hover icons in reading view. Off hides them for a clean preview. Suggestions always show in accepted form.",
            control: { type: "toggle", key: "readingShowComments" },
          },
          {
            name: "Reveal CriticMarkup on comment jump",
            desc: "Opening a comment from the panel reveals its raw {>>…<<} source instead of the rendered chip.",
            control: { type: "toggle", key: "revealMarkupOnCommentJump" },
          },
          {
            name: "Click highlighted text to open in panel",
            desc: "Plain-click inline markup to open the panel instead of editing in place. Cmd/Ctrl-click and comment chips always open the panel.",
            control: { type: "toggle", key: "clickMarksToOpenPanel" },
          },
          {
            name: "Highlight changed characters",
            desc: "In a substitution, emphasize the specific characters that changed within the old and new text. Applies to the panel and Live Preview.",
            control: { type: "toggle", key: "highlightChangedChars" },
          },
          {
            name: "Confirm before deleting",
            desc: "Ask before deleting a comment or thread. Turn off to delete immediately.",
            control: { type: "toggle", key: "confirmBeforeDelete" },
          },
        ],
      },
      {
        type: "group",
        heading: "Identity",
        items: [
          {
            name: "Your name",
            desc: "Display name stamped on replies you write and used as the author fallback for unattributed marks. Leave blank to appear as \"You\".",
            control: { type: "text", key: "localAuthorName", placeholder: "You" },
          },
          {
            name: "Reply date style",
            desc: "How replies you write stamp the date. Display-only.",
            control: {
              type: "dropdown",
              key: "replyDateStyle",
              options: {
                date: "Date (2026-06-14)",
                datetime: "Timestamp (2026-06-14T12:23:46Z)",
              },
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Finalize for publish — defaults",
        items: [
          {
            name: "Additions",
            control: {
              type: "dropdown",
              key: "finalize.additions",
              options: { accept: "Accept (keep new text)", reject: "Reject (remove)" },
            },
          },
          {
            name: "Deletions",
            control: {
              type: "dropdown",
              key: "finalize.deletions",
              options: { accept: "Accept (remove)", reject: "Reject (keep original)" },
            },
          },
          {
            name: "Substitutions",
            control: {
              type: "dropdown",
              key: "finalize.substitutions",
              options: { accept: "Accept (use new)", reject: "Reject (keep old)" },
            },
          },
          {
            name: "Strip highlights",
            control: { type: "toggle", key: "finalize.stripHighlights" },
          },
          {
            name: "Strip AI-added text",
            desc: "Remove {=+…+=} markers, keep their content.",
            control: { type: "toggle", key: "finalize.stripAiText" },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    if (key.startsWith(FINALIZE_PREFIX)) {
      return (this.plugin.settings.finalize as unknown as Record<string, unknown>)[
        key.slice(FINALIZE_PREFIX.length)
      ];
    }
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key.startsWith(FINALIZE_PREFIX)) {
      (this.plugin.settings.finalize as unknown as Record<string, unknown>)[
        key.slice(FINALIZE_PREFIX.length)
      ] = value;
      await this.plugin.saveSettings();
      return;
    }

    if (key === "localAuthorName") {
      this.plugin.settings.localAuthorName = String(value).trim();
      this.persistAuthorName();
      return;
    }

    (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    await this.plugin.saveSettings();

    if (key === "readingShowComments") this.plugin.rerenderReadingViews();
    else if (key === "highlightChangedChars") this.plugin.refreshCharHighlighting();
  }
}
