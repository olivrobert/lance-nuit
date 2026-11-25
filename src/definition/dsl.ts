import type { humanReview } from "./builtin-steps/lib/human-review.js";
import type { PromptFileFactory } from "./builtin-steps/lib/project-prompt.js";
import type { requireCapabilitiesStep } from "./builtin-steps/lib/skill-preflight.js";
import type { workItemDeliveryStep, workItemEscalateStep } from "./builtin-steps/lib/work-item-steps.js";
import type { artifact, source, textArtifact } from "./dsl/artifact.js";
import type { forEachPipeline, runPipeline } from "./dsl/dsl-orchestration.js";
import type { parallelize } from "./dsl/dsl-parallel.js";
import type { pipeline } from "./dsl/dsl-pipeline.js";
import type { actionStep, bashStep, LlmStepFactory, WithBackendFactory } from "./dsl/dsl-steps.js";
import type { OnFail } from "./dsl/dsl-types.js";
import type {
  fail,
  failIf,
  failUnless,
  failUnlessCommand,
  requireArtifact,
  skip,
  skipIf,
  skipUnless,
  skipUnlessCommand,
  stop,
  stopIf,
  stopUnless,
  stopUnlessCommand,
} from "./dsl/input.js";
import type { reject } from "./dsl/preconditions.js";
import type { RUN_REPORT_FILE } from "./run-report.js";
import type { FixContext, PipelineContext } from "../shared/language/context.js";
import type { Pipeline } from "./definition.js";
import type { decisionMatchesArtifact, pendingRejection } from "../work-items/index.js";

export type {
  HumanReviewOptions,
  ReviewApproval,
  ReviewApprovalChoice,
  ReviewKind,
} from "./builtin-steps/lib/human-review.js";
export { humanReview } from "./builtin-steps/lib/human-review.js";
export type { EffortLevel, JsonSchema } from "../contracts/backends.js";
export type { SourceOptions } from "./dsl/artifact.js";
export { artifact, source, textArtifact } from "./dsl/artifact.js";
export { forEachPipeline, runPipeline } from "./dsl/dsl-orchestration.js";
export { PipelineOrchestrationStepBuilder } from "./dsl/dsl-orchestration-step.js";
export { parallelize } from "./dsl/dsl-parallel.js";
export { pipeline } from "./dsl/dsl-pipeline.js";
export {
  ActionStepBuilder,
  AgentStepBuilder,
  actionStep,
  BashStepBuilder,
  bashStep,
  createProjectActionStep,
  createProjectBashStep,
  createProjectLlmStep,
  llmStep,
  StepBuilder,
  withBackend,
} from "./dsl/dsl-steps.js";
export type { LlmStepFactory, WithBackendFactory } from "./dsl/dsl-steps.js";
export type {
  ActionStepOptions,
  BackendAuthorOptions,
  BackendOptionsFor,
  BashStepOptions,
  CaptureSpec,
  Escalate,
  ForEachPipelineOptions,
  ForEachWorkItemOptions,
  InternalWorkItemSourceOptions,
  LlmStepOptions,
  OnFail,
  ParallelizeOptions,
  PipelineAfterOptions,
  PipelineEntry,
  ReviewOptions,
  RunPipelineOptions,
  StepOptionsBase,
} from "./dsl/dsl-types.js";
export { createInternalWorkItemSourceStep, resolveWorkItemDir } from "./dsl/dsl-work-item.js";
export type {
  InputAction,
  InputDecision,
  InputPolicy,
  InputPredicate,
  InputPredicateResult,
  StepInputCondition,
  When,
  WhenOutcome,
} from "./dsl/input.js";
export {
  fail,
  failIf,
  failUnless,
  failUnlessCommand,
  requireArtifact,
  skip,
  skipIf,
  skipUnless,
  skipUnlessCommand,
  stop,
  stopIf,
  stopUnless,
  stopUnlessCommand,
} from "./dsl/input.js";
export type { BackendFor, StepProfileName } from "./dsl/profiles.js";
export type { ClaudeStepOptions } from "../contracts/backends/claude-code.js";
export type { CodexBackendOptions, CodexModel, CodexSandbox } from "../contracts/backends/codex.js";
export { CODEX_MODEL, CODEX_SANDBOX } from "../contracts/backends/codex.js";
export type { AsyncTemplated, FixContext, PipelineContext, Templated } from "../shared/language/context.js";
export type { Pipeline, StepCapture } from "./definition.js";

/**
 * Failure policy for a mechanical fix. The restricted Claude tool set and
 * coder profile are part of the policy, so authors do not need to duplicate
 * those runtime-specific options in every step. The fix backend is inherited
 * from the step, or named by `fixBackend` on a step without one: the Claude tool
 * restrictions apply only when the fix runs on Claude, and are dropped on any
 * other backend. On another backend the fix inherits the step's own backend
 * options instead — a Codex fix repairs under the sandbox the step declared, and
 * a step that granted no write access (Codex defaults to `read-only`) gives its
 * fix none either.
 */
export const mechanicalFix = (prompt: (ctx: FixContext) => string): OnFail => ({
  fix: prompt,
  retries: 2,
  escalate: { effort: "high" },
  claude: { tools: ["Read", "Edit"], strictMcp: true, settingSources: "" },
  fixProfile: "coder",
});

/**
 * Everything a project pipeline receives at runtime: the single list of the
 * injected values, bound by `createProjectDsl`.
 */
export interface Dsl {
  pipeline: typeof pipeline;
  runPipeline: typeof runPipeline;
  forEachPipeline: typeof forEachPipeline;
  /** Run several `llmStep` side by side; they read, they do not write to the code. */
  parallelize: typeof parallelize;
  llmStep: LlmStepFactory;
  withBackend: WithBackendFactory;
  bashStep: typeof bashStep;
  actionStep: typeof actionStep;
  workItemEscalateStep: typeof workItemEscalateStep;
  /** Unified human-review helper; approval subjects are bound to this pipeline automatically. */
  humanReview: typeof humanReview;
  workItemDeliveryStep: typeof workItemDeliveryStep;
  requireCapabilitiesStep: typeof requireCapabilitiesStep;
  promptFile: PromptFileFactory;
  artifact: typeof artifact;
  textArtifact: typeof textArtifact;
  /** External state a step reads (`input`), fingerprinted from a command's stdout. */
  source: typeof source;
  skip: typeof skip;
  fail: typeof fail;
  stop: typeof stop;
  skipIf: typeof skipIf;
  skipUnless: typeof skipUnless;
  failIf: typeof failIf;
  failUnless: typeof failUnless;
  failUnlessCommand: typeof failUnlessCommand;
  stopIf: typeof stopIf;
  stopUnless: typeof stopUnless;
  stopUnlessCommand: typeof stopUnlessCommand;
  requireArtifact: typeof requireArtifact;
  skipUnlessCommand: typeof skipUnlessCommand;
  /** Failure policy preset for a fresh, tool-restricted mechanical fix. */
  mechanicalFix: typeof mechanicalFix;
  /** Reject an admission predicate with a reason suitable for logs. */
  reject: typeof reject;
  /** True when the recorded approval decision still matches the artifact bytes. */
  decisionMatchesArtifact: typeof decisionMatchesArtifact;
  /** Reason and round of a rejection the rework has not answered yet, for its prompt. */
  pendingRejection: typeof pendingRejection;
  /** File name of the run report a pipeline writes under the work item's `artifacts/`. */
  RUN_REPORT_FILE: typeof RUN_REPORT_FILE;
}

export type PipelineFactory = (dsl: Dsl, context: PipelineContext) => Pipeline;
export type { WorkQueue } from "../contracts/work-items.js";
export type { Artifact, Source } from "./dsl/artifact.js";
