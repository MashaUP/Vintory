// ESLint (npm run lint, dentro npm test). Serve soprattutto a fermare variabili non definite
// (no-undef) e codice morto (no-unused-vars) prima che arrivino nel pacchetto.
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "dist/", "tests/e2e/artifacts/"] },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.browser, ...globals.webextensions } },
  },
  {
    // I content script non sono moduli: si caricano in ordine dal manifest e si passano i dati da globalThis.
    files: ["src/content/**/*.js"],
    languageOptions: { sourceType: "script" },
  },
  {
    files: ["scripts/**/*.mjs", "tests/**/*.mjs", "eslint.config.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node } },
  },
  {
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
