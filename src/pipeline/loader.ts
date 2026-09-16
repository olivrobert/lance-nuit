// runner/pipeline/loader.ts
//
// Validate a pipeline definition and dynamically load its DSL.

import { dirname, resolve as pathResolve } from "node:path";
import { pathToFileURL } from "node:url";
import { humanReview } from "../builtin-steps/lib/human-review.js";
import { createPromptFile } from "../builtin-steps/lib/project-prompt.js";
import { requireCapabilitiesStep } from "../builtin-steps/lib/skill-preflight.js";
import { workItemDeliveryStep, workItemEscalateStep } from "../builtin-steps/lib/work-item-steps.js";
import { reject } from "../dsl/preconditions.js";
import { applyProfileOverrides, type ProfileOverrides } from "../dsl/profiles.js";
import {
  createProjectActionStep,
  artifact,
  createProjectBashStep,
  createProjectLlmStep,
  type Dsl,
  fail,
  failIf,
  failUnless,
  failUnlessCommand,
  forEachPipeline,
  mechanicalFix,
  type PipelineFactory,
  pipeline as pipelineBuilder,
  requireArtifact,
  runPipeline,
  skip,
  skipIf,
  skipUnless,
  skipUnlessCommand,
  stop,
  stopIf,
  stopUnless,
  stopUnlessCommand,
  textArtifact,
  withBackend,
} from "../dsl.js";
import { configFileLabel } from "../env/kit-paths.js";
import { type PipelineContext, requireAgentBackendRegistry } from "../model/context.js";
import type { Pipeline } from "../model/definition.js";
import type { StepOverride } from "../model/profiles.js";
import { decisionMatchesArtifact } from "../state/decisions.js";
import { freshness } from "../state/provenance.js";
import { applyStepOverrides, imposedAxes } from "../validation/step-overrides.js";
import { AgentBackendValidator } from "../validation/backend.js";
import { PipelineValidationChain, PipelineValidationError } from "../validation/chain.js";
import { FixBackendValidator } from "../validation/fix-backend.js";
import { AgentOutputContractValidator } from "../validation/output-contract.js";
import { ProfileCoherenceValidator } from "../validation/profile-coherence.js";
import { ConfigurationReferenceValidator, ExtractorReferenceValidator } from "../validation/references.js";
import { ResumeSessionValidator } from "../validation/resume-session.js";
import { ResumedFixEscalationValidator } from "../validation/resumed-fix-escalation.js";
import { PipelineStructureValidator } from "../validation/structure.js";
import { buildPipelineContext } from "./context.js";

// The file named in validation errors is the one the user REALLY edits:
// `configFileLabel` follows the root actually read, otherwise a
// project-specific definitions are always resolved from `.lance-nuit/`.

const PIPELINE_VALIDATION_CHAIN = new PipelineValidationChain([
  new PipelineStructureValidator(),
  new AgentBackendValidator(),
  new AgentOutputContractValidator(),
  new ProfileCoherenceValidator(),
  new ResumeSessionValidator(),
  new ResumedFixEscalationValidator(),
  new FixBackendValidator(),
  new ExtractorReferenceValidator(),
  new ConfigurationReferenceValidator(),
]);

/**
 * Build the facade injected into a project factory.
 *
 * Load-dependent helpers are bound here, so two imported pipelines cannot share
 * contract context or prompt resolution roots.
 */
export function createProjectDsl(context: PipelineContext, pipelineDir: string): Dsl {
  const backendRegistry = requireAgentBackendRegistry(context);
  return {
    pipeline: pipelineBuilder,
    runPipeline,
    forEachPipeline,
    llmStep: createProjectLlmStep(pipelineDir, backendRegistry),
    withBackend: (id, options) => withBackend(id, options, backendRegistry),
    bashStep: createProjectBashStep(backendRegistry),
    actionStep: createProjectActionStep(backendRegistry),
    workItemEscalateStep,
    humanReview,
    workItemDeliveryStep,
    requireCapabilitiesStep,
    promptFile: createPromptFile(pipelineDir),
    artifact,
    textArtifact,
    skip,
    fail,
    stop,
    skipIf,
    skipUnless,
    failIf,
    failUnless,
    failUnlessCommand,
    stopIf,
    stopUnless,
    stopUnlessCommand,
    requireArtifact,
    skipUnlessCommand,
    mechanicalFix,
    reject,
    decisionMatchesArtifact,
    freshness,
  };
}

export interface PipelineValidationOptions {
  profileOverrides?: ProfileOverrides;
  stepOverrides?: Readonly<Record<string, StepOverride>>;
  /** Runtime context required to detect capability conflicts. */
  context?: PipelineContext;
}

export function validatePipeline(pipeline: Pipeline, source: string, options: PipelineValidationOptions = {}): void {
  const report = PIPELINE_VALIDATION_CHAIN.validate({
    source,
    pipeline,
    profileOverrides: options.profileOverrides ?? {},
    stepOverrides: options.stepOverrides ?? {},
    pipelineContext: options.context,
  });
  if (!report.ok) {
    // The chain keeps the complete report, but the loader
    // surfaces one aggregated error to its callers.
    throw new PipelineValidationError(source, report.errors);
  }
}

/** Dynamically import a .ts pipeline factory and return its definition. */
export async function loadPipelineDefinition(pipelinePath: string, context?: PipelineContext): Promise<Pipeline> {
  const abs = pathResolve(pipelinePath);
  const mod = await import(pathToFileURL(abs).href);
  if (mod.default === undefined) {
    throw new Error(`Invalid pipeline (${pipelinePath}): missing default export`);
  }
  if (typeof mod.default !== "function") {
    throw new Error(`Invalid pipeline (${pipelinePath}): default export must be a factory (dsl) => Pipeline`);
  }
  const buildContext = context ?? buildPipelineContext();
  const projectDsl = createProjectDsl(buildContext, dirname(abs));
  // Project factories receive only the DSL. Builtin pipelines use the internal
  // two-argument signature to keep their context, without exposing it to the
  // author-facing API.
  const factory = mod.default as PipelineFactory & ((dsl: Dsl, context: PipelineContext) => Pipeline);
  const pipeline = factory.length >= 2 ? factory(projectDsl, buildContext) : factory(projectDsl);
  // All consistency validation must precede option materialization: a profile
  // incompatible with the backend must never be silently rendered inert by
  // applyProfileOverrides().
  validatePipeline(pipeline, pipelinePath, {
    profileOverrides: buildContext.config.profiles,
    stepOverrides: buildContext.config.steps,
    context: buildContext,
  });

  // Config overrides apply to the built pipeline: the profile supplies defaults,
  // then the config file decides. A key that no longer matches a step in this
  // pipeline fails here, before the first spawn.
  applyProfileOverrides(
    pipeline,
    buildContext.config.profiles,
    (step) => imposedAxes(step, buildContext),
    requireAgentBackendRegistry(buildContext),
  );
  applyStepOverrides(pipeline, buildContext.config.steps, configFileLabel(buildContext.cwd), buildContext);
  return pipeline;
}
