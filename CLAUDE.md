# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Obsidian plugin that reviews CriticMarkup suggestions (typically authored by an AI) in a side panel — accept/reject/reply. No sidecar state; everything lives as `{++…++}`, `{--…--}`, `{~~old~>new~~}`, `{>>comment<<}`, `{==highlight==}`, `{=+ai-added+=}` directly in the markdown.

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
4. **Commands**: open panel, finalize for publish (`src/finalize.ts`).

### Data flow: parse → edits → rebase → apply

- `src/parser.ts` scans source text and emits a `ParseResult` with `nodes` (the six CriticMarkup kinds) and `threads` (adjacent `{>>…<<}` blocks group). **All six kinds** carry an optional metadata prefix — a run of space/tab-separated `key="value"` pairs (HTML-attribute flavored), no leading whitespace, placed between the outer `{` and the sigil. A key is `[A-Za-z][\w-]*` (lowercased on lookup); a value is double-quoted and **may not contain `"`, `{`, `}`, or a newline** (everything else — spaces, `;`, `=`, `:`, `+`, `~`, `<`, `>`, `-`, `.`, `,`, `'` — is allowed). Surfaced on `BaseNode` as `metaAttrs: Record<string, string>` (every key, lowercased, empty values dropped, first occurrence wins — carries `author`/`date` **and any future key** like `status` with no parser change) plus the typed accessors `metaAuthor: string | null`, `metaDate: string | null` (display-only, never validated/sorted), `metaRaw` (the exact prefix consumed incl. any trailing space, `""` if none), and `innerFrom`/`innerTo` (payload bounds after the prefix+sigil — render paths use these, not `from+3`/`to-3`). `from`/`to`/`raw` span the whole outer-brace-to-outer-brace including the prefix, so accept/reject/finalize strip it for free. Comments also expose `authorName: string | null` — the legacy captured `<Name>:` body prefix (original casing) or `null`. Parsing is always-on (no toggle). **The value class forbidding `"`/`{`/`}`/newline is the corruption defense** (replacing the old mandatory trailing `;`): a truncated/streamed value (`date="2026`) finds no closing `"` before the next brace or line break, so the pair fails, the prefix collapses to `""`, and the mark fails to form *locally* instead of swallowing downstream text. There is **no nesting guard**: a mark whose body contains a nested mark (`{--a {>>b<<} c--}`, prefixed or not) collapses into the *outer* mark via the overlap-drop pass — the inner is part of the added/deleted text. The quoted value class (no `"`/`{`/`}`/newline inside a value) makes a *prefixed* straddle structurally impossible, so no guard is needed; a legit single brace in prose stays inside its one mark. (The reading-view post-processor strips the prefix from rendered preview within a single DOM text node — a value containing markdown can split it across nodes and leak; plain `author`/`date` values are unaffected.) **Code blocks are skipped** — markup inside fenced (```` ``` ````, `~~~`), indented (4-space / tab), or inline-backtick code is left alone. The sixth kind `aitext` (`{=+…+=}`, sigil "highlight + addition") marks AI-*inserted* text and is **visual-only**: no panel card, not clickable (decorations omit `data-tc-offset`), rendered as a rainbow `.tc-aitext` span in Live Preview and reading view (reading mode strips the sigils but *wraps* the body — the one render path that adds an element rather than only deleting tokens). `finalizeEdits` strips it (keeping the text) when `finalize.stripAiText` is true (default).
- `src/operations.ts` turns user actions (accept, reject, reply, delete-thread, …) into `SourceEdit[]`. Each edit carries optional `expected` (text at `[from, to)`) and `before` (text immediately preceding `from`) as anchors.
- `rebaseEdits` re-validates each edit against the *current* document right before write. If the doc drifted since parse (user typed, AI re-edited via another channel), it searches a ±200-char window for the `before+expected` anchor; non-unique matches are dropped rather than risk corrupting unrelated text. This is critical — never apply raw stale offsets.
- `main.applyEditsToFile` prefers the live CM6 `EditorView.dispatch` (so changes coalesce with the user's undo stack), falls back to `Editor.setValue`, then to `Vault.process` for unopened files.

### Threading

A thread is a run of `{>>…<<}` blocks with only inline whitespace (no blank line) between them in the same paragraph. First is root, rest are replies. The prefix lives outside the `>>`/`<<` delimiters, so adjacency detection is unchanged. Authorship resolves by precedence: `metaAuthor` (the `author="…"` prefix, on all six kinds) → legacy `<Name>:` body prefix (comments only — single token, alpha-leading, ≤30 chars, see `src/authors.ts`; always stripped from `text` even when `metaAuthor` is present) → `localAuthorName` setting → "You". Comments accept **both** the new `author="…"` form and the legacy `{>>Name: text<<}` form. Replies are the only mark the plugin writes (`appendReply`): always `date="<stamp>"` and, when `localAuthorName` is set, `author="<sanitized name>"` (written `{author="…" date="…">>…<<}`) — so a reply with no `author=` (or the user's configured name) is the user's. `date` is display-only, so the stamp can be date-only (`2026-06-14`) or a full second-precision ISO timestamp (`2026-06-14T12:23:46Z`) and both render. Treat this precedence as a hard contract; don't add other heuristics. Keep this consistent with `docs/SKILL.md`.

### Settings

`src/settings.ts` holds `TrackChangesCriticMarkupSettings`. The shape of this object is persisted via `loadData()` / `saveData()` — if you rename a key, write a migration in `loadSettings()` so existing users don't lose their config. Defaults are merged shallowly except `finalize`, which is merged one level deep — preserve that when adding nested setting groups. `localAuthorName: string` (default `""`, empty ⇒ "You") is the display fallback for unattributed marks and the name stamped on plugin-written replies; the top-level shallow merge supplies its default for existing users (no migration needed). `replyDateStyle: "date" | "datetime"` (default `"date"`, display-only) picks how plugin-written replies stamp the date; `loadSettings` coerces any non-`"datetime"` persisted value back to `"date"`.

## Conventions

- TypeScript strict, ES2018 target, CJS bundle (Obsidian requirement). External modules listed in `esbuild.config.mjs` — don't bundle `obsidian` or any `@codemirror/*` packages.
- Source edits must be non-overlapping; `applyEdits` asserts this and throws on violation. Construct edits with that contract in mind.
- When adding a new mutation, always set `expected` (and `before` for insertions) so it survives `rebaseEdits`.
- Companion-agent behavior is documented in `docs/SKILL.md` (the example reviewer-skill template shipped with the plugin). When changing thread/prefix semantics, update both this file and that one.
