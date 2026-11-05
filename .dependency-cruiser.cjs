// Executable form of the contexts, levels and modules described in guide/architecture.md.
// `bun run deps:check` validates this config, cruises `src/`, then compares the
// violations to `.dependency-cruiser-known-violations.json` (scripts/check-deps.mjs).
//
// Type imports count (`tsPreCompilationDeps`): a type imported upwards couples
// the graph as much as a value does. Do not turn it off to make a number drop.

const { existsSync } = require("node:fs");

const {
  LAYERS,
  CONTEXTS,
  MODULES,
  FACADES,
  moduleRuleName,
  modulePathPattern,
  moduleEntryPattern,
  pathAboveLevel,
  pathForbiddenTo,
} = require("./scripts/layers.cjs");

// `contracts/` is the published surface: pure types and functions. Two `lib/`
// files are whitelisted so a published contract may reuse them. The list is
// closed, and both files are held to `contracts-no-platform` too, which is what
// makes the "no platform access" guarantee transitive.
const PURE_FILES = "^src/contracts/|^src/shared/lib/(truncate|type-assertions)\\.ts$";

const TEST_DOUBLES = "/test-harness[^/]*\\.ts$|^src/work-items/providers/fake\\.ts$";

// One rule per level of `shared`: nothing may import from a level above its own.
// The top level has nothing above it, so it yields no rule.
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

// One rule per context: it may only import the contexts it declares. A context
// allowed to import all the others yields no rule.
const contextRules = CONTEXTS.flatMap((context) => {
  const forbidden = pathForbiddenTo(context);

  if (forbidden === null) return [];

  const allowed = context.mayImport.length === 0 ? "no other context" : context.mayImport.join(", ");

  return [
    {
      name: `context-${context.name}-direction`,
      severity: "error",
      comment: `${context.name}: ${context.comment} It may import ${allowed}.`,
      from: { path: context.path },
      to: { path: forbidden },
    },
  ];
});

// One rule per module: from outside the module, only its entry may be imported.
// Inside the module, files import each other freely.
const moduleRules = MODULES.map((module) => {
  const inside = modulePathPattern(module);

  return {
    name: moduleRuleName(module),
    severity: "error",
    comment: `${module.path}/ is entered through ${module.entry} only; its other files are internals.`,
    from: { pathNot: inside },
    to: { path: inside, pathNot: moduleEntryPattern(module) },
  };
});

// A file importing the facade of its own context would be a cycle through it.
const ownFacadeRules = FACADES.map((facade) => ({
  name: `context-${facade.name}-no-own-facade`,
  severity: "error",
  comment: `${facade.path}/ imports its own files directly; its facade is for other contexts.`,
  from: { path: modulePathPattern(facade) },
  to: { path: moduleEntryPattern(facade) },
}));

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
    ...contextRules,
    ...moduleRules,
    ...ownFacadeRules,
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
      comment: "`src/definition/dsl.ts` is the authoring surface, not an internal barrel.",
      from: { pathNot: "^src/definition/(project|builtins)/|^src/definition/pipeline/loader\\.ts$" },
      to: { path: "^src/definition/dsl\\.ts$" },
    },
    {
      name: "composition-only-from-entry",
      severity: "error",
      comment:
        "Default registries are composition: they are wired at the entry point, not imported by the code they serve.",
      from: { pathNot: "^src/entry/|^src/runner\\.ts$|^src/agents/index\\.ts$|^src/work-items/composition\\.ts$" },
      to: {
        path: "^src/agents/index\\.ts$|^src/agents/default-registry\\.ts$|^src/work-items/composition\\.ts$|^src/work-items/providers/registry\\.ts$",
      },
    },
    {
      name: "no-test-doubles-in-production",
      severity: "error",
      comment:
        "Test doubles are excluded from dist by name (`tsconfig.build.json`); a production import would ship a missing module.",
      from: { pathNot: TEST_DOUBLES },
      to: { path: TEST_DOUBLES },
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
        // the runner; `src/dashboard/ui/static/app.js` is a build product.
        "^src/dashboard/ui/static/",
        "^src/dashboard/ui/app/",
      ],
    },
    doNotFollow: { path: "node_modules" },
  },
};
