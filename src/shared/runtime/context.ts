//
import type { ActivityRunnerEvent, ContextRunnerEvent } from "./events.js";

// PURE builders (no I/O) of the stream telemetry every backend publishes. Each
// backend measures the occupancy off its own stream; these only shape the events.

/** Build a context event (written to the events.jsonl journal). */
export function contextEvent(
  occupancy: number,
  window: number,
  model: string | undefined,
  timestamp: number,
  stepId?: string,
): ContextRunnerEvent {
  return {
    type: "runner-event",
    event: "context",
    tokens: occupancy,
    window,
    pct: window > 0 ? occupancy / window : 0,
    model,
    timestamp,
    ...(stepId ? { stepId } : {}),
  };
}

/** Build an activity event (the tool the agent just invoked). */
export function activityEvent(label: string, tool: string, timestamp: number, stepId?: string): ActivityRunnerEvent {
  return { type: "runner-event", event: "activity", label, tool, timestamp, ...(stepId ? { stepId } : {}) };
}
