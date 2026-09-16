// runtime/events.ts
//
// In-process runner event bus. Live-feed writing is no longer wired into emission:
// it is one subscriber among others, registered when the module loads so the
// default behavior remains exactly as before (one JSON line per event, in order).
// It writes to the feed configured on `runtime/live-feed.ts`, never to an adapter
// it builds itself: the bus knows the port, not the file.
//
// This is also the destination for observability middleware in the attempt chain
// (attempt-chain.ts): they publish here instead of writing inside caller loops.

import type { RunStep } from "../model/run.js";
import { configuredLiveFeed, type LiveFeed } from "./live-feed.js";

/** Normalized spawn event for dashboards that do not need to know about Claude. */
export interface AgentSpawnEvent {
  type: "runner-event";
  event: "agent-spawn";
  provider: string;
  model?: string;
  timestamp: number;
}

export interface ContextRunnerEvent {
  type: "runner-event";
  event: "context";
  tokens: number;
  window: number;
  pct: number;
  model?: string;
  timestamp: number;
}

/** A tool call observed on the backend stream, published while the step runs.
 * It carries what the agent is doing right now, not what it has produced. */
export interface ActivityRunnerEvent {
  type: "runner-event";
  event: "activity";
  /** Human-readable form, e.g. `Read server.ts` or `skill(db-migration)`. */
  label: string;
  tool: string;
  timestamp: number;
}

/** API overload absorbed by the Claude backend; a new spawn is scheduled. */
export interface TransportRetryEvent {
  type: "runner-event";
  event: "transport-retry";
  /** `api_error_status` from the CLI (529, 503…) when provided. */
  status?: number;
  attempt: number;
  of: number;
  delayMs: number;
  timestamp: number;
}

export interface PipelineStepEvent {
  type: "pipeline-step";
  id: string;
  name: string;
  index: number;
  total: number;
  pipeline: string;
  ticket?: string;
}

/** Output events emitted by the step loop.  Keeping these on the existing event
 * bus means a run can have several observers (console, JSONL, tests) without
 * making the loop know where a message is rendered. */
export interface StepStartedEvent {
  type: "step.started";
  step: RunStep;
  index: number;
  total: number;
}

export interface StepSessionEvent {
  type: "step.session";
  step: RunStep;
  sessionId: string;
}

export interface StepLogsEvent {
  type: "step.logs";
  step: RunStep;
  path: string;
  live: boolean;
}

export interface StepDoneEvent {
  type: "step.done";
  step: RunStep;
  suffix?: string;
}

export interface StepFailedEvent {
  type: "step.failed";
  step: RunStep;
  suffix?: string;
}

/** Severity of an execution message. It qualifies the message, not the run: a
 *  `warn` says a gate degraded something, never that the run ends badly. The
 *  glyph each level renders as lives in `runtime/logging.ts`. */
export type RunnerMessageLevel = "info" | "warn" | "error";

/** Prose from the execution path, carried on the typed bus so every destination
 *  sees it: the console renders it with the glyph of its `level`, the live feed
 *  serializes it as-is, and the severity is readable by machine. */
export interface RunnerMessageEvent {
  type: "runner.message";
  level: RunnerMessageLevel;
  message: string;
}

/** Events whose schema is owned by the runner; the Claude stream remains raw. */
export type RunnerEvent =
  | AgentSpawnEvent
  | ContextRunnerEvent
  | ActivityRunnerEvent
  | TransportRetryEvent
  | PipelineStepEvent
  | StepStartedEvent
  | StepSessionEvent
  | StepLogsEvent
  | StepDoneEvent
  | StepFailedEvent
  | RunnerMessageEvent;

export type RunnerEventSubscriber = (event: RunnerEvent) => void;

/** A subscription is identified by its entry, never by the function: the same
 *  subscriber may register twice (two middleware sharing a handler), and each
 *  unsubscribe must remove only its own entry. An unsubscribe after reset cannot
 *  affect the new list. */
interface Subscription {
  readonly fn: RunnerEventSubscriber;
}

/** One JSON line per event, append-only. Only the feed configured through
 *  `setRunnerLiveFeed` is written: the bus no longer builds an adapter from the
 *  environment, which is `entry/`'s job (see entry/startup.ts). */
export function writeEventToLiveFeed(event: RunnerEvent, feed: LiveFeed | undefined = configuredLiveFeed()): void {
  feed?.append({ ts: new Date().toISOString(), ...event });
}

/** The bus's production state, restored by test resets. */
const DEFAULT_SUBSCRIBERS: readonly RunnerEventSubscriber[] = [writeEventToLiveFeed];

let subscriptions: Subscription[] = DEFAULT_SUBSCRIBERS.map((fn) => ({ fn }));

/** Register a subscriber and return its (idempotent) unsubscribe function. */
export function subscribe(fn: RunnerEventSubscriber): () => void {
  const entry: Subscription = { fn };
  subscriptions.push(entry);
  return () => {
    const i = subscriptions.indexOf(entry);
    if (i !== -1) subscriptions.splice(i, 1);
  };
}

/** Reset the bus to its default state. Otherwise a subscriber left by one test
 *  would see the next test's events. Pass an explicit list (`[]`) when nothing
 *  should be written to disk. */
export function resetRunnerEventBus(subscribers: readonly RunnerEventSubscriber[] = DEFAULT_SUBSCRIBERS): void {
  subscriptions = subscribers.map((fn) => ({ fn }));
}

/** SYNCHRONOUS dispatch in subscription order: when this returns, all subscribers
 *  have been called. No microtask or queue—the runner may be killed immediately
 *  after emission (timeout, budget, exhausted context), losing deferred events.
 *
 *  Iterate over a snapshot: subscribing or unsubscribing during dispatch must not
 *  shift the index and skip a neighboring event. Like EventEmitter, a subscriber
 *  added during dispatch receives events starting next time; an unsubscribed one
 *  still receives the current event.
 *
 *  Isolation is PER subscriber, not global: a try/catch around the loop would mute
 *  the rest of the list after the first throw. The bus is best-effort—degraded
 *  observability is always preferable to an interrupted run. */
export function emitRunnerEvent(event: RunnerEvent): void {
  for (const { fn } of [...subscriptions]) {
    try {
      fn(event);
    } catch {
      // A failing subscriber only affects itself.
    }
  }
}

/** Publishes the normalized spawn event; every backend host emits it identically. */
export function emitAgentSpawn(event: { provider: string; model?: string; timestamp: number }): void {
  emitRunnerEvent({
    type: "runner-event",
    event: "agent-spawn",
    provider: event.provider,
    ...(event.model ? { model: event.model } : {}),
    timestamp: event.timestamp,
  });
}
