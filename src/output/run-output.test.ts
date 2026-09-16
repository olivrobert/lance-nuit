import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerEvent, RunnerMessageLevel } from "../runtime/events.js";
import { setRunnerLiveFeed } from "../runtime/live-feed.js";
import { setLogInterceptor } from "../runtime/logging.js";
import { CompositeRunOutput, RunnerEventOutput } from "../runtime/run-output.js";
import { makeRunStep } from "../state/run-step.ts";
import { FileLiveFeed } from "./live-feed.ts";
import { ConsoleRunOutput, LiveFeedOutput } from "./run-output.ts";

afterEach(() => {
  setRunnerLiveFeed(undefined);
  setLogInterceptor(undefined);
});

/** Capture what `ConsoleRunOutput` writes to stderr, plus one stack trace per
 *  write taken from the log interceptor — the hook every stderr write of the
 *  runner passes through. */
function captureStderr(render: () => void): { lines: string[]; stacks: string[] } {
  const original = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  const stacks: string[] = [];
  setLogInterceptor(() => stacks.push(new Error().stack ?? ""));
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    render();
  } finally {
    process.stderr.write = original;
    setLogInterceptor(undefined);
  }
  return { lines, stacks };
}

function feedPath(): string {
  return join(mkdtempSync(join(tmpdir(), "run-output-")), "events.jsonl");
}

test("CompositeRunOutput fans out synchronously and isolates failures", () => {
  const seen: string[] = [];
  const output = new CompositeRunOutput([
    { emit: () => seen.push("first") },
    {
      emit: () => {
        throw new Error("unavailable destination");
      },
    },
    { emit: () => seen.push("last") },
  ]);

  output.emit({ type: "runner.message", level: "info", message: "hello" });
  expect(seen).toEqual(["first", "last"]);
});

test("every destination sees every event in composite order and in emission order", () => {
  const first: string[] = [];
  const second: string[] = [];
  const output = new CompositeRunOutput([
    { emit: (e: RunnerEvent) => first.push(`1:${e.type}`) },
    { emit: (e: RunnerEvent) => second.push(`2:${e.type}`) },
  ]);

  output.emit({ type: "runner.message", level: "info", message: "a" });
  output.emit({ type: "runner.message", level: "warn", message: "b" });

  expect(first).toEqual(["1:runner.message", "1:runner.message"]);
  expect(second).toEqual(["2:runner.message", "2:runner.message"]);
});

test("LiveFeedOutput writes compact step events", () => {
  const path = feedPath();
  const step = makeRunStep({ id: "check", name: "Check", command: "true", runner: "bash" });
  new LiveFeedOutput(new FileLiveFeed(path)).emit({ type: "step.done", step, suffix: " (test)" });

  const event = JSON.parse(readFileSync(path, "utf8"));
  expect(event.type).toBe("step.done");
  expect(event.stepId).toBe("check");
  expect(event.name).toBe("Check");
  expect(event.step).toBeUndefined();
});

test("a step event configured on the same feed is written exactly once", () => {
  // `wireRunOutputs` deliberately leaves `RunnerEventOutput` out of the composite:
  // the bus already writes to the configured feed, so adding it would duplicate
  // every step.* line in the very file the watcher pane reads.
  const path = feedPath();
  const feed = new FileLiveFeed(path);
  setRunnerLiveFeed(feed);
  const step = makeRunStep({ id: "check", name: "Check", command: "true", runner: "bash" });

  new CompositeRunOutput([new LiveFeedOutput(feed)]).emit({ type: "step.done", step });

  expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
});

test("routing a step event through the bus as well writes it twice", () => {
  // The counterpart of the previous case: the duplication is real, which is why
  // the composite owns the feed and the bus is left to backend telemetry.
  const path = feedPath();
  const feed = new FileLiveFeed(path);
  setRunnerLiveFeed(feed);
  const step = makeRunStep({ id: "check", name: "Check", command: "true", runner: "bash" });

  new CompositeRunOutput([new LiveFeedOutput(feed), new RunnerEventOutput()]).emit({ type: "step.done", step });

  expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
});

test("the console gives each message level its glyph, and only that glyph", () => {
  // The table is the contract of the level: an operator reads severity off the
  // line, and `info` stays bare because the informational lines of the execution
  // path already carry their own prefix (`→`, `📄`).
  const expected: Array<[RunnerMessageLevel, string]> = [
    ["info", "nothing to report\n"],
    ["warn", "⚠ budget is close\n"],
    ["error", "✗ input failed\n"],
  ];
  const messages: Record<RunnerMessageLevel, string> = {
    info: "nothing to report",
    warn: "budget is close",
    error: "input failed",
  };

  for (const [level, line] of expected) {
    const console = new ConsoleRunOutput();
    const captured = captureStderr(() => console.emit({ type: "runner.message", level, message: messages[level] }));
    expect(captured.lines).toEqual([line]);
  }
});

test("the glyph lands after the indentation and after a leading blank line", () => {
  const console = new ConsoleRunOutput();
  const indented = captureStderr(() =>
    console.emit({ type: "runner.message", level: "warn", message: "  nested under a step" }),
  );
  expect(indented.lines).toEqual(["  ⚠ nested under a step\n"]);

  const spaced = captureStderr(() =>
    console.emit({ type: "runner.message", level: "warn", message: "\nBudget exceeded\n  ↳ rerun with --budget" }),
  );
  expect(spaced.lines).toEqual(["\n⚠ Budget exceeded\n  ↳ rerun with --budget\n"]);
});

test("rendering a message never goes back through log(), so it cannot recurse", () => {
  // `log()` and `writeStderr` are indistinguishable from their output, so the
  // proof is the call stack the interceptor sees: a write coming from `log()`
  // passes through `logInfo`. One write per event, none of them through it.
  const console = new ConsoleRunOutput();
  const captured = captureStderr(() =>
    console.emit({ type: "runner.message", level: "error", message: "input failed" }),
  );

  expect(captured.lines).toHaveLength(1);
  expect(captured.stacks).toHaveLength(1);
  expect(captured.stacks[0]).toContain("renderRunnerMessage");
  expect(captured.stacks[0]).not.toContain("logInfo");
});

test("the live feed serializes the message level, so severity survives on disk", () => {
  const path = feedPath();
  new LiveFeedOutput(new FileLiveFeed(path)).emit({
    type: "runner.message",
    level: "warn",
    message: "Budget exceeded",
  });

  const event = JSON.parse(readFileSync(path, "utf8"));
  expect(event.type).toBe("runner.message");
  expect(event.level).toBe("warn");
  expect(event.message).toBe("Budget exceeded");
});
