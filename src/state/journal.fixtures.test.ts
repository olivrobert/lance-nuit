// Characterization of the run journal as it is read today, pinned on real
// `events.jsonl` content. `events.jsonl` is both the append-only audit journal
// and the live feed, so a real file interleaves journal events, `RunnerEvent`
// lines and raw backend stream lines. What must not change when the journal
// gains a contract is what the projections make of all that: `projectStepAttempts`
// drives attempt numbering on resume, and a lost attempt overwrites the logs of
// the previous ones.
import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Run, RunStep } from "../model/run.js";
import { projectStepAttempts } from "./attempt-projection.js";
import { readRunEvents } from "./run-journal.js";
import { attemptFacts } from "./stats/run-stats-projection.js";
import { EVENTS_FILE, FileRunEventStore } from "./stores/file-run-event-store.js";

const FIXTURES = fileURLToPath(new URL("../../tests/fixtures/journal/", import.meta.url));

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
  "step.status.changed",
  "step.attempt.started",
  "step.attempt.finished",
  "step.cost.unaccounted",
  "pipeline.child.started",
  "pipeline.child.finished",
  "pipeline.child.cost.reconciled",
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

function attempts(name: string): Record<string, { attempt: number; kind: string; status: string; logPath: string }[]> {
  const projected = projectStepAttempts(readRunEvents(journalDir(name)));
  return Object.fromEntries(
    [...projected].map(([stepId, list]) => [
      stepId,
      list.map((attempt) => ({
        attempt: attempt.attempt,
        kind: attempt.kind,
        status: attempt.status,
        logPath: attempt.log_path,
      })),
    ]),
  );
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

test("real journal: the attempt history a resume projects", () => {
  expect(attempts("real-run.jsonl")).toEqual({
    typecheck: [{ attempt: 1, kind: "step", status: "done", logPath: "steps/typecheck/attempt-001/output.log" }],
    tests: [
      { attempt: 1, kind: "step", status: "failed", logPath: "steps/tests/attempt-001/output.log" },
      { attempt: 2, kind: "fix", status: "done", logPath: "steps/tests/attempt-002/output.log" },
      { attempt: 3, kind: "step", status: "done", logPath: "steps/tests/attempt-003/output.log" },
    ],
  });
});

test("real journal: the finish event carries session, control and usage onto the attempt", () => {
  const projected = projectStepAttempts(readRunEvents(journalDir("real-run.jsonl")));
  const fix = projected.get("tests")?.[1];
  expect(fix?.session).toEqual({
    provider: "claude",
    id: "00000000-0000-4000-8000-000000000003",
    resumable: true,
  });
  expect(fix?.control?.total_cost_usd).toBeCloseTo(1.1960345, 7);
  expect(fix?.usage?.num_turns).toBe(24);
  expect(fix?.finished_at).toBe("2026-09-05T21:42:45.214Z");
  expect(projected.get("tests")?.[0]?.errors).toBe("exit code 1");
});

test("all event types: only the two attempt events reach the attempt projection", () => {
  expect(attempts("all-event-types.jsonl")).toEqual({
    tests: [{ attempt: 1, kind: "step", status: "failed", logPath: "steps/tests/attempt-001/output.log" }],
  });
});

test("all event types: the per-attempt cost event is read and reaches no projection", () => {
  expect(fixtureTypes("all-event-types.jsonl")).toContain("step.cost.unaccounted");
  const events = readRunEvents(journalDir("all-event-types.jsonl"));
  expect(events.filter((event) => event.type === "step.cost.unaccounted")).toHaveLength(1);
  expect(projectStepAttempts(events).size).toBe(1);
});

test("degraded journal: a partial attempt event is ignored and never shifts the numbering", () => {
  // No `stepId`, no `attempt`, a string `attempt` and a zero `attempt` are all
  // dropped; the one complete lifecycle in the same file survives.
  expect(attempts("degraded.jsonl")).toEqual({
    keep: [{ attempt: 1, kind: "step", status: "done", logPath: "steps/keep/attempt-001/output.log" }],
  });
});

test("degraded journal: an empty line, invalid JSON and a truncated tail never lose the rest", () => {
  const events = readRunEvents(journalDir("degraded.jsonl"));
  expect(events.map((event) => event.type)).toContain("run.started");
  expect(projectStepAttempts(events).get("keep")).toHaveLength(1);
});

function runFor(dir: string, stepId: string): { run: Run; step: RunStep } {
  const step = { def: { id: stepId, name: stepId, command: "true" }, id: stepId, status: "done", retries: 0 };
  const run = {
    runId: "20260101T090000.000Z-parent-pipeline-a1b2c3",
    name: "parent-pipeline",
    pipeline: "parent-pipeline",
    run_dir: dir,
    status: "PASS",
    steps: [step],
    eventStore: new FileRunEventStore({ runDir: dir }),
  } as unknown as Run;
  return { run, step: step as unknown as RunStep };
}

test("real journal: the statistics projection reads the same attempts", () => {
  const dir = journalDir("real-run.jsonl");
  const tests = runFor(dir, "tests");
  expect(attemptFacts(tests.run, tests.step, tests.run.eventStore)).toEqual([
    { attempt: 1, kind: "step", status: "failed", logPath: "steps/tests/attempt-001/output.log" },
    { attempt: 2, kind: "fix", status: "done", logPath: "steps/tests/attempt-002/output.log" },
    { attempt: 3, kind: "step", status: "done", logPath: "steps/tests/attempt-003/output.log" },
  ]);
  const typecheck = runFor(dir, "typecheck");
  expect(attemptFacts(typecheck.run, typecheck.step, typecheck.run.eventStore)).toEqual([
    { attempt: 1, kind: "step", status: "done", logPath: "steps/typecheck/attempt-001/output.log" },
  ]);
});

test("degraded journal: the statistics projection drops the same partial events", () => {
  const dir = journalDir("degraded.jsonl");
  for (const stepId of ["no-number", "string-number", "zero"]) {
    const target = runFor(dir, stepId);
    expect(attemptFacts(target.run, target.step, target.run.eventStore)).toEqual([]);
  }
  const keep = runFor(dir, "keep");
  expect(attemptFacts(keep.run, keep.step, keep.run.eventStore)).toEqual([
    { attempt: 1, kind: "step", status: "done", logPath: "steps/keep/attempt-001/output.log" },
  ]);
});
