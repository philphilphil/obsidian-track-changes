import { App, PluginSettingTab, debounce, type SettingDefinitionItem } from "obsidian";
import type TrackChangesCriticMarkupPlugin from "./main";
import { DEFAULT_FINALIZE, type FinalizeOptions } from "./operations";
import type { ReplyDateStyle } from "./operations";
import {
  DEFAULT_MARK_COLORS,
  DEFAULT_MARK_INTENSITY,
  EMPTY_MARK_COLORS,
  MAX_MARK_INTENSITY,
  MIN_MARK_INTENSITY,
  type MarkColorKey,
  type MarkColors,
} from "./colors";

export type PanelLocation = "sidebar" | "split";

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
  /** Where the review panel opens when it isn't already open: the right
   *  sidebar ("sidebar", default) or a new vertical split beside the active
   *  note ("split"). An existing panel is always revealed where it is. */
  panelLocation: PanelLocation;
  /** Show the vault-wide "N to review · M files" item in the status bar
   *  (hidden automatically when nothing is pending). On by default. */
  showPendingStatusBar: boolean;
  /** Colour overrides for marks; `""` per entry keeps the built-in colour. */
  colors: MarkColors;
  /** Percentage multiplier on the tint alphas (100 = built-in strength). */
  markIntensity: number;
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
  panelLocation: "sidebar",
  showPendingStatusBar: true,
  colors: { ...EMPTY_MARK_COLORS },
  markIntensity: DEFAULT_MARK_INTENSITY,
  finalize: { ...DEFAULT_FINALIZE },
};

const FINALIZE_PREFIX = "finalize.";
const COLORS_PREFIX = "colors.";

const COLOR_ROWS: { key: MarkColorKey; name: string; desc?: string }[] = [
  { key: "addition", name: "Addition", desc: "Also the new text of a substitution." },
  { key: "deletion", name: "Deletion", desc: "Also the old text of a substitution." },
  { key: "highlight", name: "Highlight" },
  { key: "aiTextStart", name: "AI-added text — gradient start" },
  { key: "aiTextEnd", name: "AI-added text — gradient end" },
  { key: "commentYou", name: "Your comments" },
  { key: "commentAi", name: "Other authors' comments", desc: "Background of comment markup in the editor." },
];

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
            name: "Open review panel in",
            desc: "Where the panel opens when it isn't open yet. An open panel stays where it is.",
            control: {
              type: "dropdown",
              key: "panelLocation",
              options: {
                sidebar: "Right sidebar",
                split: "New split beside the note",
              },
            },
          },
          {
            name: "Confirm before deleting",
            desc: "Ask before deleting a comment or thread. Turn off to delete immediately.",
            control: { type: "toggle", key: "confirmBeforeDelete" },
          },
          {
            name: "Show pending count in status bar",
            desc: "A vault-wide \"N to review · M files\" item in the status bar; click it to open the pending changes overview. Hidden when nothing is pending.",
            control: { type: "toggle", key: "showPendingStatusBar" },
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
        type: "page",
        name: "Colours",
        desc: "Mark colours and tint strength.",
        items: [
          {
            name: "Mark intensity",
            desc: "Strength of the background tints on additions, deletions, highlights and comments.",
            control: {
              type: "slider",
              key: "markIntensity",
              min: MIN_MARK_INTENSITY,
              max: MAX_MARK_INTENSITY,
              step: 25,
              displayFormat: (v) => `${v}%`,
            },
          },
          ...COLOR_ROWS.map((r) => ({
            name: r.name,
            desc: r.desc,
            control: { type: "color" as const, key: COLORS_PREFIX + r.key },
          })),
          {
            name: "Reset colours",
            desc: "Restore the built-in colours and intensity.",
            action: () => void this.resetColors(),
          },
        ],
      },
      {
        type: "page",
        name: "Finalize for publish",
        desc: "Defaults for the Finalize dialog.",
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
    if (key.startsWith(COLORS_PREFIX)) {
      const k = key.slice(COLORS_PREFIX.length) as MarkColorKey;
      return this.plugin.settings.colors[k] || DEFAULT_MARK_COLORS[k];
    }
    if (key.startsWith(FINALIZE_PREFIX)) {
      return (this.plugin.settings.finalize as unknown as Record<string, unknown>)[
        key.slice(FINALIZE_PREFIX.length)
      ];
    }
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key.startsWith(COLORS_PREFIX)) {
      const k = key.slice(COLORS_PREFIX.length) as MarkColorKey;
      const hex = String(value).toLowerCase();
      this.plugin.settings.colors[k] = hex === DEFAULT_MARK_COLORS[k] ? "" : hex;
      await this.plugin.saveSettings();
      this.plugin.applyColors();
      return;
    }
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
    else if (key === "markIntensity") this.plugin.applyColors();
  }

  private async resetColors(): Promise<void> {
    this.plugin.settings.colors = { ...EMPTY_MARK_COLORS };
    this.plugin.settings.markIntensity = DEFAULT_MARK_INTENSITY;
    await this.plugin.saveSettings();
    this.plugin.applyColors();
    this.update();
  }
}
