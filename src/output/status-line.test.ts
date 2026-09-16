import { expect, test } from "bun:test";
import type { RunnerEvent } from "../runtime/events.js";
import { makeRunStep } from "../state/run-step.js";
import { formatElapsed, renderStatusLine, StatusLineOutput, type StatusLineStream } from "./status-line.js";

const step = makeRunStep({ id: "implement", name: "Implement", command: "true", runner: "agent" });

function capture(isTTY: boolean): { writes: string[]; stream: StatusLineStream } {
  const writes: string[] = [];
  return { writes, stream: { write: (text) => writes.push(text), isTTY, columns: 80 } };
}

/** Drive the clock by hand: a repainting line must be assertable without waiting. */
function clock(start = 0): { now: () => number; advance(ms: number): void } {
  let value = start;
  return { now: () => value, advance: (ms) => (value += ms) };
}

const contextAt = (pct: number): RunnerEvent => ({
  type: "runner-event",
  event: "context",
  tokens: Math.round(pct * 200_000),
  window: 200_000,
  pct,
  timestamp: 0,
});

const activity = (label: string): RunnerEvent => ({
  type: "runner-event",
  event: "activity",
  label,
  tool: "Read",
  timestamp: 0,
});

test("elapsed reads as a clock, not as a duration", () => {
  expect(formatElapsed(0)).toBe("0:00");
  expect(formatElapsed(9_000)).toBe("0:09");
  expect(formatElapsed(161_000)).toBe("2:41");
  expect(formatElapsed(3_723_000)).toBe("1:02:03");
});

test("the line shows the current activity, the clock and the occupancy", () => {
  expect(renderStatusLine({ step: "Implement", startedAt: 0, activity: "Edit Order.php", pct: 0.43 }, 161_000, 0)).toBe(
    "│  ⠋ Edit Order.php · 2:41 · ctx 43%",
  );
});

test("the step name stands in until a tool is observed, and occupancy stays optional", () => {
  expect(renderStatusLine({ step: "Implement", startedAt: 0 }, 3_000, 0)).toBe("│  ⠋ Implement · 0:03");
});

test("crossing the warning threshold replaces the spinner", () => {
  expect(renderStatusLine({ step: "s", startedAt: 0, pct: 0.79 }, 0, 0)).toContain("⠋");
  expect(renderStatusLine({ step: "s", startedAt: 0, pct: 0.8 }, 0, 0)).toContain("⚠");
});

test("a non-TTY stream is never written to", () => {
  const { writes, stream } = capture(false);
  const line = new StatusLineOutput(stream, clock().now);
  line.attach();
  line.emit({ type: "step.started", step, index: 1, total: 3 });
  line.emit(contextAt(0.5));
  line.emit({ type: "step.done", step });

  expect(writes).toEqual([]);
});

test("the line is erased before it is repainted and once the step ends", () => {
  const { writes, stream } = capture(true);
  const time = clock();
  const line = new StatusLineOutput(stream, time.now);
  const release = line.attach();

  line.emit({ type: "step.started", step, index: 1, total: 3 });
  line.emit(activity("Read Order.php"));
  line.emit(contextAt(0.42));
  time.advance(5_000);
  // The renderer owns a timer; drive one paint the way the interval would.
  (line as unknown as { paint(): void }).paint();

  expect(writes.at(-1)).toBe("\r│  ⠋ Read Order.php · 0:05 · ctx 42%\x1b[K");

  line.emit({ type: "step.done", step });
  expect(writes.at(-1)).toBe("\r\x1b[K");

  // Nothing left painted: a second erase must not emit a redundant sequence.
  const before = writes.length;
  release();
  expect(writes).toHaveLength(before);
});

test("telemetry arriving outside a step never opens a line", () => {
  const { writes, stream } = capture(true);
  const line = new StatusLineOutput(stream, clock().now);
  line.attach();
  line.emit(contextAt(0.9));
  (line as unknown as { paint(): void }).paint();

  expect(writes).toEqual([]);
});

test("a long line clips the activity and keeps the values being watched", () => {
  const writes: string[] = [];
  const line = new StatusLineOutput({ write: (t) => writes.push(t), isTTY: true, columns: 24 }, clock().now);
  line.attach();
  line.emit({ type: "step.started", step, index: 1, total: 3 });
  line.emit(activity("Bash a very long command that will not fit"));
  line.emit(contextAt(0.43));
  (line as unknown as { paint(): void }).paint();

  const painted = writes.at(-1)!.replace("\r", "").replace("\x1b[K", "");
  expect(painted.length).toBeLessThanOrEqual(23);
  // The clock and the occupancy survive; the label is what gives way.
  expect(painted.endsWith("0:00 · ctx 43%")).toBe(true);
  expect(painted).toContain("…");
});

test("without a known width the line is left intact", () => {
  expect(renderStatusLine({ step: "s", startedAt: 0, activity: "a".repeat(200) }, 0, 0, 0)).toContain("a".repeat(200));
});
