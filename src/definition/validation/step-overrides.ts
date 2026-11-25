//
// Rules a `steps` key of `.lance-nuit/config.json` must pass against a loaded
// pipeline. Per-step model/effort overrides allow tuning without changing
// pipeline code.
//
// Scope is limited to inline-prompt steps. A step invoking a skill or agent gets
// its model from capability frontmatter at session initialization, so `--model` is
// ignored. Accepting a config key there would promise an ineffective setting; the
// validator rejects it and names the responsible capability.

import { type AgentBackendRegistry, isAgentStep } from "../../contracts/backends.js";
import type { PipelineContext } from "../../shared/language/context.js";
import type { StepOverride } from "../../shared/language/profiles.js";
import type { PipelineStep } from "../definition.js";
import {
  imposedAxes,
  overrideKeys,
  resolvedBackendFor,
  stepCapability,
  withoutImposed,
} from "../materialize/step-axes.js";

/** Config key targeting steps; `*` < `<pipeline>:*` < `<pipeline>:<stepId>`. */
export type StepOverrideKey = string;

// ---------------------------------------------------------------------------
// Configuration rules
//
// Single source of truth for what a `steps` key is allowed to say, read by the
// pipeline validator (definition/validation/references.ts), which both the loader
// and `--lint-config` run. Hand-copied implementations had drifted apart in
// wording and coverage: lint skipped the generic keys the loader applies, so it
// could report a configuration as consistent that the next run rejected.
// ---------------------------------------------------------------------------

/** Configuration problem, without the `Invalid configuration (<source>)` framing
 *  the validator adds. */
export interface StepOverrideFinding {
  key: StepOverrideKey;
  message: string;
}

const CONFIGURATION_AXES = ["model", "effort"] as const;

/** Same message twice means the same problem: a generic key reaching ten steps is
 *  one configuration error, not ten. Insertion order is preserved. */
function dedupeStepOverrideFindings(findings: readonly StepOverrideFinding[]): StepOverrideFinding[] {
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
  return dedupeStepOverrideFindings([...exactKeyFindings(input), ...reachingKeyFindings(input)]);
}

/** Exact keys only: they alone can name a step that does not exist, or one no
 *  backend can configure. A generic selector legitimately covers such steps. */
function exactKeyFindings({ pipelineName, steps, overrides }: StepOverrideCheckInput): StepOverrideFinding[] {
  const findings: StepOverrideFinding[] = [];
  const byId = new Map(steps.map((step) => [step.id, step]));
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
  return findings;
}

/** Every key that actually reaches a step, generic ones included: `*` can carry an
 *  axis the backend cannot translate just as well as an exact key. */
function reachingKeyFindings(input: StepOverrideCheckInput): StepOverrideFinding[] {
  const { pipelineName, steps, overrides, registry, context } = input;
  const findings: StepOverrideFinding[] = [];
  for (const step of steps) {
    if (!isAgentStep(step)) continue;
    const backend = resolvedBackendFor(step, registry);
    if (!backend) continue;
    const imposed = context ? imposedAxes(step, context) : {};
    const capability = context ? stepCapability(step, context) : undefined;
    const supported = backend.capabilities.configurationAxes ?? [];

    for (const key of overrideKeys(pipelineName, step.id)) {
      const override = overrides[key];
      if (!override) continue;
      const exact = key === `${pipelineName}:${step.id}`;
      const applicable = withoutImposed(override, imposed);

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
  return findings;
}
