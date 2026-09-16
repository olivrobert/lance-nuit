import { join } from "node:path";
import type { AgentBackendRegistry, AgentSession, BackendSpec, StepControl, StepUsage } from "../contracts/backends.js";
import { backendSpecForStep } from "../contracts/backends.js";
import type { StepStatus } from "../model/persisted.js";
import type { RunStepView, RunView } from "../model/run.js";
import { aggregateControl, aggregateUsage } from "../state/cost-accounting.js";

export interface RunReportOutcome {
  failed: boolean;
  stopped: boolean;
  budgetExceeded: boolean;
  /** The run's ledger is a lower bound: an attempt spent tokens no pricing table
   *  could price. Optional: a caller that does not track the distinction omits
   *  it. On its own it is a MEASUREMENT caveat, not a stop reason. */
  costUnaccounted?: boolean;
  /** The accounting stop is what ended the run: a gate withheld the next unit of
   *  work over that uncertainty. This — not `costUnaccounted` — is what earns the
   *  `cost` headline and the `--allow-unmetered` recovery line. */
  costUnaccountedStop?: boolean;
  cumulativeCost: number;
}

export type RunReportKind =
  | "success"
  | "verdict"
  | "failure"
  | "stopped"
  | "aborted"
  | "budget"
  /** Spending became unaccountable under a ceiling: a stop of its own, with its
   *  own recovery flag. Never folded into `budget` — raising the amount cannot
   *  price a closed attempt — nor into `failure`, which sends a reader to a log
   *  and a fix loop for something no code change repairs. */
  | "cost"
  | "unknown";

export interface RunReportStep {
  id: string;
  name: string;
  status: StepStatus;
  durationMs?: number;
  retries: number;
  control?: StepControl;
  usage?: StepUsage;
  detail?: string;
}

export interface RunReportResource {
  label: "run" | "events" | "stats" | "log";
  path: string;
}

/** What the resume command in front of the reader is actually good for.
 *
 *  `"resume"`: the run picks this conversation back up on its own — a
 *  `on_failure.resume_session` policy, or a failed step the next attempt reopens.
 *
 *  `"inspect"`: the session survived, but NOTHING will reopen it. An interrupted
 *  run replays its step with a FRESH session (`src/state/run-transitions.ts`,
 *  "fresh attempt, no session resume"), so the command is only there for a human
 *  who wants to read the conversation by hand. Printing it without that caveat
 *  reads as a promise the runner does not keep. */
export type RunReportResumeNature = "resume" | "inspect";

export interface RunReportResume {
  step: string;
  provider: string;
  sessionId: string;
  command?: string;
  location?: string;
  /** Whether the run will reopen this session, or only a human can. */
  nature: RunReportResumeNature;
}

/**
 * Presentation model independent of its destination. An HTML reporter can
 * consume this exact structure without parsing console messages.
 */
export interface RunReport {
  kind: RunReportKind;
  pipeline: string;
  ticket?: string;
  headline: string;
  action?: string;
  issue?: string;
  failedStep?: string;
  steps: RunReportStep[];
  statusCounts: Record<StepStatus, number>;
  totalControl: StepControl;
  totalUsage?: StepUsage;
  /** `costUnknown`: an attempt spent tokens no pricing table could price, so
   * `spent` is a lower bound and the limit was not strictly enforceable. */
  budget?: { spent: number; limit: number; costUnknown?: boolean };
  /** The exact command that lifts the stop, when one exists. It is printed
   *  undimmed and meant to be copied. */
  recovery?: string;
  resources: RunReportResource[];
  resumptions: RunReportResume[];
}

function sessionOf(step: RunStepView | undefined): AgentSession | undefined {
  return step?.session;
}

function backendFor(spec: BackendSpec | undefined, registry?: AgentBackendRegistry) {
  if (!spec || !registry) return undefined;
  try {
    return registry.resolve(spec);
  } catch {
    return undefined;
  }
}

function agentResumeHint(
  spec: BackendSpec | undefined,
  session: AgentSession,
  registry?: AgentBackendRegistry,
): string | undefined {
  if (!session.resumable) return undefined;
  return backendFor(spec, registry)?.resumeHint?.(session) ?? `${session.provider} --resume ${session.id}`;
}

function sessionLocation(
  spec: BackendSpec | undefined,
  session: AgentSession,
  registry?: AgentBackendRegistry,
): string | null {
  return backendFor(spec, registry)?.sessionLocation?.(session) ?? null;
}

export function stepResumeHint(step: RunStepView, registry?: AgentBackendRegistry): string | undefined {
  const session = sessionOf(step);
  return session ? agentResumeHint(backendSpecForStep(step.def), session, registry) : undefined;
}

/** Sessions named by an `on_failure.resume_session` policy: the session of each
 *  target step, once it exists. A fix resumed on it rewrites the fork into the
 *  target step, so this is the conversation to pick up after the run. */
function resumedSessions(run: RunView): Array<{ session: AgentSession; spec: BackendSpec; step: string }> {
  const out: Array<{ session: AgentSession; spec: BackendSpec; step: string }> = [];
  for (const step of run.steps) {
    const targetId = step.def.on_failure?.resume_session;
    if (!targetId) continue;
    const target = run.steps.find((candidate) => candidate.def.id === targetId);
    const session = sessionOf(target);
    if (!target || !session) continue;
    out.push({ session, spec: backendSpecForStep(target.def) ?? { id: session.provider }, step: target.def.name });
  }
  return out;
}

function stepDurationMs(step: RunStepView): number | undefined {
  if (step.control?.duration_ms != null) return step.control.duration_ms;
  if (!step.started_at || !step.finished_at) return undefined;
  const duration = Date.parse(step.finished_at) - Date.parse(step.started_at);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function reportKind(run: RunView, outcome: RunReportOutcome): RunReportKind {
  if (run.aborted) return "aborted";
  // A budget stop outranks a failed step: the step that carries the guard's kill
  // is the CONSEQUENCE of the stop, and headlining it as a technical error would
  // send an operator to a fix loop. `exceeded` also wins over `unaccounted`, the
  // precedence `costDecision` settled.
  if (outcome.budgetExceeded) return "budget";
  // The accounting stop ranks BELOW a genuine failure. An unpriced ledger sits
  // beside many outcomes — a step that failed for its own reason on an unpriced
  // attempt is a failure, and headlining it "Spending unaccounted" would hide the
  // reason an operator has to act on. `cost` wins only when the gate itself is
  // what withheld the work; the failed step in that case (an orchestration node
  // refused at its own gate) IS the stop, so it must not outrank it.
  const accountingStop = outcome.costUnaccountedStop === true;
  if (outcome.failed && !accountingStop && run.outcome?.failKind === "verdict") return "verdict";
  if (outcome.failed && !accountingStop) return "failure";
  if (accountingStop) return "cost";
  if (outcome.stopped) return "stopped";
  if (run.status === "PASS") return "success";
  return "unknown";
}

function headline(kind: RunReportKind, failedStep?: string): string {
  switch (kind) {
    case "success":
      return "Pipeline completed successfully";
    case "verdict":
      return `Quality check failed${failedStep ? `: ${failedStep}` : ""}`;
    case "failure":
      return `Technical error${failedStep ? ` during ${failedStep}` : ""}`;
    case "budget":
      return "Budget exceeded";
    case "cost":
      return "Spending unaccounted";
    case "stopped":
      return "Pipeline stopped cleanly";
    case "aborted":
      return "Pipeline aborted";
    default:
      return "Pipeline incomplete";
  }
}

function nextAction(kind: RunReportKind): string | undefined {
  switch (kind) {
    case "verdict":
      return "Address the verdict, then rerun the pipeline.";
    case "failure":
      return "Review the failure log or resume the session, then rerun.";
    case "budget":
      return "Increase the budget or reduce the scope before rerunning.";
    case "cost":
      // Deliberately not "increase the budget": no amount prices a closed
      // attempt. The authorization covers the unknown portion only, so the
      // sentence says what it does NOT lift.
      return "Authorize the unknown spend to resume where it stopped; the known spend still obeys the ceiling.";
    case "stopped":
      return "Address the reported stop condition before resuming.";
    case "aborted":
      return "Rerun the pipeline when ready.";
    default:
      return undefined;
  }
}

/**
 * The command that lifts an accounting stop, in the wrapper's own words — the
 * same shape the dashboard builds for its verbs, so an operator reading either
 * screen types the same line.
 *
 * Only the `cost` kind has one. `--budget <usd>` is already spelled out by the
 * budget block of the admission gate, and no other kind is lifted by a flag.
 */
function recoveryCommand(kind: RunReportKind, run: RunView): string | undefined {
  if (kind !== "cost") return undefined;
  if (!run.ticket) return "rerun with --allow-unmetered";
  const worktree = run.worktree === true ? " --worktree" : "";
  return `lancenuit run ${run.ticket} --pipeline ${run.pipeline} --allow-unmetered${worktree}`;
}

function statusCounts(steps: readonly RunStepView[]): Record<StepStatus, number> {
  const counts: Record<StepStatus, number> = {
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    aborted: 0,
    skipped: 0,
  };
  for (const step of steps) counts[step.status]++;
  return counts;
}

function resumptions(
  run: RunView,
  failed: RunStepView | undefined,
  kind: RunReportKind,
  registry?: AgentBackendRegistry,
): RunReportResume[] {
  const candidates: Array<{ step: string; session: AgentSession; spec: BackendSpec }> = [];
  const failedSession = sessionOf(failed);
  if (failed && failedSession) {
    candidates.push({
      step: failed.def.name,
      session: failedSession,
      spec: backendSpecForStep(failed.def) ?? { id: failedSession.provider },
    });
  }
  for (const resumed of resumedSessions(run)) {
    const known = candidates.some(
      ({ session }) => session.provider === resumed.session.provider && session.id === resumed.session.id,
    );
    if (!known) candidates.push(resumed);
  }
  // An interrupted run replays the step it was killed on with a fresh session, so
  // none of these commands describes what a rerun does.
  const nature: RunReportResumeNature = kind === "aborted" ? "inspect" : "resume";
  return candidates.map(({ step, session, spec }) => ({
    step,
    provider: session.provider,
    sessionId: session.id,
    command: agentResumeHint(spec, session, registry),
    location: sessionLocation(spec, session, registry) ?? undefined,
    nature,
  }));
}

export function buildRunReport(
  run: RunView,
  outcome: RunReportOutcome,
  options: { statsPath?: string | null; registry?: AgentBackendRegistry } = {},
): RunReport {
  const registry = options.registry;
  const failed =
    run.steps.find((step) => step.status === "failed") ??
    (run.outcome?.phase ? run.steps.find((step) => step.id === run.outcome!.phase) : undefined);
  const kind = reportKind(run, outcome);
  const resources: RunReportResource[] = [
    { label: "run", path: run.run_dir },
    { label: "events", path: join(run.run_dir, "events.jsonl") },
  ];
  if (options.statsPath) resources.push({ label: "stats", path: options.statsPath });
  if (run.outcome?.logPath)
    resources.push({
      label: "log",
      path: join(run.run_dir, run.outcome.logPath),
    });

  const totalControl = run.total_control ?? aggregateControl(run.steps);
  // The ledger stops at the last attempt the loop charged itself. An attempt
  // killed by a signal is closed by `closeAttempt` from the signal handler,
  // outside the loop's ledger, so the step totals can be ahead of it — and the
  // same screen would print two different amounts for the same run.
  const spent = Math.max(outcome.cumulativeCost, totalControl.total_cost_usd ?? 0);

  return {
    kind,
    pipeline: run.name || run.pipeline,
    ticket: run.ticket,
    headline: headline(kind, failed?.def.name),
    action: nextAction(kind),
    ...(recoveryCommand(kind, run) ? { recovery: recoveryCommand(kind, run) } : {}),
    issue: run.outcome?.reason ?? run.stopped_reason,
    failedStep: failed?.def.name,
    steps: run.steps.map((step) => ({
      id: step.id,
      name: step.def.name,
      status: step.status,
      durationMs: stepDurationMs(step),
      retries: step.retries,
      control: step.control,
      usage: step.usage,
      detail: step.errors,
    })),
    statusCounts: statusCounts(run.steps),
    totalControl,
    totalUsage: run.total_usage ?? aggregateUsage(run.steps),
    budget: run.max_cost_usd
      ? {
          spent,
          limit: run.max_cost_usd,
          // Read from the persisted steps AND the run-level latch: the steps are
          // the evidence, the latch survives a generation that rewrote the totals
          // those steps contributed to.
          ...(run.cost_unaccounted === true || run.steps.some((step) => step.control?.cost_unknown)
            ? { costUnknown: true }
            : {}),
        }
      : undefined,
    resources,
    resumptions: resumptions(run, failed, kind, registry),
  };
}
