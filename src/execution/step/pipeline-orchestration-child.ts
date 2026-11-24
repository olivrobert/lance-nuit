//
// The cycle of ONE composed child, in order: gate, resolution, identity, boot,
// start fact, execution, reconciliation, settlement, report. This module orders
// the steps and owns nothing else: the stop decision and its record belong to
// `costGate` (`run/record/cost-stop-events.ts`), the child's spend to
// `chargeChildReconciliation` (`run/record/cost-accounting.ts`), the child run's
// verdict to `finalizeRun` (`run/record/run-transitions.ts`), and the persisted child
// reference to `run/record/child-transitions.ts`.

import { loadOrCreateRun } from "./load-or-create-run.js";
import { errorMessage } from "../../shared/lib/errors.js";
import type { PipelineLot } from "../../shared/language/context.js";
import type { PipelineInvocationDefinition } from "../../definition/index.js";
import type { ChildRefView, RunView } from "../../run/index.js";
import { loadPipelineDefinition } from "../../definition/index.js";
import {
  bindChildRunDir,
  chargeChildReconciliation,
  childCostCeiling,
  completedSuccessfully,
  costGate,
  failChildLaunch,
  FileRunStateStore,
  finalizeRun,
  isBudgetExceeded,
  isChildSettled,
  isHalted,
  recordChildStarted,
  remainingWork,
  type RunBudget,
  type RunOutcome,
  settleChild,
  emitRunStats,
} from "../../run/index.js";
import { DONE, failed, NO_COST_STOPS, type StepIssue, stopped } from "./step-issue.js";
import type { PipelineOrchestrationInput } from "./pipeline-orchestration-types.js";
import {
  childContext,
  lineageForChild,
  resolvePipelinePath,
  resolveTicket,
} from "./pipeline-orchestration-resolution.js";

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
  parent: RunView,
  budget: RunBudget,
  key: string,
  stepId: string | null = null,
): StepIssue | undefined {
  // The refused launch is recorded on the PARENT: the child it would have run has
  // no journal of its own, and the stop belongs to the scope that owns the ceiling.
  const stop = costGate(parent, budget, stepId);
  if (!stop) return undefined;
  if (stop === "budget-exceeded") {
    return failed({
      cost: { ...NO_COST_STOPS, budgetExceeded: true },
      reason: `parent budget exhausted before ${key}`,
    });
  }
  return failed({
    cost: { ...NO_COST_STOPS, costUnaccounted: true, costUnaccountedStop: true },
    reason: `parent spending unaccounted before ${key}`,
  });
}

/** Execute or resume one persisted child reference and reconcile its usage. */
export async function executeChild(
  input: PipelineOrchestrationInput,
  ref: ChildRefView,
  invocation: PipelineInvocationDefinition,
  defaultTicket: string | undefined,
  defaultLot: PipelineLot | undefined,
): Promise<StepIssue> {
  const { run: parent, step, baseCtx, budget, abort } = input;
  if (abort.isRunAborted(parent)) return stopped();
  if (isChildSettled(ref)) return DONE;

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
  // `--budget` on the parent is the human answer to the "rerun with --budget" the
  // child printed. Re-imposing the child's own cap here would make that answer
  // inert; the parent's remaining budget is the only ceiling left.
  const ownMax = parent.budget_approved
    ? undefined
    : (childDefinition.max_cost_usd ?? childDefinition.max_cost_per_work_item_usd);
  const maxCostUsd = childCostCeiling(parent.max_cost_usd, budget, ref.accountedCostUsd, ownMax);

  // 3. Identity. The reference reuses its bound run id or receives a fresh one,
  //    and learns whether that identity was already used.
  const { runDir, strictSnapshot } = bindChildRunDir(parent, ref, {
    pipeline: childDefinition.name,
    ticket,
    context: childCtx,
  });

  // 4. Boot. A used identity must resume THAT snapshot. A boot failure leaves
  //    the reference resumable.
  const stateStore = new FileRunStateStore({ context: childCtx, pipeline: childDefinition.name, ticket });
  let childRun: RunView;
  let childResumed: boolean;
  try {
    ({ run: childRun, resumed: childResumed } = await loadOrCreateRun({
      pipelinePath: childPath,
      ticket,
      runDir,
      fresh: false,
      context: childCtx,
      // The child runs in this process, so where it reads and writes is where its
      // parent does.
      worktree: parent.worktree === true,
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
      strictSnapshot,
    }));
  } catch (error) {
    const reason = errorMessage(error).trim();
    failChildLaunch(parent, ref, step.id, reason);
    return failed({ reason });
  }
  if (childRun.parentRunId !== parent.runId || childRun.parentNodeId !== step.id) {
    throw new Error(`Child run ${childRun.runId} is already linked to another orchestration node`);
  }

  // 5. Start fact: from here on the identity is spent.
  recordChildStarted(parent, ref, step, childRun);

  // 6. Execution, unless the child owes nothing. A terminal child with only
  //    done/skipped steps must be reported as-is; a settled snapshot that never
  //    received a verdict — the window between the last step and finalizeRun —
  //    still owes one, and this call stamps it.
  let childOutcome: RunOutcome | undefined;
  if (!completedSuccessfully(childRun) && remainingWork(childRun).owed) {
    // The child runs under the parent's abort scope: a signal received by the
    // process stops its loops too, and the handler persists it as an active run.
    childOutcome = await input.runChild(
      childRun,
      {
        resuming: childResumed,
        abort,
        replayInterrupted: input.replayInterrupted,
        workItemSourceStepId: childDefinition.work_item_source?.step_id,
      },
      childCtx,
    );
    finalizeRun(childRun, childOutcome);
    emitRunStats(childRun, { context: childCtx });
  }

  // 7. Reconciliation, BEFORE settlement so a later orchestration exception cannot
  //    lose already-reconciled cost. Cost accounting owns the charge: the node
  //    total, the parent ledger, the reconciliation event and the accounting
  //    latch a resume reads back.
  const delta = chargeChildReconciliation({ parent, step, ref, child: childRun, budget });

  // 8. Settlement of the reference from the child's own verdict.
  const success = settleChild(parent, ref, step, childRun, delta);
  if (success) return DONE;

  // 9. Report. The budget facts come from the child: the stop its loop reported
  //    this generation, the stop it latched in a previous one, or a ledger that
  //    reached its own ceiling as `run/record/budget.ts` defines it.
  const halt = {
    cost: {
      budgetExceeded:
        childOutcome?.budgetExceeded === true ||
        childRun.budget_exceeded === true ||
        isBudgetExceeded(childRun.max_cost_usd, ref.accountedCostUsd),
      costUnaccounted: childOutcome?.costUnaccounted === true,
      // A child that stopped AT ITS OWN GATE makes the accounting stop the
      // parent's stop reason too; a child that failed for its own reason with an
      // unknown ledger does not.
      costUnaccountedStop: childOutcome?.costUnaccountedStop === true,
    },
    reason: childRun.outcome?.reason ?? `child pipeline ${childRun.pipeline} failed`,
    ...(childRun.outcome?.failKind ? { failKind: childRun.outcome.failKind } : {}),
    ...(childRun.outcome?.failCause ? { failCause: childRun.outcome.failCause } : {}),
  };
  // A child halted short of its work without failing it (a clean stop, an
  // interruption) stops the parent the same way.
  return isHalted(childRun.status) ? stopped(halt) : failed(halt);
}
