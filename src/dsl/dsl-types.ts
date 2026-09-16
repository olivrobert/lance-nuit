import type { EffortLevel, JsonSchema } from "../contracts/backends.js";
import type { WorkQueue } from "../contracts/work-items.js";
import type { ClaudeStepOptions } from "../contracts/backends/claude-code.js";
import type { CodexBackendOptions } from "../contracts/backends/codex.js";
import type {
  AsyncTemplated,
  FixContext,
  PipelineContext,
  PipelineLot,
  StepAction,
  Templated,
} from "../model/context.js";
import type { WorkItemScanDefinition } from "../model/definition.js";
import type { Artifact } from "./artifact.js";
import type { StepBuilder } from "./dsl-steps.js";
import type { InputPredicate, When } from "./input.js";
import type { BackendFor, StepProfileName } from "./profiles.js";

export type { EffortLevel, JsonSchema } from "../contracts/backends.js";
export type { AsyncTemplated } from "../model/context.js";

export interface Escalate {
  after?: number;
  model?: string;
  effort?: EffortLevel;
}

interface FixPolicyBase {
  /** Claude-shaped fix options; applied only when the fix backend is Claude,
   *  dropped otherwise. `backendOptions` takes precedence when both are set. */
  claude?: ClaudeStepOptions;
  backendOptions?: unknown;
  /** Role that sets the fix pass model/effort on the backend that repairs. For a
   *  `bashStep` with `resumeSession`, that backend is the resumed step's provider,
   *  so the role is read from `profiles.<role>.backends.<that backend>`. */
  fixProfile?: StepProfileName;
  /** Backend that repairs a `bashStep` (or `actionStep`) in a fresh session, instead
   *  of the default backend. Rejected on an agent step, which is always repaired by
   *  its own backend, and with `resumeSession`, where the repair must land on the
   *  resumed session's provider. */
  fixBackend?: string;
  escalate?: Escalate;
  resumeSizeThresholdKb?: number;
  /** `true`: when the `errorExtractor` returns no actionable error, fail the step
   *  immediately instead of repairing it — no repair pass, no retry consumed. Use it
   *  on a step whose failure can be infrastructural (a container that is down, a
   *  missing binary): the raw stderr is not a red suite, and a repair paid on it
   *  edits code that was never run. Requires `errorExtractor`. Default `false`: a
   *  failing exit code with no extracted error is still repaired from the raw
   *  output. */
  fixOnlyWhenExtracted?: boolean;
}

/** Failure policy. Without `fix`, the command is replayed `retries` times. With
 *  `fix`, each attempt repairs then replays the command; `resumeSession: "<stepId>"`
 *  runs the repair inside the session recorded by that `llmStep` (declared earlier
 *  in the same pipeline) instead of a fresh one. */
export type OnFail =
  | { retries: number; escalate?: Escalate; fix?: never; resumeSession?: never }
  | (FixPolicyBase & { fix: AsyncTemplated<FixContext>; resumeSession?: string; retries?: number });

export interface StepOptionsBase {
  id: string;
  name: string;
  when?: When | readonly When[];
  require?: AsyncTemplated<PipelineContext>;
  /** Artifacts this step reads. Opt-in: declaring it makes the runner skip the
   *  step while every `output` is up to date with the fingerprints of these
   *  inputs, and re-admit it on resume when one of them changed. An artifact
   *  listed in both `input` and `output` is revised in place: it is never erased
   *  before the attempt and never fingerprinted. */
  input?: readonly Artifact<unknown>[];
  output?: readonly Artifact<unknown>[];
  report?: string | readonly string[];
  errorExtractor?: string;
  timeout?: number;
  blocking?: boolean;
  rerunOnResume?: boolean;
  onFail?: OnFail;
}

export interface BackendAuthorOptions {
  claude: ClaudeStepOptions;
  codex: CodexBackendOptions;
}

export type BackendOptionsFor<B extends string> = B extends keyof BackendAuthorOptions
  ? BackendAuthorOptions[B]
  : unknown;

/** One captured output of an `llmStep`. Short form: a text artifact, the field is
 *  a string. Long form: any artifact with the JSON schema of the field, which
 *  must be strict-mode compatible (every property required, no additional
 *  properties) because the providers' structured-output modes reject anything
 *  else. Mandatory for a JSON artifact. */
export type CaptureSpec = Artifact<string> | { readonly artifact: Artifact<unknown>; readonly schema: JsonSchema };

export type LlmStepOptions<
  P extends StepProfileName = StepProfileName,
  B extends BackendFor<P> = BackendFor<P>,
> = StepOptionsBase & {
  profile: P;
  backend: B;
  options?: BackendOptionsFor<B>;
  /** Fields the agent returns in its verdict object and the runner persists as
   *  artifacts, keyed by field name. Each artifact joins `output` implicitly. The
   *  names `success`, `reason`, and `blocked` are the verdict's own. */
  capture?: Readonly<Record<string, CaptureSpec>>;
} & ({ prompt: string; command?: never } | { command: AsyncTemplated<PipelineContext>; prompt?: never });

export type BashStepOptions = StepOptionsBase & {
  command: AsyncTemplated<PipelineContext>;
};

export type ActionStepOptions = StepOptionsBase & {
  run: StepAction;
  describe: Templated<PipelineContext>;
};

export type PipelineEntry = StepBuilder | readonly StepBuilder[];

export interface ForEachWorkItemOptions {
  queue: WorkQueue;
  scan?: WorkItemScanDefinition;
  maxCostPerWorkItemUsd?: number;
  dir?: string;
  before?: readonly PipelineEntry[];
  load?: { allowClosed?: boolean; retries?: number };
  do: readonly PipelineEntry[];
}

export interface RunPipelineOptions {
  id: string;
  name: string;
  pipeline: string;
  when?: When | readonly When[];
  ticket?: AsyncTemplated<PipelineContext, string | undefined>;
}

export interface PipelineAfterOptions {
  pipeline: string;
  when?: InputPredicate;
  ticket?: AsyncTemplated<PipelineContext, string | undefined>;
}

export interface ForEachPipelineOptions {
  id: string;
  name: string;
  when?: When | readonly When[];
  items: AsyncTemplated<PipelineContext, readonly string[]>;
  ticket?: AsyncTemplated<PipelineContext, string | undefined>;
  lot?: (ctx: PipelineContext, item: string) => PipelineLot | Promise<PipelineLot>;
  pipeline: string;
  afterEach?: PipelineAfterOptions;
  afterAll?: PipelineAfterOptions;
}

export interface InternalWorkItemSourceOptions {
  id?: string;
  name?: string;
  dir: (ctx: PipelineContext) => string;
  refuseClosed?: boolean;
  scan?: WorkItemScanDefinition;
  queue: WorkQueue;
}

export type {
  PipelineOrchestrationDefinition,
  PipelineStep,
  PipelineWorkItemSource,
} from "../model/definition.js";
export type { InputPredicate, StepInputCondition, When } from "./input.js";
export type { BackendFor, StepProfileName } from "./profiles.js";
