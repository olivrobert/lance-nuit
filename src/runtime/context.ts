// runtime/context.ts
//
import type { ActivityRunnerEvent, ContextRunnerEvent } from "./events.js";

// PURE helpers (no I/O) for the context occupancy of a Claude session.
// The measurement remains observable; it no longer drives execution.
//
// Context occupancy = footprint of the LAST turn:
//   input + cache_read + cache_creation
// (NOT output, NOT the sum of turns — that is cost, see stream.ts.)

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Tokens occupying the context window at THIS turn (the sent prompt). */
export function contextTokensFromUsage(u?: ClaudeUsage | null): number {
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

/** Build a context event (written to the events.jsonl journal). */
export function contextEvent(
  occupancy: number,
  window: number,
  model: string | undefined,
  timestamp: number,
): ContextRunnerEvent {
  return {
    type: "runner-event",
    event: "context",
    tokens: occupancy,
    window,
    pct: window > 0 ? occupancy / window : 0,
    model,
    timestamp,
  };
}

/** Build an activity event (the tool the agent just invoked). */
export function activityEvent(label: string, tool: string, timestamp: number): ActivityRunnerEvent {
  return { type: "runner-event", event: "activity", label, tool, timestamp };
}
