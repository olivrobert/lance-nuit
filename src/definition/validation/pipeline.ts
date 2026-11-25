//
// Every rule a pipeline definition and its configuration must pass before
// materialization.

import type { PipelineContext } from "../../shared/language/context.js";
import type { ProfileOverrides, StepOverride } from "../../shared/language/profiles.js";
import type { Pipeline } from "../definition.js";
import { AgentBackendValidator } from "./backend.js";
import { PipelineValidationChain, PipelineValidationError, type PipelineValidationReport } from "./chain.js";
import { FixBackendValidator } from "./fix-backend.js";
import { AgentOutputContractValidator } from "./output-contract.js";
import { ParallelGroupValidator } from "./parallel-group.js";
import { ProfileCoherenceValidator } from "./profile-coherence.js";
import { ConfigurationReferenceValidator, ExtractorReferenceValidator } from "./references.js";
import { ResumeSessionValidator } from "./resume-session.js";
import { ResumedFixEscalationValidator } from "./resumed-fix-escalation.js";
import { PipelineStructureValidator } from "./structure.js";

const PIPELINE_VALIDATION_CHAIN = new PipelineValidationChain([
  new PipelineStructureValidator(),
  new AgentBackendValidator(),
  new AgentOutputContractValidator(),
  new ProfileCoherenceValidator(),
  new ResumeSessionValidator(),
  new ResumedFixEscalationValidator(),
  new ParallelGroupValidator(),
  new FixBackendValidator(),
  new ExtractorReferenceValidator(),
  new ConfigurationReferenceValidator(),
]);

export interface PipelineValidationOptions {
  profileOverrides?: ProfileOverrides;
  stepOverrides?: Readonly<Record<string, StepOverride>>;
  /** Runtime context required to detect capability conflicts. */
  context?: PipelineContext;
}

/** Every finding at once, for a caller that reports them rather than stops. */
export function pipelineValidationReport(
  pipeline: Pipeline,
  source: string,
  options: PipelineValidationOptions = {},
): PipelineValidationReport {
  return PIPELINE_VALIDATION_CHAIN.validate({
    source,
    pipeline,
    profileOverrides: options.profileOverrides ?? {},
    stepOverrides: options.stepOverrides ?? {},
    pipelineContext: options.context,
  });
}

/** Throw one aggregated error listing every finding. */
export function validatePipeline(pipeline: Pipeline, source: string, options: PipelineValidationOptions = {}): void {
  const report = pipelineValidationReport(pipeline, source, options);
  if (!report.ok) throw new PipelineValidationError(source, report.errors);
}
