import type { humanReview as humanReviewFactory } from "./builtin-steps/lib/human-review.js";
import type { PromptFileFactory } from "./builtin-steps/lib/project-prompt.js";
import type { requireCapabilitiesStep } from "./builtin-steps/lib/skill-preflight.js";
import type {
  workItemDeliveryStep as workItemDeliveryStepFactory,
  workItemEscalateStep as workItemEscalateStepFactory,
} from "./builtin-steps/lib/work-item-steps.js";
import type { artifact, textArtifact } from "./dsl/artifact.js";
import type { forEachPipeline, runPipeline } from "./dsl/dsl-orchestration.js";
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
import type { FixContext } from "./model/context.js";
import type { Pipeline } from "./model/definition.js";
import type { decisionMatchesArtifact } from "./state/decisions.js";
import type { freshness } from "./state/provenance.js";

export type { HumanReviewOptions, ReviewApproval, ReviewKind } from "./builtin-steps/lib/human-review.js";
export { humanReview } from "./builtin-steps/lib/human-review.js";
export type { EffortLevel, JsonSchema } from "./contracts/backends.js";
export { artifact, textArtifact } from "./dsl/artifact.js";
// The orchestration and work-item functions are imported above from their
// focused modules; export them through this stable authoring entrypoint.
export { forEachPipeline, runPipeline } from "./dsl/dsl-orchestration.js";
export { PipelineOrchestrationStepBuilder } from "./dsl/dsl-orchestration-step.js";
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
  PipelineAfterOptions,
  PipelineEntry,
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
export type { ClaudeStepOptions } from "./contracts/backends/claude-code.js";
export type { CodexBackendOptions, CodexModel, CodexSandbox } from "./contracts/backends/codex.js";
export { CODEX_MODEL, CODEX_SANDBOX } from "./contracts/backends/codex.js";
export type { AsyncTemplated, FixContext, PipelineContext, Templated } from "./model/context.js";
export type { Pipeline, StepCapture } from "./model/definition.js";
export type { ArtifactFreshness } from "./state/provenance.js";
export { freshness } from "./state/provenance.js";

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

export interface Dsl {
  pipeline: typeof pipeline;
  runPipeline: typeof runPipeline;
  forEachPipeline: typeof forEachPipeline;
  llmStep: LlmStepFactory;
  withBackend: WithBackendFactory;
  bashStep: typeof bashStep;
  actionStep: typeof actionStep;
  workItemEscalateStep: typeof workItemEscalateStepFactory;
  /** Unified human-review helper; `approval.subject` is bound to this pipeline automatically. */
  humanReview: typeof humanReviewFactory;
  workItemDeliveryStep: typeof workItemDeliveryStepFactory;
  requireCapabilitiesStep: typeof requireCapabilitiesStep;
  promptFile: PromptFileFactory;
  artifact: typeof artifact;
  textArtifact: typeof textArtifact;
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
  /** Freshness of an artifact against the inputs recorded when it was produced. */
  freshness: typeof freshness;
}

export type PipelineFactory = (dsl: Dsl) => Pipeline;
export type { WorkQueue } from "./contracts/work-items.js";
export type { Artifact } from "./dsl/artifact.js";
