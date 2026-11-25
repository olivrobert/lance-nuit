//
// Write each step's model/effort into its backend options, once the validator has
// accepted the pipeline and its configuration: nothing here refuses.

import { type BackendSpec, backendForFix, backendSpecForStep, isAgentStep } from "../../contracts/backends.js";
import { type PipelineContext, requireAgentBackendRegistry } from "../../shared/language/context.js";
import type { ProfileOverrides, StepOverride } from "../../shared/language/profiles.js";
import type { Pipeline, PipelineStep } from "../definition.js";
import { fixProfileOptions } from "../dsl/profiles.js";
import { type Axes, resolveStepAxes, type StepAxesInput } from "./step-axes.js";

export interface MaterializeInput {
  profileOverrides: ProfileOverrides;
  stepOverrides: Readonly<Record<string, StepOverride>>;
  context: PipelineContext;
}

/** `applyConfigAxes` exists whenever axes are left: profile axes are filtered by
 *  `translatableAxes`, and the validator refuses a configured axis without it. */
function withAxes(spec: BackendSpec, axes: Axes, input: StepAxesInput): unknown {
  if (Object.keys(axes).length === 0) return spec.options;
  return input.registry.resolve(spec).applyConfigAxes!(spec.options, axes);
}

/**
 * Regime for a fix pass that borrows another role from its step (mechanical fix
 * in a fresh session), for the backend that runs the fix: the step's backend, or
 * the default provider when the step is `bash`. `resume_session` may move a
 * `bash` step's fix onto the resumed step's provider at runtime; the fix loop then
 * re-resolves the role through `fixProfileOptions`.
 *
 * When the fix runs on the step's own backend and the policy declared no options
 * of its own, it starts from the step's profile options: the repair pass needs the
 * same runtime regime as the step it repairs (a Codex sandbox — `read-only` by
 * default, so a fix without it can never write a patch — `add-dirs`, a Codex
 * profile…). An explicit `on_failure.backend_options` still wins, so an author who
 * deliberately restricted the fix keeps that restriction.
 */
function materializeFix(step: PipelineStep, stepProfileOptions: unknown, input: StepAxesInput): void {
  const failure = step.on_failure;
  if (!failure?.fix_profile) return;
  const spec = backendForFix(step, input.registry);
  const base = failure.backend_options ?? stepProfileOptions;
  failure.backend_options = fixProfileOptions(
    failure.fix_profile,
    spec,
    base,
    input.profileOverrides,
    input.registry,
  )!.options;
}

/** A review session runs its own role on its own backend. The fix after it borrows
 *  `fix_profile` at runtime, on the step's backend (`fixProfileOptions`). */
function materializeReview(step: PipelineStep, input: StepAxesInput): void {
  const review = step.review;
  if (!review) return;
  const options = fixProfileOptions(
    review.profile,
    review.backend,
    review.backend.options,
    input.profileOverrides,
    input.registry,
  )!.options;
  review.backend = { ...review.backend, options };
}

/** Apply, in this order, the step profile (which the fix pass inherits), the fix
 *  and review regimes, then the `steps` configuration over the profile. */
export function materializePipeline(pipeline: Pipeline, materialize: MaterializeInput): void {
  const input: StepAxesInput = {
    pipelineName: pipeline.name,
    stepOverrides: materialize.stepOverrides,
    profileOverrides: materialize.profileOverrides,
    registry: requireAgentBackendRegistry(materialize.context),
    context: materialize.context,
  };
  for (const step of pipeline.steps) {
    const spec = isAgentStep(step) ? backendSpecForStep(step) : undefined;
    if (!spec) {
      materializeFix(step, undefined, input);
      materializeReview(step, input);
      continue;
    }
    const axes = resolveStepAxes(step, input);
    materializeFix(step, withAxes(spec, axes.profile, input), input);
    materializeReview(step, input);
    const written = { ...axes.profile, ...axes.configured };
    if (Object.keys(written).length > 0) step.backend = { ...spec, options: withAxes(spec, written, input) };
  }
}
