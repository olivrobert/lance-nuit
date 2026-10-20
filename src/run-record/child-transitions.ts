// runner/run-record/child-transitions.ts
//
// The owner of the persisted child reference of a composed run: the record a
// `runPipeline` or `forEachPipeline` node keeps, in the PARENT snapshot, for
// every child call it drives (`PersistedPipelineChildRef`). Composition
// (`step/pipeline-orchestration*.ts`) orders the cycle of a child — gate, boot,
// execution, reconciliation, settlement — and calls the operations below; it
// never writes the reference itself.
//
// The contract between the reference and the child run:
//
// - The reference is the parent's PROGRESS record, not a copy of the child. It
//   says which call was decided, under which identity, and how it ended; the
//   child run keeps its own snapshot, journal, attempts and figures.
// - `runId` binds the reference to one child run directory. It is written before
//   the child boots, so a crash in the window can retry the initialization under
//   the same id. Once `pipeline.child.started` is in the parent journal, that id
//   has been used: a missing or damaged child snapshot is refused rather than
//   turned into a second child (`hasJournaledChildStart`).
// - `accountedCostUsd`, `accountedDurationMs` and `accountedUsage` belong to cost
//   accounting (`chargeChildReconciliation`, `run-record/cost-accounting.ts`): what
//   the parent already charged for this child, so a resumed child re-reporting
//   its history is charged by difference. This module never touches them.
// - `outcome` is the child's own outcome (or the reason a launch never
//   happened), carried as the parent step's answer.
//
// Statuses, and the one operation that writes each transition:
//
//   pending ──commitChildCall──▶ running ──bindChildRun──▶ running (runId bound)
//      │            │                                                 │
//      │            └──skipChild──▶ skipped                           ├──settleChild──▶ done | failed
//      │                                                              │
//      └──failChildLaunch──▶ failed ◀───────────────────failChildLaunch┘
//
// `done` and `skipped` are final: a resume never re-enters them. `pending`,
// `running` and `failed` are re-entered by the next generation, which reuses the
// bound `runId`. `declareChild` finds or creates the reference and refuses a
// definition that no longer matches the persisted call.
//
// Every operation writes its group of fields, the journal event that records the
// transition when there is one (`pipeline.child.started`,
// `pipeline.child.finished`), then the parent snapshot — event first, snapshot
// second, like the run transitions (`run-record/run-transitions.ts`).
//
// The node's own state, which holds those references, has two writes of its
// own: `openOrchestration` finds or creates it on the step (and records the
// run's lineage), and `freezeOrchestrationItems` fixes the items a
// `forEachPipeline` iterates.

import type { PipelineLot } from "../model/context.js";
import type {
  PersistedPipelineChildRef,
  PersistedPipelineOrchestrationState,
  PipelineLineageEntry,
} from "../model/persisted.js";
import type { ChildRefView, OrchestrationView, RunStepView, RunView } from "../model/run.js";
import { writable } from "./run.js";
import { appendRunEvent, readRunEvents } from "./run-journal.js";
import { isSettledStatus } from "./run-predicates.js";
import { saveRun } from "./run-repository.js";
import { isCompleted } from "./run-status.js";

/**
 * The state of an orchestration node, found on its step or created empty, and
 * persisted. A resumed node whose kind changed is refused: its children were
 * declared for another kind of call.
 *
 * The run's lineage is recorded in the same snapshot, once: a top-level run
 * gets its root entry here, a child run keeps the lineage it was booted with.
 * Its children check recursion and depth against it, and the run list reads
 * ancestry from it.
 */
export function openOrchestration(
  parentView: RunView,
  stepView: RunStepView,
  kind: PersistedPipelineOrchestrationState["kind"],
  lineage: readonly PipelineLineageEntry[],
): OrchestrationView {
  const parent = writable(parentView);
  const step = writable(stepView);
  if (!parent.pipelineLineage?.length) parent.pipelineLineage = [...lineage];
  const state = step.orchestration ?? { kind, children: [] };
  if (state.kind !== kind) throw new Error(`Step "${step.id}": orchestration type changed during resume`);
  step.orchestration = state;
  saveRun(parent);
  return state;
}

/**
 * Fix the items a `forEachPipeline` node iterates, and return the frozen list.
 * Persisted before the first child is declared: a resume walks the same list by
 * index, even when the template that produced it would now answer differently.
 */
export function freezeOrchestrationItems(
  parentView: RunView,
  stateView: OrchestrationView,
  items: readonly string[],
): readonly string[] {
  const parent = writable(parentView);
  const state = writable(stateView);
  const frozen = [...items];
  state.items = frozen;
  saveRun(parent);
  return frozen;
}

/** The call a node wants to make, as the definition currently describes it. */
export interface ChildCall {
  key: string;
  kind: PersistedPipelineChildRef["kind"];
  pipeline: string;
  ticket: string | undefined;
  lot?: PipelineLot;
}

/**
 * Find the reference of a call, or create it `pending` and persist it. A
 * persisted reference whose pipeline, ticket or lot differs from the call is a
 * definition that changed under a resumed run: refused, the node cannot know
 * which child it is continuing.
 */
export function declareChild(parentView: RunView, stateView: OrchestrationView, call: ChildCall): ChildRefView {
  const parent = writable(parentView);
  const state = writable(stateView);
  const existing = state.children.find((candidate) => candidate.key === call.key);
  if (existing) {
    if (
      existing.pipeline !== call.pipeline ||
      existing.ticket !== call.ticket ||
      JSON.stringify(existing.lot) !== JSON.stringify(call.lot)
    ) {
      throw new Error(`Pipeline composition: child "${call.key}" is incompatible with the persisted definition`);
    }
    return existing;
  }
  const created: PersistedPipelineChildRef = {
    key: call.key,
    kind: call.kind,
    pipeline: call.pipeline,
    ...(call.ticket !== undefined ? { ticket: call.ticket } : {}),
    ...(call.lot !== undefined ? { lot: call.lot } : {}),
    status: "pending",
    accountedCostUsd: 0,
  };
  state.children.push(created);
  saveRun(parent);
  return created;
}

/** A reference the next generation must not touch again. */
export function isChildSettled(ref: ChildRefView): boolean {
  return isSettledStatus(ref.status);
}

/**
 * The decision to call is durable before the child pipeline is loaded: an
 * interruption after this point resumes the `running` child instead of
 * re-evaluating a predicate that may have since become false.
 */
export function commitChildCall(parentView: RunView, refView: ChildRefView): void {
  const parent = writable(parentView);
  const ref = writable(refView);
  refuseSettled(ref, "commit");
  ref.status = "running";
  saveRun(parent);
}

/**
 * Bind the reference to the child run it will drive. Persisted BEFORE the child
 * boots, so a crash in between leaves a reference with a `runId` and no start
 * event, which the next generation retries under the same id. A reference
 * already bound keeps its id: the caller derived `runId` from it.
 */
export function bindChildRun(parentView: RunView, refView: ChildRefView, runId: string): void {
  const parent = writable(parentView);
  const ref = writable(refView);
  refuseSettled(ref, "bind");
  if (ref.runId !== undefined && ref.runId !== runId) {
    throw new Error(`Pipeline composition: child "${ref.key}" is bound to run ${ref.runId}, not ${runId}`);
  }
  ref.runId = runId;
  ref.status = "running";
  saveRun(parent);
}

/**
 * Whether the parent journal proves that a child under this identity started.
 * The bound `runId` alone allows a retry of the initialization; this fact
 * forbids it. An unreadable journal throws rather than reading as "never
 * started": the read is strict for exactly this question.
 */
export function hasJournaledChildStart(parent: RunView, ref: ChildRefView): boolean {
  if (ref.runId === undefined) return false;
  const runId = ref.runId;
  return readRunEvents(parent).some((event) => event.type === "pipeline.child.started" && event.childRunId === runId);
}

/** Journal that the child run booted under its identity. Event only: the
 *  reference already carries the id, and the snapshot follows at settlement. */
export function recordChildStarted(parent: RunView, step: RunStepView, child: RunView): void {
  appendRunEvent(parent, "pipeline.child.started", {
    parentNodeId: step.id,
    childRunId: child.runId ?? null,
    childPipeline: child.pipeline,
    childTicket: child.ticket ?? null,
    rootRunId: child.rootRunId ?? null,
    budgetScopeId: child.budgetScopeId ?? null,
    maxCostUsd: child.max_cost_usd ?? null,
  });
}

/** A call the node decided NOT to make, durably: resume must not reinterpret it. */
export function skipChild(parentView: RunView, refView: ChildRefView, phase: string, reason: string): void {
  const parent = writable(parentView);
  const ref = writable(refView);
  refuseSettled(ref, "skip");
  ref.status = "skipped";
  ref.outcome = { phase, reason, logPath: null, resumable: false };
  saveRun(parent);
}

/**
 * The child never ran this generation: its predicate threw, or its run could not
 * be booted. Resumable, since nothing of the child was consumed; a bound `runId`
 * is kept so the retry keeps the same identity.
 */
export function failChildLaunch(parentView: RunView, refView: ChildRefView, phase: string, reason: string): void {
  const parent = writable(parentView);
  const ref = writable(refView);
  refuseSettled(ref, "fail");
  ref.status = "failed";
  ref.outcome = { phase, reason, logPath: null, resumable: true };
  saveRun(parent);
}

/** What `done` means for a child run: a PASS the interruption did not settle. */
export function completedSuccessfully(child: RunView): boolean {
  return isCompleted(child.status) && !child.aborted;
}

/**
 * Settle the reference from the child run's own verdict, after cost accounting
 * has posted the child's spend (`chargeChildReconciliation`; `delta` is what it
 * charged). Journals `pipeline.child.finished`, then writes the parent snapshot.
 *
 * A crash between the two leaves a finished child the snapshot still calls
 * `running`: the next generation re-enters the child, finds it terminal, is
 * charged a zero delta and settles it again, so the journal carries a second
 * finish and readers take the last one.
 *
 * Returns whether the child completed successfully.
 */
export function settleChild(
  parentView: RunView,
  refView: ChildRefView,
  step: RunStepView,
  child: RunView,
  delta: number,
): boolean {
  const parent = writable(parentView);
  const ref = writable(refView);
  refuseSettled(ref, "settle");
  const success = completedSuccessfully(child);
  ref.status = success ? "done" : "failed";
  ref.outcome = child.outcome;
  appendRunEvent(parent, "pipeline.child.finished", {
    parentNodeId: step.id,
    childRunId: child.runId ?? null,
    childKey: ref.key,
    status: ref.status,
    accountedCostUsd: ref.accountedCostUsd,
    deltaCostUsd: delta,
    outcome: ref.outcome ?? null,
  });
  saveRun(parent);
  return success;
}

function refuseSettled(ref: PersistedPipelineChildRef, operation: string): void {
  if (isChildSettled(ref)) {
    throw new Error(`Pipeline composition: cannot ${operation} child "${ref.key}", already ${ref.status}`);
  }
}
