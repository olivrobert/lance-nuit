// runner/step/pipeline-orchestration-child.ts
//
// The cycle of ONE composed child, in order: gate, resolution, identity, boot,
// start fact, execution, reconciliation, settlement, report. This module orders
// the steps and owns nothing else: the stop decision and its record belong to
// `state/budget.ts` and `state/cost-stop-events.ts`, the child's spend to
// `chargeChildReconciliation` (`state/cost-accounting.ts`), the child run's
// verdict to `finalizeRun` (`state/run-transitions.ts`), and the persisted child
// reference to `state/child-transitions.ts`.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadOrCreateRun } from "../boot/resume.js";
import { errorMessage } from "../lib/errors.js";
import type { PipelineContext, PipelineLot } from "../model/context.js";
import type { PipelineInvocationDefinition } from "../model/definition.js";
import type { PersistedPipelineChildRef } from "../model/persisted.js";
import type { Run } from "../model/run.js";
import { loadPipelineDefinition } from "../pipeline/loader.js";
import { costDecision, isBudgetExceeded, remainingBudget, type RunBudget } from "../state/budget.js";
import {
  bindChildRun,
  completedSuccessfully,
  failChildLaunch,
  hasJournaledChildStart,
  isChildSettled,
  recordChildStarted,
  settleChild,
} from "../state/child-transitions.js";
import { chargeChildReconciliation, measuredRunCost } from "../state/cost-accounting.js";
import { recordCostStop } from "../state/cost-stop-events.js";
import { pendingSteps } from "../state/run-predicates.js";
import { hasRunSnapshotEntry } from "../state/run-snapshot.js";
import { finalizeRun } from "../state/run-transitions.js";
import { emitRunStats } from "../state/stats/run-stats.js";
import { FileRunStateStore } from "../state/stores/file-run-state-store.js";
import { createRunId, pipelineRunsDir } from "../state/stores/run-storage.js";
import type { ChildExecutionResult, PipelineOrchestrationInput } from "./pipeline-orchestration-types.js";
import {
  childContext,
  lineageForChild,
  resolvePipelinePath,
  resolveTicket,
} from "./pipeline-orchestration-resolution.js";

function effectiveMaxCost(
  parentRemaining: number | undefined,
  ownMax: number | undefined,
  alreadyAccounted: number,
): number | undefined {
  // For a new child, alreadyAccounted is zero and this is exactly
  // min(parent remaining, child ceiling). On resume, previously charged cost is
  // restored into the total ceiling: the parent pays only the difference and the
  // child is not truncated by the newly computed remainder.
  const parentCeiling = parentRemaining === undefined ? undefined : parentRemaining + alreadyAccounted;
  if (parentCeiling === undefined) return ownMax;
  if (ownMax === undefined) return parentCeiling;
  return Math.min(parentCeiling, ownMax);
}

function allocateChildRunId(pipeline: string, ticket: string | undefined, ctx: PipelineContext): string {
  const dir = pipelineRunsDir(pipeline, ticket, ctx);
  mkdirSync(dir, { recursive: true });
  const base = createRunId(pipeline);
  let id = base;
  let suffix = 1;
  while (existsSync(join(dir, id))) id = `${base}-${suffix++}`;
  return id;
}

/**
 * The one gate every composed launch passes through: a child of a `runPipeline`
 * or `forEachPipeline` node, and every `afterEach`/`afterAll` callback.
 *
 * Returns the refusal to report, or `undefined` when the launch may proceed. The
 * accounting refusal names itself: the parent must not read it as a budget stop
 * (raising the amount changes nothing) nor as a technical failure of the item it
 * was about to run. Nothing is written to the child reference, so the remaining
 * items stay `pending` and the fan-out resumes where it stopped.
 */
export function childLaunchGate(
  parent: Run,
  budget: RunBudget,
  key: string,
  stepId: string | null = null,
): ChildExecutionResult | undefined {
  const decision = costDecision(parent.max_cost_usd, budget);
  if (decision === "continue") return undefined;
  // The refused launch is recorded on the PARENT: the child it would have run has
  // no journal of its own, and the stop belongs to the scope that owns the ceiling.
  recordCostStop(parent, budget, decision, { kind: "gate", stepId });
  if (decision === "exceeded") {
    return { ok: false, budgetExceeded: true, reason: `parent budget exhausted before ${key}` };
  }
  return {
    ok: false,
    costUnaccounted: true,
    costUnaccountedStop: true,
    reason: `parent spending unaccounted before ${key}`,
  };
}

/** What the step loop reports about a child it ran, or nothing when the child
 *  was already terminal and only had to be settled. */
interface ChildLoopOutcome {
  failed: boolean;
  stopped: boolean;
  budgetExceeded: boolean;
  costUnaccounted: boolean;
  costUnaccountedStop: boolean;
  cumulativeCost: number;
}

/** Execute or resume one persisted child reference and reconcile its usage. */
export async function executeChild(
  input: PipelineOrchestrationInput,
  ref: PersistedPipelineChildRef,
  invocation: PipelineInvocationDefinition,
  defaultTicket: string | undefined,
  defaultLot: PipelineLot | undefined,
): Promise<ChildExecutionResult> {
  const { run: parent, step, baseCtx, budget, abort } = input;
  if (abort.isRunAborted(parent)) return { ok: false, stopped: true };
  if (isChildSettled(ref)) return { ok: true };

  // 1. Gate. Every child launch reads the SAME stop decision as a step admission,
  //    and reads it BEFORE any of the child's own code is loaded. A remaining-
  //    budget test alone let a fan-out keep spawning children after one of them
  //    made the ceiling unenforceable: the ledger still showed room, because room
  //    is exactly what an unpriced attempt cannot disprove.
  const gate = childLaunchGate(parent, budget, `child ${ref.key}`, step.id);
  if (gate) return gate;

  // 2. Resolution: what to run, where, and under which ceiling.
  const ticket = ref.ticket ?? (await resolveTicket(invocation.ticket, baseCtx, defaultTicket));
  const lot = ref.lot ?? defaultLot;
  const childCtx = childContext(baseCtx, ticket, lot);
  const childPath = resolvePipelinePath(ref.pipeline, parent.pipeline_path, baseCtx);
  const pipelineLineage = lineageForChild(parent, childPath, ticket);
  const childDefinition = await loadPipelineDefinition(childPath, childCtx);
  const parentRemaining = remainingBudget(parent.max_cost_usd, budget.cumulative);
  // `--budget` on the parent is the human answer to the "rerun with --budget" the
  // child printed. Re-imposing the child's own cap here would make that answer
  // inert; the parent's remaining budget is the only ceiling left.
  const ownMax = parent.budget_approved
    ? undefined
    : (childDefinition.max_cost_usd ?? childDefinition.max_cost_per_work_item_usd);
  const maxCostUsd = effectiveMaxCost(parentRemaining, ownMax, ref.accountedCostUsd);

  // 3. Identity. The reference reuses its bound run id or receives a fresh one;
  //    whether that id was ever STARTED is a journal fact, read before the
  //    reference is (re)bound and persisted.
  const childRunId = ref.runId ?? allocateChildRunId(childDefinition.name, ticket, childCtx);
  const runDir = join(pipelineRunsDir(childDefinition.name, ticket, childCtx), childRunId);
  const snapshotPath = join(runDir, "state.json");
  const hadSnapshot = hasRunSnapshotEntry(snapshotPath);
  const childStarted = hasJournaledChildStart(parent, ref);
  bindChildRun(parent, ref, childRunId);

  // 4. Boot. A started identity, or one whose snapshot exists, must resume THAT
  //    snapshot: a missing or damaged one is refused instead of becoming a second
  //    child under the same id. A boot failure leaves the reference resumable.
  const stateStore = new FileRunStateStore({ context: childCtx, pipeline: childDefinition.name, ticket });
  let childRun: Run;
  try {
    childRun = await loadOrCreateRun(childPath, ticket, undefined, undefined, runDir, false, undefined, childCtx, {
      stateStore,
      maxCostUsd,
      budgetApproved: parent.budget_approved,
      // The authorization travels down the budget scope: authorizing the run that
      // owns the scope authorizes the work it composes, and a child never has to
      // be given the flag itself.
      allowUnmetered: parent.allow_unmetered,
      parentRunId: parent.runId,
      parentNodeId: step.id,
      rootRunId: parent.rootRunId ?? parent.runId,
      budgetScopeId: parent.budgetScopeId ?? parent.rootRunId ?? parent.runId,
      lot,
      pipelineLineage,
      strictSnapshot:
        childStarted || hadSnapshot
          ? {
              path: snapshotPath,
              releaseRunLock: false,
              expectedIdentity: { runId: childRunId, pipeline: childDefinition.name, ticket },
            }
          : undefined,
    });
  } catch (error) {
    const reason = errorMessage(error).trim();
    failChildLaunch(parent, ref, step.id, reason);
    return { ok: false, reason };
  }
  if (childRun.parentRunId !== parent.runId || childRun.parentNodeId !== step.id) {
    throw new Error(`Child run ${childRun.runId} is already linked to another orchestration node`);
  }

  // 5. Start fact: from here on the identity is spent.
  recordChildStarted(parent, step, childRun);

  // 6. Execution, unless the child is already terminal. A terminal child with
  //    only done/skipped steps must be reported as-is. The exception is a settled
  //    snapshot that never received a verdict — the window between the last step
  //    and finalizeRun — which `hydrate` deliberately loads as RUNNING precisely
  //    so this call finalizes it.
  let childOutcome: ChildLoopOutcome = {
    failed: false,
    stopped: false,
    budgetExceeded: false,
    costUnaccounted: false,
    costUnaccountedStop: false,
    cumulativeCost: measuredRunCost(childRun, 0),
  };
  const childNeedsExecution = childRun.status === "RUNNING" || pendingSteps(childRun).length > 0;
  if (!completedSuccessfully(childRun) && childNeedsExecution) {
    // Keep the recursive dependency out of the step-loop → orchestration →
    // step-loop load graph.
    const { executeRunSteps, stepLoopDeps } = await import("./step-loop.js");
    // The child runs under the parent's abort scope: a signal received by the
    // process stops its loops too, and the handler persists it as an active run.
    childOutcome = await executeRunSteps(
      childRun,
      ticket,
      input.baseBranch,
      { resuming: hadSnapshot, abort },
      stepLoopDeps(input.output),
      childCtx,
    );
    finalizeRun(childRun, childOutcome);
    emitRunStats(childRun, { context: childCtx });
  }

  // 7. Reconciliation, BEFORE settlement so a later orchestration exception cannot
  //    lose already-reconciled cost. Cost accounting owns the charge: the node
  //    total, the parent ledger, the reconciliation event and the accounting
  //    latch a resume reads back.
  const delta = chargeChildReconciliation({
    parent,
    step,
    ref,
    child: childRun,
    budget,
    fallbackCost: childOutcome.cumulativeCost,
  });

  // 8. Settlement of the reference from the child's own verdict.
  const success = settleChild(parent, ref, step, childRun, delta);
  if (success) return { ok: true };

  // 9. Report. The budget facts come from the child: the stop its loop reported
  //    this generation, the stop it latched in a previous one, or a ledger that
  //    reached its own ceiling as `state/budget.ts` defines it.
  return {
    ok: false,
    stopped: childRun.status === "STOPPED" || childRun.status === "ABORTED",
    budgetExceeded:
      childOutcome.budgetExceeded ||
      childRun.budget_exceeded === true ||
      isBudgetExceeded(childRun.max_cost_usd, ref.accountedCostUsd),
    ...(childOutcome.costUnaccounted ? { costUnaccounted: true } : {}),
    // A child that stopped AT ITS OWN GATE makes the accounting stop the
    // parent's stop reason too; a child that failed for its own reason with an
    // unknown ledger does not.
    ...(childOutcome.costUnaccountedStop ? { costUnaccountedStop: true } : {}),
    reason: childRun.outcome?.reason ?? `child pipeline ${childRun.pipeline} failed`,
    ...(childRun.outcome?.failKind ? { failKind: childRun.outcome.failKind } : {}),
    ...(childRun.outcome?.failCause ? { failCause: childRun.outcome.failCause } : {}),
  };
}
