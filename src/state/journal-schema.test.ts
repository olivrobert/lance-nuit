import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { JournalEntry } from "../model/journal.js";
import { diagnoseJournalEntry, JOURNAL_EVENT_TYPES, parseJournalEntry } from "./journal-schema.js";

const FIXTURES = fileURLToPath(new URL("../../tests/fixtures/journal/", import.meta.url));

function lines(name: string): unknown[] {
  const parsed: unknown[] = [];
  for (const line of readFileSync(`${FIXTURES}${name}`, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // The truncated tail is the caller's business, not the classifier's.
    }
  }
  return parsed;
}

test("parseJournalEntry: every line of the type inventory is a known event", () => {
  const entries = lines("all-event-types.jsonl").map(parseJournalEntry);
  expect(entries.filter((entry) => entry?.kind !== "known")).toEqual([]);
  const types = entries.map((entry) => (entry?.kind === "known" ? entry.event.type : "?"));
  expect([...types].sort()).toEqual([...JOURNAL_EVENT_TYPES].sort());
});

test("parseJournalEntry: a real journal yields no invalid entry", () => {
  const entries = lines("real-run.jsonl").map(parseJournalEntry);
  expect(entries.filter((entry) => entry?.kind === "invalid")).toEqual([]);
  // Most of a real journal is the live feed sharing the file: kept, not known.
  expect(entries.filter((entry) => entry?.kind === "unknown").length).toBeGreaterThan(0);
});

test("parseJournalEntry: a line that is not an event at all is skipped", () => {
  expect(parseJournalEntry("a string")).toBeNull();
  expect(parseJournalEntry([1, 2])).toBeNull();
  expect(parseJournalEntry(null)).toBeNull();
  expect(parseJournalEntry({ ts: "2026-01-01T00:00:00.000Z" })).toBeNull();
  expect(parseJournalEntry({ ts: "2026-01-01T00:00:00.000Z", type: 42 })).toBeNull();
});

test("parseJournalEntry: an uncontracted type is kept as unknown, with its payload", () => {
  const entry = parseJournalEntry({ type: "turn.completed", usage: { input_tokens: 10 } });
  expect(entry).toEqual({
    kind: "unknown",
    event: { type: "turn.completed", usage: { input_tokens: 10 } },
  } as JournalEntry);
  // A stream line carries no `ts`; it is still a line a follower must see.
  expect(diagnoseJournalEntry({ type: "turn.completed" })).toBe('unknown event type "turn.completed"');
});

test("parseJournalEntry: a contracted type with a refused payload is kept as invalid", () => {
  const entry = parseJournalEntry({
    ts: "2026-01-01T00:00:00.000Z",
    type: "step.attempt.started",
    attempt: 1,
  });
  expect(entry?.kind).toBe("invalid");
  expect(entry?.kind === "invalid" && entry.reason).toContain("stepId");
  // The raw line survives so a diagnostic can show what was refused.
  expect(entry?.event).toMatchObject({ type: "step.attempt.started", attempt: 1 });
});

test("parseJournalEntry: an attempt event needs a step id and a positive integer", () => {
  const base = { ts: "2026-01-01T00:00:00.000Z", type: "step.attempt.started", stepId: "tests" };
  expect(parseJournalEntry({ ...base, attempt: 1 })?.kind).toBe("known");
  // Nothing else is required: `kind`, `sessionId` and `logPath` may be absent in
  // a journal written before they were emitted, and the readers cope already.
  expect(parseJournalEntry({ ...base, attempt: 2, kind: "fix" })?.kind).toBe("known");
  expect(parseJournalEntry({ ...base, attempt: "1" })?.kind).toBe("invalid");
  expect(parseJournalEntry({ ...base, attempt: 0 })?.kind).toBe("invalid");
  expect(parseJournalEntry({ ...base, attempt: 1.5 })?.kind).toBe("invalid");
  expect(parseJournalEntry({ ...base, stepId: "", attempt: 1 })?.kind).toBe("invalid");
});

/**
 * A field of the wrong kind reads as ABSENT, never as a reason to refuse the
 * event. `closeAttempt` appends `step.attempt.finished` before it writes the
 * snapshot, so a crash in that window leaves the attempt's price in the journal
 * alone: an event refused whole would drop out of `reconcileStepSpend` and let
 * the resume spend past `max_cost_usd`. The readers already tolerate absence
 * through `attemptKind`, `attemptStatus` and `attemptSession`.
 */
test.each([
  ["an unknown attempt kind", { kind: "retry" }, "kind"],
  ["a numeric log path", { logPath: 3 }, "logPath"],
  ["an unknown attempt status", { status: "killed" }, "status"],
  ["control data with no duration", { control: { total_cost_usd: 1 } }, "control"],
  ["usage with a stringified token count", { usage: { input_tokens: "12" } }, "usage"],
  ["a session with no resumable flag", { session: { provider: "claude", id: "s-1" } }, "session"],
])("parseJournalEntry: %s is dropped, the attempt event survives", (_label, bad, field) => {
  const raw = {
    ts: "2026-01-01T00:00:00.000Z",
    type: "step.attempt.finished",
    stepId: "tests",
    attempt: 2,
    ...bad,
  };
  const entry = parseJournalEntry(raw);
  expect(entry?.kind).toBe("known");
  expect(entry?.kind === "known" && entry.event).toMatchObject({
    type: "step.attempt.finished",
    stepId: "tests",
    attempt: 2,
  });
  // Dropped, not carried through: the reader must fall back, not read garbage.
  const read: Record<string, unknown> = entry?.kind === "known" ? { ...entry.event } : {};
  expect(read[field]).toBeUndefined();
});

test("parseJournalEntry: a wrong kind on a run event is dropped too", () => {
  const entry = parseJournalEntry({
    ts: "2026-01-01T00:00:00.000Z",
    type: "run.finished",
    status: "PASS",
    outcome: "not an outcome object",
  });
  expect(entry?.kind).toBe("known");
  expect(entry?.kind === "known" && "outcome" in entry.event && entry.event.outcome).toBeUndefined();
});

test("parseJournalEntry: unknown fields survive a known event", () => {
  const entry = parseJournalEntry({
    ts: "2026-01-01T00:00:00.000Z",
    type: "run.started",
    pipeline: "quality",
    ticket: null,
    fieldFromALaterRelease: { nested: true },
  });
  expect(entry?.kind).toBe("known");
  expect({ ...entry?.event }).toEqual({
    ts: "2026-01-01T00:00:00.000Z",
    type: "run.started",
    pipeline: "quality",
    ticket: null,
    fieldFromALaterRelease: { nested: true },
  });
});

test("parseJournalEntry: the per-attempt cost event needs its stepId", () => {
  expect(
    parseJournalEntry({
      ts: "2026-01-01T00:00:00.000Z",
      type: "step.cost.unaccounted",
      stepId: "tests",
      model: "unpriced-model-1",
    }),
  ).toEqual({
    kind: "known",
    event: {
      ts: "2026-01-01T00:00:00.000Z",
      type: "step.cost.unaccounted",
      stepId: "tests",
      model: "unpriced-model-1",
    },
  } as JournalEntry);
  expect(diagnoseJournalEntry({ ts: "2026-01-01T00:00:00.000Z", type: "step.cost.unaccounted" })).toContain("stepId");
});
