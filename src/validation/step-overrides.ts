// runner/validation/step-overrides.ts
//
// Per-step model/effort overrides from `.lance-nuit/config.json`, allowing tuning
// without changing pipeline code.
//
// Scope is limited to inline-prompt steps. A step invoking a skill or agent gets
// its model from capability frontmatter at session initialization, so `--model` is
// ignored. Accepting a config key there would promise an ineffective setting; the
// validator rejects it and names the responsible capability.

import {
  type AgentBackend,
  type AgentBackendRegistry,
  backendSpecForStep,
  declaredBackendAxes,
  isAgentStep,
} from "../contracts/backends.js";
import { capabilityAxes, capabilityRoots, isForked } from "../env/capability-frontmatter.js";
import { errorMessage } from "../lib/errors.js";
import { type PipelineContext, requireAgentBackendRegistry } from "../model/context.js";
import type { Pipeline, PipelineStep } from "../model/definition.js";
import type { StepOverride } from "../model/profiles.js";

/** Config key targeting steps; `*` < `<pipeline>:*` < `<pipeline>:<stepId>`. */
export type StepOverrideKey = string;

/** Capability to which a step delegates work, if any.
 *
 *  Commands are mostly closures (`(ctx) => `/pipeline-spec ${…}``) or .md templates
 *  whose first line is a slash command, so resolve the command
 *  with the real context. If resolution fails outside a run, treat the step as
 *  capability-free and keep validation permissive. */
export function stepCapability(
  step: PipelineStep,
  context?: PipelineContext,
): { kind: "skill" | "agent"; name: string } | undefined {
  // Read backend options rather than the step; the DSL stores delegation (`--agent`)
  // there, and backendSpecForStep resolves the effective backend.
  const declaredAgent = (backendSpecForStep(step)?.options as { agent?: string } | undefined)?.agent;
  if (declaredAgent) return { kind: "agent", name: declaredAgent };
  let command: string | undefined;
  if (typeof step.command === "string") {
    command = step.command;
  } else if (typeof step.command === "function" && context) {
    try {
      const resolved = step.command(context);
      // Detection is best-effort and synchronous because validation also uses it
      // outside execution. Async commands cannot be inspected here, so no
      // capability is imposed; steps needing skill axes must use a literal prefix.
      //
      // Adopt the rejection of an async command rather than dropping its promise.
      // Such a command routinely reads an artifact a LATER step writes
      // (`branch.require(ctx)`), so it rejects on every call made before that step
      // runs — starting with the ones made at boot. Left unhandled, that rejection
      // kills the process before the run exists, and the crash names the pipeline
      // file instead of this detection.
      if (typeof resolved !== "string") {
        if (resolved instanceof Promise) resolved.catch(() => undefined);
        return undefined;
      }
      command = resolved;
    } catch {
      return undefined;
    }
  }
  const slash = command?.match(/^\s*\/([a-z0-9:-]+)/i);
  return slash ? { kind: "skill", name: slash[1] } : undefined;
}

/** Axes imposed by capability frontmatter, which takes precedence over CLI flags.
 *  No capability or missing capability file means no imposed axes.
 *
 *  A `context: fork` capability imposes nothing on the host turn: its axes apply to
 *  the fork, while the host remains configurable. Charging the host at the fork's
 *  model would overcharge a turn that often only relays a verdict. */
export function imposedAxes(step: PipelineStep, context?: PipelineContext): { model?: string; effort?: string } {
  const capability = stepCapability(step, context);
  if (!capability || !context) return {};
  const axes = capabilityAxes(capability.kind, capability.name, capabilityRoots(context.runnerDir, context.cwd));
  if (isForked(axes)) return {};
  return {
    ...(axes.model ? { model: axes.model } : {}),
    ...(axes.effort ? { effort: axes.effort } : {}),
  };
}

export interface EffectiveAxesResolution {
  /** Axes imposed by the capability frontmatter, which cannot be overridden. */
  imposed: { model?: string; effort?: string };
  /** Step override axes that remain applicable after capability precedence. */
  configured: StepOverride;
  /** Values that will be materialized for the step. */
  effective: { model?: string; effort?: string };
  source: "config" | "profile" | "capability" | "machine default";
}

function nominalAxes(step: PipelineStep): { model?: string; effort?: string } {
  return declaredBackendAxes(step);
}

/** Resolve capability > steps > profile/backend once. The loader and lint share
 * this function so displayed axes match execution. */
export function resolveEffectiveAxes(
  step: PipelineStep,
  context?: PipelineContext,
  override: StepOverride = {},
): EffectiveAxesResolution {
  const imposed = imposedAxes(step, context);
  const configured: StepOverride = {
    ...(override.model !== undefined && imposed.model === undefined ? { model: override.model } : {}),
    ...(override.effort !== undefined && imposed.effort === undefined ? { effort: override.effort } : {}),
  };
  const nominal = nominalAxes(step);
  const effective = {
    ...((imposed.model ?? configured.model ?? nominal.model)
      ? { model: imposed.model ?? configured.model ?? nominal.model }
      : {}),
    ...((imposed.effort ?? configured.effort ?? nominal.effort)
      ? { effort: imposed.effort ?? configured.effort ?? nominal.effort }
      : {}),
  };
  const source =
    imposed.model !== undefined || imposed.effort !== undefined
      ? "capability"
      : configured.model !== undefined || configured.effort !== undefined
        ? "config"
        : step.profile && (nominal.model !== undefined || nominal.effort !== undefined)
          ? "profile"
          : "machine default";
  return { imposed, configured, effective, source };
}

/** Keys applicable to a step, from general to specific. */
function keysFor(pipelineName: string, stepId: string): StepOverrideKey[] {
  return ["*", `${pipelineName}:*`, `${pipelineName}:${stepId}`];
}

/** Merge the three configuration levels applicable to a step. */
export function stepOverrideFor(
  pipelineName: string,
  stepId: string,
  overrides: Readonly<Record<StepOverrideKey, StepOverride>>,
): StepOverride {
  return Object.assign({}, ...keysFor(pipelineName, stepId).map((key) => overrides[key] ?? {}));
}

// ---------------------------------------------------------------------------
// Configuration rules
//
// Single source of truth for what a `steps` key is allowed to say. Three callers
// read it: the loader (applyStepOverrides, below), the pipeline validator
// (validation/references.ts), and `--lint-config` (commands/lint-config-check.ts). They were
// three hand-copied implementations whose messages had already drifted apart, and
// whose coverage had too: lint skipped the generic keys the loader applies, so it
// could report a configuration as consistent that the next run rejected.
// ---------------------------------------------------------------------------

/** Configuration problem, without the framing each caller adds (the loader and the
 *  validator prefix `Invalid configuration (<source>)`, lint prints it bare). */
export interface StepOverrideFinding {
  key: StepOverrideKey;
  message: string;
}

const CONFIGURATION_AXES = ["model", "effort"] as const;

/** Backend of an agent step, or undefined when it cannot be resolved. Silence is
 *  intentional: an unknown or unbuildable backend is the agent-backend validator's
 *  diagnostic, and repeating it here would say nothing new. */
function resolvedBackendFor(step: PipelineStep, registry: AgentBackendRegistry): AgentBackend | undefined {
  const spec = backendSpecForStep(step);
  if (!spec || !registry.has(spec.id)) return undefined;
  try {
    return registry.resolve(spec);
  } catch {
    return undefined;
  }
}

/** Drop the axes a capability already imposes: they are refused on an exact key,
 *  but a generic selector keeps its remaining axes. */
function applicableAxes(override: StepOverride, imposed: { model?: string; effort?: string }): StepOverride {
  return {
    ...(override.model !== undefined && imposed.model === undefined ? { model: override.model } : {}),
    ...(override.effort !== undefined && imposed.effort === undefined ? { effort: override.effort } : {}),
  };
}

/** Same message twice means the same problem: a generic key reaching ten steps is
 *  one configuration error, not ten. Insertion order is preserved. */
export function dedupeStepOverrideFindings(findings: readonly StepOverrideFinding[]): StepOverrideFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    if (seen.has(finding.message)) return false;
    seen.add(finding.message);
    return true;
  });
}

/** Key shapes rejected whatever the pipelines are. Kept apart from the per-pipeline
 *  checks so a lint over N pipelines reports a malformed key once, not N times. */
export function checkOverrideKeyShapes(
  overrides: Readonly<Record<StepOverrideKey, StepOverride>>,
): StepOverrideFinding[] {
  return Object.keys(overrides)
    .filter((key) => key !== "*" && !key.includes(":"))
    .map((key) => ({
      key,
      message: `steps["${key}"]: unqualified key — expected "*", "<pipeline>:*", or "<pipeline>:<stepId>"`,
    }));
}

export interface StepOverrideCheckInput {
  pipelineName: string;
  steps: readonly PipelineStep[];
  overrides: Readonly<Record<StepOverrideKey, StepOverride>>;
  registry: AgentBackendRegistry;
  /** Required to read capability frontmatter; without it no axis is imposed. */
  context?: PipelineContext;
}

/**
 * Every check a `steps` key must pass against one loaded pipeline. Keys targeting
 * another pipeline are ignored — they cannot be judged without its DSL.
 */
export function checkStepOverrides(input: StepOverrideCheckInput): StepOverrideFinding[] {
  const { pipelineName, steps, overrides, registry, context } = input;
  const findings: StepOverrideFinding[] = [];
  const byId = new Map(steps.map((step) => [step.id, step]));

  // Exact keys only: they alone can name a step that does not exist, or one no
  // backend can configure. A generic selector legitimately covers such steps.
  for (const key of Object.keys(overrides)) {
    const separator = key.indexOf(":");
    if (separator < 0 || key.slice(0, separator) !== pipelineName) continue;
    const stepId = key.slice(separator + 1);
    if (stepId === "*") continue;
    const step = byId.get(stepId);
    if (!step) {
      findings.push({
        key,
        message:
          `steps["${key}"] does not match any step in "${pipelineName}" ` +
          `(existing steps: ${[...byId.keys()].join(", ")})`,
      });
      continue;
    }
    if (!isAgentStep(step)) {
      findings.push({
        key,
        message: `steps["${key}"] targets a ${step.runner} step — model/effort require an agent backend`,
      });
    }
  }

  // Then every key that actually reaches a step, generic ones included: `*` can
  // carry an axis the backend cannot translate just as well as an exact key.
  for (const step of steps) {
    if (!isAgentStep(step)) continue;
    const backend = resolvedBackendFor(step, registry);
    if (!backend) continue;
    const imposed = context ? imposedAxes(step, context) : {};
    const capability = context ? stepCapability(step, context) : undefined;
    const supported = backend.capabilities.configurationAxes ?? [];

    for (const key of keysFor(pipelineName, step.id)) {
      const override = overrides[key];
      if (!override) continue;
      const exact = key === `${pipelineName}:${step.id}`;
      const applicable = applicableAxes(override, imposed);

      // An exact key is judged on what it writes; a generic one on what survives
      // capability precedence, since it did not name this step.
      for (const axis of CONFIGURATION_AXES) {
        const declared = exact ? override[axis] : applicable[axis];
        if (declared === undefined || supported.includes(axis)) continue;
        findings.push({
          key,
          message: `steps["${key}"].${axis}: axis is not supported by backend "${backend.id}"`,
        });
      }

      // Only an exact key promises this step specifically, so only it is an error
      // when the capability owns the axis. A broad selector stays silent.
      if (exact && capability) {
        for (const axis of CONFIGURATION_AXES) {
          if (override[axis] === undefined || imposed[axis] === undefined) continue;
          findings.push({
            key,
            message:
              `steps["${key}"].${axis} is imposed by ${capability.kind} ${capability.name} ` +
              `(${axis}: ${imposed[axis]}) — its frontmatter overrides runner flags; change it there`,
          });
        }
      }

      if (Object.keys(applicable).length > 0 && !backend.applyConfigAxes) {
        findings.push({
          key,
          message: `steps["${key}"]: backend "${backend.id}" does not expose model/effort axis translation`,
        });
      }
    }
  }

  return dedupeStepOverrideFindings(findings);
}

export interface ApplyResult {
  /** Keys actually applied, for run tracing. */
  applied: { key: StepOverrideKey; stepId: string; override: StepOverride }[];
}

/**
 * Apply overrides to the built pipeline in place.
 *
 * Validation is delegated to the shared rules above, so the loader can never reject
 * a configuration `--lint-config` called consistent. The loader already validates
 * before calling this; re-checking keeps the function safe for direct callers and
 * costs one pass over the keys.
 */
export function applyStepOverrides(
  pipeline: Pipeline,
  rawOverrides: Record<StepOverrideKey, StepOverride>,
  source: string,
  context: PipelineContext,
): ApplyResult {
  if (Object.keys(rawOverrides).length === 0) return { applied: [] };

  const overrides = rawOverrides;
  const registry = requireAgentBackendRegistry(context);

  const findings = [
    ...checkOverrideKeyShapes(overrides),
    ...checkStepOverrides({ pipelineName: pipeline.name, steps: pipeline.steps, overrides, registry, context }),
  ];
  // Report the first problem: this runs before the first spawn, and the validator
  // already aggregated the full list for the author.
  if (findings.length > 0) throw new Error(`Invalid configuration (${source}): ${findings[0].message}`);

  const applied: ApplyResult["applied"] = [];
  for (const step of pipeline.steps) {
    if (!isAgentStep(step)) continue;
    const spec0 = backendSpecForStep(step);
    if (!spec0) continue;
    let backend: AgentBackend;
    try {
      backend = registry.resolve(spec0);
    } catch (error) {
      throw new Error(`Invalid configuration (${source}): ${errorMessage(error)}`, { cause: error });
    }
    // Keys accumulate from broadest to most specific: a demo:* model override must
    // preserve effort from *. Each pass starts from the options already written.
    let spec = spec0;
    for (const key of keysFor(pipeline.name, step.id)) {
      const override = overrides[key];
      if (!override) continue;
      // Do not write capability-imposed axes; using the shared resolver keeps lint
      // and execution precedence aligned.
      const effective = resolveEffectiveAxes(step, context, override).configured;
      if (effective.model === undefined && effective.effort === undefined) continue;
      const applyAxes = backend.applyConfigAxes;
      if (!applyAxes) {
        throw new Error(
          `Invalid configuration (${source}): steps["${key}"]: backend "${backend.id}" does not expose model/effort axis translation`,
        );
      }
      spec = { ...spec, options: applyAxes(spec.options, effective) };
      step.backend = spec;
      applied.push({ key, stepId: step.id, override: effective });
    }
  }
  return { applied };
}
