// Human authoring of CriticMarkup marks: pure tag builders and guard
// predicates. No Obsidian imports — main.ts wires these into commands and
// the editor menu.

export type AuthoringKind = "addition" | "deletion" | "substitution" | "highlight" | "comment";

export type BuildResult =
  | { ok: true; text: string; cursorOffset: number }
  | { ok: false; refusal: string };

/**
 * Build the mark text for a kind + selection. `attribution` is the metadata
 * prefix without braces (always non-empty: at minimum `date="…"`).
 * `cursorOffset` is relative to the start of `text` — the slot the user types
 * into next, or the end of the mark when it is already complete.
 */
export function buildMark(kind: AuthoringKind, selection: string, attribution: string): BuildResult {
  const p = attribution;
  switch (kind) {
    case "addition": {
      if (selection !== "") {
        return {
          ok: false,
          refusal: "Addition inserts new text; clear the selection, or use Substitution to replace it.",
        };
      }
      return { ok: true, text: `{${p}++++}`, cursorOffset: 1 + p.length + 2 };
    }
    case "deletion": {
      if (selection === "") return { ok: false, refusal: "Select the text to delete." };
      const text = `{${p}--${selection}--}`;
      return { ok: true, text, cursorOffset: text.length };
    }
    case "substitution": {
      if (selection === "") return { ok: false, refusal: "Select the text to replace." };
      return {
        ok: true,
        text: `{${p}~~${selection}~>~~}`,
        cursorOffset: 1 + p.length + 2 + selection.length + 2,
      };
    }
    case "highlight": {
      if (selection === "") return { ok: false, refusal: "Select the text to highlight." };
      const text = `{${p}==${selection}==}`;
      return { ok: true, text, cursorOffset: text.length };
    }
    case "comment": {
      if (selection === "") {
        return { ok: true, text: `{${p}>><<}`, cursorOffset: 1 + p.length + 2 };
      }
      const anchor = `{==${selection}==}`;
      return {
        ok: true,
        text: `${anchor}{${p}>><<}`,
        cursorOffset: anchor.length + 1 + p.length + 2,
      };
    }
  }
}
