//
// How a run ended, read once from its snapshot for every view of the read
// model: the morning box item and the external read API. Each view renders
// these facts in its own words; none re-reads the snapshot for them.
//
// The facts stay in the runner's vocabulary (`verdict` / `technical`,
// `blocked`, the stop kinds): naming them for a reader is the view's choice.
// Each rule keeps its fallback for snapshots written before the structured
// field existed, because those snapshots stay on disk and stay listed.

import type { StepFailCause, StepFailKind } from "../../contracts/backends.js";
import type { PersistedRun, RunStopState } from "../../run/index.js";
import {
  awaitsHuman,
  isClosureCurrent,
  isFailure,
  readClosureAt,
  remainingWork,
  runProvesUnpricedSpend,
  strictCostAccountingFor,
} from "../../run/index.js";
import { createArtifactRef } from "../../shared/language/artifact-ports.js";
import { FileWorkItemArtifactStore, gateDecisionStatus, isValidSubjectToken } from "../../work-items/index.js";
import type { ProjectEntry } from "./projects.js";
import { workItemDirOf } from "./runs.js";
import type { ItemApproval, ItemStatus } from "./types.js";

/** Structured cause of a clean stop. `detail` is always present: a run stopped
 *  before `outcome.stop` existed still carries its raw `stopped_reason`. */
export type RunStop = Omit<RunStopState, "artifact">;

/** Why a run failed or has no verdict, in the runner's words. */
export interface RunFailure {
  phase: string;
  reason: string;
  kind?: StepFailKind;
  /** Present when no fix pass could have changed the answer. */
  cause?: StepFailCause;
}

/** A hand closure (`lancenuit close`) that still describes the snapshot. */
export interface RunClosure {
  at: string;
  by: string;
}

/**
 * Structured cause of a clean stop, for a `STOPPED` run only.
 *
 * `outcome.stop` is the current shape; a run stopped before it existed carries
 * only the console sentence of `stopped_reason`, which becomes the detail with
 * no subject and no kind — the reader sees why, and no button claims to know
 * which approval would lift it.
 */
export function stopOf(state: PersistedRun, status: ItemStatus): RunStop | undefined {
  if (status !== "STOPPED") return undefined;
  const stop = state.outcome?.stop;
  if (stop) {
    return {
      ...(stop.subject ? { subject: stop.subject } : {}),
      ...(stop.kind ? { kind: stop.kind } : {}),
      detail: stop.detail,
      ...(stop.reworkable ? { reworkable: true } : {}),
    };
  }
  return { detail: state.stopped_reason ?? state.outcome?.reason ?? "" };
}

/** Why an interrupted run has no verdict. A fixed sentence: the snapshot of a
 *  run nobody finished carries no outcome to quote. */
const INTERRUPTED_REASON = "the runner process died without recording a verdict (crash, kill, or reboot)";

/**
 * The failure of a failed or interrupted run, `undefined` for any other.
 *
 * A run whose runner died has no outcome to quote: its failure is the step it
 * was in, when the snapshot recorded one, and why there is no verdict.
 */
export function failureOf(state: PersistedRun, status: ItemStatus, interrupted: boolean): RunFailure | undefined {
  if (interrupted) {
    return {
      phase: state.steps.find((step) => step.status === "running")?.id ?? "",
      reason: INTERRUPTED_REASON,
    };
  }
  if (!isFailure(status)) return undefined;
  const kind = state.outcome?.failKind;
  const cause = state.outcome?.failCause;
  return {
    phase: state.outcome?.phase ?? "",
    reason: state.outcome?.reason ?? state.stopped_reason ?? "",
    ...(kind ? { kind } : {}),
    ...(cause ? { cause } : {}),
  };
}

/**
 * A run that hit its cost ceiling.
 *
 * `outcome.stopKind` is the answer of the generation that stopped, and the only
 * one that survives a `--budget` resume wiping `budget_exceeded`. The flag comes
 * next, and the sentence the report printed is the fallback for a snapshot
 * written before either existed.
 */
export function budgetExceededOf(state: PersistedRun): boolean {
  if (state.outcome?.stopKind === "budget-exceeded") return true;
  if (state.outcome?.stopKind === "cost-unaccounted") return false;
  if (state.budget_exceeded === true) return true;
  const text = `${state.outcome?.reason ?? ""} ${state.stopped_reason ?? ""}`;
  return /budget exceeded|cost limit/i.test(text);
}

/**
 * A run that actually STOPPED because its spending stopped being accountable —
 * the only case where a reader may be told to authorize with
 * `--allow-unmetered`.
 *
 * Keyed on a real stop, like `budgetExceededOf`: a ceiling to enforce, no human
 * authorization, evidence of unpriceable spend, and work left to do. Without
 * those, an unknown total is only a `≥` on a run nothing withheld anything from —
 * an uncapped run has no ceiling to lose, an authorized one already answered the
 * question, and a finished one has nothing left to withhold. The evidence is the
 * latch, or the attempts of a snapshot written before it existed, or the sentence
 * the report printed for a run older still.
 */
export function costUnaccountedOf(state: PersistedRun): boolean {
  if (!strictCostAccountingFor(state.max_cost_usd, state.allow_unmetered)) return false;
  if (remainingWork(state).steps.length === 0) return false;
  // The stopping generation's own typed answer, when it wrote one: it also says
  // NO for a run whose ledger is a lower bound but which stopped at its ceiling
  // or failed for its own reason, which the evidence tiers below cannot tell
  // apart.
  if (state.outcome?.stopKind) return state.outcome.stopKind === "cost-unaccounted";
  if (state.cost_unaccounted === true || runProvesUnpricedSpend(state)) return true;
  return /cost unaccounted/i.test(`${state.outcome?.reason ?? ""} ${state.stopped_reason ?? ""}`);
}

/**
 * The single pending approval of a stopped run.
 *
 * Gates are sequential, so a stopped run has exactly one. Its state is the
 * runner's own reading (`gateDecisionStatus`), judged on the artifact as it
 * stands NOW in the effective directory: an artifact rewritten since the approval
 * makes the decision stale, and a rejection the rework answered is `reworked`,
 * exactly as the gate and `--inspect` will say. That reading is about the work
 * item today, so it only describes the run the ticket is currently about.
 */
export async function approvalOf(
  project: ProjectEntry,
  ticket: string,
  subject: string,
): Promise<ItemApproval | undefined> {
  // The subject reaches a file path; an invalid one is dropped rather than
  // joined, so a corrupt snapshot cannot steer the read out of `decisions/`.
  if (!isValidSubjectToken(subject)) return undefined;

  const store = new FileWorkItemArtifactStore({
    cwd: project.cwd,
    config: { specPath: project.specPath },
    ticket,
    ticketDir: ticket,
  });
  const status = await gateDecisionStatus(workItemDirOf(project, ticket), subject, (name) =>
    store.readText(createArtifactRef(ticket, name)),
  );
  if (status.state === "absent") return { subject, state: "absent" };
  const { decision } = status;
  return {
    subject,
    state: status.state,
    decidedAt: decision.decidedAt,
    decidedBy: decision.decidedBy,
    ...(status.state === "rejected" && decision.reason ? { reason: decision.reason } : {}),
    ...((status.state === "rejected" || status.state === "reworked") && decision.round
      ? { round: decision.round }
      : {}),
  };
}

/**
 * The hand closure of the run, while it still describes the snapshot.
 *
 * A closure taken on a snapshot the runner has since rewritten is ignored: the
 * run moved, so whatever it now waits on is new. A closure on a status nobody
 * waits on (PASS, RUNNING) is ignored too, rather than hiding a live run.
 */
export function closureOf(runDir: string, state: PersistedRun, status: ItemStatus): RunClosure | undefined {
  if (!awaitsHuman(status)) return undefined;
  const closure = readClosureAt(runDir);
  if (!closure || !isClosureCurrent(closure, state)) return undefined;
  return { at: closure.closedAt, by: closure.closedBy };
}
