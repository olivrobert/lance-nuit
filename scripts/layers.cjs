// Single definition of the architecture layers described in guide/architecture.md.
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

module.exports = { LAYERS, layersOf, layerOf, pathAboveLevel };
