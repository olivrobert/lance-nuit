// runner/step/attempt-chain.ts
//
// Middleware chain around one attempt, whether it executes the step command or a
// fix pass. This is the single home for budget remaining, session rotation, and
// step-log banners, so no loop duplicates them around its own spawn. Cost
// accounting is NOT a middleware: the attempt lifecycle (step-attempt.ts) charges
// the ledger from the accepted closure, so the isolation below never applies to
// it.
//
// This module knows neither runners nor persistence. It defines context shape,
// isolation, and composition; concrete middleware lives with its bookkeeping in
// step-attempt.ts.

import type { AgentSession, AttemptStats, StepFailCause, StepFailKind } from "../contracts/backends.js";
import type { PersistedAttempt } from "../model/persisted.js";
import type { Run, RunStep } from "../model/run.js";
import type { RunBudget } from "../state/budget.js";

/** `step` replays the step command (initial, rerun, or retry after a fix);
 * `fix` is a backend repair pass. The distinction matters because
 * a fix has no step session and is never a coder-resume source. */
export type AttemptKind = "step" | "fix";

/** Common subset of executeStep's StepResult and runWithAgent's result: everything
 * the chain reads from a completed attempt. It omits the heavy `output`, which no
 * middleware currently needs. */
export interface AttemptRecord {
  ok: boolean;
  stats?: AttemptStats;
  session?: AgentSession;
  failReason?: string;
  failKind?: StepFailKind;
  /** Why repairing this attempt is pointless, when the backend said so. */
  failCause?: StepFailCause;
  /** The live cost guard killed this attempt; the chain raises it to the ledger. */
  budgetExceeded?: boolean;
  /** The live accounting guard killed this attempt: its usage was provably
   *  unpriceable under a ceiling nobody authorized unmetered spend against. The
   *  chain raises it to the ledger as uncertainty, never as a budget stop. */
  costUnaccounted?: boolean;
}

/** Mutable attempt budget, which is the run's `RunBudget`, not a copy. Middleware
 * cannot widen a runner result, so updates flow through this object and are visible
 * to the next attempt immediately. */
export type AttemptBudget = RunBudget;

export interface AttemptContext {
  readonly run: Run;
  readonly step: RunStep;
  /** The running attempt this chain wraps. Middleware reads its `status` to know
   * whether another path (signal handler) already closed it. */
  readonly attempt: PersistedAttempt;
  readonly kind: AttemptKind;
  /** Resolved step command or fix prompt. */
  readonly command: string;
  /** Attempt banner in the step log (`rerun 2/3`). Absent for the initial attempt,
   * which has no separator. */
  readonly banner?: string;
  readonly stepLogPath?: string;
  readonly budget: AttemptBudget;
}

export type AttemptHandler<R extends AttemptRecord> = (ctx: AttemptContext) => Promise<R>;

/** The type parameter `R` is the contract: middleware cannot construct an `R`, so
 * it can only return `next`'s result. Middleware observes but cannot replace the
 * step verdict. */
export type AttemptMiddleware = <R extends AttemptRecord>(ctx: AttemptContext, next: AttemptHandler<R>) => Promise<R>;

/** Middleware cannot fail a step or prevent its execution. If it throws before or
 * after spawn, or forgets to call `next`, the attempt still runs and the runner's
 * result leaves the chain. Degraded observability is preferable to an interrupted
 * run.
 *
 * A middleware throwing after spawn may skip its own work. This is acceptable
 * only because nothing the run's correctness depends on lives in a middleware:
 * the ledger charge and the attempt closure happen in the lifecycle, after the
 * chain has returned or rejected. */
function isolate(mw: AttemptMiddleware): AttemptMiddleware {
  return async <R extends AttemptRecord>(ctx: AttemptContext, next: AttemptHandler<R>): Promise<R> => {
    let record: R | undefined;
    let spawnFailed = false;
    let spawnError: unknown;
    let inFlight: Promise<R> | undefined;

    const guarded: AttemptHandler<R> = (inner) => {
      // A second next call would spawn the same attempt twice; share the one
      // in-flight spawn instead. The promise is memoized, not its result: two
      // concurrent calls would otherwise both find no result and both spawn.
      inFlight ??= next(inner).then(
        (out) => {
          record = out;
          return out;
        },
        (e) => {
          spawnFailed = true;
          spawnError = e;
          throw e;
        },
      );
      return inFlight;
    };

    try {
      const out = await mw(ctx, guarded);
      if (record !== undefined) return out ?? record;
    } catch {
      // Isolate middleware errors from the step loop.
    }
    // A spawn error belongs to the runner, not middleware. Propagate it so the
    // fallback next(ctx) does not spawn a second process.
    if (spawnFailed) throw spawnError;
    return record ?? next(ctx);
  };
}

/** `compose(a, b, c)(handler)` becomes `a(b(c(handler)))`: the first middleware is
 * outermost. Place late-calculated values such as remaining budget nearest the
 * handler, and early-applied values such as cumulative cost there as well. */
export function compose(...middlewares: readonly AttemptMiddleware[]) {
  const isolated = middlewares.map(isolate);
  return <R extends AttemptRecord>(handler: AttemptHandler<R>): AttemptHandler<R> =>
    isolated.reduceRight<AttemptHandler<R>>((next, mw) => (ctx) => mw(ctx, next), handler);
}
