// Only the run record writes a run. Code outside `src/run-record/` holds a
// `RunView` (`model/run.ts`), read-only at every depth, and hands it back to the
// operations of the entry; the mutable run (`run-record/run.ts`) is internal.
//
// Three tests hold that guarantee, each for what the one before cannot see:
//  - the compiler refuses a write through a view (assignment, `delete`, `++`,
//    an array method);
//  - the entry hands out no mutable part of an executing run, nor of a value it
//    carries (control, usage, outcome, lineage, session);
//  - TypeScript still accepts a view given to a mutable type of the same shape
//    (a parameter, a variable) and `Object.assign` on a view, so production code
//    outside the module is scanned for any write whose object has a run shape.

import { expect, test } from "bun:test";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "../..");
const ENTRY = join(ROOT, "src/run-record/index.ts");
const INTERNAL_RUN = join(ROOT, "src/run-record/run.ts");
const PERSISTED = join(ROOT, "src/model/persisted.ts");
const VIEWS = join(ROOT, "src/model/run.ts");
const BACKENDS = join(ROOT, "src/contracts/backends.ts");
const STORAGE_PORTS = join(ROOT, "src/model/storage-ports.ts");
// A module of the step layer that does not exist on disk: what any code outside
// the run record can write against the types it is given.
const PROBE = join(ROOT, "src/step/readonly-probe.ts");
// Another such module, with the writes the compiler accepts: the scan must see them.
const ALIAS_PROBE = join(ROOT, "src/step/aliased-write-probe.ts");

// Each line writes an executing run through what code outside the module holds;
// each must be refused. The read on the last line must compile.
const WRITES = [
  `run.status = "PASS";`,
  `run.aborted = true;`,
  `run.outcome!.reason = "edited";`,
  `run.pipelineLineage!.push({ pipelinePath: "p" });`,
  `run.steps = [];`,
  `run.steps[0]!.status = "done";`,
  `delete step.errors;`,
  `step.retries += 1;`,
  `step.control!.total_cost_usd = 0;`,
  `step.usage!.tools_used!.push("Bash");`,
  `step.attempts.push(step.attempts[0]!);`,
  `step.attempts[0]!.status = "done";`,
  `step.orchestration!.items!.length = 0;`,
  `step.orchestration!.children[0]!.status = "done";`,
  `opened.run.status = "PASS";`,
  `attempt.attempt.status = "failed";`,
  `child.accountedCostUsd = 0;`,
  `node.children.splice(0);`,
  // A run total summed from a single step is that step's own usage.
  `aggregateUsage(run.steps)!.input_tokens = 0;`,
  `aggregateUsage(run.steps)!.tools_used!.push("Bash");`,
];

const PROBE_SOURCE = `
import type { RunStepView, RunView } from "../model/run.js";
import {
  aggregateUsage,
  type declareChild,
  type OpenedAttempt,
  type OpenedRun,
  type openOrchestration,
} from "../run-record/index.js";

export function probe(
  run: RunView,
  step: RunStepView,
  opened: OpenedRun,
  attempt: OpenedAttempt,
  child: ReturnType<typeof declareChild>,
  node: ReturnType<typeof openOrchestration>,
): string | undefined {
${WRITES.map((line) => `  ${line}`).join("\n")}
  return step.attempts[0]?.log_path ?? run.outcome?.reason ?? undefined;
}
`;

// Each line writes an executing run through a view and compiles: a view handed
// to a mutable type of the same shape, or a call that writes its first argument.
// The scan must report each one.
const ALIASED_WRITES = [
  `Object.assign(step, { status: "done" });`,
  `Object.assign(step.control!, { total_cost_usd: 0 });`,
  `const zero = (control: StepControl) => { control.total_cost_usd = 0; }; zero(step.control!);`,
  `const control: StepControl = step.control!; control.total_cost_usd = 0;`,
  `const stats: AttemptStats = step.control!; stats.total_cost_usd = 0;`,
  `const edit = (outcome: RunOutcomeState) => { outcome.reason = "edited"; }; edit(run.outcome!);`,
  `const entry: PipelineLineageEntry = run.pipelineLineage![0]!; entry.ticket = "X";`,
  `const loose: Partial<StepControl> = step.control!; loose.total_cost_usd = 0;`,
  `Reflect.set(run, "status", "PASS");`,
  `(step.control as StepControl).total_cost_usd = 0;`,
  `(run.steps as RunStepView[]).sort();`,
  `const lineage = run.pipelineLineage as PipelineLineageEntry[]; lineage.push({ pipelinePath: "p" });`,
];

const ALIAS_PROBE_SOURCE = `
import type { AttemptStats, StepControl } from "../contracts/backends.js";
import type { PipelineLineageEntry, RunOutcomeState } from "../model/persisted.js";
import type { RunStepView, RunView } from "../model/run.js";

export function probe(run: RunView, step: RunStepView): void {
${ALIASED_WRITES.map((line) => `  ${line}`).join("\n")}
}
`;

const VIRTUAL: Record<string, string> = { [PROBE]: PROBE_SOURCE, [ALIAS_PROBE]: ALIAS_PROBE_SOURCE };

let compiled: { program: ts.Program; probe: ts.SourceFile; aliasProbe: ts.SourceFile } | undefined;

/** One program for every test: the repository's own, plus the two probes. */
function program(): { program: ts.Program; probe: ts.SourceFile; aliasProbe: ts.SourceFile } {
  if (compiled) return compiled;
  const config = ts.getParsedCommandLineOfConfigFile(
    join(ROOT, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (!config) throw new Error("tsconfig.json could not be read");
  const host = ts.createCompilerHost(config.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, language, ...rest) => {
    const source = VIRTUAL[resolve(fileName)];
    return source !== undefined
      ? ts.createSourceFile(fileName, source, language)
      : getSourceFile(fileName, language, ...rest);
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => resolve(fileName) in VIRTUAL || fileExists(fileName);
  const built = ts.createProgram([...config.fileNames, PROBE, ALIAS_PROBE], config.options, host);
  const probe = built.getSourceFile(PROBE);
  const aliasProbe = built.getSourceFile(ALIAS_PROBE);
  if (!probe || !aliasProbe) throw new Error("the probes were not compiled");
  compiled = { program: built, probe, aliasProbe };
  return compiled;
}

test(
  "code outside the run record cannot write an executing run: no field, nested record or list of it",
  () => {
    const { program: built, probe } = program();
    const lines = PROBE_SOURCE.split("\n");
    const refused = new Set(
      built
        .getSemanticDiagnostics(probe)
        .map((diagnostic) => lines[probe.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line]!.trim()),
    );
    expect(WRITES.filter((write) => !refused.has(write))).toEqual([]);
    // Nothing else is refused — not the imports, not the read on the last line:
    // each write fails for being a write.
    expect([...refused].filter((line) => !WRITES.includes(line))).toEqual([]);
  },
  { timeout: 120_000 },
);

type Polarity = 1 | -1;

/** The mutable shapes of an executing run and of the values it carries. Code
 *  outside the module may receive one only as a copy that is not the run (a
 *  reader's, a store's). */
function mutableShapes(checker: ts.TypeChecker, built: ts.Program): Map<ts.Symbol, string> {
  const shapes = new Map<ts.Symbol, string>();
  const declared = (file: string, names: readonly string[]) => {
    for (const [symbol, name] of exportsNamed(checker, built, file, names)) shapes.set(symbol, name);
  };
  declared(INTERNAL_RUN, ["Run", "RunStep"]);
  declared(PERSISTED, [
    "PersistedRun",
    "PersistedStepState",
    "PersistedAttempt",
    "PersistedPipelineChildRef",
    "PersistedPipelineOrchestrationState",
    // The values a run carries: written in place, each would rewrite the run.
    "PipelineLineageEntry",
    "RunOutcomeState",
    "RunStopState",
  ]);
  declared(BACKENDS, ["AgentSession", "AttemptStats", "StepControl", "StepUsage"]);
  return shapes;
}

function exportsNamed(
  checker: ts.TypeChecker,
  built: ts.Program,
  file: string,
  names: readonly string[],
): Array<[ts.Symbol, string]> {
  const source = built.getSourceFile(file);
  const module = source && checker.getSymbolAtLocation(source);
  if (!module) throw new Error(`${file} is not in the program`);
  return checker
    .getExportsOfModule(module)
    .filter((symbol) => names.includes(symbol.getName()))
    .map((symbol) => [symbol, symbol.getName()]);
}

/** The storage ports a caller may inject. A `RunView` carries two of them, so
 *  every operation reaches them: what they are given is checked once, below,
 *  rather than under each operation. */
const PORTS = ["RunEventStore", "RunLogStore", "RunStateStore"];

/** The mutable shapes reachable from `type`, with the position each is reached in:
 *  `1` where the module hands a value out, `-1` where it receives one. A function
 *  parameter flips the position, so the argument of a callback the module calls
 *  is a value it hands out. */
function reachedShapes(
  checker: ts.TypeChecker,
  shapes: Map<ts.Symbol, string>,
  type: ts.Type,
  ports: ReadonlySet<ts.Symbol> = new Set(),
): Array<[string, Polarity]> {
  const found = new Set<string>();
  const seen = new Set<string>();
  const visit = (current: ts.Type, polarity: Polarity) => {
    const key = `${checker.typeToString(current, undefined, ts.TypeFormatFlags.NoTruncation)}|${(current as { id?: number }).id}|${polarity}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (current.isUnionOrIntersection()) {
      for (const member of current.types) visit(member, polarity);
      return;
    }
    const symbol = current.getSymbol();
    if (symbol && ports.has(symbol)) return;
    const shape = symbol && shapes.get(symbol);
    if (shape) found.add(`${shape}|${polarity}`);
    for (const signature of [...current.getCallSignatures(), ...current.getConstructSignatures()]) {
      for (const parameter of signature.getParameters()) {
        visit(checker.getTypeOfSymbol(parameter), (polarity * -1) as Polarity);
      }
      visit(signature.getReturnType(), polarity);
    }
    if (!(current.flags & ts.TypeFlags.Object)) return;
    if (checker.isArrayType(current) || checker.isTupleType(current)) {
      for (const element of checker.getTypeArguments(current as ts.TypeReference)) visit(element, polarity);
      return;
    }
    if ((current as ts.TypeReference).target) {
      for (const argument of checker.getTypeArguments(current as ts.TypeReference)) visit(argument, polarity);
    }
    for (const property of current.getProperties()) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (declaration?.getSourceFile().fileName.includes("/node_modules/")) continue;
      visit(checker.getTypeOfSymbol(property), polarity);
    }
  };
  visit(type, 1);
  return [...found].map((entry) => {
    const [shape, polarity] = entry.split("|");
    return [shape!, Number(polarity) as Polarity];
  });
}

/** A whole run snapshot read from disk: every shape it holds. */
const RUN_COPY = [
  "AgentSession",
  "PersistedPipelineChildRef",
  "PersistedPipelineOrchestrationState",
  "PersistedRun",
  "PersistedStepState",
  "PipelineLineageEntry",
  "RunOutcomeState",
  "RunStopState",
  "StepControl",
  "StepUsage",
];

/** Journal events: every value an event records. */
const EVENT_VALUES = ["AgentSession", "RunOutcomeState", "RunStopState", "StepControl", "StepUsage"];

// What the entry may hand out in a mutable shape, and why it is not the run. A
// new operation that returns a part of an executing run — the run, a step, an
// attempt, a child reference, a node state, or a value one of them carries —
// fails here until it returns a view. A type export has no position of its own:
// whatever it holds is listed, input or output.
const HANDED_OUT: Record<string, string[]> = {
  // Readers: a snapshot reconciled with its journal, read from disk for the call.
  RunRead: RUN_COPY,
  readRun: RUN_COPY,
  readLatestRun: RUN_COPY,
  readListedRun: RUN_COPY,
  resolveLatestRunSnapshot: RUN_COPY,
  // Attempts and events read back from the journal for the call.
  RunHistory: [...EVENT_VALUES, "PersistedAttempt"].sort(),
  readRunHistory: [...EVENT_VALUES, "PersistedAttempt"].sort(),
  RunJournalReport: EVENT_VALUES,
  readRunJournal: EVENT_VALUES,
  lastJournalEvent: EVENT_VALUES,
  // The file stores: they read copies from disk, and are given what the run
  // record writes (see GIVEN_TO_STORES).
  FileRunEventStore: EVENT_VALUES,
  FileRunStateStore: RUN_COPY,
  // What a spawn returned, which the caller gives `settleAttempt`: built by the
  // backend, never read from a run. The figures are copied into the run; the
  // session is kept as it is, and the scan below checks no caller writes it.
  AttemptResult: ["AgentSession", "AttemptStats"],
  // What a caller gives `openRun`. A child run keeps the lineage it is given as
  // its own; the scan below checks the caller does not write it afterwards.
  RunScope: ["PipelineLineageEntry"],
  // Not the run's: the stop a step definition's `when` predicate returns
  // (`def.when`), produced by the call.
  OpenedRun: ["RunStopState"],
  openRun: ["RunStopState"],
};

// What an injected store is given to serialize: the snapshot the run record
// writes, and each journal event. Neither is a deep copy — the snapshot is a
// shallow one, and an event carries the figures it records — so a store that
// wrote what it is given would write the run. The stores of the module do not;
// no production store exists outside it.
const GIVEN_TO_STORES: Record<string, string[]> = {
  RunEventStore: EVENT_VALUES,
  RunStateStore: RUN_COPY,
};

test(
  "the run record's entry hands out no mutable part of an executing run, and never names the mutable run",
  () => {
    const { program: built } = program();
    const checker = built.getTypeChecker();
    const shapes = mutableShapes(checker, built);
    const ports = exportsNamed(checker, built, STORAGE_PORTS, PORTS);
    const portSymbols = new Set(ports.map(([symbol]) => symbol));
    const entry = built.getSourceFile(ENTRY);
    const module = entry && checker.getSymbolAtLocation(entry);
    if (!module) throw new Error("run-record/index.ts is not in the program");
    const handedOut: Record<string, string[]> = {};
    const namesRun: string[] = [];
    for (const exported of checker.getExportsOfModule(module)) {
      const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const declaration = target.declarations?.[0];
      if (!declaration) continue;
      const type =
        target.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)
          ? checker.getDeclaredTypeOfSymbol(target)
          : checker.getTypeOfSymbolAtLocation(target, declaration);
      const reached = reachedShapes(checker, shapes, type, portSymbols);
      if (reached.some(([shape]) => shape === "Run" || shape === "RunStep")) namesRun.push(exported.getName());
      const out = [...new Set(reached.filter(([, polarity]) => polarity === 1).map(([shape]) => shape))].sort();
      if (out.length > 0) handedOut[exported.getName()] = out;
    }
    const given: Record<string, string[]> = {};
    for (const [port, name] of ports) {
      const intake = reachedShapes(checker, shapes, checker.getDeclaredTypeOfSymbol(port))
        .filter(([, polarity]) => polarity === -1)
        .map(([shape]) => shape);
      if (intake.length > 0) given[name] = [...new Set(intake)].sort();
    }
    expect(namesRun).toEqual([]);
    expect(handedOut).toEqual(HANDED_OUT);
    expect(given).toEqual(GIVEN_TO_STORES);
  },
  { timeout: 120_000 },
);

/** Files whose every type is a run shape: the persisted records, the views, the
 *  mutable run. */
const SHAPE_FILES = [PERSISTED, VIEWS, INTERNAL_RUN];
/** The values a run carries, declared with the backend contract. `AttemptStats`
 *  is among them: every field of a control or a usage is optional in it but one,
 *  so a step's control fits it. */
const CARRIED_VALUES = new Set(["AgentSession", "AttemptStats", "StepControl", "StepUsage"]);
const ARRAY_MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);
/** Calls that write the object given as their first argument. */
const WRITING_CALLS = new Set([
  "Object.assign",
  "Object.defineProperty",
  "Object.defineProperties",
  "Reflect.set",
  "Reflect.defineProperty",
  "Reflect.deleteProperty",
]);

/** The run shape `type` is, if any: a shape itself, or a utility type over one
 *  (`Partial<StepControl>`, `Pick<RunView, …>`), whose first argument is the shape. */
function runShapeOf(type: ts.Type, depth = 0): string | undefined {
  for (const member of type.isUnionOrIntersection() ? type.types : [type]) {
    for (const symbol of [member.aliasSymbol, member.getSymbol()]) {
      const file = symbol?.declarations?.[0]?.getSourceFile().fileName;
      if (!symbol || !file) continue;
      if (SHAPE_FILES.includes(resolve(file))) return symbol.getName();
      if (resolve(file) === BACKENDS && CARRIED_VALUES.has(symbol.getName())) return symbol.getName();
    }
    const wrapped = member.aliasTypeArguments?.[0];
    const shape = wrapped && depth < 4 ? runShapeOf(wrapped, depth + 1) : undefined;
    if (shape) return shape;
  }
  return undefined;
}

/** The run shape a write lands in: the written object or list, or any object it
 *  was read from (`run.outcome.reason = …` writes the run), seen through casts,
 *  so that `(run as Mutable<RunView>)` still names the run. */
function writtenShape(checker: ts.TypeChecker, target: ts.Expression): string | undefined {
  let current: ts.Expression = target;
  for (;;) {
    const type = checker.getTypeAtLocation(current);
    // A list of run values is written too when an element is added or replaced:
    // the run may hold that very list (the lineage a child run is opened with).
    // A list built on the spot (`[...runs]`, `runs.slice()`) is nobody's.
    const held =
      ts.isIdentifier(current) || ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current);
    const element =
      held && checker.isArrayType(type) ? checker.getTypeArguments(type as ts.TypeReference)[0] : undefined;
    const shape = runShapeOf(type) ?? (element && runShapeOf(element));
    if (shape) return shape;
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      current = current.expression;
    } else {
      return undefined;
    }
  }
}

/** The object a write changes: `a` in `a.b = …`, `a.b` in `a.b.push(…)`, the
 *  first argument of `Object.assign(…)`. A plain local (`x = …`) changes none. */
function writeTarget(node: ts.Node): ts.Expression | undefined {
  const objectOf = (written: ts.Expression) =>
    ts.isPropertyAccessExpression(written) || ts.isElementAccessExpression(written) ? written.expression : undefined;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return objectOf(node.left);
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return objectOf(node.operand);
  }
  if (ts.isDeleteExpression(node)) return objectOf(node.expression);
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const callee = node.expression;
    if (ARRAY_MUTATORS.has(callee.name.text)) return callee.expression;
    if (WRITING_CALLS.has(callee.getText())) return node.arguments[0];
  }
  return undefined;
}

/** Every write in `source` whose object has a run shape, as `text` per line. */
function runWrites(checker: ts.TypeChecker, source: ts.SourceFile): Array<{ line: number; text: string }> {
  const writes: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    const target = writeTarget(node);
    if (target && writtenShape(checker, target)) {
      writes.push({
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line,
        text: node.getText(source).replace(/\s+/g, " "),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return writes;
}

// Writes outside the module whose object has a run shape but is not part of a
// run. Each entry is one write, by file; a new one fails the test until it is
// argued for here.
const NOT_A_RUN: Record<string, string[]> = {
  // The figures a Claude Code backend parses from its own output, adjusted before
  // the backend returns them. They reach a run only through `settleAttempt`,
  // which copies them (`splitAttemptStats`), so no write here reaches a run.
  "src/engine/backends/claude-code/result.ts": [
    "parsed.stats.duration_ms = raw.durationMs",
    "parsed.stats.duration_ms += raw.priorAttemptsDurationMs",
    "parsed.stats.total_cost_usd = netCumulative(parsed.stats.total_cost_usd, baseline.costUsd)",
    "parsed.stats.duration_api_ms = netCumulative(parsed.stats.duration_api_ms, baseline.apiDurationMs)",
    "parsed.stats.num_turns = parsed.turnsInProcess",
    "parsed.stats.cost_unknown = true",
    "parsed.stats.total_cost_usd = (parsed.stats.total_cost_usd ?? 0) + raw.priorAttemptsCostUsd",
  ],
};

test(
  "the scan sees a write through a view that the compiler accepts",
  () => {
    const { program: built, aliasProbe } = program();
    // The compiler accepts every one of them: the scan is what refuses them.
    expect(
      built.getSemanticDiagnostics(aliasProbe).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    ).toEqual([]);
    const lines = ALIAS_PROBE_SOURCE.split("\n");
    const seen = new Set(runWrites(built.getTypeChecker(), aliasProbe).map(({ line }) => lines[line]!.trim()));
    expect(ALIASED_WRITES.filter((write) => !seen.has(write))).toEqual([]);
  },
  { timeout: 120_000 },
);

test(
  "production code outside the run record writes no object with a run shape",
  () => {
    const { program: built } = program();
    const checker = built.getTypeChecker();
    const found: Record<string, string[]> = {};
    for (const source of built.getSourceFiles()) {
      const file = relative(ROOT, source.fileName);
      if (!file.startsWith("src/") || file.startsWith("src/run-record/") || /\.test\.tsx?$/.test(file)) continue;
      if (resolve(source.fileName) in VIRTUAL) continue;
      const writes = runWrites(checker, source).map(({ text }) => text);
      if (writes.length > 0) found[file] = writes;
    }
    expect(found).toEqual(NOT_A_RUN);
  },
  { timeout: 120_000 },
);
