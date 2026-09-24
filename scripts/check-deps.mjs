#!/usr/bin/env bun

// Architecture gate, run by `bun run deps:check`.
//
// Four things, in order:
//   1. every source file is classified in exactly one layer (scripts/layers.cjs);
//   2. the dependency-cruiser violations match the known-violations baseline,
//      entry for entry — a violation missing from the baseline is new debt, a
//      baseline entry with no matching edge is stale and must be removed;
//   3. the folders directly under `src/` match the known-folder-cycles baseline
//      the same way: an edge between two folders of one cycle must be listed,
//      and an entry that no longer names such an edge is stale;
//   4. the remaining debt is printed per rule, cycles apart.
//
// The two baselines are read as one gate: both are compared, both print what
// they found, and a single non-zero exit reports either.
//
// The folder check exists because `no-circular` cannot see a folder cycle: two
// folders lock each other as soon as `a/x` imports `b/x` and `b/y` imports
// `a/y`, and no file of that pair sits in a file cycle. So the graph is grouped
// first — one node per folder directly under `src/`, plus one node per file
// directly under `src/`, `src/dsl.ts` being a different node from `src/dsl/` —
// and the cycles are read off its strongly connected components.
//
// The file baseline is a list of file to file edges, never a folder, and it is
// edited by hand: `--write-baseline` only exists to bootstrap it and to print
// the exact lines to paste after a rename. The folder baseline is edited by
// hand only, and each entry names the cut that is meant to remove it. One entry
// per line keeps the diffs readable, which is why biome.json excludes both
// files from the formatter.
//
// Since the closing lot every entry must carry a `why` and a `reviewedOn` date:
// the baseline is no longer a bulk record of what the refactor had not reached
// yet, it is a short list of edges someone argued for and dated. And once the
// baseline is empty, `--write-baseline` refuses to fill it again — the only way
// out of a violation is to fix the import.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { layersOf } = require("./layers.cjs");

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASELINE = ".dependency-cruiser-known-violations.json";
const DEFAULT_FOLDER_BASELINE = ".dependency-cruiser-known-folder-cycles.json";
const DEFAULT_CONFIG = ".dependency-cruiser.cjs";

// Kept in sync with `options.exclude.path` of the dependency-cruiser config:
// the cruise never reports these files, so the classification must not demand
// a layer for them either.
const UNCLASSIFIED_BY_DESIGN = [/\.test\.tsx?$/, /^src\/modules\/ui\/static\//, /^src\/modules\/ui\/app\//];

function parseArgs(argv) {
  const options = {
    baseline: DEFAULT_BASELINE,
    folderBaseline: DEFAULT_FOLDER_BASELINE,
    config: DEFAULT_CONFIG,
    write: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--write-baseline") options.write = true;
    else if (arg === "--baseline") options.baseline = argv[++index];
    else if (arg === "--folder-baseline") options.folderBaseline = argv[++index];
    else if (arg === "--config") options.config = argv[++index];
    else throw new Error(`unknown option: ${arg}`);
  }

  return options;
}

function sourceFilesUnder(directory) {
  if (!existsSync(directory)) return [];

  const found = [];

  for (const name of readdirSync(directory)) {
    const path = join(directory, name);

    if (statSync(path).isDirectory()) found.push(...sourceFilesUnder(path));
    else if (/\.tsx?$/.test(name)) found.push(path);
  }

  return found;
}

function checkClassification() {
  const problems = [];

  for (const path of sourceFilesUnder("src")) {
    const relativePath = relative(".", path).split("\\").join("/");

    if (UNCLASSIFIED_BY_DESIGN.some((pattern) => pattern.test(relativePath))) continue;

    const matches = layersOf(relativePath);

    if (matches.length === 0) {
      problems.push(`unclassified file: ${relativePath}`);
    } else if (matches.length > 1) {
      const names = matches.map((layer) => `L${layer.level} ${layer.name}`).join(", ");

      problems.push(`file classified in several layers (${names}): ${relativePath}`);
    }
  }

  return problems;
}

function cruise(configPath) {
  // The package entry point, not the `.bin/depcruise` wrapper: that wrapper carries
  // a `#!/usr/bin/env node` shebang, so on a Bun-only machine it fails with exit 127
  // and an empty stdout — read below as "depcruise refused to run", which names the
  // config rather than the missing runtime. `process.execPath` is the runtime that
  // started this script, as `checkDeps` already does in tests/deps.
  const binary = join(REPO_ROOT, "node_modules", "dependency-cruiser", "bin", "dependency-cruise.mjs");
  const result = spawnSync(process.execPath, [binary, "--config", configPath, "--output-type", "json", "src"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) throw new Error(`could not run depcruise: ${result.error.message}`);

  try {
    return JSON.parse(result.stdout);
  } catch {
    // A non-JSON stdout means depcruise refused to run at all — most often a
    // config option that is not in its schema. That is the other half of what
    // this gate is for, so it must be loud.
    throw new Error(`depcruise failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
}

function compareEntries(left, right) {
  return left.rule.localeCompare(right.rule) || left.from.localeCompare(right.from) || left.to.localeCompare(right.to);
}

function violationsOf(report) {
  const violations = report.summary?.violations ?? [];

  return violations
    .map((violation) => ({ rule: violation.rule.name, from: violation.from, to: violation.to }))
    .sort(compareEntries);
}

function keyOf(entry) {
  return [entry.rule, entry.from, entry.to].join("\u0000");
}

/**
 * The node a source file belongs to in the folder graph: the folder directly
 * under `src/`, or the file name itself when the file sits at the root of
 * `src/`. Anything outside `src/` — a package, a build product — has no node
 * and is left out of the graph.
 *
 * @param {string} path
 */
function moduleOf(path) {
  const match = /^src\/([^/]+)(?:\/|$)/.exec(path.split("\\").join("/"));

  return match === null ? null : match[1];
}

/**
 * The folder graph, grouped from the cruise report already in hand: one edge
 * per ordered pair of distinct nodes, whatever the number of file edges behind
 * it. Edges inside one folder are what a folder is for, so they are dropped.
 */
function folderEdgesOf(report) {
  const edges = new Map();

  for (const module of report.modules ?? []) {
    const from = moduleOf(module.source);

    if (from === null) continue;

    for (const dependency of module.dependencies ?? []) {
      const to = moduleOf(dependency.resolved);

      if (to === null || to === from) continue;

      edges.set(`${from}\u0000${to}`, { from, to });
    }
  }

  return [...edges.values()];
}

/**
 * Tarjan's strongly connected components, keeping only the components holding
 * more than one node. An edge belongs to a folder cycle exactly when both of
 * its ends sit in the same such component.
 */
function multiNodeComponents(edges) {
  const successors = new Map();

  for (const { from, to } of edges) {
    if (!successors.has(from)) successors.set(from, []);
    if (!successors.has(to)) successors.set(to, []);

    successors.get(from).push(to);
  }

  const index = new Map();
  const lowLink = new Map();
  const onStack = new Set();
  const stack = [];
  const component = new Map();
  let counter = 0;

  function visit(node) {
    index.set(node, counter);
    lowLink.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of successors.get(node)) {
      if (!index.has(next)) {
        visit(next);
        lowLink.set(node, Math.min(lowLink.get(node), lowLink.get(next)));
      } else if (onStack.has(next)) {
        lowLink.set(node, Math.min(lowLink.get(node), index.get(next)));
      }
    }

    if (lowLink.get(node) !== index.get(node)) return;

    const members = [];
    let popped;

    do {
      popped = stack.pop();
      onStack.delete(popped);
      members.push(popped);
    } while (popped !== node);

    if (members.length > 1) {
      const id = members.slice().sort().join(" <-> ");

      for (const member of members) component.set(member, id);
    }
  }

  for (const node of successors.keys()) if (!index.has(node)) visit(node);

  return component;
}

function compareFolderEntries(left, right) {
  return left.from.localeCompare(right.from) || left.to.localeCompare(right.to);
}

/** Every folder edge whose two ends belong to one and the same cycle. */
function cyclicFolderEdges(report) {
  const edges = folderEdgesOf(report);
  const component = multiNodeComponents(edges);

  return edges
    .filter(({ from, to }) => component.has(from) && component.get(from) === component.get(to))
    .sort(compareFolderEntries);
}

function folderKeyOf(entry) {
  return [entry.from, entry.to].join("\u0000");
}

function folderLineOf(entry) {
  const { from, to, why, reviewedOn, removedBy } = entry;

  return `  ${JSON.stringify({
    from,
    to,
    why: why ?? "",
    reviewedOn: reviewedOn ?? today(),
    removedBy: removedBy ?? "",
  })}`;
}

function readFolderBaseline(path) {
  if (!existsSync(path)) return [];

  const parsed = JSON.parse(readFileSync(path, "utf8"));

  if (!Array.isArray(parsed)) throw new Error(`${path}: expected a JSON array of entries`);

  return parsed.map((entry) => ({
    from: entry.from,
    to: entry.to,
    why: entry.why,
    reviewedOn: entry.reviewedOn,
    removedBy: entry.removedBy,
  }));
}

function lineOf(entry) {
  const { rule, from, to, why, reviewedOn } = entry;

  return `  ${JSON.stringify({ rule, from, to, why: why ?? "", reviewedOn: reviewedOn ?? today() })}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Carry over the justification of an edge the baseline already knew, so
 * rewriting it after a rename does not silently drop an argued exception.
 */
function withKnownJustifications(observed, known) {
  const byKey = new Map(known.map((entry) => [keyOf(entry), entry]));

  return observed.map((entry) => {
    const previous = byKey.get(keyOf(entry));

    return previous ? { ...entry, why: previous.why, reviewedOn: previous.reviewedOn } : entry;
  });
}

function serializeBaseline(entries) {
  if (entries.length === 0) return "[]\n";

  return `[\n${entries.map(lineOf).join(",\n")}\n]\n`;
}

function readBaseline(path) {
  if (!existsSync(path)) return [];

  const parsed = JSON.parse(readFileSync(path, "utf8"));

  if (!Array.isArray(parsed)) throw new Error(`${path}: expected a JSON array of entries`);

  return parsed.map((entry) => ({
    rule: entry.rule,
    from: entry.from,
    to: entry.to,
    why: entry.why,
    reviewedOn: entry.reviewedOn,
  }));
}

const REVIEWED_ON = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A kept violation is an argued exception, not a leftover: it says why it is
 * there and when that reason was last looked at. An entry without both is
 * rejected rather than silently tolerated. Both baselines are held to it; the
 * folder one carries no rule name, so the edge alone names it.
 */
function checkJustifications(entries) {
  const problems = [];

  for (const entry of entries) {
    const edge = entry.rule ? `${entry.rule}: ${entry.from} -> ${entry.to}` : `${entry.from} -> ${entry.to}`;

    if (typeof entry.why !== "string" || entry.why.trim() === "") {
      problems.push(`${edge}: missing \`why\` (state the reason this edge is kept, or remove the edge)`);
    }

    if (typeof entry.reviewedOn !== "string" || !REVIEWED_ON.test(entry.reviewedOn)) {
      problems.push(`${edge}: missing or malformed \`reviewedOn\` (expected YYYY-MM-DD)`);
    }
  }

  return problems;
}

function printDebt(entries, folderCycles) {
  const counts = new Map();

  for (const entry of entries) counts.set(entry.rule, (counts.get(entry.rule) ?? 0) + 1);

  const cycles = counts.get("no-circular") ?? 0;
  const others = [...counts]
    .filter(([rule]) => rule !== "no-circular")
    .sort(([left], [right]) => left.localeCompare(right));

  console.log("Known architecture debt, per rule:");

  for (const [rule, count] of others) console.log(`  ${rule.padEnd(30)} ${count}`);

  console.log(`  ${"no-circular".padEnd(30)} ${cycles}`);
  console.log(`  ${"total".padEnd(30)} ${entries.length}`);
  console.log(`  ${"folder cycles".padEnd(30)} ${folderCycles}`);
}

/**
 * Compare the cyclic folder edges to their baseline, print what does not match,
 * and say whether the check failed. The file baseline is compared the same way
 * by the block below; neither short-circuits the other.
 */
function checkFolderBaseline(baselinePath, observed) {
  const known = readFolderBaseline(baselinePath);
  const unjustified = checkJustifications(known);

  if (unjustified.length > 0) {
    console.error(`Every entry of ${baselinePath} must be justified and dated.`);

    for (const problem of unjustified) console.error(`  ${problem}`);

    return true;
  }

  const knownKeys = new Set(known.map(folderKeyOf));
  const observedKeys = new Set(observed.map(folderKeyOf));
  const added = observed.filter((entry) => !knownKeys.has(folderKeyOf(entry)));
  const stale = known.filter((entry) => !observedKeys.has(folderKeyOf(entry))).sort(compareFolderEntries);

  if (added.length > 0) {
    console.error(`New folder cycle: ${added.length} cyclic folder edge(s) absent from ${baselinePath}.`);
    console.error("Cut the dependency, or, when the plan says so, add these lines to the baseline:");

    for (const entry of added) console.error(folderLineOf(entry));
  }

  if (stale.length > 0) {
    console.error(`Stale folder baseline: ${stale.length} entry(ies) of ${baselinePath} no longer name a cycle.`);
    console.error("Remove these lines:");

    for (const entry of stale) console.error(folderLineOf(entry));
  }

  return added.length > 0 || stale.length > 0;
}

/** The same comparison, on the file to file baseline. */
function checkFileBaseline(baselinePath, observed) {
  const known = readBaseline(baselinePath);
  const unjustified = checkJustifications(known);

  if (unjustified.length > 0) {
    console.error(`Every entry of ${baselinePath} must be justified and dated.`);

    for (const problem of unjustified) console.error(`  ${problem}`);

    return true;
  }

  const knownKeys = new Set(known.map(keyOf));
  const observedKeys = new Set(observed.map(keyOf));
  const added = observed.filter((entry) => !knownKeys.has(keyOf(entry)));
  const stale = known.filter((entry) => !observedKeys.has(keyOf(entry))).sort(compareEntries);

  if (added.length > 0) {
    console.error(`New architecture debt: ${added.length} violation(s) absent from ${baselinePath}.`);
    console.error("Fix the import, or, when the plan says so, add these lines to the baseline:");

    for (const entry of added) console.error(lineOf(entry));
  }

  if (stale.length > 0) {
    console.error(`Stale baseline: ${stale.length} entry(ies) of ${baselinePath} no longer match an edge.`);
    console.error("Remove these lines:");

    for (const entry of stale) console.error(lineOf(entry));
  }

  return added.length > 0 || stale.length > 0;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const classification = checkClassification();

  if (classification.length > 0) {
    console.error("Every file under src/ must belong to exactly one layer (scripts/layers.cjs).");

    for (const problem of classification) console.error(`  ${problem}`);

    process.exitCode = 1;

    return;
  }

  const report = cruise(options.config);
  const observed = violationsOf(report);
  const folderCycles = cyclicFolderEdges(report);

  if (options.write) {
    // An empty baseline is a state to defend, not a starting point: refilling it
    // would turn every new violation into a recorded fact instead of a fix.
    if (existsSync(options.baseline) && readBaseline(options.baseline).length === 0) {
      console.error(`${options.baseline} is empty: architecture debt may no longer be recorded, only fixed.`);
      process.exitCode = 1;

      return;
    }

    writeFileSync(
      options.baseline,
      serializeBaseline(withKnownJustifications(observed, readBaseline(options.baseline))),
    );
    console.log(`Wrote ${observed.length} entries to ${options.baseline}.`);
    printDebt(observed, folderCycles.length);

    return;
  }

  // Both baselines are compared, and both report: a run that fails on files
  // still has to say what it found on folders, so one pass fixes both.
  const fileFailed = checkFileBaseline(options.baseline, observed);
  const folderFailed = checkFolderBaseline(options.folderBaseline, folderCycles);

  if (fileFailed || folderFailed) {
    process.exitCode = 1;

    return;
  }

  printDebt(observed, folderCycles.length);
}

main();
