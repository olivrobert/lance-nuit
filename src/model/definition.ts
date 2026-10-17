/** Authoring model of a pipeline: what a pipeline author writes (steps, failure
 *  policy, orchestration) and the context their functions receive. Persisted and
 *  runtime shapes live in `model/persisted.ts` and `model/run.ts`. */
import type { BackendSpec, EffortLevel, JsonSchema } from "../contracts/backends.js";
import type { WorkQueue } from "../contracts/work-items.js";
import type { Artifact } from "./artifact.js";
import type { AsyncTemplated, FixContext, PipelineContext, PipelineLot, StepAction } from "./context.js";
import type { InputPredicate, StepInputCondition } from "./input.js";
import type { StepProfileName } from "./profiles.js";
import type { StepInput } from "./source.js";

export interface StepFailure {
  /** Repair prompt. Absent: the command is simply replayed. */
  fix_prompt?: AsyncTemplated<FixContext>;
  /** Id of an earlier agent step whose recorded session hosts the repair, instead
   *  of a fresh one. Requires `fix_prompt`. After the repair, the forked session is
   *  written back to that step so a later gate resumes the repaired conversation. */
  resume_session?: string;
  max_retries: number;
  /** Options for the selected AgentBackend; unknown here by design. */
  backend_options?: unknown;
  /** Role whose fix pass borrows the model/effort regime when it differs from the
   *  step's (for example, a mechanical fix in a fresh session). Materialized in
   *  `backend_options` at load time through the fix backend, and re-read at runtime
   *  when `resume_session` moves a `bash` step's fix onto the resumed session's
   *  provider. */
  fix_profile?: StepProfileName;
  /** Backend chosen by the author for a fresh-session fix of a step without a
   *  backend of its own. Absent: the default backend. */
  fix_backend?: string;
  // If set, the fix switches to this model from the second attempt onward
  // (retry 1 = base model, retry >= 2 = this model). Escalation example: sonnet → opus.
  escalate_model?: string;
  // First rung of the ladder: increase effort before changing tier (cheaper).
  // A timeout remains a direct reason to switch model.
  escalate_effort?: EffortLevel;
  // Number of retries before arming catch-all escalation (sticky latch).
  // Runtime default = 2, whether or not the policy carries a fix.
  escalate_after?: number;
  resume_size_threshold_kb?: number;
  /** Opt-in: fail the step without spending a repair or a retry when the extractor
   *  returned no actionable error. Requires `error_extractor`. Default (absent) keeps
   *  the documented fallback, where a failing exit code with no extracted error is
   *  still repaired from the raw output. */
  fix_only_when_extracted?: boolean;
  /** Opt-out: `false` settles the step right after a successful repair instead of
   *  replaying its command. Only on a non-blocking step with a single repair. */
  replay_after_fix?: boolean;
}

/** Child pipeline call declared by an orchestration node. */
export interface PipelineInvocationDefinition {
  pipeline: string;
  ticket?: AsyncTemplated<PipelineContext, string | undefined>;
  when?: InputPredicate;
}

/** Runtime definition of a pipeline composition node. */
export type PipelineOrchestrationDefinition =
  | {
      kind: "runPipeline";
      pipeline: string;
      ticket?: AsyncTemplated<PipelineContext, string | undefined>;
    }
  | {
      kind: "forEachPipeline";
      items: AsyncTemplated<PipelineContext, readonly string[]>;
      /** Business ticket shared by children; defaults to the item itself. */
      ticket?: AsyncTemplated<PipelineContext, string | undefined>;
      /** Build the batch context from the item identifier. */
      lot?: (ctx: PipelineContext, item: string) => PipelineLot | Promise<PipelineLot>;
      pipeline: string;
      afterEach?: PipelineInvocationDefinition;
      afterAll?: PipelineInvocationDefinition;
    };

/** One field of an agent step's structured output, persisted by the runner as an
 *  artifact once the attempt succeeds. Built by `llmStep({ capture })`. */
export interface StepCapture {
  /** Key of the field in the verdict object, next to success/reason/blocked. */
  field: string;
  artifact: Artifact<unknown>;
  /** Schema of the field, inserted under the verdict schema by the backend. */
  schema: JsonSchema;
  /** Text artifact: the value must be a string, written as-is. Otherwise the value
   *  is any JSON the artifact's own parser accepts. */
  text: boolean;
}

export interface PipelineStep {
  id: string;
  name: string;
  command: AsyncTemplated<PipelineContext>;
  /** Step execution mode. The provider lives in `backend`: these are distinct
   *  axes, and one agent mode can serve every provider. */
  runner?: "agent" | "bash" | "noop" | "fn" | "pipeline";
  /** Definition of a pipeline call controlled by the runner. */
  orchestration?: PipelineOrchestrationDefinition;
  /** Provider that runs the step. Required by every `agent` step. */
  backend?: BackendSpec;
  /** In-process action for `fn` steps (not persisted; supplied by the pipeline). */
  action?: StepAction;
  /** Composable admission contracts, evaluated in declaration order. */
  inputs?: StepInputCondition[];
  /** Bash environment guard, run after admissions and before any spawn.
   *  Failure = immediate `failed` step, with no fix or retry: the environment is
   *  missing and code cannot change that. Distinct from admissions, which carry
   *  their own policy. */
  preflight?: AsyncTemplated<PipelineContext>;
  output_format?: "text" | "json";
  /** Artifacts a successful attempt must produce in a fresh run. */
  outputs?: Artifact<unknown>[];
  /** Fields of the agent's structured output the runner writes as artifacts,
   *  before `outputs` are verified. Each captured artifact is also in `outputs`.
   *  Agent steps only. */
  captures?: StepCapture[];
  /** Artifacts and external sources this step reads, declared through `input`.
   *  `inputs` above is already taken by admission conditions, hence the
   *  distinct name. Present only on steps that opted into input-freshness
   *  skipping. */
  sources?: StepInput[];
  error_extractor?: string;
  /** Machine reports written by the command (project-defined format).
   *  When set, error_extractor reads these files instead of stdout: the command
   *  may remain quiet (`--no-progress`) without depriving the fix of context. */
  report_paths?: string[];
  on_failure?: StepFailure;
  /** false: persist failure as a warning without failing the run. */
  blocking?: boolean;
  /** Semantic role and source of the nominal model/effort regime. */
  profile?: StepProfileName;
  timeout?: number;
  /** Rerun this step (idempotently) on resume even if it is `done` — e.g. create-branch:
   *  restore the Git state (HEAD on the feature/fix branch) that a skip would leave
   *  wrong (HEAD left on base/develop → commits on the wrong branch). */
  rerun_on_resume?: boolean;
  /** Replay this step on resume when the runner died during its last attempt,
   *  without asking: its side effects are safe to repeat. Implied by
   *  `rerun_on_resume`. */
  replay_interrupted?: boolean;
  /** Approval subjects this step reworks when a human rejects them. On resume the
   *  step replays while one of them has a pending rejection, whatever its input
   *  freshness says: a rejection is not an input, it is the reason to run. */
  rework_for?: string[];
}

/** Discovery configuration carried by a pipeline work-item source.
 * Only input queues are scannable: `done` and `escalate` are destinations, never
 * automated work sources. */
export interface WorkItemScanDefinition {
  /** Pipeline-specific limit; CLI `--limit` overrides it. */
  limit?: number;
  /** Provider-native selection (JQL for Jira, `gh issue list --search` syntax for
   *  GitHub) passed to the tracker verbatim in place of the default
   *  queue-label + todo-state query. The runner neither parses nor completes it:
   *  the pipeline owns the whole selection, project clause included. Delivery
   *  moves (`done`/`escalate` labels, review state) are unaffected. */
  query?: string;
}

/** Contribution of a `workItemSourceStep` to the pipeline definition. The runner
 * reads it before running steps to determine whether and how `--scan` can find
 * tickets. */
export interface PipelineWorkItemSource {
  step_id: string;
  /** Logical queue left by an escalation or pipeline delivery. */
  queue: WorkQueue;
  scan?: WorkItemScanDefinition;
}

export interface PipelineRework {
  stepId: string;
  maxRounds: number;
}

export interface Pipeline {
  name: string;
  description?: string;
  max_cost_usd?: number;
  /** Limit applied to every work-item run, including scan mode. */
  max_cost_per_work_item_usd?: number;
  /** Disable the clean Git tree guard at startup (commit and quality are dirty by nature). */
  allow_dirty?: boolean;
  /** Reconcile mode: on every invocation, a settled step is re-admitted and its
   *  declared outputs, not its status, decide whether it runs. Every step must
   *  then declare an output or `rerun_on_resume`; orchestration nodes keep the
   *  authority of their status. */
  reconcile?: boolean;
  /** Tracker source declared by a step. When absent, `--scan` is rejected: there is
   * no implicit source or default `bugTodo` queue. */
  work_item_source?: PipelineWorkItemSource;
  /** Human approval subjects declared by this pipeline and the artifact each one
   * binds. `--approve <subject>` resolves the artifact to hash here: this is the
   * only source of the mapping, with no hard-coded subject list. Missing means
   * this pipeline accepts no approvals. */
  approvals?: ReadonlyMap<string, Artifact<unknown>>;
  /** Reason a subject cannot be approved for the current artifact, undefined when
   * it can. Absent for a subject approvable whatever the verdict. */
  approvalGuards?: ReadonlyMap<string, (ctx: PipelineContext) => Promise<string | undefined>>;
  /** Step that reworks the artifact of a rejected subject, and the number of
   * rejection rounds allowed. `--reject <subject>` is refused for a subject
   * absent here: nothing would replay and the gate would stop forever. */
  reworks?: ReadonlyMap<string, PipelineRework>;
  steps: PipelineStep[];
}

/**
 * Reconcile mode's classification of a step (decisions D2 and D3), owned here so
 * the build, the validation, the admission and the loop share one answer.
 *
 * An orchestration node is out of scope whatever it declares: it keeps the
 * authority of its status, so neither its outputs nor its `rerun_on_resume`
 * make reconcile mode re-admit it.
 */
type ClassifiedStep = Pick<PipelineStep, "runner" | "outputs" | "rerun_on_resume">;

/** In reconcile mode, the presence of the step's outputs proves its work done. */
export function deliversOutputs(step: ClassifiedStep): boolean {
  return step.runner !== "pipeline" && (step.outputs?.length ?? 0) > 0;
}

/** Whether the author's `rerun_on_resume` replays this settled step on resume.
 *  The default mode honors it on every step, orchestration nodes included, as it
 *  always has; reconcile mode leaves a node to its status. */
export function rerunsOnResume(step: ClassifiedStep, reconcile: boolean): boolean {
  return step.rerun_on_resume === true && !(reconcile && step.runner === "pipeline");
}

/** A step reconcile mode re-admits: it declares outputs to check, or a replay
 *  it vouches for. */
export function reconcilable(step: ClassifiedStep): boolean {
  return deliversOutputs(step) || rerunsOnResume(step, true);
}

/**
 * Steps reconcile mode has nothing to decide on. In that mode a settled step runs
 * again unless its outputs prove its work done, so a step without output would
 * repeat its side effects on every invocation: it must declare what it delivers,
 * or declare itself safe to replay. Composed pipelines keep the authority of
 * their status, and the work-item source step belongs to the runner, so neither
 * is the author's to classify.
 */
export function stepsWithoutDeliverable(pipeline: Pick<Pipeline, "steps" | "work_item_source">): PipelineStep[] {
  return pipeline.steps.filter(
    (step) => step.runner !== "pipeline" && step.id !== pipeline.work_item_source?.step_id && !reconcilable(step),
  );
}

/** Why reconcile mode refuses `steps`, and the two ways out. */
export function withoutDeliverableMessage(steps: readonly PipelineStep[]): string {
  const names = steps.map((step) => `"${step.id}"`).join(", ");
  const subject = steps.length === 1 ? `step ${names} declares` : `steps ${names} declare`;
  return (
    `reconcile mode requires every step to declare what it delivers; ${subject} neither output nor rerunOnResume. ` +
    `Declare the artifact a step produces, or a receipt of its side effect, as output; ` +
    `or set rerunOnResume: true if replaying it on every invocation is idempotent.`
  );
}

/** Resolve templated values that accept an `async` function. A sync function
 *  remains valid: `await` passes through a non-thenable value. */
export async function resolveTemplateAsync<TCtx, TValue = string>(
  value: AsyncTemplated<TCtx, TValue> | undefined,
  ctx: TCtx,
): Promise<TValue | undefined> {
  if (value == null) return undefined;
  return typeof value === "function" ? await (value as (c: TCtx) => TValue | Promise<TValue>)(ctx) : value;
}
