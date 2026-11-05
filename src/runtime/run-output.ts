// runner/runtime/run-output.ts
//
// Port of the structured run output, its step events, and the destinations that
// only depend on the runtime itself. Presentation destinations (console, live feed,
// status line) stay in `output/`; the step loop only ever sees this interface.

import type { RunStepView } from "../model/run.js";
import type { RunnerEvent } from "./events.js";

/** Step progress emitted by the step loop. It travels on `RunOutput` and never on
 * the process-wide bus, whose publishers (agent backends included) know nothing of
 * a run; a run can still have several observers (console, JSONL, tests) without the
 * loop knowing where a message is rendered. */
export interface StepStartedEvent {
  type: "step.started";
  step: RunStepView;
  index: number;
  total: number;
}

export interface StepSessionEvent {
  type: "step.session";
  step: RunStepView;
  sessionId: string;
}

export interface StepLogsEvent {
  type: "step.logs";
  step: RunStepView;
  path: string;
  live: boolean;
}

export interface StepDoneEvent {
  type: "step.done";
  step: RunStepView;
  suffix?: string;
}

export interface StepFailedEvent {
  type: "step.failed";
  step: RunStepView;
  suffix?: string;
}

/** What a destination receives: the step events, plus what the bus carries. */
export type RunOutputEvent =
  | RunnerEvent
  | StepStartedEvent
  | StepSessionEvent
  | StepLogsEvent
  | StepDoneEvent
  | StepFailedEvent;

/** A destination for structured run output. Implementations must be best effort:
 * output failures must never change the pipeline result. */
export interface RunOutput {
  emit(event: RunOutputEvent): void;
}

/** Fan out one event to all destinations. A broken destination is isolated from
 * the other outputs, just like the runtime event bus. */
export class CompositeRunOutput implements RunOutput {
  constructor(private readonly outputs: readonly RunOutput[]) {}

  emit(event: RunOutputEvent): void {
    for (const output of this.outputs) {
      try {
        output.emit(event);
      } catch {
        // Observability is deliberately non-blocking.
      }
    }
  }
}

/** Destination that drops everything. The output is a required dependency of the
 * step loop, so a caller that wants no output says so explicitly instead of
 * omitting it and inheriting a global default. */
export const NULL_RUN_OUTPUT: RunOutput = new CompositeRunOutput([]);
