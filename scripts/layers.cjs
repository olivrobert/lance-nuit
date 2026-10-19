// Single definition of the architecture layers and modules described in
// guide/architecture.md.
// Both `.dependency-cruiser.cjs` (to build the `layer-<n>-no-upward` rules) and
// `scripts/check-deps.mjs` (to prove every source file is classified) read it, so
// a new folder is declared once and both checks see it.
//
// Invariants:
// - a folder belongs to exactly one layer, and a file is never classified apart
//   from its folder;
// - a layer may only import from its own level or below.

/** @type {{ level: number, name: string, path: string, comment: string }[]} */
const LAYERS = [
  {
    level: 0,
    name: "lib",
    path: "^src/lib/",
    comment: "Standalone helpers; Node built-ins only.",
  },
  {
    level: 1,
    name: "contracts",
    path: "^src/contracts/",
    comment: "Published types and pure functions; no I/O, no zod.",
  },
  {
    level: 2,
    name: "model",
    path: "^src/model/",
    comment: "Data shapes and ports; no behaviour, no I/O.",
  },
  {
    level: 3,
    name: "infra",
    path: "^src/(env|exec|runtime)/",
    comment: "Configuration, process execution and cross-cutting runtime services.",
  },
  {
    level: 4,
    name: "core",
    path: "^src/(validation|pipeline|dsl|builtin-steps|extractors|engine|step|dispatch|boot|state|project|builtins)/|^src/dsl\\.ts$",
    comment: "Pipeline definition, execution and persistence.",
  },
  {
    level: 5,
    name: "adapters",
    path: "^src/(output|modules|commands)/",
    comment: "Presentation, integrations and CLI commands.",
  },
  {
    level: 6,
    name: "entry",
    path: "^src/(entry|cli)/|^src/runner\\.ts$",
    comment: "Composition root; may import anything.",
  },
];

// Modules are a second axis, orthogonal to the layers: a layer says which way an
// import may go, a module says through which file it may enter. Each module
// becomes a `module-<name>-entry-only` rule in `.dependency-cruiser.cjs`, and
// `check-deps.mjs` proves every `entry` exists, so a renamed entry cannot leave
// behind a rule that silently forbids every outside import, the entry included.
//
// These rules have no baseline: a module is declared in the change that routes
// every outside import through its entry.

/** @type {{ name: string, path: string, entry: string }[]} */
const MODULES = [
  { name: "ui", path: "src/modules/ui", entry: "index.ts" },
  { name: "read-model", path: "src/modules/read-model", entry: "index.ts" },
  { name: "dashboard-home", path: "src/modules/dashboard-home", entry: "index.ts" },
  { name: "work-item", path: "src/modules/work-item", entry: "registry.ts" },
  { name: "extractors", path: "src/extractors", entry: "registry.ts" },
  { name: "step", path: "src/step", entry: "step-loop.ts" },
  { name: "engine", path: "src/engine", entry: "default-registry.ts" },
];

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The regex matching every file of `module`.
 *
 * @param {{ path: string }} module
 */
function modulePathPattern(module) {
  return `^${escapeRegex(module.path)}/`;
}

/**
 * The regex matching only the entry file of `module`.
 *
 * @param {{ path: string, entry: string }} module
 */
function moduleEntryPattern(module) {
  return `^${escapeRegex(`${module.path}/${module.entry}`)}$`;
}

const MATCHERS = LAYERS.map((layer) => ({ layer, regex: new RegExp(layer.path) }));

/**
 * Every layer whose regex matches `filePath`. More than one match means the
 * table is ambiguous, which `check-deps.mjs` reports as an error.
 *
 * @param {string} filePath repository-relative path, POSIX separators
 */
function layersOf(filePath) {
  return MATCHERS.filter(({ regex }) => regex.test(filePath)).map(({ layer }) => layer);
}

/**
 * The single layer owning `filePath`, or `null` when the file is unclassified
 * or ambiguously classified.
 *
 * @param {string} filePath repository-relative path, POSIX separators
 */
function layerOf(filePath) {
  const matches = layersOf(filePath);

  return matches.length === 1 ? matches[0] : null;
}

/**
 * Union of the regexes of the layers strictly above `level`, or `null` when
 * `level` is the top one and nothing is above it.
 *
 * @param {number} level
 */
function pathAboveLevel(level) {
  const above = LAYERS.filter((layer) => layer.level > level).map((layer) => layer.path);

  return above.length === 0 ? null : above.join("|");
}

module.exports = { LAYERS, MODULES, layersOf, layerOf, pathAboveLevel, modulePathPattern, moduleEntryPattern };
