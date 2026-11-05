// Single definition of the contexts, levels and modules described in
// guide/architecture.md.
// Both `.dependency-cruiser.cjs` (to build the rules) and `scripts/check-deps.mjs`
// (to prove every source file is classified) read it, so a new file or folder is
// declared once and both checks see it.

// Contexts are the axis of the source tree: one folder under `src/` per question
// the code answers, and `mayImport` says which contexts it may rely on. Each one
// becomes a `context-<name>-direction` rule in `.dependency-cruiser.cjs`.
//
// `shared` is a closed list on purpose. A regex on its folder would let any new
// file in, and the base every context imports is where a coupling hides best: a
// new file there has to be named here, which `check-deps.mjs` enforces.

/** @type {{ name: string, path: string, mayImport: string[] | "all", comment: string }[]} */
const CONTEXTS = [
  {
    name: "entry",
    path: "^src/runner\\.ts$|^src/entry/",
    mayImport: "all",
    comment: "What the operator asks for, and the assembly of everything else.",
  },
  {
    name: "dashboard",
    path: "^src/dashboard/",
    mayImport: ["run", "work-items", "definition", "shared"],
    comment: "What the human reads.",
  },
  {
    name: "execution",
    path: "^src/execution/",
    mayImport: ["definition", "run", "work-items", "shared"],
    comment: "Which step to run, and what to do with its outcome.",
  },
  {
    name: "agents",
    path: "^src/agents/",
    mayImport: ["shared"],
    comment: "How to talk to each agent CLI. Execution reaches it through contracts/backends, never directly.",
  },
  {
    name: "definition",
    path: "^src/definition/",
    mayImport: ["work-items", "shared"],
    comment: "What a pipeline is, and whether it is valid.",
  },
  {
    name: "run",
    path: "^src/run/",
    mayImport: ["definition", "shared"],
    comment: "What happened during a run, and what it cost.",
  },
  {
    name: "work-items",
    path: "^src/work-items/",
    mayImport: ["shared"],
    comment: "Which ticket, which artifacts, which provenance.",
  },
  {
    name: "shared",
    path: "^src/contracts/|^src/shared/lib/|^src/shared/language/(context|artifact-ports|config|profiles|run-stop)\\.ts$|^src/shared/runtime/(logging|live-feed|events|context)\\.ts$|^src/shared/process/(process-runner|process-supervision|self-spawn|bash-runner)\\.ts$|^src/shared/env/(config|config\\.schema|kit-paths|tickets|lock|pricing|pricing\\.schema|capability-frontmatter)\\.ts$",
    mayImport: [],
    comment: "Primitives and the language every context shares; it imports no context.",
  },
];

// Levels order the inside of `shared` only: a context has no internal layers, and
// the direction between contexts already says which way an import may go. A level
// may import from its own level or below; each one becomes a `layer-<n>-no-upward`
// rule.

/** @type {{ level: number, name: string, path: string, comment: string }[]} */
const LAYERS = [
  {
    level: 0,
    name: "lib",
    path: "^src/shared/lib/",
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
    name: "language",
    path: "^src/shared/language/",
    comment: "Data shapes and ports every context speaks; no behaviour, no I/O.",
  },
  {
    level: 3,
    name: "infra",
    path: "^src/shared/(env|process|runtime)/",
    comment: "Configuration, process execution and cross-cutting runtime services.",
  },
];

// Modules say through which file a folder may be entered from outside. Each one
// becomes a `module-<name>-entry-only` rule in `.dependency-cruiser.cjs`, and
// `check-deps.mjs` proves every entry exists, so a renamed entry cannot leave
// behind a rule that silently forbids every outside import, the entry included.
//
// These rules have no baseline: a module is declared in the change that routes
// every outside import through its entry.
//
// A facade is the module of a whole context: the only files other contexts may
// import from it, re-exports only. `work-items` has a second door because the
// adapter registry is composition, reserved to `entry`: in `index.ts`, every
// context could reach it.

/** @type {{ name: string, path: string, entry: string, otherEntries?: string[] }[]} */
const FACADES = [
  {
    name: "agents",
    path: "src/agents",
    entry: "index.ts",
  },
  {
    name: "dashboard",
    path: "src/dashboard",
    entry: "index.ts",
  },
  {
    name: "definition",
    path: "src/definition",
    entry: "index.ts",
  },
  {
    name: "execution",
    path: "src/execution",
    entry: "index.ts",
  },
  {
    name: "run",
    path: "src/run",
    entry: "index.ts",
  },
  {
    name: "work-items",
    path: "src/work-items",
    entry: "index.ts",
    otherEntries: ["composition.ts"],
  },
];

const MODULES = [
  ...FACADES,
  { name: "ui", path: "src/dashboard/ui", entry: "index.ts" },
  { name: "read-model", path: "src/dashboard/read-model", entry: "index.ts" },
  { name: "dashboard-home", path: "src/dashboard/home", entry: "index.ts" },
  { name: "work-item", path: "src/work-items/providers", entry: "registry.ts" },
  { name: "extractors", path: "src/definition/extractors", entry: "registry.ts" },
  { name: "step", path: "src/execution/step", entry: "step-loop.ts" },
  { name: "work-item-store", path: "src/work-items/store", entry: "index.ts" },
  { name: "run-stats", path: "src/run/stats", entry: "index.ts" },
  { name: "run-record", path: "src/run/record", entry: "index.ts" },
];

const CONTEXT_MATCHERS = CONTEXTS.map((context) => ({ context, regex: new RegExp(context.path) }));

/**
 * Every context whose regex matches `filePath`. Anything but one match is an
 * error `check-deps.mjs` reports.
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
 * Every file through which `module` may be entered.
 *
 * @param {{ entry: string, otherEntries?: string[] }} module
 */
function moduleEntries(module) {
  return [module.entry, ...(module.otherEntries ?? [])];
}

/**
 * The regex matching only the entry files of `module`.
 *
 * @param {{ path: string, entry: string, otherEntries?: string[] }} module
 */
function moduleEntryPattern(module) {
  return moduleEntries(module)
    .map((entry) => `^${escapeRegex(`${module.path}/${entry}`)}$`)
    .join("|");
}

const MATCHERS = LAYERS.map((layer) => ({ layer, regex: new RegExp(layer.path) }));

/**
 * Every level whose regex matches `filePath`: none outside `shared`, and more than
 * one means the table is ambiguous, which `check-deps.mjs` reports as an error.
 *
 * @param {string} filePath repository-relative path, POSIX separators
 */
function layersOf(filePath) {
  return MATCHERS.filter(({ regex }) => regex.test(filePath)).map(({ layer }) => layer);
}

/**
 * Union of the regexes of the levels strictly above `level`, or `null` when
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
  FACADES,
  layersOf,
  contextsOf,
  pathForbiddenTo,
  pathAboveLevel,
  moduleRuleName,
  moduleEntries,
  modulePathPattern,
  moduleEntryPattern,
};
