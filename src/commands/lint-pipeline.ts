// Lint a loaded pipeline outside a run: no lock, clean-tree guard, run creation,
// or command execution.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backendSpecForStep } from "../contracts/backends.js";
import { isPipelineName, resolveBuiltinPipeline } from "../env/builtin-pipeline.js";
import { capabilityAxes, capabilityRoots } from "../env/capability-frontmatter.js";
import type { PipelineContext } from "../model/context.js";
import type { Pipeline, PipelineStep } from "../model/definition.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { loadPipelineDefinition } from "../pipeline/loader.js";
import type { RunnerArgs } from "../model/cli-options.js";
import { log } from "../runtime/logging.js";
import { stepCapability } from "../validation/step-overrides.js";
import type { RunnerCommand } from "./runner-command.js";
import { pipelineNotFoundError } from "./pipeline-reference.js";
import { commandRegistries } from "./registries.js";
import { errorMessage } from "./shared.js";

/** The single option `--lint-pipeline` reads; the parser guarantees it is set. */
type LintPipelineArgs = Pick<RunnerArgs, "pipelinePath">;

const RUNNER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINT_TICKET = "LINT-0";

export interface PipelineLintFinding {
  level: "error" | "warn";
  rule: "escalation-ids" | "capabilities" | "load";
  message: string;
}

export interface PipelineLintReport {
  source: string;
  pipeline?: Pipeline;
  findings: PipelineLintFinding[];
}

export function resolvePipelineForLint(reference: string, cwd = process.cwd()): string {
  if (isPipelineName(reference)) {
    const found = resolveBuiltinPipeline(reference, cwd);
    if (found) return found;
    throw pipelineNotFoundError(reference, cwd);
  }
  const path = resolve(cwd, reference);
  if (!existsSync(path)) throw new Error(`Pipeline not found: ${reference} (${path})`);
  return path;
}

function duplicateEscalationFindings(pipeline: Pipeline): PipelineLintFinding[] {
  const counts = new Map<string, number>();
  for (const step of pipeline.steps) {
    if (step.id === "escalate" || step.id.startsWith("escalate-")) {
      counts.set(step.id, (counts.get(step.id) ?? 0) + 1);
    }
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({
      level: "error" as const,
      rule: "escalation-ids" as const,
      message: `duplicate escalation id "${id}" (${count} occurrences): the idempotency key { ticket, stepId } must be unique`,
    }));
}

function capabilityFindings(pipeline: Pipeline, context: PipelineContext): PipelineLintFinding[] {
  const roots = capabilityRoots(context.runnerDir, context.cwd);
  const findings: PipelineLintFinding[] = [];
  for (const step of pipeline.steps) {
    const capability = stepCapability(step, context);
    if (!capability) continue;
    const resolved = capabilityAxes(capability.kind, capability.name, roots);
    if (resolved.file) continue;
    findings.push({
      level: "error",
      rule: "capabilities",
      message: `step "${step.id}": declared ${capability.kind} not found on disk (${capability.name})`,
    });
  }
  return findings;
}

/** Lint rules kept separate from loading so they can be tested without dynamic imports. */
export function lintPipelineDefinition(
  pipeline: Pipeline,
  context: PipelineContext,
  source = pipeline.name,
): PipelineLintReport {
  return {
    source,
    pipeline,
    findings: [...duplicateEscalationFindings(pipeline), ...capabilityFindings(pipeline, context)],
  };
}

/** Load and validate a pipeline through the same loader used by a run. */
export async function lintPipeline(
  reference: string,
  options: { cwd?: string; context?: PipelineContext } = {},
): Promise<PipelineLintReport> {
  const cwd = options.cwd ?? process.cwd();
  let source = reference;
  try {
    source = resolvePipelineForLint(reference, cwd);
    const context =
      options.context ??
      buildPipelineContext({
        cwd,
        ticket: LINT_TICKET,
        runnerDir: RUNNER_DIR,
        ...commandRegistries(),
      });
    const pipeline = await loadPipelineDefinition(source, context);
    return lintPipelineDefinition(pipeline, context, source);
  } catch (error) {
    return {
      source,
      findings: [
        {
          level: "error",
          rule: "load",
          message: errorMessage(error),
        },
      ],
    };
  }
}

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row, index) => {
    const line = row
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join("  ")
      .trimEnd();
    if (index !== 0) return line;
    return `${line}\n${widths.map((width) => "-".repeat(width)).join("  ")}`;
  });
}

function stepRow(step: PipelineStep): string[] {
  return [
    step.id,
    // The runner is explicit at this point, so validation can inspect it directly.
    // before linting. The dash identifies a definition that did not go through it.
    step.runner ?? "-",
    step.profile ?? "-",
    backendSpecForStep(step)?.id ?? "-",
    String(step.inputs?.length ?? 0),
    (step.outputs ?? []).map((output) => output.name).join(",") || "-",
  ];
}

export function formatPipelineLintReport(report: PipelineLintReport): { text: string; exitCode: number } {
  const lines = [`Pipeline lint: ${report.pipeline?.name ?? report.source}`];
  if (report.pipeline) {
    lines.push(
      ...table([["ID", "RUNNER", "PROFILE", "BACKEND", "WHEN", "OUTPUTS"], ...report.pipeline.steps.map(stepRow)]),
    );
  }
  if (report.findings.length === 0) lines.push("✓ definition and references are valid");
  else {
    lines.push(
      ...report.findings.map(
        (finding) => `${finding.level === "error" ? "✗" : "⚠"} [${finding.rule}] ${finding.message}`,
      ),
    );
  }
  return {
    text: lines.join("\n"),
    exitCode: report.findings.some(({ level }) => level === "error") ? 1 : 0,
  };
}

export const lintPipelineCommand: RunnerCommand = {
  id: "lint-pipeline",
  flag: "--lint-pipeline",
  key: "lintPipeline",
  desc: "Load and validate a pipeline, then display its steps without starting a run.",
  async run(args: LintPipelineArgs): Promise<number> {
    const formatted = formatPipelineLintReport(await lintPipeline(args.pipelinePath!));
    log(formatted.text);
    return formatted.exitCode;
  },
};
