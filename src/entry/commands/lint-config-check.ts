//
// `runner --lint-config`: compare `profiles` and `steps` configuration sections with
// ALL pipelines, and display effective model/effort per step.
//
// The loader can validate only the pipeline it loads: a key targeting another
// pipeline goes unnoticed, and an orphaned key (a step renamed elsewhere) remains a
// dead setting that looks active. This lint closes that gap and runs outside a run,
// typically from bin/check.

import { RUNNER_ROOT_DIR } from "../../shared/env/kit-layout.js";
import type { ComposeRegistries } from "../boot/extensions.js";
import { type AgentConfigAxis, backendSpecForStep, isAgentStep } from "../../contracts/backends.js";
import {
  type AxisSource,
  buildPipelineDefinition,
  listPipelineFiles,
  type Pipeline,
  pipelineValidationReport,
  resolveStepAxes,
} from "../../definition/index.js";
import { type PipelineContext, requireAgentBackendRegistry } from "../../shared/language/context.js";
import { contextWithProjectProviders, errorMessage } from "./shared.js";

/** Nonexistent but well-formed ticket, sufficient to resolve artifact paths. */
const LINT_TICKET = "LINT-0";

export interface LintFinding {
  level: "error" | "warn";
  message: string;
}

export interface LintReport {
  findings: LintFinding[];
  /** One line per Claude step: what will actually run. */
  effective: {
    pipeline: string;
    stepId: string;
    profile?: string;
    capability?: string;
    model?: string;
    effort?: string;
    sources: Record<AgentConfigAxis, AxisSource>;
  }[];
}

/**
 * Pipelines to compare with config: those of a RUN, not the runner's own pipelines.
 *
 * Reading `runner/pipelines/` was enough while only builtins existed. Since project
 * pipelines were added, that set produces two false verdicts: a `✓ coherent` that
 * examined nothing the author just wrote, and an ERROR "unknown pipeline" for every
 * key that actually targets its pipeline.
 */
function pipelineFiles(context: PipelineContext): string[] {
  return listPipelineFiles(context.cwd);
}

/** Build all pipelines without validating nor applying anything: lint judges the
 *  definitions and the configuration itself instead of failing on the first key. */
async function buildAll(context: PipelineContext): Promise<{ pipelines: LintedPipeline[]; findings: LintFinding[] }> {
  const pipelines: LintedPipeline[] = [];
  const findings: LintFinding[] = [];
  for (const file of pipelineFiles(context)) {
    try {
      pipelines.push({ file, pipeline: await buildPipelineDefinition(file, context) });
    } catch (e) {
      // A pipeline that cannot build outside a run (missing artifact) is not a
      // configuration error: report it without failing lint.
      findings.push({ level: "warn", message: `${file} cannot be built outside a run: ${errorMessage(e)}` });
    }
  }
  return { pipelines, findings };
}

interface LintedPipeline {
  file: string;
  pipeline: Pipeline;
}

/** The context `--lint-config` checks: the project in `cwd`, with the providers a
 *  run there would see, so a backend its manifest declares is a known one. */
export function lintConfigContext(
  composeRegistries: ComposeRegistries,
  cwd: string = process.cwd(),
): Promise<PipelineContext> {
  // Dummy ticket: many commands are built from `paths.artifact()`, which throws
  // without a ticket. Without it, command resolution fails and the step appears to
  // have no capability; lint would report "machine default" for steps that actually
  // delegate to a skill.
  return contextWithProjectProviders(composeRegistries, { cwd, runnerDir: RUNNER_ROOT_DIR, ticket: LINT_TICKET });
}

/** The validation a run performs before materialization, over every pipeline. A
 *  configuration finding (`configuration-references`) can come from each pipeline
 *  and is reported once; a definition finding names its pipeline. */
function validationErrors(pipelines: readonly LintedPipeline[], ctx: PipelineContext): string[] {
  const configuration = { profileOverrides: ctx.config.profiles, stepOverrides: ctx.config.steps, context: ctx };
  return pipelines.flatMap(({ file, pipeline }) =>
    pipelineValidationReport(pipeline, file, configuration).errors.map((finding) =>
      finding.rule === "configuration-references" ? finding.message : `${pipeline.name}: ${finding.message}`,
    ),
  );
}

/** Only lint knows every pipeline, so it alone can tell an unknown pipeline from one
 *  the validator of another pipeline simply is not looking at. */
function unknownPipelineErrors(pipelines: readonly LintedPipeline[], ctx: PipelineContext): string[] {
  const names = new Set(pipelines.map(({ pipeline }) => pipeline.name));
  return Object.keys(ctx.config.steps).flatMap((key) => {
    const separator = key.indexOf(":");
    if (separator < 0) return [];
    const pipelineName = key.slice(0, separator);
    if (names.has(pipelineName)) return [];
    return [`steps["${key}"]: unknown pipeline "${pipelineName}" (known: ${[...names].sort().join(", ")})`];
  });
}

export async function lintStepOverrides(ctx: PipelineContext): Promise<LintReport> {
  const { pipelines, findings } = await buildAll(ctx);
  // A `*` key reaching several pipelines is one problem, reported once.
  for (const message of new Set([...unknownPipelineErrors(pipelines, ctx), ...validationErrors(pipelines, ctx)])) {
    findings.push({ level: "error", message });
  }

  const registry = requireAgentBackendRegistry(ctx);
  const agentSteps = pipelines.flatMap(({ pipeline }) =>
    pipeline.steps
      .filter((step) => isAgentStep(step))
      .map((step) => ({
        pipeline: pipeline.name,
        step,
        axes: resolveStepAxes(step, {
          pipelineName: pipeline.name,
          stepOverrides: ctx.config.steps,
          profileOverrides: ctx.config.profiles,
          registry,
          context: ctx,
        }),
      })),
  );

  // Configured but unused profiles: unlike an explicit step key, a role is a broad
  // selector. It remains non-blocking, but never silent.
  for (const [profile, configured] of Object.entries(ctx.config.profiles)) {
    const uses = agentSteps.filter(({ step }) => step.profile === profile);
    if (uses.length === 0) {
      findings.push({ level: "warn", message: `profiles["${profile}"] is not used by any step` });
      continue;
    }
    for (const axis of ["model", "effort"] as const) {
      const configuredUses = uses.filter(({ step }) => {
        const backendId = backendSpecForStep(step)?.id;
        return backendId !== undefined && configured?.backends?.[backendId]?.[axis] !== undefined;
      });
      if (configuredUses.length === 0) continue;
      if (configuredUses.every(({ axes }) => axes.imposed[axis] !== undefined)) {
        findings.push({
          level: "warn",
          message: `profiles["${profile}"].backends.<backend>.${axis} is imposed by a capability in all uses`,
        });
      }
    }
  }

  for (const { pipeline, step, axes } of agentSteps) {
    const escalateModel = step.on_failure?.escalate_model;
    if (!escalateModel) continue;
    if (axes.imposed.model !== undefined) {
      findings.push({
        level: "warn",
        message: `${pipeline}:${step.id}: escalation.model has no effect (model imposed by capability: ${axes.imposed.model})`,
      });
    } else if (escalateModel === axes.profile.model) {
      findings.push({
        level: "warn",
        message: `${pipeline}:${step.id}: escalation.model=${escalateModel} matches the nominal model`,
      });
    }
  }

  // View "what will actually run", ordered by pipeline and then step: the same
  // resolution the loader materializes.
  const effective: LintReport["effective"] = agentSteps.map(({ pipeline, step, axes }) => ({
    pipeline,
    stepId: step.id,
    ...(step.profile ? { profile: step.profile } : {}),
    ...(axes.capability ? { capability: `${axes.capability.kind}:${axes.capability.name}` } : {}),
    ...(axes.effective.model ? { model: axes.effective.model } : {}),
    ...(axes.effective.effort ? { effort: axes.effective.effort } : {}),
    sources: axes.sources,
  }));
  return { findings, effective };
}

/** One source when both axes share it, else each axis with its own. */
function originOf(row: LintReport["effective"][number]): string {
  const { model, effort } = row.sources;
  const source = model === effort ? model : `model: ${model}, effort: ${effort}`;
  return row.capability ? `${source} (${row.capability})` : source;
}

/** Console rendering and exit code: 1 as soon as an error is found. */
export function formatLintReport(report: LintReport): { text: string; exitCode: number } {
  const lines: string[] = ["Effective model / effort per step", ""];
  // Column widths are measured, not fixed: a provider-qualified model name
  // (`opencode/nemotron-3-ultra-free`) is 30 characters and pushed every
  // following column out of alignment.
  const cells = report.effective.map((row) => ({
    row,
    axes: [row.model ?? "?", row.effort ?? "-"].join(" / "),
    profile: row.profile ? `@${row.profile}` : "@?",
  }));
  const widest = (pick: (cell: (typeof cells)[number]) => string, min: number) =>
    Math.max(min, ...cells.map((cell) => pick(cell).length));
  const [stepWidth, axesWidth, profileWidth] = [
    widest((cell) => cell.row.stepId, 28),
    widest((cell) => cell.axes, 20),
    widest((cell) => cell.profile, 12),
  ];
  let currentPipeline = "";
  for (const { row, axes, profile } of cells) {
    if (row.pipeline !== currentPipeline) {
      currentPipeline = row.pipeline;
      lines.push(`  ${currentPipeline}`);
    }
    lines.push(
      `    ${row.stepId.padEnd(stepWidth)} ${axes.padEnd(axesWidth)} ${profile.padEnd(profileWidth)} ${originOf(row)}`,
    );
  }
  const errors = report.findings.filter((f) => f.level === "error");
  const warnings = report.findings.filter((f) => f.level === "warn");
  if (warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const w of warnings) lines.push(`  ⚠ ${w.message}`);
  }
  lines.push("");
  if (errors.length === 0) {
    lines.push(`✓ Profile/step configuration is consistent with pipelines`);
  } else {
    lines.push(`✗ ${errors.length} configuration problem(s):`);
    for (const e of errors) lines.push(`  ✗ ${e.message}`);
  }
  return { text: lines.join("\n"), exitCode: errors.length > 0 ? 1 : 0 };
}
