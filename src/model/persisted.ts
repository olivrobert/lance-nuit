/** Persisted run schema: the durable shapes written to disk (snapshot, journal).
 *  The snapshot is the source of truth for resuming. The authoring model lives in
 *  `model/definition.ts`, the in-memory shapes in `model/run.ts`. */
import type { AgentSession, StepControl, StepFailCause, StepFailKind, StepUsage } from "../contracts/backends.js";
import type { PipelineLot } from "./context.js";
import type { StepProfileName } from "./profiles.js";

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped" | "aborted";

/** Durable run status. The snapshot is the source of truth for resuming; stats
 * reuse these exact uppercase values so persisted stats stay comparable. */
export type RunStatus = "RUNNING" | "PASS" | "FAIL" | "STOPPED" | "ABORTED" | "UNKNOWN";

/** Expected recovery for a clean stop, in the reader's vocabulary. The first three
 *  mirror the review kinds a `humanReview` gate declares; `blocked` is the step
 *  fail cause of the same name — an obstacle outside the code. */
export type RunStopKind = "needs-info" | "needs-decision" | "needs-human" | "blocked";

/**
 * Why a capped run was stopped by its own cost policy, as a value instead of a
 * sentence.
 *
 * `budget-exceeded` — the ledger reached `max_cost_usd`, or a live guard killed
 * an attempt for crossing what was left of it. `cost-unaccounted` — an attempt
 * spent tokens no pricing table could price, so the ceiling stopped being
 * enforceable and a gate withheld the next unit of work.
 *
 * Deliberately NOT a `StepFailKind`: that kind drives retry and repair policy at
 * step level, and a cost stop is a run-level decision no fix pass can repair. A
 * post-mortem reading a snapshot or a `run.finished` event tells the two stops
 * from a technical failure without parsing `outcome.reason`, which is what the
 * console prints and not a contract.
 */
export type RunOutcomeStopKind = "budget-exceeded" | "cost-unaccounted";

/** Structured cause of a clean stop, so a reader does not have to parse the
 *  console sentence stored in `stopped_reason`. */
export interface RunStopState {
  /** Approval subject that lifts the stop, when the gate declares one. */
  subject?: string;
  kind?: RunStopKind;
  /** Reason without the console decoration (`escalated:` prefix, `--approve` hint). */
  detail: string;
}

/** Homogeneous issue exposed for PASS, FAIL, STOPPED, and ABORTED.
 * `logPath` is always relative to the run directory when a step is involved. */
export interface RunOutcomeState {
  phase: string | null;
  reason: string | null;
  logPath: string | null;
  resumable: boolean;
  /** Failure kind of the offending step. Absent for PASS and snapshots written
   *  before this field was introduced. */
  failKind?: StepFailKind;
  /** Fail cause of the offending step, when repairing it is pointless. Absent
   *  for PASS, for every failure a fix pass could still resolve, and for
   *  snapshots written before this field was introduced. */
  failCause?: StepFailCause;
  /** When this outcome was finalized (ISO 8601). A resumed run rewrites the
   *  outcome, so this timestamp tells a stale snapshot from a current one.
   *  Absent for snapshots written before this field was introduced. */
  at?: string;
  /** Structured cause of a STOPPED run. Absent for other statuses, for stops
   *  raised by an admission that declares nothing, and for snapshots written
   *  before this field was introduced — read `reason` in that case. */
  stop?: RunStopState;
  /** Cost policy that ended the run, when one did. Absent for every other
   *  outcome — including a run whose total is a lower bound but which stopped for
   *  its own reason — and for snapshots written before this field was
   *  introduced. `reason` carries the sentence; this carries the fact. */
  stopKind?: RunOutcomeStopKind;
}

/** Canonical pair forming a composition call stack. */
export interface PipelineLineageEntry {
  pipelinePath: string;
  ticket?: string;
}

/** Persisted reference to a run launched by an orchestration node. */
/** The parent's progress record for one composed child call. Its status,
 *  `runId` and `outcome` move through `state/child-transitions.ts` only; the
 *  `accounted*` figures through `chargeChildReconciliation`
 *  (`state/cost-accounting.ts`) only. */
export interface PersistedPipelineChildRef {
  key: string;
  kind: "main" | "afterEach" | "afterAll";
  pipeline: string;
  ticket?: string;
  lot?: PipelineLot;
  runId?: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  /** Child cost already added to the parent node's total. */
  accountedCostUsd: number;
  /** Auxiliary aggregates used to reconcile statistics without duplication. */
  accountedDurationMs?: number;
  /** Child tokens already merged into the parent node, so a resumed child does not
   *  re-donate the tokens of its first pass. */
  accountedUsage?: StepUsage;
  outcome?: RunOutcomeState;
}

/** Durable resume state for a runPipeline/forEachPipeline node. */
export interface PersistedPipelineOrchestrationState {
  kind: "runPipeline" | "forEachPipeline";
  /** List frozen on the first loop pass; resuming does not scan again. */
  items?: string[];
  children: PersistedPipelineChildRef[];
}

/** Durable fact corresponding to a step or fix attempt. Step aggregates remain
 * useful for budgets; this list preserves session, cost, and log-file detail
 * without inventing attempts overwritten by older formats. */
export interface PersistedAttempt {
  attempt: number;
  kind: "step" | "fix";
  status: "running" | "done" | "failed" | "aborted";
  started_at: string;
  finished_at?: string;
  /** Provider-aware session reference. */
  session?: AgentSession;
  log_path: string;
  control?: StepControl;
  usage?: StepUsage;
  errors?: string;
}

/** Persisted step state. The definition (command, on_failure, ...) is reloaded
 * from pipeline.ts. */
export interface PersistedStepState {
  id: string;
  status: StepStatus;
  retries: number;
  started_at?: string;
  finished_at?: string;
  /** Backend session, without conflating providers that use the same id. */
  session?: AgentSession;
  profile?: StepProfileName;
  /** Control state required for resume (budget, model, context). */
  control?: StepControl;
  /** Usage reporting, also persisted for run stats after resuming. */
  usage?: StepUsage;
  /** Readable failure reason (verdict.reason, missing verdict, exit code, kill),
   *  persisted on `failed` steps for direct inclusion in run stats. */
  errors?: string;
  /** Failure kind of the latest step attempt (judgment vs incident). */
  fail_kind?: StepFailKind;
  /** Fail cause of the latest step attempt, when no fix pass can change the
   *  answer. Same life cycle as `fail_kind`: written on failure, cleared on
   *  success and by the next attempt. Optional and additive, so the schema is
   *  unchanged and a snapshot written without it reads as "no such cause". */
  fail_cause?: StepFailCause;
  /** Reruns consumed while draining timeouts. Quota SEPARATE from `retries`:
   *  a drain that exhausted `retries` would deprive the step of every fix pass. */
  timeout_retries?: number;
  /** Highest attempt number allocated. Kept in the snapshot so a missing journal
   * event can never make a resume reuse an existing attempt log. */
  last_attempt?: number;
  /** Origin of a `skipped` status: the CLI selection (`--step`, `--skip`,
   * `--start-at`) took the step out of the run. A step skipped by its own
   * admission carries no such flag, which is what lets a resume re-admit it while
   * leaving an operator exclusion alone. Absent by default; the schema is unchanged. */
  excluded?: true;
  orchestration?: PersistedPipelineOrchestrationState;
}

/** Persisted run snapshot. References the pipeline by path for reloading. */
export interface PersistedRun {
  schemaVersion?: 1;
  runId?: string;
  name: string;
  ticket?: string;
  pipeline: string;
  /** Project-relative path; absolute paths are no longer persisted. */
  pipeline_path?: string;
  createdAt?: string;
  updatedAt?: string;
  status?: RunStatus;
  outcome?: RunOutcomeState;
  max_cost_usd?: number;
  /** Composition identity: absent from older top-level runs. */
  parentRunId?: string;
  parentNodeId?: string;
  rootRunId?: string;
  budgetScopeId?: string;
  /** Current batch of a feature sub-run; absent from runs written before batches existed. */
  lot?: PipelineLot;
  /** Canonical stack of composed pipelines, including root and current run. */
  pipelineLineage?: PipelineLineageEntry[];
  steps: PersistedStepState[];
  total_control?: StepControl;
  total_usage?: StepUsage;
  /** true when the run was manually stopped by the app (disables automatic resume). */
  aborted?: boolean;
  /** Reason for a clean stop caused by a stop admission. Absent for normal runs. */
  stopped_reason?: string;
  /** true when the run executed inside a worktree. Absent from snapshots written
   *  before this field existed; read it as `false`. */
  worktree?: boolean;
  /** Effective working directory of the run, after any worktree `chdir`. It is
   *  where the run reads its artifacts and writes its decisions. Absent from
   *  snapshots written before this field existed; fall back to the main clone. */
  cwd?: string;
  /** A live cost guard killed an attempt for crossing the ceiling. The ledger may
   *  still sit under `max_cost_usd` (the guard fires on an estimate the provider's
   *  final figure can undercut), so a resume must not read the ceiling as free room
   *  and replay the killed step. Cleared only by an explicit `--budget`. */
  budget_exceeded?: boolean;
  /** A human approved more spend with `--budget` on a resume. Child runs then
   *  answer to the parent's remaining budget alone: the ceiling a child pipeline
   *  declares for itself no longer blocks the resume the message told the user
   *  to make. */
  budget_approved?: boolean;
  /** Latched run-level uncertainty: at least one attempt of this run — or of a
   *  composed child folded into it — spent tokens no pricing table could price.
   *  It is a projection of the reconciled attempts made durable, not a counter:
   *  nothing clears it, because nothing can retroactively price a closed attempt.
   *  A capped run carrying it stops with `cost-unaccounted` unless
   *  `allow_unmetered` authorizes the unknown portion. Absent from snapshots
   *  written before this field existed — the ledger then reads the same fact from
   *  the attempts' own `cost_unknown`, so such a snapshot still stops. */
  cost_unaccounted?: boolean;
  /** A human authorized spending nobody can price with `--allow-unmetered`. It
   *  lifts the `cost-unaccounted` stop only: the known lower bound still obeys
   *  `max_cost_usd`, and no unknown marker is cleared. Durable, so later resumes
   *  need no flag, and propagated to the children launched in this run's budget
   *  scope. Absent means strict — a missing authorization is never permissive. */
  allow_unmetered?: boolean;
  specPath?: string;
}
