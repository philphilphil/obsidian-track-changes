# Track Changes

Review [CriticMarkup](http://criticmarkup.com/) suggestions from an AI (or any external editor) in an Obsidian side panel. Accept, reject, or reply — everything stays in plain markdown, no sidecar state.

![Track Changes panel showing multi-author comments from Claude and GPT](docs/screenshot.png)

## The flow

Your AI writes CriticMarkup into your notes — additions, deletions, substitutions, comments. You open the review panel and walk through each change.

```markdown
The deadline is {~~Tuesday~>Friday~~}. {>>Claude: source says Friday — meeting notes 2026-05-08.<<} {>>good catch, keep<<}
```

Authorship is detected from the `<Name>:` prefix on each comment. Well-known names (`Claude`, `GPT`, `Gemini`, `Copilot`, …) get brand-ish colors; any other name gets a stable hash-derived color. Unprefixed comments are treated as your own replies — that's how the plugin tells the two apart.

Multiple reviewers work naturally: run Claude and GPT over the same doc and their comments surface in distinct colors in the panel.

## Tell your agent how to behave

Drop [`docs/CLAUDE.md`](docs/CLAUDE.md) into the folder you want reviewed (rename to `AGENTS.md` for non-Claude agents, or paste as a system prompt). It sets the reviewer-mode protocol: insert-only, every comment prefixed with the agent's name, threading and reply conventions.

## Features

- All five CriticMarkup forms: `{++add++}`, `{--del--}`, `{~~old~>new~~}`, `{>>comment<<}`, `{==highlight==}`
- Threaded comments — adjacent `{>>...<<}` blocks with no blank line between them group into one thread
- Multi-author support — each `<Name>:` prefix gets its own color; well-known AI names get brand-ish hues
- Accept / reject per suggestion; delete per message or per thread; reply inline
- **Finalize for publish** — resolves all remaining markup in one pass
- Reading mode renders either the accepted preview or raw side-by-side
- Markup inside code blocks is left alone

## Commands

| Command | What it does |
|---|---|
| Open review panel | Opens the side panel for the active note |
| Finalize for publish | Accepts all insertions, removes all deletions and comments |

## Install

**Community Plugins** → search "Track Changes" *(once accepted)*.

**Manual:** drop `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/track-changes/` and enable in settings.

## Build

```sh
npm install && npm run build
```

## Related

For human-to-human collaboration, [Fevol/obsidian-criticmarkup](https://github.com/Fevol/obsidian-criticmarkup) is the full-featured general-purpose CriticMarkup plugin. This one is intentionally narrower: review-focused, tuned for an external AI author.

## License

MIT.
