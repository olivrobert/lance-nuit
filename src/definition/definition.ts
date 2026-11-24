/** Authoring model of a pipeline: what a pipeline author writes (steps, failure
 *  policy, orchestration) and the context their functions receive. Persisted and
 *  runtime shapes live in `run/persisted.ts` and `run/run.ts`. */
import type { BackendSpec, EffortLevel, JsonSchema } from "../contracts/backends.js";
import { VERDICT_FIELD_NAMES } from "../contracts/verdict.js";
import type { WorkQueue } from "../contracts/work-items.js";
import { type Artifact, isSource, type Source, type StepInput } from "../work-items/index.js";
import type {
  AsyncTemplated,
  FixContext,
  PipelineContext,
  PipelineLot,
  StepAction,
} from "../shared/language/context.js";
import type { InputPredicate, StepInputCondition } from "./input.js";
import type { StepProfileName } from "../shared/language/profiles.js";

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
   *  replaying its command. Only on a non-blocking step with a single repair and
   *  no output: nothing would vouch for outputs the repair rewrote. */
  replay_after_fix?: boolean;
  /** Opt-in: a successful repair that changed neither the git tree nor `HEAD`
   *  stops the step as blocked instead of replaying its command. Requires
   *  `fix_prompt`; refused with `replay_after_fix: false`. */
  stop_if_unchanged?: boolean;
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

/** Review of an agent step's outputs, run once its produce phase succeeded: a
 *  fresh session judges them, then at most one fix in the producing session.
 *  Built by `llmStep({ review })`. */
export interface StepReview {
  command: AsyncTemplated<PipelineContext>;
  /** Backend of the review session, never resumed. */
  backend: BackendSpec;
  profile: StepProfileName;
  /** The review's verdict field, persisted as an artifact; it is also in the
   *  step's `outputs`. */
  capture: StepCapture;
  /** Prompt sent to the producing session, or `undefined`: no fix. */
  fix: (review: unknown, ctx: PipelineContext) => string | undefined | Promise<string | undefined>;
  /** Role of the fix pass on the step's backend; absent: the step's profile. */
  fix_profile?: StepProfileName;
  /** Plain reruns of a failed review attempt. */
  retries: number;
}

/** Steps declared together by `parallelize`. */
export interface ParallelGroup {
  id: string;
  name: string;
}

export interface PipelineStep {
  id: string;
  name: string;
  command: AsyncTemplated<PipelineContext>;
  /** Step execution mode. The provider lives in `backend`: these are distinct
   *  axes, and one agent mode can serve every provider. */
  runner?: "agent" | "bash" | "fn" | "pipeline";
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
  /** Artifacts a successful pass must produce; erased before every `step`
   *  attempt. Includes the captures and the review capture. */
  outputs?: Artifact<unknown>[];
  /** Fields of the agent's structured output the runner writes as artifacts,
   *  before `outputs` are verified. Each captured artifact is also in `outputs`.
   *  Agent steps only. */
  captures?: StepCapture[];
  /** Artifacts and external sources this step reads, declared through `input`.
   *  `inputs` above is already taken by admission conditions, hence the
   *  distinct name. */
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
  /** `stop`: a stamped step whose inputs changed since it succeeded stops the run
   *  for a decision instead of running again. */
  on_stale?: "stop";
  /** Approval subjects this step reworks when a human rejects them. On resume the
   *  step replays while one of them has a pending rejection, whatever its input
   *  freshness says: a rejection is not an input, it is the reason to run. */
  rework_for?: string[];
  /** Group this step runs in, side by side with the other steps carrying it. Kept on
   *  the definition only: the run stays a flat list, and a snapshot does not change. */
  parallel_group?: ParallelGroup;
  /** Agent steps only. */
  review?: StepReview;
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
 * How a resume classifies a step (decisions D2 and D3), owned here so the
 * build, the validation, the admission and the loop share one answer.
 *
 * An orchestration node and the work-item source step (`sourceStepId`, the
 * pipeline's `work_item_source.step_id`) are out of scope whatever they declare:
 * they keep the authority of their status, so neither outputs nor
 * `rerun_on_resume` make a resume re-admit them.
 */
type ClassifiedStep = Pick<PipelineStep, "id" | "runner" | "outputs" | "sources" | "rerun_on_resume">;

function declaresIo(step: ClassifiedStep): boolean {
  return (step.sources?.length ?? 0) > 0 || (step.outputs?.length ?? 0) > 0;
}

function keepsStatusAuthority(step: ClassifiedStep, sourceStepId: string | undefined): boolean {
  return step.runner === "pipeline" || step.id === sourceStepId;
}

/** Whether the author's `rerun_on_resume` replays this settled step on resume. */
export function rerunsOnResume(step: ClassifiedStep): boolean {
  return step.rerun_on_resume === true && step.runner !== "pipeline";
}

/** A step the freshness lock decides: it declares what it reads or delivers, and
 *  neither replays on every invocation nor keeps the authority of its status. */
export function isStamped(step: ClassifiedStep, sourceStepId: string | undefined): boolean {
  return !keepsStatusAuthority(step, sourceStepId) && step.rerun_on_resume !== true && declaresIo(step);
}

/** A settled step a resume admits again: its stamp decides, or it vouches for
 *  its replay. */
export function readmittedOnResume(step: ClassifiedStep, sourceStepId: string | undefined): boolean {
  if (keepsStatusAuthority(step, sourceStepId)) return false;
  return declaresIo(step) || rerunsOnResume(step);
}

/**
 * Steps a resume has nothing to decide on. A settled step runs again unless its
 * declarations prove its work done, so a step declaring none would repeat its
 * side effects on every invocation: it must declare what it reads or delivers,
 * or declare itself safe to replay. Composed pipelines keep the authority of
 * their status, and the work-item source step belongs to the runner, so neither
 * is the author's to classify.
 */
export function stepsWithoutDeliverable(pipeline: Pick<Pipeline, "steps" | "work_item_source">): PipelineStep[] {
  const sourceStepId = pipeline.work_item_source?.step_id;
  return pipeline.steps.filter(
    (step) => !keepsStatusAuthority(step, sourceStepId) && !readmittedOnResume(step, sourceStepId),
  );
}

/** Why the build refuses `steps`, and the two ways out. */
export function withoutDeliverableMessage(steps: readonly PipelineStep[]): string {
  const names = steps.map((step) => `"${step.id}"`).join(", ");
  const subject = steps.length === 1 ? `step ${names} declares` : `steps ${names} declare`;
  return (
    `every step must declare what it reads or delivers; ${subject} neither input, output nor rerunOnResume. ` +
    `Declare the artifact a step produces, or a receipt of its side effect, as output; ` +
    `or set rerunOnResume: true if replaying it on every invocation is idempotent.`
  );
}

/** Why a step's `review` is declared wrong, or `undefined`. Shared with the
 *  structure validator, which sees raw definitions. */
export function reviewDeclarationError(step: PipelineStep): string | undefined {
  const review = step.review;
  if (!review) return undefined;
  if (step.runner !== "agent") return "review applies only to an agent step (llmStep)";
  // An absorbed failure would settle a step whose review never ran.
  if (step.blocking === false) return "review cannot be combined with blocking: false";
  const field = review.capture?.field;
  if ((VERDICT_FIELD_NAMES as readonly string[]).includes(field)) {
    return `review capture "${field}" is reserved by the verdict contract (${VERDICT_FIELD_NAMES.join(", ")})`;
  }
  return undefined;
}

/**
 * Why the stamps of a pipeline could not vouch for its artifacts: each artifact
 * has one producer, and no step reads what it writes. Two producers would make
 * each other stale in turn, and a step reading its own output would never be
 * fresh. Checked within one pipeline only.
 */
export function producerConflicts(pipeline: Pick<Pipeline, "steps">): string[] {
  const errors: string[] = [];
  const producers = new Map<string, string>();
  // The structure validator hands raw definitions over: a malformed entry is a
  // finding, not a crash.
  const named = <T extends { name: string }>(entries: readonly T[] | undefined, what: string, id: string): T[] => {
    if (entries === undefined) return [];
    const list = Array.isArray(entries) ? entries : [];
    const valid = list.filter((entry) => typeof entry?.name === "string");
    if (!Array.isArray(entries) || valid.length < list.length) errors.push(`step "${id}": every ${what} must be named`);
    return valid;
  };
  for (const step of pipeline.steps) {
    const written = new Set<string>();
    for (const output of named(step.outputs, "output", step.id)) {
      written.add(output.name);
      const first = producers.get(output.name);
      if (first === undefined) producers.set(output.name, step.id);
      else if (first !== step.id) {
        errors.push(
          `artifact "${output.name}" is an output of both "${first}" and "${step.id}": one producer per artifact`,
        );
      }
    }
    for (const input of named(step.sources, "input", step.id)) {
      if (!isSource(input) && written.has(input.name)) {
        errors.push(`step "${step.id}": artifact "${input.name}" is both its input and its output`);
      }
    }
  }
  return errors;
}

/** Why a step's `on_stale` is declared wrong, or `undefined`: only a stamp can be
 *  stale. Shared with the structure validator, which sees raw definitions. */
export function onStaleDeclarationError(step: PipelineStep): string | undefined {
  if (step.on_stale === undefined) return undefined;
  if (step.on_stale !== "stop") return 'on_stale must be "stop"';
  if (step.runner === "pipeline" || step.rerun_on_resume === true || !declaresIo(step)) {
    return "onStale applies only to a step that declares input or output, without rerunOnResume";
  }
  return undefined;
}

/** A consumer's source that does not count the changes of the step it is listed under. */
export interface IgnoredBy {
  consumer: string;
  source: Source;
}

function ignoringSources(step: Pick<PipelineStep, "sources">): Source[] {
  const sources = Array.isArray(step.sources) ? step.sources : [];
  return sources.filter((input): input is Source => isSource(input) && (input.ignoredSteps?.length ?? 0) > 0);
}

/** For each step, the consumers whose source moves when it settles `done`. */
export function ignoredSourcesByStep(steps: readonly Pick<PipelineStep, "id" | "sources">[]): Map<string, IgnoredBy[]> {
  const byStep = new Map<string, IgnoredBy[]>();
  for (const consumer of steps) {
    for (const source of ignoringSources(consumer)) {
      for (const stepId of source.ignoredSteps ?? []) {
        byStep.set(stepId, [...(byStep.get(stepId) ?? []), { consumer: consumer.id, source }]);
      }
    }
  }
  return byStep;
}

/** Why the `ignoring` of a pipeline's sources names no step it could follow. */
export function ignoringErrors(pipeline: Pick<Pipeline, "steps">): string[] {
  const ids = new Set(pipeline.steps.map((step) => step.id));
  const errors: string[] = [];
  for (const consumer of pipeline.steps) {
    for (const source of ignoringSources(consumer)) {
      for (const stepId of source.ignoredSteps ?? []) {
        if (stepId === consumer.id) {
          errors.push(`step "${consumer.id}": source "${source.name}" cannot ignore the step that reads it`);
        } else if (!ids.has(stepId)) {
          errors.push(
            `step "${consumer.id}": source "${source.name}" ignores "${stepId}", which is not a step of the pipeline`,
          );
        }
      }
    }
  }
  return errors;
}
