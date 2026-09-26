// modules/ui/verbs.ts
//
// The verbs: the closed set of things the dashboard can make the runner do, each
// one exactly one existing `lancenuit` invocation (spec 5.1).
//
// The server builds `argv` itself. A request names a verb and an item; it never
// carries an argument that reaches the command line as typed. The subject must
// be the one the run is stopped on, the pipeline is the run's, the worktree mode
// is the run's, and the budget is a bounded number the server formats.
//
// Pure: nothing here spawns or writes; `launcher.ts` does.

import type { Item } from "../read-model/index.js";

export const VERBS = ["approve-and-rerun", "approve", "rerun", "fresh", "budget", "close", "reopen"] as const;
export type Verb = (typeof VERBS)[number];

export function isVerb(value: unknown): value is Verb {
  return typeof value === "string" && (VERBS as readonly string[]).includes(value);
}

/** Highest cost ceiling the dashboard will approve in one click, in USD. */
export const MAX_BUDGET_USD = 1000;

/** Inputs a request may carry beside the verb and the item. */
export interface ActionInput {
  subject?: unknown;
  budget?: unknown;
}

export type ArgvResult = { ok: true; argv: string[] } | { ok: false; status: number; reason: string };

/** An item on which nothing may be launched right now: the runner is running, or
 *  a launch of ours is still alive. */
export function isBusy(item: Item): boolean {
  return item.status === "RUNNING" || item.launch?.alive === true;
}

/** Format a validated budget the way the CLI parses it: a positive decimal. */
function formatBudget(value: unknown): string | undefined {
  const amount = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > MAX_BUDGET_USD)
    return undefined;
  // Validate what the CLI will actually receive: 0.001 is positive but rounds
  // to "0", which the CLI would refuse or, worse, read as no budget at all.
  const cents = Math.round(amount * 100) / 100;
  if (cents <= 0) return undefined;
  return String(cents);
}

/**
 * Arguments of one verb on one item, or the refusal.
 *
 * Each verb is admitted only in the situation of spec 5.1 — an approval on a run
 * that is not stopped at a gate is refused, not attempted — and every value on
 * the command line comes from the item the read model built, never from the
 * request, except the budget, which is parsed and formatted here.
 */
export function buildArgv(item: Item, verb: Verb, input: ActionInput = {}): ArgvResult {
  if (isBusy(item)) return { ok: false, status: 409, reason: "a run is already in progress for this item" };

  const worktree = item.worktree ? ["--worktree"] : [];
  const run = ["run", item.ticket, "--pipeline", item.pipeline];
  const gate = item.status === "STOPPED" ? item.stop?.subject : undefined;

  switch (verb) {
    case "approve-and-rerun":
    case "approve": {
      if (!gate) return { ok: false, status: 409, reason: "this run is not stopped at a gate with a subject" };
      if (typeof input.subject !== "string" || input.subject !== gate) {
        return { ok: false, status: 400, reason: `subject must be the pending gate "${gate}"` };
      }
      if (!/^[\w-]+$/.test(gate)) return { ok: false, status: 409, reason: "the pending subject is not a valid token" };
      if (verb === "approve") {
        return { ok: true, argv: ["approve", item.ticket, gate, "--pipeline", item.pipeline, ...worktree] };
      }
      return { ok: true, argv: [...run, "--approve", gate, ...worktree] };
    }
    case "rerun": {
      const blocked = item.status === "STOPPED" && !gate;
      const failed = item.status === "FAIL" || item.status === "ABORTED";
      if (!blocked && !failed) return { ok: false, status: 409, reason: "only a blocked or failed run can be resumed" };
      return { ok: true, argv: [...run, ...worktree] };
    }
    case "budget": {
      if (!item.budgetExceeded) return { ok: false, status: 409, reason: "this run was not stopped by its budget" };
      const budget = formatBudget(input.budget);
      if (!budget) {
        return { ok: false, status: 400, reason: `budget must be a positive amount of at most ${MAX_BUDGET_USD} USD` };
      }
      return { ok: true, argv: [...run, "--budget", budget, ...worktree] };
    }
    case "fresh":
      return { ok: true, argv: [...run, "--fresh", ...worktree] };
    case "close": {
      const waiting = item.status === "STOPPED" || item.status === "FAIL" || item.status === "ABORTED";
      if (!waiting || item.closed)
        return { ok: false, status: 409, reason: "only an open failed or stopped run can be closed" };
      return { ok: true, argv: ["close", item.ticket, "--pipeline", item.pipeline] };
    }
    case "reopen":
      if (!item.closed) return { ok: false, status: 409, reason: "this run is not closed" };
      return { ok: true, argv: ["reopen", item.ticket, "--pipeline", item.pipeline] };
  }
}
