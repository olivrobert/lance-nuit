// runner/step/pipeline-orchestration-types.ts
//
// What the orchestration node and the child executor exchange. They call each
// other — the node drives a child, the child reports back — so the shapes live
// apart from both, and the only remaining edge between the two modules is the
// call itself.

import type { StepFailCause, StepFailKind } from "../contracts/backends.js";
import type { PipelineContext } from "../model/context.js";
import type { Run, RunStep } from "../model/run.js";
import type { AbortScope } from "../runtime/abort.js";
import type { RunOutput } from "../runtime/run-output.js";
import type { RunBudget } from "../state/budget.js";

export interface PipelineOrchestrationInput {
  run: Run;
  step: RunStep;
  baseCtx: PipelineContext;
  baseBranch?: string;
  /** Parent run budget; each child posts its reconciled delta here. */
  budget: RunBudget;
  resuming: boolean;
  /** The parent's abort scope. Every child run executes under it, which is how
   *  an interruption of the process reaches runs that never see `run.aborted`. */
  abort: AbortScope;
  /** Shared output fan-out for parent and recursively executed child runs. */
  output: RunOutput;
}

export interface PipelineOrchestrationResult {
  action: "continue" | "failed" | "stopped";
  budgetExceeded: boolean;
  /** A descendant stopped because its spending became unaccountable. Optional
   *  rather than required: only a child failure can carry it, and every other
   *  exit of the node is silent about it. */
  costUnaccounted?: boolean;
  /** The accounting stop is the REASON the node stopped: this fan-out refused to
   *  launch its next child or callback, or the child it launched stopped at its
   *  own gate. Distinct from `costUnaccounted`, which a child failing on its own
   *  merits also carries whenever its ledger is a lower bound. */
  costUnaccountedStop?: boolean;
}

/** Outcome of a child call from the main node or a callback. */
export interface ChildExecutionResult {
  ok: boolean;
  stopped?: boolean;
  budgetExceeded?: boolean;
  /** The child could not account for what it spent. Distinct from
   *  `budgetExceeded`: no ceiling was reached, the ceiling stopped being
   *  enforceable. The parent inherits the uncertainty through the reconciled
   *  child control as well, so its own decision stays derived from the ledger. */
  costUnaccounted?: boolean;
  /** The launch was WITHHELD by the accounting gate, or the child stopped at its
   *  own. The remaining items and children are untouched and resumable. */
  costUnaccountedStop?: boolean;
  reason?: string;
  /** Nature of the child failure, as the child itself established it. A child
   *  stopped by a quality verdict must not be reported by the parent as a
   *  technical error: the parent step is only the carrier of that verdict. */
  failKind?: StepFailKind;
  /** Why repairing the child is pointless, as the child itself established it. A
   *  child stopped by an obstacle outside the code must not send the parent into
   *  a fix loop that would hit the same obstacle. */
  failCause?: StepFailCause;
}
