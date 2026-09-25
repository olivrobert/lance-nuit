// modules/read-model/steps.ts
//
// Where a run stands, step by step.
//
// `state.json` is the resume source of truth, so it is also the honest answer to
// "how far did it get": the step list, in pipeline order, with the status the
// runner last persisted. The journal answers a different question — "is anything
// happening right now" — and only for a run still in flight, where the snapshot
// is by definition behind. So the last journal line is read for a RUNNING run and
// for no other: on a finished run it would say what the snapshot already says,
// one file later.

import type { StepFailCause, StepFailKind } from "../../contracts/backends.js";
import type { RawJournalEvent, RunJournalKnownEvent } from "../../model/journal.js";
import type { PersistedStepState } from "../../model/persisted.js";
import { FileRunEventStore } from "../../state/stores/file-run-event-store.js";
import type { ReadModelOptions } from "./projects.js";
import { resolveRun } from "./runs.js";
import type { ItemFailCause, ItemFailKind, RunEventView, RunStepStatus, RunStepsView, RunStepView } from "./types.js";

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

function stepView(step: PersistedStepState): RunStepView {
  const failKind = failKindOf(step.fail_kind);
  const failCause = failCauseOf(step.fail_cause);
  return {
    id: step.id,
    status: stepStatusOf(step),
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
  return {
    pipeline: resolved.run.pipeline,
    runId: resolved.run.state.runId ?? "",
    runDir: resolved.run.runDir,
    status: resolved.status,
    steps: resolved.run.state.steps.map(stepView),
    ...(event ? { lastEvent: event } : {}),
  };
}
