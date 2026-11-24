// Characterization of the run journal as it is read today, pinned on real
// `events.jsonl` content. Old files interleave journal events, `RunnerEvent`
// lines and raw backend stream lines; the reader keeps only the contract events.
import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readRunEvents } from "./run-journal.js";
import { EVENTS_FILE } from "./stores/file-run-event-store.js";

const FIXTURES = fileURLToPath(new URL("../../../tests/fixtures/journal/", import.meta.url));

/** Type inventory of `all-event-types.jsonl`, i.e. the names AS FOUND ON DISK. */
const FIXTURE_TYPES = [
  "run.started",
  "run.resumed",
  "run.finished",
  "run.stopped",
  "run.aborted",
  "run.budget.exceeded",
  "run.cost.unaccounted",
  "run.unmetered.authorized",
  "step.skipped",
  "step.source.unavailable",
  "step.status.changed",
  "step.attempt.started",
  "step.attempt.finished",
  "step.cost.unaccounted",
  "pipeline.child.started",
  "pipeline.child.finished",
  "pipeline.child.cost.reconciled",
  "decision.recorded",
  // Twice: once approved, once rejected with its reason and round.
  "decision.recorded",
] as const;

/** Parse the fixture without going through the store, so this inventory stays a
 *  statement about the file rather than about the reader. */
function fixtureTypes(name: string): string[] {
  const types: string[] = [];
  for (const line of readFileSync(join(FIXTURES, name), "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const type = (parsed as { type?: unknown }).type;
    if (typeof type === "string") types.push(type);
  }
  return types;
}

function journalDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "journal-fixture-"));
  copyFileSync(join(FIXTURES, name), join(dir, EVENTS_FILE));
  return dir;
}

test("journal fixtures: one line per event type the runner emits", () => {
  expect(fixtureTypes("all-event-types.jsonl").sort()).toEqual([...FIXTURE_TYPES].sort());
});

test("journal fixtures: a real journal interleaves the live feed with the audit journal", () => {
  const types = new Set(fixtureTypes("real-run.jsonl"));
  // Journal events.
  expect(types.has("step.attempt.started")).toBe(true);
  expect(types.has("pipeline.child.finished")).toBe(true);
  // `RunnerEvent` lines written by the live feed into the same file.
  expect(types.has("step.started")).toBe(true);
  expect(types.has("pipeline-step")).toBe(true);
  // Raw backend stream lines, which carry no `ts` at all.
  expect(types.has("turn.completed")).toBe(true);
});

test("all event types: the per-attempt cost event is read", () => {
  expect(fixtureTypes("all-event-types.jsonl")).toContain("step.cost.unaccounted");
  const events = readRunEvents(journalDir("all-event-types.jsonl"));
  expect(events.filter((event) => event.type === "step.cost.unaccounted")).toHaveLength(1);
});

test("degraded journal: an empty line, invalid JSON and a truncated tail never lose the rest", () => {
  const events = readRunEvents(journalDir("degraded.jsonl"));
  expect(events.map((event) => event.type)).toContain("run.started");
  expect(events.filter((event) => event.type === "step.attempt.finished")).toHaveLength(1);
});
test("journal fixtures: a rejection is a known decision carrying its reason and round", () => {
  const decisions = readRunEvents(journalDir("all-event-types.jsonl")).filter(
    (event) => event.type === "decision.recorded",
  );
  expect(decisions).toEqual([
    expect.objectContaining({ subject: "plan", decision: "approved" }),
    expect.objectContaining({ subject: "plan", decision: "rejected", reason: "split step 2", round: 1 }),
  ]);
});
