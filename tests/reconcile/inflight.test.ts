// In-flight attempts, rows W1 to W6 and W11 of the reconciliation matrix. Before
// every spawn the runner marks each output the step declares as written by an
// attempt that has not finished yet, in `.provenance/`; only a successful attempt
// clears the mark. Outputs revised in place: revised.test.ts.
// A deliverable a failed or killed attempt left behind is therefore never adopted,
// whatever the run facts say: a new run, `--fresh`, `--start-at` and selectors
// all lose the status of the failed pass, the work item keeps the mark.

import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  cleanupScratch,
  eventsSince,
  failAt,
  heal,
  killDuring,
  latestRunId,
  mark,
  partialAt,
  provenanceRecords,
  readArtifact,
  removeProvenanceRecord,
  run,
  scratchRoute,
  skipsSince,
  snapshot,
  trace,
  traceSince,
  writeArtifact,
} from "./harness.ts";

setDefaultTimeout(60_000);

afterEach(cleanupScratch);

const FULL = ["context", "branch", "triage", "plan", "prepare", "implement", "quality", "commit", "publish", "report"];
/** Until `implement`, where `partialAt implement` makes the first run fail. */
const UNTIL_IMPLEMENT = ["context", "branch", "triage", "plan", "prepare", "implement"];
/** What a new run replays when only `implement` owes work: legacy also replays `branch`. */
const FROM_IMPLEMENT = ["context", "prepare", "implement", "quality", "commit", "publish", "report"];

/** Exit code of a run `--until` stopped with work left (guide/cli-options.md). */
const UNTIL_EXIT = 3;

const reconcile = { reconcile: true } as const;

/** Journal event naming the outputs an unfinished attempt left behind. */
const UNFINISHED_EVENT = "step.outputs.unfinished";

function statusesOf(cwd: string): Record<string, string> {
  return Object.fromEntries(snapshot(cwd).steps.map((step) => [step.id, step.status]));
}

function skippedIds(cwd: string, since: ReturnType<typeof mark>): string[] {
  return skipsSince(cwd, since).map(({ stepId }) => stepId);
}

/** `partialAt implement`: the first run writes `impl.md` with partial content, then fails on it. */
function failWithPartialImplement(cwd: string): void {
  partialAt(cwd, "implement");
  const failed = run(cwd);
  expect(failed.status).not.toBe(0);
  expect(snapshot(cwd).status).toBe("FAIL");
  expect(statusesOf(cwd).implement).toBe("failed");
  expect(trace(cwd)).toEqual(UNTIL_IMPLEMENT);
  expect(readArtifact(cwd, "impl.md")).toBe("partial implement\n");
}

/** A fresh run replayed `implement` and replaced its partial output, and said why. */
function expectPartialReplaced(cwd: string, since: ReturnType<typeof mark>): void {
  expect(skippedIds(cwd, since)).not.toContain("implement");
  expect(traceSince(cwd, since)).toContain("implement");
  expect(readArtifact(cwd, "impl.md")).toStartWith("implement ");
  const unfinished = eventsSince(cwd, since, UNFINISHED_EVENT);
  expect(unfinished).toHaveLength(1);
  expect(unfinished[0]).toMatchObject({ stepId: "implement", outputs: ["impl.md"] });
}

function inFlightRecords(cwd: string): string[] {
  return Object.entries(provenanceRecords(cwd))
    .filter(([, record]) => "inFlight" in record)
    .map(([name]) => name);
}

test("W1: a partial output left by a failed attempt is replayed by --fresh, never adopted", () => {
  const cwd = scratchRoute(reconcile);
  failWithPartialImplement(cwd);
  const failedRun = latestRunId(cwd);
  const markLeft = provenanceRecords(cwd)["impl.md.json"]?.inFlight;
  heal(cwd, "implement");
  const before = mark(cwd);

  const fresh = run(cwd, "--fresh");

  expect(fresh.status).toBe(0);
  expect(traceSince(cwd, before)).toEqual(FROM_IMPLEMENT);
  expect(latestRunId(cwd)).not.toBe(failedRun);
  expect(snapshot(cwd).status).toBe("PASS");
  // The failed attempt had left its mark beside the partial output.
  expect(markLeft).toMatchObject({ runId: failedRun, stepId: "implement", attempt: 1 });
  expectPartialReplaced(cwd, before);
  expect(skipsSince(cwd, before).some(({ freshness }) => freshness === "adoptable")).toBe(false);
  expect(inFlightRecords(cwd)).toEqual([]);
});

// Deliberate change of the legacy behavior (L2b): before it, the fresh run adopted
// the partial `impl.md`, which carried no record, and skipped `implement` with
// `outputs up to date with declared inputs` and freshness `adoptable`.
test("W2: in legacy mode too, --fresh replays the step whose partial output a failed attempt left", () => {
  const cwd = scratchRoute();
  failWithPartialImplement(cwd);
  heal(cwd, "implement");
  const before = mark(cwd);

  const fresh = run(cwd, "--fresh");

  expect(fresh.status).toBe(0);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, before)).toEqual(["context", "branch", "prepare", ...FROM_IMPLEMENT.slice(2)]);
  expectPartialReplaced(cwd, before);
  expect(inFlightRecords(cwd)).toEqual([]);
});

// The third FAIL of L3: the run facts that kept the partial output from being
// adopted vanish once `--start-at` puts the step back to `pending` and a new run
// starts. The form with `--skip implement` in place of `--fresh` is in
// selectors.test.ts.
test("W3: a step requeued by --start-at, then run anew, never adopts the partial output of its failed pass", () => {
  const cwd = scratchRoute(reconcile);
  failAt(cwd, "implement");
  expect(run(cwd).status).not.toBe(0);
  expect(statusesOf(cwd).implement).toBe("failed");
  // What a step that died mid-write leaves: the attempt wrote part of its output.
  writeArtifact(cwd, "impl.md", "partial implement\n");
  heal(cwd, "implement");

  const bounded = run(cwd, "--start-at", "plan", "--until", "plan");
  expect(bounded.status).toBe(UNTIL_EXIT);
  expect(statusesOf(cwd).implement).toBe("pending");
  const before = mark(cwd);

  const fresh = run(cwd, "--fresh");

  expect(fresh.status).toBe(0);
  expect(snapshot(cwd).status).toBe("PASS");
  expectPartialReplaced(cwd, before);
  const afterPass = mark(cwd);

  const relaunch = run(cwd);

  expect(relaunch.status).toBe(0);
  // The output a successful attempt wrote is fresh now, and its record is a plain one.
  expect(traceSince(cwd, afterPass)).toEqual(["context", "prepare", "quality", "report"]);
  for (const skip of [...skipsSince(cwd, before), ...skipsSince(cwd, afterPass)]) {
    expect(skip.stepId === "implement" && skip.freshness === "adoptable").toBe(false);
  }
  expect(inFlightRecords(cwd)).toEqual([]);
});

test("W4: a partial output left by a killed attempt is replayed by --fresh, never adopted", async () => {
  const cwd = scratchRoute(reconcile);
  partialAt(cwd, "implement");
  await killDuring(cwd, "implement");
  expect(readArtifact(cwd, "impl.md")).toBe("partial implement\n");
  const marksLeft = inFlightRecords(cwd);
  heal(cwd, "implement");
  const killedRun = latestRunId(cwd);
  const before = mark(cwd);

  const fresh = run(cwd, "--fresh");

  expect(fresh.status).toBe(0);
  expect(traceSince(cwd, before)).toEqual(FROM_IMPLEMENT);
  expect(latestRunId(cwd)).not.toBe(killedRun);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(marksLeft).toEqual(["impl.md.json"]);
  expectPartialReplaced(cwd, before);
  expect(inFlightRecords(cwd)).toEqual([]);
});

test("W5: a step without input whose failed attempt left its output replays on resume", () => {
  const cwd = scratchRoute(reconcile);
  partialAt(cwd, "branch");
  expect(run(cwd).status).not.toBe(0);
  expect(statusesOf(cwd).branch).toBe("failed");
  expect(readArtifact(cwd, "branch.json")).toBe("partial branch\n");
  heal(cwd, "branch");
  const failedRun = latestRunId(cwd);
  const before = mark(cwd);

  const resumed = run(cwd);

  expect(resumed.status).toBe(0);
  expect(latestRunId(cwd)).toBe(failedRun);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, before)).toEqual(FULL);
  expect(readArtifact(cwd, "branch.json")).toStartWith("branch ");
});

// The resume above is also guarded by the run fact (`branch` is `failed`). A new
// run has no such fact: only the mark stops `outputs present` from settling it.
test("W5: a step without input ignores `outputs present` when a failed attempt left its output, on a new run", () => {
  const cwd = scratchRoute(reconcile);
  partialAt(cwd, "branch");
  expect(run(cwd).status).not.toBe(0);
  heal(cwd, "branch");
  const before = mark(cwd);

  const fresh = run(cwd, "--fresh");

  expect(fresh.status).toBe(0);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(skippedIds(cwd, before)).not.toContain("branch");
  expect(traceSince(cwd, before)).toEqual(FULL);
  expect(readArtifact(cwd, "branch.json")).toStartWith("branch ");
  expect(eventsSince(cwd, before, UNFINISHED_EVENT)).toEqual([
    expect.objectContaining({ stepId: "branch", outputs: ["branch.json"] }),
  ]);
  // A step without input that succeeds replaces its mark with a record without fingerprint.
  expect(provenanceRecords(cwd)["branch.json.json"]).toMatchObject({ producedBy: "branch", inputs: {} });
});

for (const mode of [
  { name: "legacy", options: {}, relaunch: ["context", "branch", "prepare", "quality", "report"] },
  { name: "reconcile", options: reconcile, relaunch: ["context", "prepare", "quality", "report"] },
] as const) {
  test(`W6 (${mode.name}): no record carries a mark after a complete PASS, and a relaunch is unchanged`, () => {
    const cwd = scratchRoute(mode.options);
    expect(run(cwd).status).toBe(0);
    expect(trace(cwd)).toEqual(FULL);
    const records = provenanceRecords(cwd);
    expect(Object.keys(records)).toEqual([
      "branch.json.json",
      "commit.sha.json",
      "impl.md.json",
      "mr-url.txt.json",
      "plan.md.json",
      "triage.md.json",
    ]);
    expect(inFlightRecords(cwd)).toEqual([]);
    const before = mark(cwd);

    expect(run(cwd).status).toBe(0);

    // S1 in legacy, R2 in reconcile mode.
    expect(traceSince(cwd, before)).toEqual([...mode.relaunch]);
    expect(inFlightRecords(cwd)).toEqual([]);
  });
}

// ── Repairing an output by hand (guide/dsl.md, Input freshness) ──────────────

/** A failed `implement` whose partial output the operator repaired, then whose record they deleted. */
function repairedByHand(cwd: string): void {
  failWithPartialImplement(cwd);
  heal(cwd, "implement");
  writeArtifact(cwd, "impl.md", "repaired by hand\n");
  removeProvenanceRecord(cwd, "impl.md");
}

test("W11: a repaired output whose record was deleted is adopted by a new run", () => {
  const cwd = scratchRoute(reconcile);
  repairedByHand(cwd);
  const before = mark(cwd);

  const fresh = run(cwd, "--fresh");

  expect(fresh.status).toBe(0);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(skipsSince(cwd, before).find(({ stepId }) => stepId === "implement")).toMatchObject({
    freshness: "adoptable",
  });
  expect(readArtifact(cwd, "impl.md")).toBe("repaired by hand\n");
  expect(provenanceRecords(cwd)["impl.md.json"]).not.toHaveProperty("inFlight");
});

test("W11: resuming the failed run instead replays the step over the repair", () => {
  const cwd = scratchRoute(reconcile);
  repairedByHand(cwd);
  const before = mark(cwd);

  expect(run(cwd).status).toBe(0);

  expect(traceSince(cwd, before)).toContain("implement");
  expect(readArtifact(cwd, "impl.md")).toStartWith("implement ");
});
