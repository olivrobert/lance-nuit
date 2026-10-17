// Outputs revised in place, rows W7 to W10, W12, ADV-A and ADV-B of the
// reconciliation matrix. `review` revises `plan.md` (`input: [notes, plan]`,
// `output: [plan]`). Before it spawns, its mark keeps the bytes it found and the
// record that vouched for them: a revision that wrote nothing leaves `plan`
// fresh, one that wrote leaves `plan.md` unfinished. A revision that succeeds over
// unfinished bytes vouches only for itself: the record says so (`unguaranteed`,
// with the revisers it exempts) until a step producing the output from scratch
// writes it again.

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
  redefineRoute,
  run,
  scratchRoute,
  skipsSince,
  snapshot,
  touchNotes,
  trace,
  traceSince,
} from "./harness.ts";

setDefaultTimeout(60_000);

afterEach(cleanupScratch);

const FULL = ["context", "branch", "triage", "plan", "prepare", "implement", "quality", "commit", "publish", "report"];

const reconcile = { reconcile: true } as const;

/** Journal event naming the outputs an unfinished attempt left behind. */
const UNFINISHED_EVENT = "step.outputs.unfinished";

/** Steps that pay an agent in a real pipeline: none of them may run on a relaunch with nothing to redo.
 *  `branch` is not among them: legacy mode replays a step without input on every new run (S1). */
const COSTLY = ["rbranch", "triage", "plan", "review", "implement", "commit", "publish"];

/** `route` with `review`, in run order. */
const REVIEWED = ["context", "branch", "triage", "plan", "review", ...FULL.slice(4)];
/** What resuming a run failed at `review` replays when `plan.md` is the one `plan` wrote. */
const FROM_REVIEW = ["context", "review", "prepare", "implement", "quality", "commit", "publish", "report"];

const MODES = [
  { name: "legacy", options: {} },
  { name: "reconcile", options: reconcile },
] as const;

function statusesOf(cwd: string): Record<string, string> {
  return Object.fromEntries(snapshot(cwd).steps.map((step) => [step.id, step.status]));
}

function skippedIds(cwd: string, since: ReturnType<typeof mark>): string[] {
  return skipsSince(cwd, since).map(({ stepId }) => stepId);
}

/** Names of the records carrying `field`. */
function recordsWith(cwd: string, field: "inFlight" | "unguaranteed"): string[] {
  return Object.entries(provenanceRecords(cwd))
    .filter(([, record]) => field in record)
    .map(([name]) => name);
}

function failedAtReview(cwd: string): string {
  expect(run(cwd).status).not.toBe(0);
  expect(snapshot(cwd).status).toBe("FAIL");
  expect(statusesOf(cwd).review).toBe("failed");
  expect(trace(cwd)).toEqual(REVIEWED.slice(0, 5));
  return latestRunId(cwd);
}

/** `partialAt review` → FAIL, `heal`, then `--fresh --skip plan`: `review` revises the partial bytes and succeeds. */
function revisedOverPartialBytes(cwd: string): void {
  partialAt(cwd, "review");
  failedAtReview(cwd);
  heal(cwd, "review");
  const revised = run(cwd, "--fresh", "--skip", "plan");
  expect(revised.status).toBe(0);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(readArtifact(cwd, "plan.md")).toStartWith("review ");
}

/** Two relaunches with nothing left to redo: no costly step runs, and no record keeps a mark or a doubt. */
function expectStable(cwd: string): void {
  expectNothingRepaid(cwd);
  expect(recordsWith(cwd, "unguaranteed")).toEqual([]);
}

/** Two relaunches with nothing left to redo: no costly step runs, and no record keeps a mark. */
function expectNothingRepaid(cwd: string): void {
  for (const relaunch of [1, 2]) {
    const before = mark(cwd);
    expect(run(cwd).status, `relaunch ${relaunch}`).toBe(0);
    expect(
      traceSince(cwd, before).filter((id) => COSTLY.includes(id)),
      `relaunch ${relaunch}`,
    ).toEqual([]);
  }
  expect(recordsWith(cwd, "inFlight")).toEqual([]);
}

// ── A revision that failed ───────────────────────────────────────────────────

for (const mode of MODES) {
  test(`W7 (${mode.name}): a revision that failed before writing does not make the step that produced the output pay again`, () => {
    const cwd = scratchRoute({ ...mode.options, review: true });
    failAt(cwd, "review");
    const failedRun = failedAtReview(cwd);
    expect(recordsWith(cwd, "inFlight")).toEqual(["plan.md.json"]);
    const planBefore = readArtifact(cwd, "plan.md");
    heal(cwd, "review");
    const before = mark(cwd);

    const resumed = run(cwd);

    expect(resumed.status).toBe(0);
    expect(traceSince(cwd, before)).toEqual(FROM_REVIEW);
    expect(latestRunId(cwd)).toBe(failedRun);
    expect(snapshot(cwd).status).toBe("PASS");
    expect(planBefore).toStartWith("plan ");
    expect(readArtifact(cwd, "plan.md")).toStartWith("review ");
    expect(recordsWith(cwd, "inFlight")).toEqual([]);
  });

  // Replaces the known limit L2b documented (WL): the revision was resumed over
  // its own partial bytes, and `plan` was never replayed.
  test(`W8 (${mode.name}): a revision that wrote then failed leaves the output unfinished, so it is produced again`, () => {
    const cwd = scratchRoute({ ...mode.options, review: true });
    partialAt(cwd, "review");
    failedAtReview(cwd);
    expect(readArtifact(cwd, "plan.md")).toBe("partial review\n");
    heal(cwd, "review");
    const before = mark(cwd);

    const resumed = run(cwd);

    expect(resumed.status).toBe(0);
    expect(traceSince(cwd, before)).toEqual(["context", "plan", ...FROM_REVIEW.slice(1)]);
    expect(eventsSince(cwd, before, UNFINISHED_EVENT)).toEqual([
      expect.objectContaining({ stepId: "plan", outputs: ["plan.md"] }),
    ]);
    expect(readArtifact(cwd, "plan.md")).toStartWith("review ");
    expect(recordsWith(cwd, "inFlight")).toEqual([]);
  });
}

test("W9: a revision killed after writing leaves the output unfinished, so it is produced again", async () => {
  const cwd = scratchRoute({ ...reconcile, review: true });
  partialAt(cwd, "review");
  await killDuring(cwd, "review");
  expect(readArtifact(cwd, "plan.md")).toBe("partial review\n");
  heal(cwd, "review");
  const before = mark(cwd);

  const resumed = run(cwd, "--replay-interrupted");

  expect(resumed.status).toBe(0);
  expect(traceSince(cwd, before)).toEqual(["context", "plan", ...FROM_REVIEW.slice(1)]);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(readArtifact(cwd, "plan.md")).toStartWith("review ");
});

for (const mode of [
  { ...MODES[0], relaunch: ["context", "branch", "review", "prepare", "quality", "report"] },
  { ...MODES[1], relaunch: ["context", "review", "prepare", "quality", "report"] },
] as const) {
  test(`W10 (${mode.name}): an absorbed revision that never writes costs only itself on every new run`, () => {
    const cwd = scratchRoute({ ...mode.options, review: "absorbed" });
    failAt(cwd, "review");
    expect(run(cwd).status).toBe(0);
    expect(snapshot(cwd).status).toBe("PASS");
    expect(trace(cwd)).toEqual(REVIEWED);

    for (const relaunch of [1, 2]) {
      const before = mark(cwd);
      expect(run(cwd).status, `relaunch ${relaunch}`).toBe(0);
      expect(traceSince(cwd, before), `relaunch ${relaunch}`).toEqual([...mode.relaunch]);
      expect(snapshot(cwd).status).toBe("PASS");
    }
    // The absorbed failure keeps its mark; the bytes it vouches for are still those `plan` wrote.
    expect(recordsWith(cwd, "inFlight")).toEqual(["plan.md.json"]);
    expect(readArtifact(cwd, "plan.md")).toStartWith("plan ");
  });
}

// ── A revision made over unfinished bytes (decision of 2026-10-17) ───────────
// It does not vouch for the step that produced them, always, whichever run left
// them: that step is replayed on the next run, then everything settles.

for (const mode of MODES) {
  test(`W12 (${mode.name}): a revision that succeeded over partial bytes does not keep the producer fresh`, () => {
    const cwd = scratchRoute({ ...mode.options, review: true });
    revisedOverPartialBytes(cwd);
    // Written down, not inferred from the inputs the record lacks.
    expect(provenanceRecords(cwd)["plan.md.json"]).toMatchObject({ unguaranteed: { revisedBy: ["review"] } });
    expect(recordsWith(cwd, "inFlight")).toEqual([]);
    const before = mark(cwd);

    expect(run(cwd).status).toBe(0);

    expect(traceSince(cwd, before)).toContain("plan");
    expect(skippedIds(cwd, before)).not.toContain("plan");
    expect(readArtifact(cwd, "plan.md")).toStartWith("review ");
    expectStable(cwd);
  });

  test(`W12 (${mode.name}): a retry that revised the partial bytes of its own first attempt does not keep the producer fresh`, () => {
    const cwd = scratchRoute({ ...mode.options, review: "retried" });
    partialAt(cwd, "review");
    expect(run(cwd).status).toBe(0);
    expect(snapshot(cwd).status).toBe("PASS");
    expect(trace(cwd).filter((id) => id === "review")).toHaveLength(2);
    const before = mark(cwd);

    expect(run(cwd).status).toBe(0);

    expect(traceSince(cwd, before)).toContain("plan");
    expect(skippedIds(cwd, before)).not.toContain("plan");
    expectStable(cwd);
  });

  // The earlier rule dropped the producer's fingerprints from the record and let
  // the revision merge its own: a reviser reading every input of the producer
  // brought them all back, and the record vouched for the partial bytes again.
  test(`ADV-A (${mode.name}): a revision whose inputs cover those of the producer does not keep it fresh either`, () => {
    const cwd = scratchRoute({ ...mode.options, review: true, reviewReadsAll: true });
    revisedOverPartialBytes(cwd);
    const before = mark(cwd);

    expect(run(cwd).status).toBe(0);

    expect(traceSince(cwd, before)).toContain("plan");
    expect(skippedIds(cwd, before)).not.toContain("plan");
    expectStable(cwd);
  });
}

// A producer without input keeps no record once it succeeded, so no missing key
// could ever make it stale: only the written fact does.
test("ADV-B: a revision over the partial output of a step without input does not keep that step settled", () => {
  const cwd = scratchRoute({ ...reconcile, branchReview: true });
  partialAt(cwd, "branch");
  expect(run(cwd).status).not.toBe(0);
  expect(readArtifact(cwd, "branch.json")).toBe("partial branch\n");
  heal(cwd, "branch");
  expect(run(cwd, "--fresh", "--skip", "branch").status).toBe(0);
  expect(readArtifact(cwd, "branch.json")).toStartWith("rbranch ");
  expect(provenanceRecords(cwd)["branch.json.json"]).toMatchObject({ unguaranteed: { revisedBy: ["rbranch"] } });
  const before = mark(cwd);

  expect(run(cwd).status).toBe(0);

  expect(traceSince(cwd, before)).toContain("branch");
  expect(skippedIds(cwd, before)).not.toContain("branch");
  expect(eventsSince(cwd, before, UNFINISHED_EVENT)).toEqual([
    expect.objectContaining({ stepId: "branch", outputs: ["branch.json"] }),
  ]);
  expect(recordsWith(cwd, "unguaranteed")).toEqual([]);
});

// ── A step revising its own output ───────────────────────────────────────────
// A step that declares its output as input too (a step amending its own
// deliverable) produces what it revises. Its success over its own partial bytes
// exempts it from the doubt it leaves, or it would replay itself on every run.

for (const mode of MODES) {
  test(`self-revision (${mode.name}): a producer that revises its own partial output pays for it once`, () => {
    const cwd = scratchRoute({ ...mode.options, planRevisesItself: true });
    partialAt(cwd, "plan");
    expect(run(cwd).status).not.toBe(0);
    expect(statusesOf(cwd).plan).toBe("failed");
    expect(readArtifact(cwd, "plan.md")).toBe("partial plan\n");
    heal(cwd, "plan");
    const before = mark(cwd);

    expect(run(cwd).status).toBe(0);

    expect(snapshot(cwd).status).toBe("PASS");
    expect(traceSince(cwd, before)).toContain("plan");
    expect(readArtifact(cwd, "plan.md")).toStartWith("plan ");
    expect(provenanceRecords(cwd)["plan.md.json"]).toMatchObject({ unguaranteed: { revisedBy: ["plan"] } });
    expectNothingRepaid(cwd);
  });
}

// ── The producer of a revised output, named by what it wrote ─────────────────
// A step without input that succeeds records that it produced its outputs, with no
// fingerprint: a revision of them finds that record, never an empty place another
// step could adopt as its own.

test("rbranch: a revision of the output of a step without input runs on a clean first run, then settles", () => {
  const cwd = scratchRoute({ ...reconcile, branchReview: true });

  expect(run(cwd).status).toBe(0);

  expect(trace(cwd)).toEqual(["context", "branch", "rbranch", ...FULL.slice(2)]);
  expect(readArtifact(cwd, "branch.json")).toStartWith("rbranch ");
  expect(provenanceRecords(cwd)["branch.json.json"]).toMatchObject({ producedBy: "branch" });
  expectStable(cwd);
});

test("W7 (no input): a revision that failed before writing does not replay the step without input that produced the output", () => {
  const cwd = scratchRoute({ ...reconcile, branchReview: true });
  failAt(cwd, "rbranch");
  expect(run(cwd).status).not.toBe(0);
  expect(statusesOf(cwd).rbranch).toBe("failed");
  heal(cwd, "rbranch");
  const before = mark(cwd);

  expect(run(cwd).status).toBe(0);

  expect(traceSince(cwd, before)).toEqual(["context", "rbranch", ...FULL.slice(2)]);
  expect(skippedIds(cwd, before)).toContain("branch");
});

// The first FAIL of L2c: `rbranch` adopted `branch.json`, which `branch` had left
// without a record, so it was named its producer; its success over its own partial
// bytes then passed for the producer's, and `branch` was never replayed.
test("V1: a revision of a step without input, made over its own partial bytes, does not keep that step settled", () => {
  const cwd = scratchRoute({ ...reconcile, branchReview: true });
  expect(run(cwd).status).toBe(0);
  touchNotes(cwd);
  partialAt(cwd, "rbranch");
  expect(run(cwd).status).not.toBe(0);
  expect(readArtifact(cwd, "branch.json")).toBe("partial rbranch\n");
  heal(cwd, "rbranch");
  expect(run(cwd, "--fresh", "--skip", "branch").status).toBe(0);
  expect(readArtifact(cwd, "branch.json")).toStartWith("rbranch ");
  const before = mark(cwd);

  expect(run(cwd).status).toBe(0);

  expect(traceSince(cwd, before)).toContain("branch");
  expect(skippedIds(cwd, before)).not.toContain("branch");
  expectStable(cwd);
});

test("V2: a retry of that revision over the partial bytes of its first attempt does not keep the step settled either", () => {
  const cwd = scratchRoute({ ...reconcile, branchReview: "retried" });
  expect(run(cwd).status).toBe(0);
  touchNotes(cwd);
  partialAt(cwd, "rbranch");
  expect(run(cwd).status).toBe(0);
  expect(trace(cwd).filter((id) => id === "rbranch")).toHaveLength(3);
  const before = mark(cwd);

  expect(run(cwd).status).toBe(0);

  expect(traceSince(cwd, before)).toContain("branch");
  expect(skippedIds(cwd, before)).not.toContain("branch");
  expectStable(cwd);
});

// The doubt names the revisers it exempts, not the producer: renaming the step
// that produces the output does not let the bytes pass for its own.
test("V7: a producer renamed while its output is in doubt is still replayed", () => {
  const options = { ...reconcile, review: true, reviewReadsAll: true } as const;
  const cwd = scratchRoute(options);
  revisedOverPartialBytes(cwd);
  redefineRoute(cwd, { ...options, planId: "draft" });
  const before = mark(cwd);

  expect(run(cwd).status).toBe(0);

  expect(traceSince(cwd, before)).toContain("draft");
  expect(recordsWith(cwd, "unguaranteed")).toEqual([]);
});
