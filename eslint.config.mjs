import tsparser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  { ignores: ["main.js", "node_modules/**", "test/**", "esbuild.config.mjs"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Misfires on proper nouns (CriticMarkup, Markdown, Cmd/Ctrl) and on ISO timestamps.
      "obsidianmd/ui/sentence-case": "off",
    },
  },
  {
    // These files create detached nodes in a specific document (`el.ownerDocument`,
    // `activeDocument`) so popout windows render into their own document. Obsidian's
    // window/Node helpers always build in the main document — `Node.prototype.createEl`
    // additionally appends to the receiver, which throws on a Document.
    files: ["src/reading.ts", "src/editor/decorations.ts"],
    rules: { "obsidianmd/prefer-create-el": "off" },
  },
];
