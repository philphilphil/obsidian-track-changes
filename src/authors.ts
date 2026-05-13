// Author detection and per-author color assignment.
//
// A CriticMarkup comment is "named" if its body starts with `<Name>:` where
// `<Name>` is a single token (alpha-leading, \w/./- body, max 30 chars).
// Otherwise it's unnamed — the local user, rendered as "You".
//
// Each named author gets a hue from a small palette. Well-known LLM names
// (Claude, GPT, Gemini, …) are pinned to specific palette indices so the
// same model gets the same color across documents. Unknown names fall
// through to a hash. The palette itself lives in `styles.css` as
// `--kcm-author-hue-N` CSS variables.

export const AUTHOR_RE = /^\s*([A-Za-z][\w.\-]{0,29})\s*:\s*/;

const KNOWN_AUTHORS: Record<string, number> = {
  // index → hue defined in styles.css
  claude: 7,            // red
  gpt: 2,
  "gpt-4": 2,
  "gpt-4o": 2,
  "gpt-5": 2,
  chatgpt: 2,
  openai: 2,            // green
  gemini: 0,
  "gemini-pro": 0,
  bard: 0,              // blue
  copilot: 1,
  "github-copilot": 1,  // purple
  mistral: 3,
  mixtral: 3,           // orange
  llama: 5,             // teal
};

export function authorHueIndex(name: string): number {
  const lower = name.toLowerCase();
  if (lower in KNOWN_AUTHORS) return KNOWN_AUTHORS[lower];
  let h = 0;
  for (let i = 0; i < lower.length; i++) h = (h * 31 + lower.charCodeAt(i)) >>> 0;
  return h % 8;
}
