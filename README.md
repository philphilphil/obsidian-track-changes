# Track Changes

Review [CriticMarkup](http://criticmarkup.com/) suggestions from an AI (or any external editor) in an Obsidian side panel. Accept, reject, or reply.

## The flow

Your AI writes CriticMarkup into your notes — additions, deletions, substitutions, comments. You open the review panel and walk through each change. Everything stays in plain markdown; no sidecar state.

```markdown
The deadline is {~~Tuesday~>Friday~~}. {>>AI: source says Friday — meeting notes 2026-05-08.<<} {>>good catch, keep<<}
```

The `AI:` prefix marks the comment as agent-authored; unprefixed comments are treated as human replies. The prefix is configurable in settings — set it to whatever name your agent uses (`Claude`, `GPT`, `Gemini`, …) and tell your agent to match.

## Tell your agent how to behave

Drop [`examples/CLAUDE.md`](examples/CLAUDE.md) into the folder you want reviewed (rename to `AGENTS.md` for non-Claude agents, or use as a system prompt). It sets the reviewer-mode protocol: insert-only, every comment prefixed, threading and reply conventions.

## Features

- All five CriticMarkup forms: `{++add++}`, `{--del--}`, `{~~old~>new~~}`, `{>>comment<<}`, `{==highlight==}`
- Threaded comments (adjacent `{>>...<<}` blocks group into one thread)
- Configurable prefix (`AI:` by default) marks agent comments; unprefixed comments are human replies
- Accept / reject per suggestion, delete per message or per thread, reply inline
- "Finalize for publish" — resolve all remaining markup in one pass
- Reading mode renders either the accepted preview or raw side-by-side
- Markup inside code blocks is left alone

## Commands

- **Open review panel**
- **Finalize for publish**
- **Delete all resolved (ignore / won't fix / done / resolved) threads**

## Install

Community Plugins → search "Track Changes" (once accepted).

Manual: drop `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/track-changes/` and enable.

## Build

```sh
npm install && npm run build
```

## Related

If you're collaborating with humans rather than AIs, use [Fevol/obsidian-criticmarkup](https://github.com/Fevol/obsidian-criticmarkup) — it's the full-featured general-purpose CriticMarkup plugin. This one is intentionally narrower: review-focused, tuned for an external AI author.

## License

MIT.
