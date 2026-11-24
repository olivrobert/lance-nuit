import type { EffortLevel, JsonSchema } from "../../contracts/backends.js";
import type { WorkQueue } from "../../contracts/work-items.js";
import type { ClaudeStepOptions } from "../../contracts/backends/claude-code.js";
import type { CodexBackendOptions } from "../../contracts/backends/codex.js";
import type {
  AsyncTemplated,
  FixContext,
  PipelineContext,
  PipelineLot,
  StepAction,
  Templated,
} from "../../shared/language/context.js";
import type { WorkItemScanDefinition } from "../definition.js";
import type { StepInput } from "../../work-items/index.js";
import type { Artifact } from "./artifact.js";
import type { AgentStepBuilder, StepBuilder } from "./dsl-steps.js";
import type { InputPredicate, When } from "./input.js";
import type { BackendFor, StepProfileName } from "./profiles.js";

export type { EffortLevel, JsonSchema } from "../../contracts/backends.js";
export type { AsyncTemplated } from "../../shared/language/context.js";

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
  /** `false`: a successful repair ends the step without replaying its command; the
   *  original failure is absorbed with a note that the fix was not verified. For a
   *  check whose second verdict would change nothing but its own cost (an advisory
   *  check), where later steps still exercise the repaired code. Requires
   *  `blocking: false` — an unverified repair must never open a blocking gate —,
   *  a single repair (`retries: 1`) and no `output`: nothing would vouch for
   *  outputs the repair rewrote. To have an agent step's outputs reviewed and
   *  fixed once, use `llmStep({ review })`. Default `true`. */
  replayAfterFix?: boolean;
  /** `true`: a successful repair that changed nothing in the git tree — no edited,
   *  added or deleted file outside `.gitignore`, no new commit — is not followed by
   *  a replay; the step stops as blocked, with the last failure reason suffixed by
   *  `(fix changed nothing)`. For a costly check whose repair may answer that the
   *  failure lies outside the code. Refused with `replayAfterFix: false`. Default
   *  `false`: a repair may work outside the tree (a test database, an ignored
   *  dependency folder) and still deserve its replay. */
  stopIfUnchanged?: boolean;
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
  /** Artifacts and external sources (`source()`) this step reads. Once the step
   *  succeeded, its stamp in `artifacts/lock.json` binds the hashes of these
   *  inputs to those of its `output`; the step is skipped while both still match,
   *  and runs again when one of them changed. An artifact absent then and now is
   *  unchanged. A step may not read what it writes, and a source can never be an
   *  `output`. Refused with `rerunOnResume`. */
  input?: readonly StepInput[];
  /** Artifacts the step produces, erased before each attempt and required after
   *  it. One producer per artifact in a pipeline. */
  output?: readonly Artifact<unknown>[];
  report?: string | readonly string[];
  errorExtractor?: string;
  timeout?: number;
  blocking?: boolean;
  rerunOnResume?: boolean;
  /** Safe to replay automatically on resume after the runner died mid-attempt
   *  (crash, OOM, SIGKILL). Without it the resumed run stops and asks. Implied by
   *  `rerunOnResume`. */
  replayInterrupted?: boolean;
  onFail?: OnFail;
}

export interface BackendAuthorOptions {
  claude: ClaudeStepOptions;
  codex: CodexBackendOptions;
}

export type BackendOptionsFor<B extends string> = B extends keyof BackendAuthorOptions
  ? BackendAuthorOptions[B]
  : unknown;

/** Review of an `llmStep`'s outputs once its produce phase succeeded: a review
 *  attempt in a fresh session returns `capture`, then `fix` decides whether one
 *  fix attempt runs in the producing session. There is no review after the fix. */
export interface ReviewOptions<
  T = unknown,
  P extends StepProfileName = StepProfileName,
  B extends BackendFor<P> = BackendFor<P>,
> {
  profile: P;
  backend: B;
  options?: BackendOptionsFor<B>;
  /** Review prompt, sent to a fresh session. */
  command: AsyncTemplated<PipelineContext>;
  /** The verdict field the review returns, written to `artifact` (which joins
   *  the step's `output`). Its schema must be strict-mode compatible. */
  capture: { field: string; artifact: Artifact<T>; schema: JsonSchema };
  /** Prompt sent to the producing session, or `undefined`: no fix. Called once,
   *  with the captured review. */
  fix: (review: T, ctx: PipelineContext) => string | undefined | Promise<string | undefined>;
  /** Role of the fix attempt on the step's backend. Default: the step's profile. */
  fixProfile?: StepProfileName;
  /** Plain reruns of a review attempt that failed or returned a refused capture.
   *  Default 0. */
  retries?: number;
}

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
  /** Review of the step's outputs, then at most one fix in its session. Refused
   *  with `blocking: false` and on a backend that cannot resume a session. */
  // biome-ignore lint/suspicious/noExplicitAny: each review declares its own capture type
  review?: ReviewOptions<any>;
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

export interface ParallelizeOptions {
  id: string;
  name: string;
  /** Agent steps that run side by side. Each id starts with `<id>.`. */
  steps: readonly AgentStepBuilder[];
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
} from "../definition.js";
export type { InputPredicate, StepInputCondition, When } from "./input.js";
export type { BackendFor, StepProfileName } from "./profiles.js";
