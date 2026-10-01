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
// The same rules decide what the sheet offers: `verbsFor` lists the verbs an
// item admits, each with the command `buildArgv` would build, and every item the
// server answers carries that list. The browser draws it; it never re-derives it.
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

/** The subject the run is stopped on, when it is stopped at a gate. */
function pendingGate(item: Item): string | undefined {
  return item.status === "STOPPED" ? item.stop?.subject : undefined;
}

/** A gate someone already approved, from here, an agent, or a terminal: the
 *  decision is fresh, so the run needs resuming, not another approval. */
function approvedGate(item: Item): boolean {
  return pendingGate(item) !== undefined && item.approval?.state === "fresh";
}

/**
 * The command line of one verb, once admitted: every value comes from the item
 * except the budget, which the caller formatted — or a placeholder, for a
 * command shown before the reader typed an amount.
 */
function argvOf(item: Item, verb: Verb, budget: string): string[] {
  const worktree = item.worktree ? ["--worktree"] : [];
  const run = ["run", item.ticket, "--pipeline", item.pipeline];
  const gate = pendingGate(item) ?? "";
  switch (verb) {
    case "approve-and-rerun":
      return [...run, "--approve", gate, ...worktree];
    case "approve":
      return ["approve", item.ticket, gate, "--pipeline", item.pipeline, ...worktree];
    case "rerun":
      return [...run, ...worktree];
    case "budget":
      return [...run, "--budget", budget, ...worktree];
    case "fresh":
      return [...run, "--fresh", ...worktree];
    case "close":
      return ["close", item.ticket, "--pipeline", item.pipeline];
    case "reopen":
      return ["reopen", item.ticket, "--pipeline", item.pipeline];
  }
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

  const gate = pendingGate(item);
  switch (verb) {
    case "approve-and-rerun":
    case "approve": {
      if (!gate) return { ok: false, status: 409, reason: "this run is not stopped at a gate with a subject" };
      if (typeof input.subject !== "string" || input.subject !== gate) {
        return { ok: false, status: 400, reason: `subject must be the pending gate "${gate}"` };
      }
      if (!/^[\w-]+$/.test(gate)) return { ok: false, status: 409, reason: "the pending subject is not a valid token" };
      return { ok: true, argv: argvOf(item, verb, "") };
    }
    case "rerun": {
      const blocked = item.status === "STOPPED" && (!gate || approvedGate(item));
      const failed = item.status === "FAIL" || item.status === "ABORTED";
      if (!blocked && !failed) return { ok: false, status: 409, reason: "only a blocked or failed run can be resumed" };
      return { ok: true, argv: argvOf(item, verb, "") };
    }
    case "budget": {
      if (!item.budgetExceeded) return { ok: false, status: 409, reason: "this run was not stopped by its budget" };
      const budget = formatBudget(input.budget);
      if (!budget) {
        return { ok: false, status: 400, reason: `budget must be a positive amount of at most ${MAX_BUDGET_USD} USD` };
      }
      return { ok: true, argv: argvOf(item, verb, budget) };
    }
    case "fresh":
      return { ok: true, argv: argvOf(item, verb, "") };
    case "close": {
      const waiting = item.status === "STOPPED" || item.status === "FAIL" || item.status === "ABORTED";
      if (!waiting || item.closed)
        return { ok: false, status: 409, reason: "only an open failed or stopped run can be closed" };
      return { ok: true, argv: argvOf(item, verb, "") };
    }
    case "reopen":
      if (!item.closed) return { ok: false, status: 409, reason: "this run is not closed" };
      return { ok: true, argv: argvOf(item, verb, "") };
  }
}

/** One action button: the verb posted, its label, and the command the server
 *  will build — shown as the tooltip so the reader can see it before clicking. */
export interface VerbAction {
  verb: Verb;
  label: string;
  command: string;
  primary?: boolean;
  danger?: boolean;
}

function offer(item: Item, verb: Verb, label: string, flags: { primary?: true; danger?: true } = {}): VerbAction {
  return { verb, label, command: ["lancenuit", ...argvOf(item, verb, "<usd>")].join(" "), ...flags };
}

/**
 * The verbs the sheet offers for one item (spec 5.1), in the order it shows them.
 *
 * Every offer is one `buildArgv` admits on a quiet item, and its command is the
 * line `buildArgv` would build, the budget left as a placeholder. The browser
 * draws these and names one back; it decides none of them.
 */
export function verbsFor(item: Item): VerbAction[] {
  // A closed run waits on nobody: the only questions left are to reopen it, or
  // to start over. A plain rerun would reopen it too, but silently.
  if (item.closed) {
    return [offer(item, "reopen", "Reopen", { primary: true }), offer(item, "fresh", "Start fresh", { danger: true })];
  }

  const verbs: VerbAction[] = [];
  const stopped = item.status === "STOPPED";
  const failed = item.status === "FAIL" || item.status === "ABORTED";
  if (stopped && pendingGate(item) && !approvedGate(item)) {
    verbs.push(offer(item, "approve-and-rerun", "Approve and rerun", { primary: true }));
    verbs.push(offer(item, "approve", "Approve only"));
  }
  if (stopped && (!pendingGate(item) || approvedGate(item)))
    verbs.push(offer(item, "rerun", "Rerun", { primary: true }));
  if (failed) verbs.push(offer(item, "rerun", "Rerun from failure", { primary: true }));
  if (item.budgetExceeded) verbs.push(offer(item, "budget", "Raise budget"));
  if (stopped || failed) verbs.push(offer(item, "close", "Mark as closed"));
  if (item.status !== "RUNNING") verbs.push(offer(item, "fresh", "Start fresh", { danger: true }));
  return verbs;
}

/** An item as the dashboard serves it: the read model's item, plus what may be
 *  launched on it. `busy` disables every verb without hiding them. */
export interface ActionableItem extends Item {
  busy: boolean;
  verbs: VerbAction[];
}

export function actionable(item: Item): ActionableItem {
  return { ...item, busy: isBusy(item), verbs: verbsFor(item) };
}
