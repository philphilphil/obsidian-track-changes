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
];
