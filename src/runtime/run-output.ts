// runner/runtime/run-output.ts
//
// Port of the structured run output, and the two destinations that only depend on
// the runtime itself. Presentation destinations (console, live feed, status line)
// stay in `output/`; the step loop only ever sees this interface.

import { emitRunnerEvent, type RunnerEvent } from "./events.js";

/** A destination for structured run output. Implementations must be best effort:
 * output failures must never change the pipeline result. */
export interface RunOutput {
  emit(event: RunnerEvent): void;
}

/** Fan out one event to all destinations. A broken destination is isolated from
 * the other outputs, just like the runtime event bus. */
export class CompositeRunOutput implements RunOutput {
  constructor(private readonly outputs: readonly RunOutput[]) {}

  emit(event: RunnerEvent): void {
    for (const output of this.outputs) {
      try {
        output.emit(event);
      } catch {
        // Observability is deliberately non-blocking.
      }
    }
  }
}

/** Adapter retaining the existing event bus for backend-owned events. */
export class RunnerEventOutput implements RunOutput {
  emit(event: RunnerEvent): void {
    emitRunnerEvent(event);
  }
}

/** Destination that drops everything. The output is a required dependency of the
 * step loop, so a caller that wants no output says so explicitly instead of
 * omitting it and inheriting a global default. */
export const NULL_RUN_OUTPUT: RunOutput = new CompositeRunOutput([]);
