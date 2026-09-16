// runner/output/run-output.ts
//
// Presentation destinations for the `RunOutput` port declared in
// `runtime/run-output.ts`: the JSONL live feed and the human-readable console.

import type {
  RunnerEvent,
  RunnerMessageEvent,
  StepDoneEvent,
  StepFailedEvent,
  StepLogsEvent,
  StepSessionEvent,
  StepStartedEvent,
} from "../runtime/events.js";
import type { LiveFeed } from "../runtime/live-feed.js";
import { withSeverityGlyph, writeStderr } from "../runtime/logging.js";
import type { RunOutput } from "../runtime/run-output.js";
import { logStepDone, logStepFailed, logStepLogs, logStepSession, logStepStarted } from "./console-reporter.js";

/** Direct JSONL destination for callers that do not want to use the global event
 * bus. The timestamp is added at the boundary, keeping emitted events deterministic
 * and easy to assert in tests. */
export class LiveFeedOutput implements RunOutput {
  constructor(private readonly feed: LiveFeed) {}

  emit(event: RunnerEvent): void {
    this.feed.append({ ts: new Date().toISOString(), ...liveEvent(event) });
  }
}

/** Keep the JSONL feed a useful event stream rather than serializing the entire
 * mutable RunStep (which can contain prompts and backend definitions). */
function liveEvent(event: RunnerEvent): Record<string, unknown> {
  if (!("step" in event)) return { ...event };
  const { step, ...rest } = event;
  return {
    ...rest,
    stepId: step.id,
    name: step.def.name,
    ...(step.control ? { control: step.control } : {}),
    ...(step.usage ? { usage: step.usage } : {}),
  };
}

/** Human-readable step progress destination. It intentionally ignores backend
 * telemetry; stream formatters remain the owner of that presentation. */
export class ConsoleRunOutput implements RunOutput {
  emit(event: RunnerEvent): void {
    switch (event.type) {
      case "step.started":
        renderStepStarted(event);
        break;
      case "step.session":
        renderStepSession(event);
        break;
      case "step.logs":
        renderStepLogs(event);
        break;
      case "step.done":
        renderStepDone(event);
        break;
      case "step.failed":
        renderStepFailed(event);
        break;
      case "runner.message":
        renderRunnerMessage(event);
        break;
      default:
        break;
    }
  }
}

/** Severity becomes a glyph here and nowhere else in `output/`: the table lives
 * with the stderr writer (`runtime/logging.ts`), which the direct `log.warn`
 * path shares. `writeStderr` rather than `log()`, so a message that reached this
 * destination through the bus cannot be re-published onto it. */
function renderRunnerMessage(event: RunnerMessageEvent): void {
  writeStderr(`${withSeverityGlyph(event.level, event.message)}\n`);
}

function renderStepStarted(event: StepStartedEvent): void {
  logStepStarted(event.step, event.index, event.total);
}

function renderStepSession(event: StepSessionEvent): void {
  logStepSession(event.sessionId);
}

function renderStepLogs(event: StepLogsEvent): void {
  logStepLogs(event.path, event.live);
}

function renderStepDone(event: StepDoneEvent): void {
  logStepDone(event.step, event.suffix ?? "");
}

function renderStepFailed(event: StepFailedEvent): void {
  logStepFailed(event.step, event.suffix ?? "");
}
