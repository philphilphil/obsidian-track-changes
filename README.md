# Track Changes

Review [CriticMarkup](http://criticmarkup.com/) suggestions in an Obsidian side panel. Accept, reject, or reply — straight back into the markdown, no sidecar state.

![Track Changes panel showing multi-author comments from Claude and GPT](docs/screenshot.png)

Intended for AI-assisted review: the agent leaves `{++…++}`, `{--…--}`, `{~~old~>new~~}`, `{>>comment<<}`, `{==highlight==}` in your notes, you review them here. A sixth mark, `{=+…+=}`, flags AI-inserted text with a subtle rainbow highlight — visual only, no review card.

[`docs/SKILL.md`](https://github.com/philphilphil/obsidian-track-changes/blob/main/docs/SKILL.md) is a starting-point reviewer skill you can hand your agent.

## Features

- All five CriticMarkup forms with inline styling and a side-panel card per mark, plus `{=+…+=}` AI-added-text marks (rainbow, visual-only)
- Threaded comments (adjacent `{>>…<<}` blocks), multi-author colors
- Per-mark metadata — `author="…" date="…"` prefixes on any mark drive the author colors and dates
- Accept / reject per mark, reply inline, delete per message or thread
- **Finalize for publish** — resolves all remaining markup in one pass
- Reading mode: accepted preview or raw side-by-side
- Code blocks left alone

## Interaction

- **Click a mark** in Live Preview to edit in place — the raw markup is exposed, the color stays.
- **⌘/Ctrl-click a mark** (or set *Click highlighted text to open in panel*) opens the side panel instead.
- **Click a panel card** to jump the editor to its chip.
- **Source Mode** shows raw markup verbatim.

## Commands

- *Open review panel*
- *Finalize for publish* — accept additions, drop deletions and comments, etc.

## Install

**Community Plugins** → search "Track Changes" ([community.obsidian.md](https://community.obsidian.md/plugins/track-changes)).

Manual: drop `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/track-changes/`.

## Build

```sh
npm install && npm run build
```

## License

MIT.
