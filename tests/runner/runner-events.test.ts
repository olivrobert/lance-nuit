import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLiveFeed } from "../../src/output/live-feed.js";
import { emitRunnerEvent, type RunnerEvent, resetRunnerEventBus, subscribe } from "../../src/runtime/events.js";
import { setRunnerLiveFeed } from "../../src/runtime/live-feed.js";

// The bus is a module singleton: without reset, a subscriber left by one case
// would see the next case's events and pass a test for the wrong reason.
afterEach(() => {
  setRunnerLiveFeed(undefined);
  resetRunnerEventBus();
});

const SPAWN: RunnerEvent = {
  type: "runner-event",
  event: "agent-spawn",
  provider: "claude",
  model: "sonnet",
  timestamp: 1,
};

/** The configured feed is process-global, like the bus: each case installs a fresh
 *  one and clears it, or test-file order changes results. The environment is kept
 *  in sync because that is what `entry/startup.ts` reads to build the feed it
 *  installs — but the bus itself only ever sees the injected port. */
function withLiveFeed<T>(fn: (feed: string) => T, feed?: string): T {
  const previous = process.env.RUNNER_LIVE_FEED;
  const previousEvents = process.env.RUNNER_EVENTS_FILE;
  delete process.env.RUNNER_EVENTS_FILE;
  process.env.RUNNER_LIVE_FEED = feed ?? join(mkdtempSync(join(tmpdir(), "runner-events-")), "live.jsonl");
  setRunnerLiveFeed(new FileLiveFeed(process.env.RUNNER_LIVE_FEED));
  try {
    return fn(process.env.RUNNER_LIVE_FEED);
  } finally {
    setRunnerLiveFeed(undefined);
    if (previous == null) delete process.env.RUNNER_LIVE_FEED;
    else process.env.RUNNER_LIVE_FEED = previous;
    if (previousEvents == null) delete process.env.RUNNER_EVENTS_FILE;
    else process.env.RUNNER_EVENTS_FILE = previousEvents;
  }
}

function feedLines(file: string): unknown[] {
  return readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .map((line) => {
      const { ts: _ts, ...event } = JSON.parse(line) as Record<string, unknown>;
      return event;
    });
}

test("emitRunnerEvent appends runner-owned events", () => {
  withLiveFeed((file) => {
    emitRunnerEvent({ type: "runner-event", event: "agent-spawn", provider: "claude", model: "sonnet", timestamp: 1 });
    emitRunnerEvent({ type: "runner-event", event: "context", tokens: 10, window: 100, pct: 0.1, timestamp: 2 });
    emitRunnerEvent({
      type: "pipeline-step",
      id: "quality.tests",
      name: "Tests",
      index: 2,
      total: 3,
      pipeline: "default",
    });
    expect(feedLines(file)).toEqual([
      { type: "runner-event", event: "agent-spawn", provider: "claude", model: "sonnet", timestamp: 1 },
      { type: "runner-event", event: "context", tokens: 10, window: 100, pct: 0.1, timestamp: 2 },
      { type: "pipeline-step", id: "quality.tests", name: "Tests", index: 2, total: 3, pipeline: "default" },
    ]);
  });
});

test("the feed subscriber is registered by default", () => {
  withLiveFeed((file) => {
    emitRunnerEvent(SPAWN);
    expect(feedLines(file)).toEqual([SPAWN]);
  });
});

test("the feed subscriber writes to the injected port, not to the environment", () => {
  withLiveFeed((replaced) => {
    const injected = join(mkdtempSync(join(tmpdir(), "runner-events-injected-")), "events.jsonl");
    setRunnerLiveFeed(new FileLiveFeed(injected));
    emitRunnerEvent(SPAWN);
    expect(feedLines(injected)).toEqual([SPAWN]);
    expect(existsSync(replaced)).toBe(false);
  });
});

test("the environment alone does not feed the bus", () => {
  // The bus knows the LiveFeed port, never a file: a process that never calls
  // `setRunnerLiveFeed` writes nowhere. `entry/startup.ts` installs the feed built
  // from the environment, which is what keeps child runs writing to their parent.
  const path = join(mkdtempSync(join(tmpdir(), "runner-events-env-")), "live.jsonl");
  const previous = process.env.RUNNER_LIVE_FEED;
  const previousEvents = process.env.RUNNER_EVENTS_FILE;
  delete process.env.RUNNER_EVENTS_FILE;
  process.env.RUNNER_LIVE_FEED = path;
  try {
    emitRunnerEvent(SPAWN);
    expect(existsSync(path)).toBe(false);
  } finally {
    if (previous == null) delete process.env.RUNNER_LIVE_FEED;
    else process.env.RUNNER_LIVE_FEED = previous;
    if (previousEvents != null) process.env.RUNNER_EVENTS_FILE = previousEvents;
  }
});

test("events reach every subscriber in registration order", () => {
  resetRunnerEventBus([]);
  const calls: string[] = [];
  subscribe(() => calls.push("first"));
  subscribe(() => calls.push("second"));
  subscribe(() => calls.push("third"));
  emitRunnerEvent(SPAWN);
  expect(calls).toEqual(["first", "second", "third"]);
});

test("a subscriber receives the original event without copying or serialization", () => {
  resetRunnerEventBus([]);
  const seen: RunnerEvent[] = [];
  subscribe((e) => seen.push(e));
  emitRunnerEvent(SPAWN);
  expect(seen[0]).toBe(SPAWN);
});

test("an unsubscribed listener stops receiving events while others continue", () => {
  resetRunnerEventBus([]);
  const kept: RunnerEvent[] = [];
  const dropped: RunnerEvent[] = [];
  subscribe((e) => kept.push(e));
  const unsubscribe = subscribe((e) => dropped.push(e));
  emitRunnerEvent(SPAWN);
  unsubscribe();
  emitRunnerEvent(SPAWN);
  expect(kept.length).toBe(2);
  expect(dropped.length).toBe(1);
});

test("calling unsubscribe twice does not remove another subscriber", () => {
  resetRunnerEventBus([]);
  const calls: string[] = [];
  const unsubscribe = subscribe(() => calls.push("a"));
  subscribe(() => calls.push("b"));
  unsubscribe();
  unsubscribe();
  emitRunnerEvent(SPAWN);
  expect(calls).toEqual(["b"]);
});

test("a throwing subscriber neither interrupts the run nor blocks later subscribers", () => {
  resetRunnerEventBus([]);
  const after: string[] = [];
  subscribe(() => {
    throw new Error("broken subscriber");
  });
  subscribe(() => after.push("suivant"));
  expect(() => emitRunnerEvent(SPAWN)).not.toThrow();
  expect(after).toEqual(["suivant"]);
});

test("a throwing subscriber does not prevent feed writes", () => {
  withLiveFeed((file) => {
    subscribe(() => {
      throw new Error("broken subscriber");
    });
    emitRunnerEvent(SPAWN);
    expect(feedLines(file)).toEqual([SPAWN]);
  });
});

test("an unavailable feed remains silent and allows other subscribers", () => {
  const root = mkdtempSync(join(tmpdir(), "runner-events-"));
  const blocker = join(root, "not-a-directory");
  writeFileSync(blocker, "x");
  const missing = join(blocker, "live.jsonl");
  withLiveFeed(() => {
    const seen: RunnerEvent[] = [];
    subscribe((e) => seen.push(e));
    expect(() => emitRunnerEvent(SPAWN)).not.toThrow();
    expect(seen).toEqual([SPAWN]);
    expect(existsSync(missing)).toBe(false);
  }, missing);
});

test("missing injected and configured feeds remain silent", () => {
  const previousLive = process.env.RUNNER_LIVE_FEED;
  const previousEvents = process.env.RUNNER_EVENTS_FILE;
  delete process.env.RUNNER_LIVE_FEED;
  delete process.env.RUNNER_EVENTS_FILE;
  const seen: RunnerEvent[] = [];
  subscribe((event) => seen.push(event));
  try {
    expect(() => emitRunnerEvent(SPAWN)).not.toThrow();
    expect(seen).toEqual([SPAWN]);
  } finally {
    if (previousLive != null) process.env.RUNNER_LIVE_FEED = previousLive;
    if (previousEvents != null) process.env.RUNNER_EVENTS_FILE = previousEvents;
  }
});

test("the feed path is resolved on emission rather than registration", () => {
  // Real case: the module loads (and registers the feed subscriber) before
  // entry/feed.ts knows the run directory. Reading the configured feed once at
  // registration would pin the first feed for the whole process.
  const first = withLiveFeed((file) => {
    emitRunnerEvent(SPAWN);
    return file;
  });
  const second = withLiveFeed((file) => {
    emitRunnerEvent({ ...SPAWN, timestamp: 2 });
    return file;
  });
  expect(second).not.toBe(first);
  expect(feedLines(first)).toEqual([SPAWN]);
  expect(feedLines(second)).toEqual([{ ...SPAWN, timestamp: 2 }]);
});

test("resetRunnerEventBus restores the feed subscriber and clears test subscribers", () => {
  const calls: string[] = [];
  resetRunnerEventBus([]);
  subscribe(() => calls.push("test"));
  resetRunnerEventBus();
  withLiveFeed((file) => {
    emitRunnerEvent(SPAWN);
    expect(calls).toEqual([]);
    expect(feedLines(file)).toEqual([SPAWN]);
  });
});

test("a subscriber registered during emission starts with the next event", () => {
  // Snapshot guard: mutating the list during iteration would skip a neighboring
  // event, the worst failure mode for an observability bus.
  resetRunnerEventBus([]);
  const late: RunnerEvent[] = [];
  const others: string[] = [];
  subscribe(() => {
    if (others.length === 0) subscribe((e) => late.push(e));
    others.push("first");
  });
  subscribe(() => others.push("second"));
  emitRunnerEvent(SPAWN);
  expect(others).toEqual(["first", "second"]);
  expect(late).toEqual([]);
  emitRunnerEvent(SPAWN);
  expect(late.length).toBe(1);
});
