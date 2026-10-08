// modules/read-model/steps.ts
//
// Where a run stands, step by step.
//
// The step list answers "how far did it get" the way a resume would: the
// snapshot's steps, in pipeline order, reconciled with the journal by the
// runner's own projection (`projectRunState`). The snapshot is written after
// each event, so a crash between the two leaves a terminal status in the journal
// alone; only a step the snapshot left pending or running can move, so the whole
// journal is read only when one is.
//
// The journal also answers "is anything happening right now", and only for a run
// a live runner holds, where the snapshot is by definition behind. So its last
// line is read for a RUNNING run and for no other: on a finished run it would say
// what the snapshot already says, and on a run whose runner died it would present
// a dead line as current activity.

import type { StepFailCause, StepFailKind } from "../../contracts/backends.js";
import type { RawJournalEvent, RunJournalKnownEvent } from "../../model/journal.js";
import type { PersistedRun, PersistedStepState } from "../../model/persisted.js";
import { projectRunState } from "../../state/run-projection.js";
import { FileRunEventStore } from "../../state/stores/file-run-event-store.js";
import type { ReadModelOptions } from "./projects.js";
import { resolveRun } from "./runs.js";
import type {
  CoderSessionRead,
  ItemFailCause,
  ItemFailKind,
  RunEventView,
  RunStepStatus,
  RunStepsView,
  RunStepView,
} from "./types.js";

/** Profile of the steps that write the code: their session is the one a human
 *  picks up to understand or continue what the agent did. */
const CODER_PROFILE = "coder";

/** Read window for the journal tail. Enough for the last events of any run
 *  without loading a journal that grew to megabytes. */
const TAIL_BYTES = 64 * 1024;

/** Persisted step status in the dashboard's vocabulary; shared with the recap so
 *  both views name a step's state the same way. */
export function stepStatusOf(step: PersistedStepState): RunStepStatus {
  switch (step.status) {
    case "pending":
    case "running":
    case "done":
    case "failed":
    case "skipped":
    case "aborted":
      return step.status;
    default:
      // A status written by a newer runner is shown as pending rather than
      // dropped: the step exists, and nothing is claimed about it.
      return "pending";
  }
}

/** The runner's failure kinds in the dashboard's words. */
function failKindOf(kind: StepFailKind | undefined): ItemFailKind | undefined {
  if (kind === "verdict") return "judgment";
  if (kind === "technical") return "incident";
  return undefined;
}

/** A cause nothing can repair, shown beside the kind rather than folded into it:
 *  "incident" sends a reader to the logs, "blocked" to the environment. */
function failCauseOf(cause: StepFailCause | undefined): ItemFailCause | undefined {
  return cause === "blocked" ? "blocked" : undefined;
}

/** A step still `running` in a run whose runner died runs nowhere: it is shown
 *  `aborted`, as the runner writes the step it was in when it is interrupted. */
function stepView(step: PersistedStepState, interrupted: boolean): RunStepView {
  const failKind = failKindOf(step.fail_kind);
  const failCause = failCauseOf(step.fail_cause);
  const status = stepStatusOf(step);
  return {
    id: step.id,
    status: interrupted && status === "running" ? "aborted" : status,
    ...(step.started_at ? { startedAt: step.started_at } : {}),
    ...(step.finished_at ? { finishedAt: step.finished_at } : {}),
    ...(typeof step.retries === "number" && step.retries > 0 ? { retries: step.retries } : {}),
    ...(failKind ? { failKind } : {}),
    ...(failCause ? { failCause } : {}),
    ...(step.errors ? { error: step.errors } : {}),
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `stepId` exists on some journal variants and on any raw line; `in` narrows
 *  both sides of the envelope without a cast. */
function eventView(event: RawJournalEvent | RunJournalKnownEvent): RunEventView {
  const stepId = "stepId" in event ? text(event.stepId) : undefined;
  return {
    type: event.type,
    ...(text(event.ts) ? { at: event.ts } : {}),
    ...(stepId ? { stepId } : {}),
  };
}

/** Last line of `events.jsonl`, or `undefined` when the journal is absent, empty,
 *  or made only of lines no reader can parse.
 *
 *  Read from `entries`, not from `events`: the journal is also the live feed, and
 *  the answer to "is anything happening right now" is usually one of the feed's
 *  own lines, which the journal contract does not describe. */
function lastEvent(runDir: string): RunEventView | undefined {
  const page = new FileRunEventStore().readTailAt(runDir, { maxBytes: TAIL_BYTES });
  const entry = page.entries.at(-1);
  return entry ? eventView(entry.event) : undefined;
}

/** The snapshot's steps as the runner projects them with its journal, in
 *  snapshot order. Steps the journal alone knows are left out: the list shows
 *  the pipeline the snapshot describes. */
function projectedSteps(runDir: string, state: PersistedRun): PersistedStepState[] {
  if (!state.steps.some((step) => step.status === "pending" || step.status === "running")) return state.steps;
  let events: ReturnType<FileRunEventStore["readAt"]>;
  try {
    events = new FileRunEventStore().readAt(runDir);
  } catch {
    // An unreadable journal costs the reconciliation, not the step list: the
    // snapshot is still what the runner last persisted.
    return state.steps;
  }
  const projected = projectRunState(state, events);
  return state.steps.map((step) => projected.steps.get(step.id)?.state ?? step);
}

/**
 * Steps of the run `project/ticket` is currently about.
 *
 * Returns `undefined` for the same reasons as `readItem`: an unlisted project, a
 * path that disappeared, or a work item with no run at all.
 */
export function readSteps(
  projectName: string,
  ticket: string,
  options: ReadModelOptions = {},
): RunStepsView | undefined {
  const resolved = resolveRun(projectName, ticket, options);
  if (!resolved) return undefined;

  const event = resolved.status === "RUNNING" ? lastEvent(resolved.run.runDir) : undefined;
  const coder = coderStepOf(resolved.run.state.steps);
  return {
    pipeline: resolved.run.pipeline,
    runId: resolved.run.state.runId ?? "",
    runDir: resolved.run.runDir,
    status: resolved.status,
    steps: projectedSteps(resolved.run.runDir, resolved.run.state).map((step) => stepView(step, resolved.interrupted)),
    ...(event ? { lastEvent: event } : {}),
    ...(coder ? { coderStep: coder.id } : {}),
  };
}

/** The last coder step, in pipeline order, holding a session its provider can
 *  resume. The last one: in a pipeline coding lot after lot, it is the
 *  conversation that wrote the latest code. */
function coderStepOf(steps: PersistedStepState[]): CoderStep | undefined {
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    if (step?.profile === CODER_PROFILE && step.session?.resumable === true && step.session.id !== "") {
      return { id: step.id, session: step.session };
    }
  }
  return undefined;
}

interface CoderStep {
  id: string;
  session: NonNullable<PersistedStepState["session"]>;
}

/**
 * The coder session of the run `project/ticket` is currently about, or
 * `undefined` when there is no such run or no coder step with a resumable
 * session in it.
 */
export function readCoderSession(
  projectName: string,
  ticket: string,
  options: ReadModelOptions = {},
): CoderSessionRead | undefined {
  const resolved = resolveRun(projectName, ticket, options);
  if (!resolved) return undefined;
  const coder = coderStepOf(resolved.run.state.steps);
  if (!coder) return undefined;
  return {
    pipeline: resolved.run.pipeline,
    runId: resolved.run.state.runId ?? "",
    status: resolved.status,
    stepId: coder.id,
    provider: coder.session.provider,
    sessionId: coder.session.id,
    cwd: resolved.cwd,
    worktree: resolved.run.state.worktree === true,
  };
}
