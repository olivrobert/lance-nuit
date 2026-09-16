/**
 * Public facade for project pipelines.
 *
 * The runner keeps its primitives in `dsl.ts`, but this is the only module whose
 * declarations are installed under `@lance-nuit/dsl`. Construction details
 * and persisted types therefore do not accidentally become author-facing APIs.
 */

export type { HumanReviewOptions, ReviewApproval, ReviewKind } from "../builtin-steps/lib/human-review.js";
export { humanReview } from "../builtin-steps/lib/human-review.js";
export type {
  PromptFileFactory,
  PromptRenderer,
} from "../builtin-steps/lib/project-prompt.js";
export type {
  ProjectEscalation,
  ProjectEscalationNoteOptions,
  ProjectEscalationOptions,
  ProjectEscalationStepOptions,
} from "../builtin-steps/lib/public-work-item.js";
export type { CapabilityPreflightOptions } from "../builtin-steps/lib/skill-preflight.js";
export { requireCapabilitiesStep } from "../builtin-steps/lib/skill-preflight.js";
export { workItemDeliveryStep, workItemEscalateStep } from "../builtin-steps/lib/work-item-steps.js";
export type {
  AutomationQueue,
  RefValidation,
  TerminalQueue,
  WorkItem,
  WorkItemGateway,
  WorkItemNote,
  WorkItemNoteField,
  WorkItemRef,
  WorkItemState,
  WorkQueue,
} from "../contracts/work-items.js";
export type {
  Artifact,
  ArtifactParser,
} from "../dsl/artifact.js";
export type {
  ActionStepOptions,
  AsyncTemplated,
  BackendAuthorOptions,
  BackendFor,
  BackendOptionsFor,
  BashStepOptions,
  CaptureSpec,
  ClaudeStepOptions,
  CodexBackendOptions,
  CodexModel,
  CodexSandbox,
  Dsl,
  EffortLevel,
  Escalate,
  FixContext,
  ForEachPipelineOptions,
  ForEachWorkItemOptions,
  InputAction,
  InputDecision,
  InputPolicy,
  InputPredicate,
  InputPredicateResult,
  JsonSchema,
  LlmStepOptions,
  OnFail,
  Pipeline,
  PipelineAfterOptions,
  PipelineContext,
  PipelineEntry,
  PipelineFactory,
  PipelineOrchestrationStepBuilder,
  RunPipelineOptions,
  StepCapture,
  StepInputCondition,
  StepOptionsBase,
  StepProfileName,
  Templated,
  When,
  WhenOutcome,
} from "../dsl.js";
export {
  actionStep,
  artifact,
  bashStep,
  fail,
  failIf,
  failUnless,
  failUnlessCommand,
  forEachPipeline,
  llmStep,
  mechanicalFix,
  pipeline,
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
export type { ClaudeBackendOptions } from "../contracts/backends/claude-code.js";
export type {
  ActionStepOptions as ProviderNeutralActionStepOptions,
  AuthoringContext,
  AuthoringStep,
  BashStepOptions as ProviderNeutralBashStepOptions,
  ExtensionOptions,
  LlmStepOptions as ProviderNeutralLlmStepOptions,
  OnFailPolicy,
} from "./sdk.js";
// Provider-neutral authoring helpers live in the internal project facade. The
// existing DSL exports below remain host-specific compatibility types; these
// names let projects opt into extensible backend options without importing a
// concrete provider package.
export {
  backend as defineBackend,
  definePipeline as defineAuthoringPipeline,
  defineStep as defineAuthoringStep,
} from "./sdk.js";
