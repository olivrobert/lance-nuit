//
// Where a step's model and effort come from: capability frontmatter, then the
// `steps` configuration, then the step's profile. Materialization writes what this
// resolves, and `--lint-config` displays it.

import {
  type AgentBackend,
  type AgentBackendRegistry,
  type AgentConfigAxis,
  backendSpecForStep,
} from "../../contracts/backends.js";
import { capabilityAxes, capabilityRoots, isForked } from "../../shared/env/capability-frontmatter.js";
import type { PipelineContext } from "../../shared/language/context.js";
import { isStepProfileName, type ProfileOverrides, type StepOverride } from "../../shared/language/profiles.js";
import type { PipelineStep } from "../definition.js";
import { resolveProfileForBackend } from "../dsl/profiles.js";

export type Axes = Partial<Record<AgentConfigAxis, string>>;

export type AxisSource = "capability" | "config" | "profile" | "machine default";

const AXES = ["model", "effort"] as const;

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
  return slash ? { kind: "skill", name: slash[1]! } : undefined;
}

/** Axes imposed by capability frontmatter, which takes precedence over CLI flags.
 *  No capability or missing capability file means no imposed axes.
 *
 *  A `context: fork` capability imposes nothing on the host turn: its axes apply to
 *  the fork, while the host remains configurable. Charging the host at the fork's
 *  model would overcharge a turn that often only relays a verdict. */
export function imposedAxes(step: PipelineStep, context?: PipelineContext): Axes {
  const capability = stepCapability(step, context);
  if (!capability || !context) return {};
  const axes = capabilityAxes(capability.kind, capability.name, capabilityRoots(context.runnerDir, context.cwd));
  if (isForked(axes)) return {};
  return {
    ...(axes.model ? { model: axes.model } : {}),
    ...(axes.effort ? { effort: axes.effort } : {}),
  };
}

/** The one precedence rule: an axis the capability imposes is never configured. */
export function withoutImposed(axes: Axes, imposed: Axes): Axes {
  return Object.fromEntries(
    AXES.filter((axis) => axes[axis] !== undefined && imposed[axis] === undefined).map((axis) => [axis, axes[axis]]),
  );
}

/** Config keys reaching a step, from general to specific: `*` < `<pipeline>:*` < `<pipeline>:<stepId>`. */
export function overrideKeys(pipelineName: string, stepId: string): string[] {
  return ["*", `${pipelineName}:*`, `${pipelineName}:${stepId}`];
}

/** Backend of an agent step, or undefined when it cannot be resolved: an unknown
 *  backend or rejected options are reported by the validator. */
export function resolvedBackendFor(step: PipelineStep, registry: AgentBackendRegistry): AgentBackend | undefined {
  const spec = backendSpecForStep(step);
  if (!spec || !registry.has(spec.id)) return undefined;
  try {
    return registry.resolve(spec);
  } catch {
    return undefined;
  }
}

/** Keep only the axes a backend translates; none when it translates no axis. */
export function translatableAxes(backend: AgentBackend, axes: Axes): Axes {
  if (!backend.applyConfigAxes) return {};
  const supported = backend.capabilities.configurationAxes ?? [];
  return Object.fromEntries(
    AXES.filter((axis) => axes[axis] !== undefined && supported.includes(axis)).map((axis) => [axis, axes[axis]]),
  );
}

export interface StepAxesInput {
  pipelineName: string;
  stepOverrides: Readonly<Record<string, StepOverride>>;
  profileOverrides: ProfileOverrides;
  registry: AgentBackendRegistry;
  /** Required to read capability frontmatter; without it no axis is imposed. */
  context?: PipelineContext;
}

export interface StepAxes {
  capability?: { kind: "skill" | "agent"; name: string };
  /** Axes imposed by the capability frontmatter, which cannot be overridden. */
  imposed: Axes;
  /** Profile axes written into the step's options. */
  profile: Axes;
  /** `steps` configuration axes written into the step's options, over the profile. */
  configured: Axes;
  /** Values the step runs with. */
  effective: Axes;
  sources: Record<AgentConfigAxis, AxisSource>;
}

function profileAxes(step: PipelineStep, backend: AgentBackend | undefined, input: StepAxesInput): Axes {
  const spec = backendSpecForStep(step);
  if (!backend || !spec || !step.profile || !isStepProfileName(step.profile)) return {};
  return translatableAxes(backend, resolveProfileForBackend(step.profile, spec.id, input.profileOverrides) ?? {});
}

function configuredAxes(step: PipelineStep, input: StepAxesInput): Axes {
  return Object.assign(
    {},
    ...overrideKeys(input.pipelineName, step.id).map((key) => input.stepOverrides[key] ?? {}),
  ) as Axes;
}

/** Resolve capability > steps > profile once for an agent step. */
export function resolveStepAxes(step: PipelineStep, input: StepAxesInput): StepAxes {
  const capability = stepCapability(step, input.context);
  const imposed = imposedAxes(step, input.context);
  const backend = resolvedBackendFor(step, input.registry);
  const profile = withoutImposed(profileAxes(step, backend, input), imposed);
  const configured = withoutImposed(configuredAxes(step, input), imposed);
  const effective: Axes = {};
  const sources = {} as Record<AgentConfigAxis, AxisSource>;
  for (const axis of AXES) {
    const [value, source]: [string | undefined, AxisSource] =
      imposed[axis] !== undefined
        ? [imposed[axis], "capability"]
        : configured[axis] !== undefined
          ? [configured[axis], "config"]
          : profile[axis] !== undefined
            ? [profile[axis], "profile"]
            : [undefined, "machine default"];
    if (value !== undefined) effective[axis] = value;
    sources[axis] = source;
  }
  return { ...(capability ? { capability } : {}), imposed, profile, configured, effective, sources };
}
