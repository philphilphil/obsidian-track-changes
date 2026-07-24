// Human authoring of CriticMarkup marks: pure tag builders and guard
// predicates. No Obsidian imports — main.ts wires these into commands and
// the editor menu.

import { parse, findCodeRegions } from "./parser";

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

/** Lines that open a new Markdown block — a mark delimiter ahead of one breaks the block. */
export const BLOCK_MARKER_RE = /^ {0,3}(#{1,6}[ \t]|[-*+][ \t]|\d+[.)][ \t]|>|```|~~~|\|)/;

// Substrings that would terminate (or, for `~>`, split) the mark early.
const FORBIDDEN_IN_SELECTION: Record<AuthoringKind, string[]> = {
  addition: [],
  deletion: ["--}"],
  substitution: ["~~}", "~>"],
  highlight: ["==}"],
  comment: ["==}"], // the selection is wrapped in the {==…==} anchor
};

/** Returns a refusal message, or null when the range [from, to) is safe for `kind`. from === to means cursor insertion. */
export function checkGuards(
  source: string,
  from: number,
  to: number,
  kind: AuthoringKind,
): string | null {
  // A cursor (from === to) conflicts only when strictly inside a range;
  // a selection conflicts when it overlaps one at all.
  const intersects = (a: number, b: number): boolean =>
    from === to ? a < from && from < b : a < to && from < b;

  for (const n of parse(source).nodes) {
    if (intersects(n.from, n.to)) {
      return "Cannot create a mark overlapping an existing CriticMarkup mark.";
    }
  }

  for (const [a, b] of findCodeRegions(source)) {
    if (intersects(a, b)) {
      return "Cannot create a mark inside a code block or inline code.";
    }
  }

  const sel = source.slice(from, to);
  const lines = sel.split("\n");
  const crossesBlank = /\n[ \t]*\n/.test(sel);
  const laterMarker = lines.slice(1).some((l) => BLOCK_MARKER_RE.test(l));
  if (crossesBlank || laterMarker) {
    return "Selection spans more than one block; select within a single paragraph.";
  }

  for (const d of FORBIDDEN_IN_SELECTION[kind]) {
    if (sel.includes(d)) {
      return `Selection contains "${d}", which would break the mark.`;
    }
  }
  return null;
}
