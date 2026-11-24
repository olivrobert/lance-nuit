//
// What the orchestration node and the child executor exchange. They call each
// other — the node drives a child, the child reports back — so the shapes live
// apart from both, and the only remaining edge between the two modules is the
// call itself.

import type { PipelineContext } from "../../shared/language/context.js";
import type { RunBudget, RunOutcome, RunStepView, RunView } from "../../run/index.js";
import type { AbortScope } from "../abort.js";
import type { RunOutput } from "../run-output.js";

/** What a child run needs from the execution that runs it. */
export interface ChildRunOptions {
  resuming: boolean;
  abort: AbortScope;
  replayInterrupted?: boolean;
  workItemSourceStepId?: string;
}

/** Runs the steps of a child run. Handed down by the step loop, which owns the
 *  deps the child must run under: the child cannot import the loop that drives it. */
export type ChildRunExecutor = (run: RunView, options: ChildRunOptions, ctx: PipelineContext) => Promise<RunOutcome>;

export interface PipelineOrchestrationInput {
  run: RunView;
  step: RunStepView;
  baseCtx: PipelineContext;
  /** Parent run budget; each child posts its reconciled delta here. */
  budget: RunBudget;
  /** The parent's abort scope. Every child run executes under it, which is how
   *  an interruption of the process reaches runs that never see `run.aborted`. */
  abort: AbortScope;
  /** `--replay-interrupted` of the invocation, passed down to every child run. */
  replayInterrupted?: boolean;
  /** Shared output fan-out for parent and recursively executed child runs. */
  output: RunOutput;
  runChild: ChildRunExecutor;
}
