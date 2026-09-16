// runner/dispatch/loop.ts
//
// The dispatch loop lives in one place as a shared skeleton:
//
//   tickets → skip complete runs → selfSpawnRunner → between-ticket hook → aggregate
//
// Strategy parameters cover ticket discovery, between-ticket work, failure policy,
// finalization, and reporting.
//
// The parent never runs a step: it spawns children, aggregates results, and exits.
// Children never see `DispatchStrategy`, so dispatch stays decoupled from step-loop.ts.

import { DISPATCH_CHILD_ENV, selfSpawnRunner } from "../exec/self-spawn.js";
import type { PersistedRun } from "../model/persisted.js";
import { log } from "../runtime/logging.js";
import { FileRunStateStore } from "../state/stores/file-run-state-store.js";
import { isPersistedRunComplete } from "../state/run-predicates.js";
import { DispatchAbort } from "./abort.js";
import type { DispatchClassification, DispatchEnv, DispatchOutcome, DispatchStrategy } from "./dispatch-strategy.js";

/** Classify a loop run: non-zero exit is failed; a JSON run with stopped_reason is
 * escalated; otherwise it is fixed. */
export function classifyPersistedRunOutcome(
  exitCode: number,
  run: PersistedRun | null,
): "fixed" | "escalated" | "failed" {
  if (exitCode !== 0) return "failed";
  if (run?.stopped_reason) return "escalated";
  return "fixed";
}

/** Injectable boundaries, following the StepLoopDeps / FixLoopDeps pattern. */
export interface DispatchDeps {
  /** Whether this ticket's run is already complete (resume). */
  isTicketComplete(ticket: string, env: DispatchEnv): boolean;
  /** Classify a ticket run as fixed, escalated, or failed, and name the run it
   *  produced. Both come from one snapshot read. */
  classify(ticket: string, exitCode: number, env: DispatchEnv): DispatchClassification;
  spawn(args: string[]): number | Promise<number>;
}

const defaultDeps: DispatchDeps = {
  isTicketComplete: (ticket, env) => isPersistedRunComplete(latestRunFor(env, ticket)),
  classify: (ticket, exitCode, env) => {
    const run = latestRunFor(env, ticket);
    return { outcome: classifyPersistedRunOutcome(exitCode, run), runId: run?.runId ?? null };
  },
  spawn: (args) => selfSpawnRunner(args, { ...DISPATCH_CHILD_ENV }),
};

function latestRunFor(env: DispatchEnv, ticket: string): PersistedRun | null {
  return (env.stateStore ?? new FileRunStateStore({ context: env.ctx })).loadLatest(env.def.name, ticket);
}

/** Assemble the loop's per-ticket result, keeping `runId` off the object when the
 *  child left no snapshot rather than carrying an explicit `undefined`. */
function outcomeOf(ticket: string, classification: DispatchClassification): DispatchOutcome {
  return {
    ticket,
    outcome: classification.outcome,
    ...(classification.runId !== null ? { runId: classification.runId } : {}),
  };
}

export async function runDispatch(
  strategy: DispatchStrategy,
  env: DispatchEnv,
  deps: DispatchDeps = defaultDeps,
): Promise<number> {
  let tickets: string[];
  try {
    tickets = await strategy.tickets(env);
  } catch (e) {
    if (e instanceof DispatchAbort) return e.code;
    throw e;
  }

  if (tickets.length === 0) {
    const { message, code } = strategy.onEmpty(env);
    log(message);
    return code;
  }

  const childArgs = [...env.passthrough, ...strategy.childArgs(env)];
  const outcomes: DispatchOutcome[] = [];
  /** Whether `betweenTickets` requested a stop in continue mode. */
  let halted = false;

  for (const ticket of tickets) {
    log(strategy.banner(ticket));

    // A complete run is skipped on resume, but betweenTickets still runs so it can
    // perform required post-ticket work.
    const skipped = !env.fresh && deps.isTicketComplete(ticket, env);

    if (skipped) {
      log(strategy.skipMessage(ticket));
      const outcome = outcomeOf(ticket, deps.classify(ticket, 0, env));
      outcomes.push(outcome);
      await strategy.onTicketFinished?.(outcome, env);
    } else {
      // Before the spawn, so a strategy keeping a durable record shows this
      // ticket as started even if the process never comes back.
      await strategy.onTicketStarted?.(ticket, env);
      const code = await deps.spawn([ticket, "--pipeline", env.pipelinePath, ...childArgs]);
      const outcome = outcomeOf(ticket, deps.classify(ticket, code, env));
      outcomes.push(outcome);
      await strategy.onTicketFinished?.(outcome, env);
      if (code !== 0) {
        strategy.onTicketFailed?.(ticket, code, env);
        if (strategy.onFailure === "stop") return code;
      }
    }

    if (strategy.betweenTickets && !(await strategy.betweenTickets(ticket, env, { skipped }))) {
      await strategy.onHalted?.(`betweenTickets refused to continue after ${ticket}`, env);
      if (strategy.onFailure === "stop") return 1;
      halted = true;
      break;
    }
  }

  if (!halted && strategy.after) {
    const code = await strategy.after(env);
    if (code !== 0) return code;
  }

  strategy.report(outcomes, tickets, env);
  return 0;
}
