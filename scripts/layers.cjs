// Single definition of the architecture layers, contexts and modules described in
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
    path: "^src/(validation|pipeline|dsl|builtin-steps|extractors|engine|step|dispatch|boot|run-record|work-item-store|run-stats|project|builtins)/|^src/dsl\\.ts$",
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

// Contexts are the business axis: a layer says how technical a file is, a context
// says which question it answers, and `mayImport` which contexts it may rely on.
// Each one becomes a `context-<name>-direction` rule in `.dependency-cruiser.cjs`.
//
// Unlike a layer, a context classifies single files: `model/`, `env/`, `exec/` and
// `runtime/` mix files that belong to different contexts. A new file in one of these
// folders must be claimed here, which `check-deps.mjs` enforces.

/** @type {{ name: string, path: string, mayImport: string[] | "all", comment: string }[]} */
const CONTEXTS = [
  {
    name: "entry",
    path: "^src/runner\\.ts$|^src/(entry|cli|commands|boot|output)/|^src/model/cli-options\\.ts$|^src/env/(worktree|gitguard|runlock|docker-stack|docker-stack\\.schema)\\.ts$",
    mayImport: "all",
    comment: "What the operator asks for, and the assembly of everything else.",
  },
  {
    name: "dashboard",
    path: "^src/modules/(ui|read-model|dashboard-home)/",
    mayImport: ["run", "work-items", "definition", "shared"],
    comment: "What the human reads.",
  },
  {
    name: "execution",
    path: "^src/(step|dispatch)/|^src/exec/(runners|report-extraction)\\.ts$|^src/runtime/(abort|run-output)\\.ts$",
    mayImport: ["definition", "run", "work-items", "shared"],
    comment: "Which step to run, and what to do with its outcome.",
  },
  {
    name: "agents",
    path: "^src/engine/",
    mayImport: ["shared"],
    comment: "How to talk to each agent CLI. Execution reaches it through contracts/backends, never directly.",
  },
  {
    name: "definition",
    path: "^src/(dsl|builtin-steps|builtins|validation|project|extractors|pipeline)/|^src/dsl\\.ts$|^src/model/(definition|input)\\.ts$|^src/env/builtin-pipeline\\.ts$",
    mayImport: ["work-items", "shared"],
    comment: "What a pipeline is, and whether it is valid.",
  },
  {
    name: "run",
    path: "^src/(run-record|run-stats)/|^src/model/(run|persisted|journal|storage-ports|run-report|scan-record)\\.ts$",
    mayImport: ["definition", "shared"],
    comment: "What happened during a run, and what it cost.",
  },
  {
    name: "work-items",
    path: "^src/modules/work-item/|^src/work-item-store/|^src/model/(source|artifact)\\.ts$",
    mayImport: ["shared"],
    comment: "Which ticket, which artifacts, which provenance.",
  },
  {
    name: "shared",
    path: "^src/(contracts|lib)/|^src/model/(context|artifact-ports|config|profiles|run-stop)\\.ts$|^src/runtime/(logging|live-feed|events|live-cost|context)\\.ts$|^src/exec/(process-runner|process-supervision|self-spawn|bash-runner)\\.ts$|^src/env/(config|config\\.schema|kit-paths|tickets|lock|pricing|pricing\\.schema|capability-frontmatter)\\.ts$",
    mayImport: [],
    comment: "Primitives and the language every context shares; it imports no context.",
  },
];

// Modules are a third axis, orthogonal to the other two: a layer says which way an
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
  { name: "work-item-store", path: "src/work-item-store", entry: "index.ts" },
  { name: "run-stats", path: "src/run-stats", entry: "index.ts" },
  { name: "run-record", path: "src/run-record", entry: "index.ts" },
];

const CONTEXT_MATCHERS = CONTEXTS.map((context) => ({ context, regex: new RegExp(context.path) }));

/**
 * Every context whose regex matches `filePath`. Anything but one match is an
 * error `check-deps.mjs` reports, as it does for layers.
 *
 * @param {string} filePath repository-relative path, POSIX separators
 */
function contextsOf(filePath) {
  return CONTEXT_MATCHERS.filter(({ regex }) => regex.test(filePath)).map(({ context }) => context);
}

/**
 * Union of the regexes of the contexts `context` may not import, or `null` when it
 * may import all of them.
 *
 * @param {{ name: string, mayImport: string[] | "all" }} context
 */
function pathForbiddenTo(context) {
  if (context.mayImport === "all") return null;

  const { mayImport } = context;
  const forbidden = CONTEXTS.filter((other) => other.name !== context.name && !mayImport.includes(other.name));

  return forbidden.length === 0 ? null : forbidden.map((other) => other.path).join("|");
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The name of the dependency-cruiser rule guarding `module`. `check-deps.mjs`
 * reads it back to refuse these rules in the baseline, so both sides share it.
 *
 * @param {{ name: string }} module
 */
function moduleRuleName(module) {
  return `module-${module.name}-entry-only`;
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

module.exports = {
  LAYERS,
  CONTEXTS,
  MODULES,
  layersOf,
  contextsOf,
  pathForbiddenTo,
  layerOf,
  pathAboveLevel,
  moduleRuleName,
  modulePathPattern,
  moduleEntryPattern,
};
