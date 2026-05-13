# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Obsidian plugin that reviews CriticMarkup suggestions (typically authored by an AI) in a side panel — accept/reject/reply. No sidecar state; everything lives as `{++…++}`, `{--…--}`, `{~~old~>new~~}`, `{>>comment<<}`, `{==highlight==}` directly in the markdown.

## Commands

```sh
npm install              # one-time
npm run dev              # esbuild watch -> main.js (with inline sourcemaps)
npm run build            # tsc --noEmit + esbuild production bundle
npm run typecheck        # tsc --noEmit -skipLibCheck
npm test                 # runs all six test files sequentially
node test/parser.test.mjs        # run a single test file
```

Tests are plain Node ESM scripts (`.mjs`) under `test/` — no test framework. They import compiled TS via Node's TS loader path or by re-implementing fixtures; check an existing test before adding one.

To load the dev build into Obsidian: symlink or copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/track-changes/`.

## Architecture

Entry point `src/main.ts` is the `Plugin` subclass. It wires four things into Obsidian and owns nothing else of substance:

1. **Right-side panel view** (`src/panel/view.ts`, `REVIEW_VIEW_TYPE`) — the review UI. `main.ts` constructs a `PanelHost` adapter so the panel never imports the `Plugin` directly; the panel calls back through `host.applyEdits`, `host.revealOffset`.
2. **CodeMirror 6 decoration extension** (`src/editor/decorations.ts`) — inline highlighting of CriticMarkup ranges in Live Preview / Source mode. Click handler routes back into `main.handleInlineClick` which opens the panel and focuses the offset.
3. **Reading-mode post-processor** (`src/reading.ts`) — renders markup in preview mode either as accepted preview or side-by-side, based on settings.
4. **Commands**: open panel, finalize for publish (`src/finalize.ts`), delete resolved threads.

### Data flow: parse → edits → rebase → apply

- `src/parser.ts` scans source text and emits a `ParseResult` with `nodes` (the five CriticMarkup kinds) and `threads` (adjacent `{>>…<<}` blocks group). Comments expose `authorName: string | null` — the captured `<Name>:` prefix (original casing) or `null` if unprefixed. **Code blocks are skipped** — markup inside fences is left alone.
- `src/operations.ts` turns user actions (accept, reject, reply, delete-thread, …) into `SourceEdit[]`. Each edit carries optional `expected` (text at `[from, to)`) and `before` (text immediately preceding `from`) as anchors.
- `rebaseEdits` re-validates each edit against the *current* document right before write. If the doc drifted since parse (user typed, AI re-edited via another channel), it searches a ±200-char window for the `before+expected` anchor; non-unique matches are dropped rather than risk corrupting unrelated text. This is critical — never apply raw stale offsets.
- `main.applyEditsToFile` prefers the live CM6 `EditorView.dispatch` (so changes coalesce with the user's undo stack), falls back to `Editor.setValue`, then to `vault.modify`.

### Threading

A thread is a run of `{>>…<<}` blocks with only inline whitespace (no blank line) between them in the same paragraph. First is root, rest are replies. Authorship is detected from a `<Name>:` prefix on each comment (single token, alpha-leading, ≤30 chars — see `src/authors.ts`). Comments without a recognised prefix render as "You" (the local user). Treat this as a hard contract; don't add other heuristics.

The "delete all resolved threads" command sweeps threads whose reply matches `/^(ignore|won't fix|wontfix|done|resolved)$/i`, regardless of who wrote it.

### Settings

`src/settings.ts` holds `KissCriticMarkupSettings` (note the legacy "Kiss" prefix in identifiers — the plugin was renamed; don't rename the symbols casually, they're tied to `loadData()` persisted state). Defaults are merged shallowly except `finalize` which is merged one level deep — preserve that when adding nested setting groups.

## Conventions

- TypeScript strict, ES2018 target, CJS bundle (Obsidian requirement). External modules listed in `esbuild.config.mjs` — don't bundle `obsidian` or any `@codemirror/*` packages.
- Source edits must be non-overlapping; `applyEdits` sorts descending by `from` and splices. Construct edits with that contract in mind.
- When adding a new mutation, always set `expected` (and `before` for insertions) so it survives `rebaseEdits`.
- Companion-agent behavior is documented in `examples/CLAUDE.md` (the example reviewer prompt shipped with the plugin). When changing thread/prefix semantics, update both this file and that one.
