// Only the run record writes a run. Code outside `src/run-record/` holds a
// `RunView` (`model/run.ts`), read-only at every depth, and hands it back to the
// operations of the entry; the mutable run (`run-record/run.ts`) is internal.
// These tests hold that guarantee in the compiler rather than in a convention:
// a write through a view does not compile, and the entry hands out no mutable
// part of an executing run.

import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "../..");
const ENTRY = join(ROOT, "src/run-record/index.ts");
const INTERNAL_RUN = join(ROOT, "src/run-record/run.ts");
const PERSISTED = join(ROOT, "src/model/persisted.ts");
// A module of the step layer that does not exist on disk: what any code outside
// the run record can write against the types it is given.
const PROBE = join(ROOT, "src/step/readonly-probe.ts");

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
];

const PROBE_SOURCE = `
import type { RunStepView, RunView } from "../model/run.js";
import type { declareChild, OpenedAttempt, OpenedRun, openOrchestration } from "../run-record/index.js";

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

let compiled: { program: ts.Program; probe: ts.SourceFile } | undefined;

/** One program for both tests: the probe and the entry pull in most of `src/`. */
function program(): { program: ts.Program; probe: ts.SourceFile } {
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
  host.getSourceFile = (fileName, language, ...rest) =>
    resolve(fileName) === PROBE
      ? ts.createSourceFile(fileName, PROBE_SOURCE, language)
      : getSourceFile(fileName, language, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => resolve(fileName) === PROBE || fileExists(fileName);
  const built = ts.createProgram([ENTRY, PROBE], config.options, host);
  const probe = built.getSourceFile(PROBE);
  if (!probe) throw new Error("the probe was not compiled");
  compiled = { program: built, probe };
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

/** The mutable shapes of an executing run. Code outside the module may receive
 *  one only as a copy that is not the run (a reader's, a store's). */
function mutableShapes(checker: ts.TypeChecker, built: ts.Program): Map<ts.Symbol, string> {
  const shapes = new Map<ts.Symbol, string>();
  const declared = (file: string, names: readonly string[]) => {
    const source = built.getSourceFile(file);
    const module = source && checker.getSymbolAtLocation(source);
    if (!module) throw new Error(`${file} is not in the program`);
    for (const symbol of checker.getExportsOfModule(module)) {
      if (names.includes(symbol.getName())) shapes.set(symbol, symbol.getName());
    }
  };
  declared(INTERNAL_RUN, ["Run", "RunStep"]);
  declared(PERSISTED, [
    "PersistedRun",
    "PersistedStepState",
    "PersistedAttempt",
    "PersistedPipelineChildRef",
    "PersistedPipelineOrchestrationState",
  ]);
  return shapes;
}

/** The mutable shapes reachable from `type`, with the position each is reached in:
 *  `1` where the module hands a value out, `-1` where it receives one. A function
 *  parameter flips the position, so the argument of a callback the module calls
 *  is a value it hands out. */
function reachedShapes(
  checker: ts.TypeChecker,
  shapes: Map<ts.Symbol, string>,
  type: ts.Type,
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

// What the entry may hand out in a mutable shape, and why it is not the run. A
// new operation that returns a part of an executing run — the run, a step, an
// attempt, a child reference, a node state — fails here until it returns a view.
const HANDED_OUT: Record<string, string[]> = {
  // Readers: a snapshot reconciled with its journal, read from disk for the call.
  RunRead: ["PersistedPipelineChildRef", "PersistedPipelineOrchestrationState", "PersistedRun", "PersistedStepState"],
  readRun: ["PersistedPipelineChildRef", "PersistedPipelineOrchestrationState", "PersistedRun", "PersistedStepState"],
  readLatestRun: [
    "PersistedPipelineChildRef",
    "PersistedPipelineOrchestrationState",
    "PersistedRun",
    "PersistedStepState",
  ],
  readListedRun: [
    "PersistedPipelineChildRef",
    "PersistedPipelineOrchestrationState",
    "PersistedRun",
    "PersistedStepState",
  ],
  resolveLatestRunSnapshot: [
    "PersistedPipelineChildRef",
    "PersistedPipelineOrchestrationState",
    "PersistedRun",
    "PersistedStepState",
  ],
  // Attempts read back from the journal for the call.
  RunHistory: ["PersistedAttempt"],
  readRunHistory: ["PersistedAttempt"],
  // The snapshot store: it reads copies from disk and is given the snapshot the
  // run record serialized to write.
  FileRunStateStore: [
    "PersistedPipelineChildRef",
    "PersistedPipelineOrchestrationState",
    "PersistedRun",
    "PersistedStepState",
  ],
  // The stores a caller injects into the opening are given that same snapshot.
  openRun: ["PersistedPipelineChildRef", "PersistedPipelineOrchestrationState", "PersistedRun", "PersistedStepState"],
};

test(
  "the run record's entry hands out no mutable part of an executing run, and never names the mutable run",
  () => {
    const { program: built } = program();
    const checker = built.getTypeChecker();
    const shapes = mutableShapes(checker, built);
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
      const reached = reachedShapes(checker, shapes, type);
      if (reached.some(([shape]) => shape === "Run" || shape === "RunStep")) namesRun.push(exported.getName());
      const out = [...new Set(reached.filter(([, polarity]) => polarity === 1).map(([shape]) => shape))].sort();
      if (out.length > 0) handedOut[exported.getName()] = out;
    }
    expect(namesRun).toEqual([]);
    expect(handedOut).toEqual(HANDED_OUT);
  },
  { timeout: 120_000 },
);
