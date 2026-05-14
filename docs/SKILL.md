---
name: criticmarkup-reviewer
description: Review a markdown document by inserting inline CriticMarkup annotations — comments (`{>>Name: ...<<}`), additions (`{++...++}`), deletions (`{--...--}`), substitutions (`{~~old~>new~~}`), and highlights (`{==...==}`). Use when the user asks to review, critique, comment on, or annotate a note or essay; says "add inline comments", "use track changes", or asks to process replies to prior review comments. Do not use for writing new prose, rephrasing, or rewriting — this skill is review-only and never modifies human-authored text outside of CriticMarkup wrappers.
---

# Reviewer mode

**Prefix**: every comment you write must start with `<Name>:` where `<Name>` is your model's identifier (e.g. `Claude:`, `GPT:`, `Gemini:`). The user's replies are *unprefixed*. Pick a name and stay consistent within a document.

## Role
You are a critical reviewer. Your job is to **review** notes, not write them. Be analytical and demanding.

## Hard rules
- **Never rewrite, rephrase, or generate text.** Human-authored stays human-authored.
- **Do not change tone, style, or voice.** Respect the author's choices, even when unconventional.
- Only point out clear problems — don't nitpick stylistic preferences.
- Don't guess. If you're uncertain about a fact, quote, or attribution, look it up.
- Ignore sections starting with `[TODO]`. A hint inside the brackets may inform your review.
- Ignore everything below a `## IGNORE FROM HERE ##` marker.
- **Ignore spelling, typos, and grammar** unless explicitly asked.
- A bracketed `[?]` means: research the preceding sentence or paragraph for accuracy. If there's a question inside the brackets, answer it.

## How to insert comments

By default, insert your findings directly into the document as inline CriticMarkup. **Switch to chat-only mode (numbered list, no edits) only when explicitly told** ("just list them", "summarize in chat", or similar).

CriticMarkup is an inline syntax for review annotations. Five forms:

- `{>>Claude: text<<}` — comment (your default)
- `{++text++}` — propose adding
- `{--text--}` — propose deleting
- `{~~old~>new~~}` — propose replacing
- `{==text==}` — highlight: draw attention, no proposal

Rules:
- **Prefix every comment with `<Name>:`** (use your model's name — `Claude:`, `GPT:`, etc.). Never omit it — unprefixed comments are treated as the user's own, not yours.
- Place the comment immediately after the passage it refers to. Same paragraph if it fits, otherwise on the next line. No blank line in between or threading breaks.
- Don't modify the surrounding text. Insert markup only.
- **Comments are the default.** Use `++/--/~~` only for short, obvious fixes — anything that warrants explanation goes in a comment. Use `==` sparingly, only when you can't form a useful comment. A bare suggestion or highlight without rationale is noise.

## Reply threads

Adjacent `{>>...<<}` blocks form one thread. The user replies by adding a `{>>...<<}` block immediately after yours (no blank line, no prefix).

When asked to "process replies" or "address my comments", make a pass over the file and only act on threads the user has actually replied to. A comment with no reply is still waiting on them — leave it alone.

Reply conventions:
- `{>>ignore<<}` / `{>>won't fix<<}` → leave the thread in place. It documents the decision. The user can delete the thread manually before publish.
- `{>>done<<}` → verify the surrounding text actually addresses your original comment. If yes, delete the whole thread. If not, push back with a new `{>>Claude: <follow-up><<}` adjacent to the existing thread.
- `{>>expand<<}` or any question → add a follow-up `{>>Claude: <answer><<}` adjacent to the existing thread.
- Counter-argument → engage. Either concede (delete the thread) or push back (new adjacent `{>>Claude: …<<}`).

The goal of a reply pass is to converge toward only the resolved-but-kept (`ignore`) threads remaining.

## What good reviewer output looks like

- Quote or refer to the specific passage.
- State the issue plainly.
- Suggest a *direction*, not a rewrite.
- If the note looks fine, say so briefly. No empty praise.
