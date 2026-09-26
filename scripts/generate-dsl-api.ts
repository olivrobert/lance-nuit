import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { installKitTypes } from "../src/project/dsl-types.js";

const RUNNER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const OUTPUT = join(RUNNER_DIR, "..", "docs", "DSL-API.md");

interface Section {
  title: string;
  /** Declaration files searched in order. A section whose names now live in
   *  several `model/` modules lists them all rather than being split in two,
   *  which would duplicate its heading in the generated reference. */
  file: string | readonly string[];
  names: readonly string[];
  note?: string;
}

const SECTIONS: Section[] = [
  {
    title: "Builders and injected facade",
    file: ["project/dsl.d.ts", "dsl/dsl-steps.d.ts", "dsl/dsl-orchestration-step.d.ts"],
    names: [
      // `gateStep` is intentionally absent: admissions use `when`.
      "Dsl",
      "PipelineFactory",
      "PipelineEntry",
      "Pipeline",
      "LlmStepFactory",
      "WithBackendFactory",
      "PipelineOrchestrationStepBuilder",
      "pipeline",
      "llmStep",
      "bashStep",
      "actionStep",
      "mechanicalFix",
      "runPipeline",
      "forEachPipeline",
      "withBackend",
    ],
    note: "The `Dsl` members are bound to the runner and are the forms project pipelines should call. The direct `llmStep` and `withBackend` exports below retain the runner registry parameter.",
  },
  {
    title: "Step options",
    file: "project/dsl.d.ts",
    names: [
      "ClaudeStepOptions",
      "ClaudeBackendOptions",
      "CodexBackendOptions",
      "CodexModel",
      "CodexSandbox",
      "BackendAuthorOptions",
      "EffortLevel",
      "StepOptionsBase",
      "Escalate",
      "OnFail",
      "BackendOptionsFor",
      "LlmStepOptions",
      "CaptureSpec",
      "JsonSchema",
      "StepCapture",
      "BashStepOptions",
      "ActionStepOptions",
    ],
  },
  {
    title: "Orchestration",
    file: "project/dsl.d.ts",
    names: ["RunPipelineOptions", "ForEachPipelineOptions", "PipelineAfterOptions", "ForEachWorkItemOptions"],
  },
  {
    // Copying these fields manually into a guide is the trap closed here: an
    // incomplete table looks exhaustive and suggests a field does not exist.
    // The list therefore comes from the type, including `config` and `paths`.
    title: "Context",
    file: ["model/context.d.ts", "model/profiles.d.ts", "model/artifact-ports.d.ts"],
    names: [
      "PipelineContext",
      "PipelinePaths",
      "PipelineLot",
      "ArtifactRef",
      "ArtifactRefInput",
      "WorkItemArtifactStore",
      "StepOverride",
      "FixContext",
      "Templated",
      "AsyncTemplated",
      "StepAction",
    ],
    note: "Some of these types are reachable only through `ctx` fields and are not importable from `@lance-nuit/dsl`.",
  },
  {
    title: "Configuration available from context",
    file: ["model/config.d.ts", "model/profiles.d.ts", "contracts/config.d.ts", "contracts/work-items.d.ts"],
    names: [
      "PipelineConfig",
      "ExtensionsConfig",
      "StackPreflightConfig",
      "PipelineLabels",
      "ProfileAxes",
      "StepProfile",
      "ProfileOverrides",
      "WorkItemConfig",
    ],
    note: "Reachable through `ctx.config`; not importable from `@lance-nuit/dsl`.",
  },
  {
    title: "Admissions and profiles",
    file: "dsl/input.d.ts",
    names: [
      "InputAction",
      "WhenOutcome",
      "InputDecision",
      "InputPolicy",
      "When",
      "InputPredicate",
      "InputPredicateResult",
      "StepInputCondition",
    ],
  },
  {
    title: "Admission helpers",
    file: "dsl/input.d.ts",
    names: [
      "skip",
      "fail",
      "stop",
      "skipIf",
      "failIf",
      "stopIf",
      "skipUnless",
      "failUnless",
      "stopUnless",
      "requireArtifact",
      "skipUnlessCommand",
      "failUnlessCommand",
      "stopUnlessCommand",
    ],
  },
  {
    // Reachable from `InputPredicateResult`: an admission that stops the run
    // describes its stop there, so the shape belongs in this reference.
    title: "Stop cause",
    file: "model/persisted.d.ts",
    names: ["RunStopKind", "RunStopState"],
    note: "Persisted in `state.json` under `outcome.stop`; not importable from `@lance-nuit/dsl`.",
  },
  {
    title: "Profile × backend compatibility",
    file: "dsl/profiles.d.ts",
    names: ["StepProfileName", "BackendFor"],
  },
  {
    title: "Artifacts",
    file: "dsl/artifact.d.ts",
    names: ["ArtifactParser", "Artifact", "artifact", "textArtifact"],
  },
  {
    title: "Prompt files",
    file: "project/dsl.d.ts",
    names: ["PromptRenderer", "PromptFileFactory"],
    note: "`promptFile` is injected through `Dsl`; these types describe its typed placeholder renderer.",
  },
  {
    title: "Capability preflight",
    file: "project/dsl.d.ts",
    names: ["CapabilityPreflightOptions", "requireCapabilitiesStep"],
  },
  {
    title: "Work-item composites",
    file: ["project/dsl.d.ts", "builtin-steps/lib/public-work-item.d.ts", "builtin-steps/lib/work-item-steps.d.ts"],
    names: [
      "ProjectEscalation",
      "ProjectEscalationBase",
      "ProjectEscalationNoteOptions",
      "ProjectEscalationOptions",
      "ProjectEscalationStepOptions",
      "PublicWorkItemDeliveryOptions",
      "workItemEscalateStep",
      "workItemDeliveryStep",
    ],
  },
  {
    title: "Work-item contracts",
    file: "contracts/work-items.d.ts",
    names: [
      "WorkQueue",
      "TerminalQueue",
      "AutomationQueue",
      "WorkItemState",
      "WorkItemRef",
      "RefValidation",
      "WorkItem",
      "WorkItemNoteField",
      "WorkItemNote",
      "ExecutionKey",
      "MoveTarget",
      "WorkItemQuery",
      "WorkItemGateway",
    ],
    note: "The exported work-item types are provider-neutral. Types used only by the injected context or gateway signatures are included for completeness and are not all importable from `@lance-nuit/dsl`.",
  },
  {
    // The dashboard renders `artifacts/report.json` against this shape; a
    // pipeline's report step typechecks against it. See guide/work-item-layout.md.
    title: "Run report",
    file: "model/run-report.d.ts",
    names: [
      "RUN_REPORT_FILE",
      "RunReport",
      "RunReportLink",
      "RunReportDelivered",
      "RunReportCriterion",
      "RunReportProof",
      "RunReportFollowUp",
      "RunReportReview",
      "RunReportCaptureGroup",
      "RunReportNote",
    ],
    note: "Written by a pipeline to `artifacts/report.json`; the dashboard shows it only while its `runId` is the work item's current run.",
  },
  {
    title: "Human review",
    file: "builtin-steps/lib/human-review.d.ts",
    names: ["ReviewKind", "ReviewApproval", "HumanReviewOptions", "humanReview"],
  },
  {
    title: "Provider-neutral authoring",
    file: ["project/dsl.d.ts", "project/sdk.d.ts"],
    names: [
      "ExtensionOptions",
      "AuthoringContext",
      "AuthoringStep",
      "ProviderNeutralActionStepOptions",
      "ProviderNeutralBashStepOptions",
      "ProviderNeutralLlmStepOptions",
      "OnFailPolicy",
      "defineBackend",
      "defineAuthoringPipeline",
      "defineAuthoringStep",
    ],
    note: "These helpers are exported under provider-neutral aliases for extensions and authoring tools; ordinary project pipelines should use the injected `Dsl` facade.",
  },
  {
    title: "Injected-only helpers",
    file: ["dsl/preconditions.d.ts", "state/decisions.d.ts", "state/provenance.d.ts"],
    names: ["reject", "decisionMatchesArtifact", "ArtifactFreshness", "freshness"],
    note: "These helpers are available on `Dsl` but are not importable from `@lance-nuit/dsl`.",
  },
];

function declarationName(node: ts.Node): string | undefined {
  if (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isEnumDeclaration(node)
  )
    return node.name?.text;
  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations[0];
    return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
  }
  return undefined;
}

const sourceCache = new Map<string, ts.SourceFile>();

function loadSource(path: string): ts.SourceFile {
  const cached = sourceCache.get(path);
  if (cached) return cached;
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  sourceCache.set(path, source);
  return source;
}

function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  if (specifier.startsWith(".")) return join(dirname(fromFile), specifier.replace(/\.js$/, ".d.ts"));
  return undefined;
}

interface FoundDeclaration {
  nodes: ts.Node[];
  source: ts.SourceFile;
  publicName: string;
}

/**
 * Find every statement declaring `name` (overloads included), following named
 * and star re-exports across the installed declaration tree. The public facade
 * is made of re-exports only, so without this walk the generator silently
 * produces empty sections.
 */
function findDeclaration(file: string, name: string, seen = new Set<string>()): FoundDeclaration | undefined {
  const key = `${file}\0${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const source = loadSource(file);
  const local = source.statements.filter((node) => declarationName(node) === name);
  if (local.length > 0) return { nodes: local, source, publicName: name };

  const starTargets: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const specifier =
      statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
    if (!specifier) continue;
    const target = resolveSpecifier(file, specifier);
    if (!target) continue;
    if (!statement.exportClause) {
      starTargets.push(target);
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      if (element.name.text !== name) continue;
      const originalName = element.propertyName?.text ?? name;
      const found = findDeclaration(target, originalName, seen);
      if (found) return { ...found, publicName: name };
    }
  }
  for (const target of starTargets) {
    const found = findDeclaration(target, name, seen);
    if (found) return found;
  }
  return undefined;
}

function renamedDeclaration(text: string, from: string, to: string): string {
  if (from === to) return text;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`(\\b(?:interface|type|function|class|enum|const)\\s+)${escaped}\\b`);
  const renamed = text.replace(declaration, `$1${to}`);
  if (renamed === text) {
    throw new Error(`Unable to rename declaration ${from} to public export ${to}`);
  }
  return renamed;
}

function declarations(typesDir: string, section: Section): string {
  const entries = (typeof section.file === "string" ? [section.file] : section.file).map((file) =>
    join(typesDir, file),
  );
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const missing: string[] = [];
  const printed: string[] = [];
  for (const name of section.names) {
    let found: FoundDeclaration | undefined;
    for (const entry of entries) {
      found = findDeclaration(entry, name);
      if (found) break;
    }
    if (!found) {
      missing.push(name);
      continue;
    }
    printed.push(
      found.nodes
        .map((node) =>
          renamedDeclaration(
            printer.printNode(ts.EmitHint.Unspecified, node, found.source),
            declarationName(node) ?? found.publicName,
            found.publicName,
          ),
        )
        .join("\n"),
    );
  }
  // An unfound name means the docs would silently drop part of the surface:
  // fail loudly instead of publishing an incomplete reference.
  if (missing.length > 0) {
    throw new Error(
      `Section "${section.title}": no declaration found in ${entries.join(", ")} for: ${missing.join(", ")}`,
    );
  }
  return printed.join("\n\n");
}

function publicExportNames(file: string): Set<string> {
  const source = loadSource(file);
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause) continue;
    if (!ts.isNamedExports(statement.exportClause)) {
      throw new Error(`Public DSL facade must use named exports: ${file}`);
    }
    for (const element of statement.exportClause.elements) names.add(element.name.text);
  }
  return names;
}

function assertPublicExportsDocumented(typesDir: string): void {
  const documented = new Set(SECTIONS.flatMap((section) => section.names));
  const missing = [...publicExportNames(join(typesDir, "project/dsl.d.ts"))].filter((name) => !documented.has(name));
  if (missing.length > 0) {
    throw new Error(`Public DSL exports missing from the generated reference: ${missing.join(", ")}`);
  }
}

function generate(): string {
  const temporary = mkdtempSync(join(tmpdir(), "pipeline-dsl-docs-"));
  try {
    installKitTypes(temporary);
    const typesDir = join(temporary, ".lance-nuit-types");
    assertPublicExportsDocumented(typesDir);
    const body = SECTIONS.map((section) => {
      const note = section.note ? `${section.note}\n\n` : "";
      return `## ${section.title}\n\n${note}\`\`\`ts\n${declarations(typesDir, section)}\n\`\`\``;
    }).join("\n\n");
    return [
      "# Pipeline DSL API",
      "",
      "<!-- Generated by `bun run docs:dsl` from installed TypeScript declarations. Do not edit manually. -->",
      "",
      "This reference describes the canonical surface available through `@lance-nuit/dsl`.",
      "",
      body,
      "",
    ].join("\n");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

writeFileSync(OUTPUT, generate());
process.stdout.write(`${OUTPUT}\n`);
