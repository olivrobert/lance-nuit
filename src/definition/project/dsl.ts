/**
 * Public facade for project pipelines, installed as `@lance-nuit/dsl`.
 *
 * Types only: a project pipeline receives every value through the injected
 * `Dsl`, since the installed declarations have no JavaScript behind them and a
 * value import would typecheck, then fail at load time.
 */

export type {
  HumanReviewOptions,
  ReviewApproval,
  ReviewApprovalChoice,
  ReviewKind,
} from "../builtin-steps/lib/human-review.js";
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
} from "../../contracts/work-items.js";
export type {
  Artifact,
  ArtifactParser,
  Source,
  SourceOptions,
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
  ParallelizeOptions,
  Pipeline,
  PipelineAfterOptions,
  PipelineContext,
  PipelineEntry,
  PipelineFactory,
  PipelineOrchestrationStepBuilder,
  ReviewOptions,
  RunPipelineOptions,
  StepCapture,
  StepInputCondition,
  StepOptionsBase,
  StepProfileName,
  Templated,
  When,
  WhenOutcome,
} from "../dsl.js";
export type { ClaudeBackendOptions } from "../../contracts/backends/claude-code.js";
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
} from "../run-report.js";
