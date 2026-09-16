// runner/commands/lint-config-check.ts
//
// `runner --lint-config`: compare `profiles` and `steps` configuration sections with
// ALL pipelines, and display effective model/effort per step.
//
// The loader can validate only the pipeline it loads: a key targeting another
// pipeline goes unnoticed, and an orphaned key (a step renamed elsewhere) remains a
// dead setting that looks active. This lint closes that gap and runs outside a run,
// typically from bin/check.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backendSpecForStep, declaredBackendAxes, isAgentStep } from "../contracts/backends.js";
import { listPipelineFiles } from "../env/builtin-pipeline.js";
import { type PipelineContext, requireAgentBackendRegistry } from "../model/context.js";
import type { Pipeline } from "../model/definition.js";
import { buildPipelineContext, deriveContext } from "../pipeline/context.js";
import { loadPipelineDefinition } from "../pipeline/loader.js";
import {
  checkOverrideKeyShapes,
  checkStepOverrides,
  dedupeStepOverrideFindings,
  imposedAxes,
  resolveEffectiveAxes,
  stepCapability,
  stepOverrideFor,
} from "../validation/step-overrides.js";
import { commandRegistries } from "./registries.js";
import { errorMessage } from "./shared.js";

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
    source: "config" | "profile" | "capability" | "machine default";
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
  // `runnerDir`, not `runnerDir/pipelines`: this is the BASE to which the chain
  // joins `pipelines/<name>.ts`, as `resolveBuiltinPipeline` does.
  return listPipelineFiles(context.cwd, context.runnerDir);
}

/** Load all pipelines WITHOUT applying overrides: lint must see DSL defaults and
 *  judge keys itself instead of failing on the first one. */
async function loadAll(context: PipelineContext): Promise<{ pipelines: Pipeline[]; findings: LintFinding[] }> {
  // `deriveContext`, not a spread: `context.workItem` is a memoized getter, and a
  // spread would read it, creating the tracker bridge just to list model/effort
  // (see the invariant in pipeline/context.ts).
  const bare = deriveContext(context, { config: { ...context.config, steps: {} } });
  const pipelines: Pipeline[] = [];
  const findings: LintFinding[] = [];
  for (const file of pipelineFiles(context)) {
    try {
      pipelines.push(await loadPipelineDefinition(file, bare));
    } catch (e) {
      // A pipeline that cannot build outside a run (missing artifact) is not a
      // configuration error: report it without failing lint.
      findings.push({ level: "warn", message: `${file} cannot be loaded outside a run: ${errorMessage(e)}` });
    }
  }
  return { pipelines, findings };
}

export async function lintStepOverrides(context?: PipelineContext): Promise<LintReport> {
  // `..`: this file lives in env/, while the context expects the runner root.
  const runnerDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // Dummy ticket: many commands are built from `paths.artifact()`, which throws
  // without a ticket. Without it, command resolution fails and the step appears to
  // have no capability; lint would report "machine default" for steps that actually
  // delegate to a skill.
  const ctx = context ?? buildPipelineContext({ runnerDir, ticket: LINT_TICKET, ...commandRegistries() });
  const { pipelines, findings } = await loadAll(ctx);
  const overrides = ctx.config.steps;
  const names = new Set(pipelines.map((p) => p.name));
  const registry = requireAgentBackendRegistry(ctx);

  // Key shape and per-pipeline rules come from step-overrides.ts, the same code the
  // loader runs before a spawn: reusing it means a generic key carrying an
  // unsupported axis is rejected the same way here as it would be at spawn time.
  //
  // Only the check below is lint's own: it alone knows every pipeline, so it alone
  // can tell an unknown pipeline from one it simply is not looking at.
  const stepFindings = [...checkOverrideKeyShapes(overrides)];
  for (const key of Object.keys(overrides)) {
    const separator = key.indexOf(":");
    if (separator < 0) continue;
    const pipelineName = key.slice(0, separator);
    if (names.has(pipelineName)) continue;
    stepFindings.push({
      key,
      message: `steps["${key}"]: unknown pipeline "${pipelineName}" (known: ${[...names].sort().join(", ")})`,
    });
  }
  for (const pipeline of pipelines) {
    stepFindings.push(
      ...checkStepOverrides({ pipelineName: pipeline.name, steps: pipeline.steps, overrides, registry, context: ctx }),
    );
  }
  // A `*` key reaching several pipelines is one problem, reported once.
  for (const finding of dedupeStepOverrideFindings(stepFindings)) {
    findings.push({ level: "error", message: finding.message });
  }

  // Configured but unused profiles: unlike an explicit step key, a role is a broad
  // selector. It remains non-blocking, but never silent.
  const agentSteps = pipelines.flatMap((pipeline) =>
    pipeline.steps.filter((step) => isAgentStep(step)).map((step) => ({ pipeline: pipeline.name, step })),
  );
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
      if (configuredUses.every(({ step }) => imposedAxes(step, ctx)[axis] !== undefined)) {
        findings.push({
          level: "warn",
          message: `profiles["${profile}"].backends.<backend>.${axis} is imposed by a capability in all uses`,
        });
      }
    }
  }

  for (const { pipeline, step } of agentSteps) {
    const imposed = imposedAxes(step, ctx);
    if (step.on_failure?.escalate_model) {
      if (imposed.model !== undefined) {
        findings.push({
          level: "warn",
          message: `${pipeline}:${step.id}: escalation.model has no effect (model imposed by capability: ${imposed.model})`,
        });
      } else {
        if (step.on_failure.escalate_model !== declaredBackendAxes(step).model) continue;
        findings.push({
          level: "warn",
          message: `${pipeline}:${step.id}: escalation.model=${step.on_failure.escalate_model} matches the nominal model`,
        });
      }
    }
  }

  // View "what will actually run", ordered by pipeline and then step.
  const effective: LintReport["effective"] = [];
  for (const pipeline of pipelines) {
    for (const step of pipeline.steps) {
      if (!isAgentStep(step)) continue;
      const capability = stepCapability(step, ctx);
      const fromConfig = stepOverrideFor(pipeline.name, step.id, overrides);
      const resolvedAxes = resolveEffectiveAxes(step, ctx, fromConfig);
      effective.push({
        pipeline: pipeline.name,
        stepId: step.id,
        ...(step.profile ? { profile: step.profile } : {}),
        ...(capability ? { capability: `${capability.kind}:${capability.name}` } : {}),
        ...(resolvedAxes.effective.model ? { model: resolvedAxes.effective.model } : {}),
        ...(resolvedAxes.effective.effort ? { effort: resolvedAxes.effective.effort } : {}),
        source: resolvedAxes.source,
      });
    }
  }
  return { findings, effective };
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
    const origin = row.capability ? `${row.source} (${row.capability})` : row.source;
    lines.push(
      `    ${row.stepId.padEnd(stepWidth)} ${axes.padEnd(axesWidth)} ${profile.padEnd(profileWidth)} ${origin}`,
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
