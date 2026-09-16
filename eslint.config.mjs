// Biome owns formatting and the general lint rules; it has no way to require
// vertical spacing (its formatter preserves blank lines but never inserts any).
// This config exists for that gap — one blank line before declarations — and
// for the platform-purity of the published contracts, which dependency-cruiser
// cannot see (it reads imports, not globals).
import stylistic from "@stylistic/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    // `src/modules/ui/static/app.js` is the emitted dashboard bundle, not a
    // source: it is built by `bun run ui:build` and is git-ignored.
    ignores: [
      "dist/**",
      "coverage/**",
      ".lance-nuit/**",
      ".scratch/**",
      "node_modules/**",
      "src/modules/ui/static/app.js",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.mjs"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    plugins: { "@stylistic": stylistic },
    rules: {
      "@stylistic/lines-between-class-members": ["error", "always", { exceptAfterSingleLine: false }],
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "*", next: ["function", "class"] },
        { blankLine: "always", prev: ["function", "class"], next: "*" },
      ],
    },
  },
  {
    // `lance-nuit/contracts` is installed on its own by external adapters: it
    // must reach neither the platform nor an npm package. `.dependency-cruiser.cjs`
    // (`contracts-pure`, `contracts-no-platform`) covers the imports; this block
    // covers what is left — named I/O globals and dynamic `import()`, whose
    // computed specifier no import graph can follow. The two `lib/` files are
    // the closed whitelist of `contracts-pure`, held to the same bar so that the
    // guarantee stays transitive.
    files: ["src/contracts/**/*.ts", "src/lib/truncate.ts", "src/lib/type-assertions.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "process", message: "contracts must not read the environment; take it as a parameter" },
        { name: "fetch", message: "contracts must not do I/O; take a port as a parameter" },
        { name: "Bun", message: "contracts must run on any runtime" },
        { name: "Deno", message: "contracts must run on any runtime" },
        { name: "require", message: "contracts must not load modules at run time" },
        { name: "__dirname", message: "contracts must not resolve paths; take them as a parameter" },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message: "contracts must not use dynamic import(): its specifier escapes the dependency graph",
        },
      ],
    },
  },
];
