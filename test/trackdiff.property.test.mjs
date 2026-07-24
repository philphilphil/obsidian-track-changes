import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = await build({
  stdin: {
    contents: `
      export { computeTrackEdits } from "./src/trackdiff";
      export { parse } from "./src/parser";
      export { applyEdits, finalizeEdits } from "./src/operations";
    `,
    resolveDir: resolve(__dirname, ".."),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  target: "es2018",
  write: false,
  platform: "node",
});
const code = out.outputFiles[0].text;
const mod = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const { computeTrackEdits, parse, applyEdits, finalizeEdits } = mod;

// Deterministic PRNG — failures must reproduce.
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_DOC = [
  "The quick brown fox jumps over the lazy dog near the river bank.",
  "A second paragraph talks about weather patterns and seasonal change in detail.",
  "Closing thoughts mention gratitude patience and the long road ahead for everyone.",
].join("\n\n");

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];

// Random single-paragraph edits: replace, delete, or insert words WITHIN a
// paragraph (multi-block chunks have documented whitespace exceptions and are
// covered by targeted tests instead).
function randomEdit(text, rnd) {
  const paras = text.split("\n\n");
  const pi = Math.floor(rnd() * paras.length);
  const words = paras[pi].split(" ");
  const wi = Math.floor(rnd() * words.length);
  const op = rnd();
  if (op < 0.34 && words.length > 3) words.splice(wi, 1);
  else if (op < 0.67) words.splice(wi, 0, WORDS[Math.floor(rnd() * WORDS.length)]);
  else words[wi] = WORDS[Math.floor(rnd() * WORDS.length)];
  paras[pi] = words.join(" ");
  return paras.join("\n\n");
}

const ACCEPT_ALL = { additions: "accept", deletions: "accept", substitutions: "accept", stripHighlights: true, stripAiText: true };
const REJECT_ALL = { additions: "reject", deletions: "reject", substitutions: "reject", stripHighlights: true, stripAiText: true };

const PP = 'date="2026-07-24"';
let failures = 0;
for (let seed = 1; seed <= 200; seed++) {
  const rnd = mulberry32(seed);
  let current = BASE_DOC;
  const editCount = 1 + Math.floor(rnd() * 6);
  for (let k = 0; k < editCount; k++) current = randomEdit(current, rnd);

  const { edits } = computeTrackEdits(BASE_DOC, current, PP);
  const marked = applyEdits(current, edits);
  const parsed = parse(marked);

  const accepted = applyEdits(marked, finalizeEdits(parsed, ACCEPT_ALL));
  const rejected = applyEdits(marked, finalizeEdits(parsed, REJECT_ALL));

  if (accepted !== current) {
    failures++;
    console.error(`  FAIL seed=${seed}: accept-all != current`);
    console.error("    current:", JSON.stringify(current));
    console.error("    accepted:", JSON.stringify(accepted));
  }
  if (rejected !== BASE_DOC) {
    failures++;
    console.error(`  FAIL seed=${seed}: reject-all != baseline`);
    console.error("    rejected:", JSON.stringify(rejected));
  }
}
if (failures > 0) {
  console.error(`property: ${failures} failures`);
  process.exitCode = 1;
} else {
  console.log("  ok  - 200 seeds × accept-all/reject-all invariants");
}
console.log("done.");
