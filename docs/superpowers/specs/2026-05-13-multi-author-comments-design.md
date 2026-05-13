# Multi-author comments — design

Closes #1. Lets multiple distinct authors (AI models, the user, anyone) appear in a CriticMarkup thread, each with their own label and color. Replaces the single configured `aiPrefix` with auto-detection of any `Name:` prefix on a comment.

## Goals

- Any agent can identify itself by writing `{>>Name: text<<}`. The plugin recognizes the prefix without configuration.
- Distinct authors get distinct visual treatment (color-coded chips and message bubbles).
- Unprefixed comments remain "You" — the local user, exactly as today.
- Zero new settings; one setting (`aiPrefix`) removed.

## Non-goals

- Orchestrating multiple models. The user runs each agent against the file separately; the plugin just reads what they wrote.
- Mention/ping affordance, legend in panel header, manual per-author color override — deferred to follow-ups.
- Backwards compatibility for the removed `aiPrefix` setting. Stale values are silently ignored on load.

## Authorship detection

A comment's body is matched against:

```
AUTHOR_RE = /^\s*([A-Za-z][\w.\-]{0,29})\s*:\s*/
```

- Match → `authorName` is the captured token, preserved with original casing.
- No match → `authorName` is `null` (the local user, displayed as "You").

The regex constraints (single token, alpha-leading, `\w`/`.`/`-` body, max 30 chars) keep false positives narrow. Multi-word strings ending in a colon (e.g. `see line 4 :`) do not match. Short capitalized words ending in colon (`TODO:`, `Note:`) match and render as faux authors — this is an accepted cosmetic edge case rather than a bug.

Identity for color hashing is the lowercased name; display uses the original casing. So `Claude:` and `claude:` share a hue but render exactly as written.

## Data model changes

In `src/parser.ts`:

```ts
export interface CommentNode extends BaseNode {
  kind: "comment";
  text: string;
  authorName: string | null;
}
```

- Remove the `author: "ai" | "human"` field.
- Remove `ParseOptions.aiPrefix` and `DEFAULT_AI_PREFIX`.
- Remove `buildPrefixRe`. Replace with a single module-level `AUTHOR_RE`.

## Settings changes

In `src/settings.ts`:

- Remove `aiPrefix` from `KissCriticMarkupSettings` and `DEFAULT_SETTINGS`.
- Remove the "AI author prefix" `Setting` row from the settings tab.
- `loadData()` returns a plain object; extra keys are ignored by the shallow merge already in place — no explicit migration code needed.

## Resolution-marker sweep

`main.ts` "delete resolved threads" currently requires `r.author === "human"` (i.e., unprefixed) on the reply that resolves a thread. Relax: any reply whose body matches `/^(ignore|won't fix|wontfix|done|resolved)$/i` resolves the thread, regardless of `authorName`. This keeps the command useful when users tag their own replies.

## Rendering

### Color palette

Add ~8 distinct hues, exposed as CSS variables in `styles.css`:

```css
:root {
  --kcm-author-hue-0: 210; /* blue */
  --kcm-author-hue-1: 280; /* purple */
  --kcm-author-hue-2: 150; /* green */
  --kcm-author-hue-3: 30;  /* orange */
  --kcm-author-hue-4: 340; /* pink */
  --kcm-author-hue-5: 190; /* teal */
  --kcm-author-hue-6: 50;  /* yellow */
  --kcm-author-hue-7: 0;   /* red */
}
```

Background and accent are derived via `hsl(var(--kcm-author-hue-N), ...)` so they pick up reasonable saturation/lightness without per-hue tuning.

A hash function lives in a small helper at `src/authors.ts`:

```ts
export function authorHueIndex(name: string): number {
  let h = 0;
  const lower = name.toLowerCase();
  for (let i = 0; i < lower.length; i++) h = (h * 31 + lower.charCodeAt(i)) >>> 0;
  return h % 8;
}
```

### Panel (`src/panel/view.ts`)

- Display label: `c.authorName ?? "You"`.
- Class on the message div: `kcm-message kcm-message-${c.authorName ? "named" : "human"}`.
- When `authorName` is set, also set `data-author-hue="${authorHueIndex(name)}"` so CSS picks up the hue.

### Inline chip (`src/editor/decorations.ts`)

- Pass `authorName` (instead of the old `"ai" | "human"`) into the widget.
- Chip class: `kcm-chip kcm-chip-${authorName ? "named" : "human"}` plus `data-author-hue` when named.
- Chip icon text: full name, truncated to 12 chars with ellipsis, when named; `💬` when unnamed.
- Tooltip: `${c.authorName ?? "You"}: ${c.text.trim()}` (replaces today's "AI / You" branching).

### Reading mode (`src/reading.ts`)

- Drop `aiPrefix` from `ReadingOptions`.
- Re-parse with no prefix option.
- Chip label and class derive from `authorName` the same way as the editor decoration.

## Finalize (`src/finalize.ts`)

Finalize logic doesn't actually use authorship for decisions — `aiPrefix` is only passed through to `parse()` because every caller has been doing so. Remove the parameter from `FinalizeReviewModal`, `finalizeEdits`, and `summarizeFinalize`. The Finalize dialog UI is unchanged.

## Tests (`test/parser.test.mjs`)

Add cases:

- `{>>Claude: hello<<}` → `authorName === "Claude"`, `text === "hello"`.
- `{>>GPT-4: hi<<}` → `authorName === "GPT-4"`.
- `{>>asdjak adakjds ajksdjads : oops<<}` → `authorName === null`, `text === "asdjak adakjds ajksdjads : oops"`.
- `{>>see line 4: bad<<}` → `authorName === null` (multi-word).
- `{>>TODO: fix<<}` → `authorName === "TODO"` (accepted false positive — document in the test why this is fine).
- `{>>: empty<<}` → `authorName === null`.
- A thread with three comments authored by three different names parses as one thread with three distinct `authorName` values.

Update existing assertions that read `author === "ai" | "human"`. Remove any test cases that pass `aiPrefix` as an option.

Other test files (`test/*.mjs`) that import or assert on the old shape get the same mechanical update.

## Documentation

`examples/CLAUDE.md` — replace the existing "configured AI prefix" guidance with: "Prefix each of your comments with `<Name>:` so the user knows it's from you, e.g. `{>>Claude: this section feels long<<}`. The user replies without any prefix." Drop any references to a configurable single prefix.

`CLAUDE.md` (project) — update the "Threading" paragraph: the `aiPrefix` setting is gone; authorship is detected from a `<Name>:` prefix on each comment. Resolution markers (`ignore`/`done`/...) work regardless of author.

## Risk / open questions

- **`TODO:` false positives.** Mild. Documented as an accepted edge case. If it becomes annoying we can add a small denylist later.
- **Color collisions on small palette.** With 8 hues, two authors will collide if their hashes land on the same index. With typical 2–4 authors per document it's unlikely; if it happens the user can pick different names. A per-author color override is deferred.
- **Hue accessibility.** Hues alone aren't enough for color-blind readers — the author name label always appears next to the chip/bubble, so identity is never color-only.
