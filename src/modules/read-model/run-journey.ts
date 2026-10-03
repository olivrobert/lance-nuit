// modules/read-model/run-journey.ts
//
// The whole run in time: every attempt of every step, and the pauses between a
// stop and the resume that followed it.
//
// The step list reads the snapshot, which keeps one start and one end per step
// and rewrites them on a resume; a step skipped as up to date then claims the
// whole wait. Only the journal knows when each attempt ran and when the run sat
// waiting for a human, so the Run tab draws from it instead.
//
// Like a step opened from the timeline, this read parses the whole journal: the
// Run tab asks for it while it is shown, the item's poll never does.

import type { RunJournalEvent } from "../../state/run-journal.js";
import { projectStepAttempts } from "../../state/attempt-projection.js";
import { FileRunEventStore } from "../../state/stores/file-run-event-store.js";
import { runTreePath } from "./explorer.js";
import type { ReadModelOptions } from "./projects.js";
import { resolveRun } from "./runs.js";
import { attemptView } from "./step-detail.js";
import type { RunJourney, RunJourneyAttempt, RunPause } from "./types.js";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decisionOf(value: unknown): RunPause["decision"] {
  return value === "approved" || value === "rejected" ? value : undefined;
}

/**
 * Pauses of the run, in journal order.
 *
 * A pause runs from the last line before a `run.resumed` to that resume, so a
 * runner that died without writing `run.stopped` still shows its gap. The
 * decision a resume carries is journaled right after it, before any step
 * event; one found later belongs to no pause.
 */
function pausesOf(events: RunJournalEvent[]): RunPause[] {
  const pauses: RunPause[] = [];
  let lastTs: string | undefined;
  let stopReason: string | undefined;
  let resumed: RunPause | undefined;
  for (const event of events) {
    const ts = text(event.ts);
    if (event.type === "run.resumed" && lastTs && ts) {
      resumed = { stoppedAt: lastTs, resumedAt: ts, ...(stopReason ? { reason: stopReason } : {}) };
      pauses.push(resumed);
      stopReason = undefined;
    } else if (event.type === "run.stopped") {
      stopReason = text(event.reason);
    } else if (event.type === "decision.recorded" && resumed) {
      const decision = decisionOf(event.decision);
      if (decision) resumed.decision = decision;
    } else if (event.type.startsWith("step.")) {
      resumed = undefined;
    }
    if (ts) lastTs = ts;
  }
  // A run stopped and not resumed yet is waiting now: the pause has no end.
  if (stopReason && lastTs) pauses.push({ stoppedAt: lastTs, reason: stopReason });
  return pauses;
}

/**
 * Attempts and pauses of the run `project/ticket` is currently about.
 *
 * Attempts are ordered by start, the order they ran in. Returns `undefined` for
 * the same reasons as `readSteps`: an unlisted project, a path that disappeared,
 * or a work item with no run at all.
 */
export function readRunJourney(
  projectName: string,
  ticket: string,
  options: ReadModelOptions = {},
): RunJourney | undefined {
  const resolved = resolveRun(projectName, ticket, options);
  if (!resolved) return undefined;
  const { runDir, state, pipeline } = resolved.run;
  const events = new FileRunEventStore().readAt(runDir);
  const treePathOf = (inRun: string): string => runTreePath(resolved.workItemDir, runDir, inRun);

  const attempts: RunJourneyAttempt[] = [];
  for (const [stepId, stepAttempts] of projectStepAttempts(events)) {
    for (const attempt of stepAttempts) attempts.push({ stepId, ...attemptView(attempt, treePathOf) });
  }
  attempts.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  const startedAt = text(state.createdAt);

  return {
    pipeline,
    runId: state.runId ?? "",
    status: resolved.status,
    ...(startedAt ? { startedAt } : {}),
    ...(typeof state.max_cost_usd === "number" ? { maxCostUsd: state.max_cost_usd } : {}),
    attempts,
    pauses: pausesOf(events),
  };
}
