// What other contexts may import from this one: re-exports only, every name with a caller outside.
// `module-<context>-entry-only` in `.dependency-cruiser.cjs` holds the rule.
export { deliversOutputs, reconcilable, rerunsOnResume } from "./definition.js";
export type {
  Pipeline,
  PipelineInvocationDefinition,
  PipelineOrchestrationDefinition,
  PipelineStep,
  StepFailure,
} from "./definition.js";
export type { Artifact } from "./dsl/artifact.js";
export type { InputAction, InputDecision, InputPredicate, StepInputCondition } from "./dsl/input.js";
export { fixProfileOptions } from "./dsl/profiles.js";
export {
  PIPELINE_NAME_RE,
  isPipelineName,
  listPipelineFiles,
  pipelineSearchPaths,
  resolveBuiltinPipeline,
} from "./pipeline/builtin-pipeline.js";
export { agentBackendRegistryOf, buildPipelineContext, deriveContext, workItemRegistryOf } from "./pipeline/context.js";
export type { BuildPipelineContextOptions } from "./pipeline/context.js";
export { loadPipelineDefinition } from "./pipeline/loader.js";
export {
  installProjectTypes,
  installUserTypes,
  typecheckProjectPipelines,
  typecheckUserPipelines,
} from "./project/dsl-types.js";
export { ensureContractsForExtension } from "./project/dsl-types/contracts-package.js";
export { projectKitDirs } from "./project/dsl-types/layout.js";
export { RUN_REPORT_FILE } from "./run-report.js";
export type {
  RunReport,
  RunReportCaptureGroup,
  RunReportCriterion,
  RunReportDelivered,
  RunReportFollowUp,
  RunReportLink,
  RunReportNote,
  RunReportProof,
  RunReportReview,
} from "./run-report.js";
export {
  checkOverrideKeyShapes,
  checkStepOverrides,
  dedupeStepOverrideFindings,
  imposedAxes,
  resolveEffectiveAxes,
  stepCapability,
  stepOverrideFor,
} from "./validation/step-overrides.js";
