// Executable form of the layering described in guide/architecture.md.
// `bun run deps:check` validates this config, cruises `src/`, then compares the
// violations to `.dependency-cruiser-known-violations.json` (scripts/check-deps.mjs).
//
// Type imports count (`tsPreCompilationDeps`): a type imported upwards couples
// the graph as much as a value does. Do not turn it off to make a number drop.

const { existsSync } = require("node:fs");

const { LAYERS, pathAboveLevel } = require("./scripts/layers.cjs");

// `contracts/` is the published surface: pure types and functions. Two `lib/`
// files are whitelisted so a published contract may reuse them. The list is
// closed, and both files are held to `contracts-no-platform` too, which is what
// makes the "no platform access" guarantee transitive.
const PURE_FILES = "^src/contracts/|^src/lib/(truncate|type-assertions)\\.ts$";

// One rule per layer: nothing may import from a layer above its own. The top
// layer (`entry`) has nothing above it, so it yields no rule.
const layerRules = LAYERS.flatMap((layer) => {
  const above = pathAboveLevel(layer.level);

  if (above === null) return [];

  return [
    {
      name: `layer-${layer.level}-no-upward`,
      severity: "error",
      comment: `L${layer.level} ${layer.name}: ${layer.comment} It may not import from a higher layer.`,
      from: { path: layer.path },
      to: { path: above, pathNot: layer.path },
    },
  ];
});

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "A cycle between modules makes the graph unreadable and unsplittable.",
      from: {},
      to: { circular: true },
    },
    ...layerRules,
    {
      name: "contracts-pure",
      severity: "error",
      comment: "The published contracts must not reach into the runner's own code.",
      from: { path: "^src/contracts/" },
      to: { pathNot: PURE_FILES },
    },
    {
      name: "contracts-no-platform",
      severity: "error",
      comment: "The published contracts must be installable without the runner: no Node built-in, no npm package.",
      from: { path: PURE_FILES },
      to: { dependencyTypes: ["core", "npm", "npm-dev", "npm-no-pkg", "npm-unknown"] },
    },
    {
      name: "root-dsl-barrel",
      severity: "error",
      comment: "`src/dsl.ts` is the authoring surface, not an internal barrel.",
      from: { pathNot: "^src/(project|builtins)/|^src/pipeline/loader\\.ts$" },
      to: { path: "^src/dsl\\.ts$" },
    },
    {
      name: "composition-only-from-entry",
      severity: "error",
      comment:
        "Default registries are composition: they are wired at the entry point, not imported by the code they serve.",
      from: { pathNot: "^src/(entry|commands)/" },
      to: { path: "^src/engine/default-registry\\.ts$|^src/modules/work-item/registry\\.ts$" },
    },
    {
      name: "no-types-barrel",
      severity: "error",
      comment:
        "`src/types.ts` was a barrel re-exporting four layers at once; it is gone. Import the owning module instead.",
      from: {},
      to: { path: "^src/types\\.ts$" },
    },
    {
      name: "no-persistence-barrel",
      severity: "error",
      comment:
        "`state/stores/persistence.ts` hid pipeline loading behind a storage barrel; it is gone. Import the owning module instead.",
      from: {},
      to: { path: "^src/state/stores/persistence\\.ts$" },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    // Resolved against the current working directory: the fixtures under
    // tests/deps/ are cruised from their own root and have no tsconfig.
    ...(existsSync("tsconfig.json") ? { tsConfig: { fileName: "tsconfig.json" } } : {}),
    exclude: {
      path: [
        "\\.test\\.tsx?$",
        // The dashboard front end has its own build and shares nothing with
        // the runner; `src/modules/ui/static/app.js` is a build product.
        "^src/modules/ui/static/",
        "^src/modules/ui/app/",
      ],
    },
    doNotFollow: { path: "node_modules" },
  },
};
