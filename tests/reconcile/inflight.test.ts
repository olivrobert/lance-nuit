// Unfinished passes, rows W1 to W6 and W11 of the reconciliation matrix, through
// the real CLI. A pass clears its step's stamp in `artifacts/lock.json` before its
// first spawn and writes it back only once it settled `done`. A deliverable a
// failed or killed attempt left behind is therefore never vouched for, whatever
// the run facts say: a new run, `--fresh`, `--start-at` and selectors all lose
// the status of the failed pass, the lock keeps the missing stamp.

import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  cleanupScratch,
  failAt,
  heal,
  killDuring,
  latestRunId,
  lockSteps,
  mark,
  partialAt,
  readArtifact,
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
/** What a new run replays when only `implement` owes work. */
const FROM_IMPLEMENT = ["context", "prepare", "implement", "quality", "commit", "publish", "report"];
const STAMPED = ["branch", "commit", "implement", "plan", "publish", "triage"];

/** Exit code of a run `--until` stopped with work left (guide/cli-options.md). */
const UNTIL_EXIT = 3;

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

/** A run replayed `implement` and replaced its partial output. */
function expectPartialReplaced(cwd: string, since: ReturnType<typeof mark>): void {
  expect(skippedIds(cwd, since)).not.toContain("implement");
  expect(traceSince(cwd, since)).toContain("implement");
  expect(readArtifact(cwd, "impl.md")).toStartWith("implement ");
}

test("W1: a partial output left by a failed attempt has no stamp, so --fresh replays it", () => {
  const cwd = scratchRoute();
  failWithPartialImplement(cwd);
  const failedRun = latestRunId(cwd);
  expect(Object.keys(lockSteps(cwd)).sort()).toEqual(["branch", "plan", "triage"]);
  heal(cwd, "implement");
  const before = mark(cwd);

  const fresh = run(cwd, "--fresh");

  expect(fresh.status).toBe(0);
  expect(traceSince(cwd, before)).toEqual(FROM_IMPLEMENT);
  expect(latestRunId(cwd)).not.toBe(failedRun);
  expect(snapshot(cwd).status).toBe("PASS");
  expectPartialReplaced(cwd, before);
  expect(Object.keys(lockSteps(cwd)).sort()).toEqual(STAMPED);
});

// The third FAIL of L3: the run facts that kept the partial output from being
// kept vanish once `--start-at` puts the step back to `pending` and a new run
// starts. The form with `--skip implement` in place of `--fresh` is in
// selectors.test.ts.
test("W3: a step requeued by --start-at, then run anew, never keeps the partial output of its failed pass", () => {
  const cwd = scratchRoute();
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
  expect(traceSince(cwd, afterPass)).toEqual(["context", "prepare", "quality", "report"]);
});

test("W4: an attempt killed by SIGKILL leaves no stamp, so --fresh replays its step (L4)", async () => {
  const cwd = scratchRoute();
  partialAt(cwd, "implement");
  await killDuring(cwd, "implement");
  expect(readArtifact(cwd, "impl.md")).toBe("partial implement\n");
  expect(lockSteps(cwd).implement).toBeUndefined();
  heal(cwd, "implement");
  const killedRun = latestRunId(cwd);
  const before = mark(cwd);

  const fresh = run(cwd, "--fresh");

  expect(fresh.status).toBe(0);
  expect(traceSince(cwd, before)).toEqual(FROM_IMPLEMENT);
  expect(latestRunId(cwd)).not.toBe(killedRun);
  expect(snapshot(cwd).status).toBe("PASS");
  expectPartialReplaced(cwd, before);
  expect(lockSteps(cwd).implement).toBeDefined();
});

test("W5: a step without input whose failed attempt left its output replays on resume", () => {
  const cwd = scratchRoute();
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

test("W5: a step without input whose output a failed attempt left replays on a new run too", () => {
  const cwd = scratchRoute();
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
  expect(lockSteps(cwd).branch).toMatchObject({ inputs: {} });
});

test("W6: a complete PASS stamps every stamped step, and a relaunch is unchanged", () => {
  const cwd = scratchRoute();
  expect(run(cwd).status).toBe(0);
  expect(trace(cwd)).toEqual(FULL);
  expect(Object.keys(lockSteps(cwd)).sort()).toEqual(STAMPED);
  const before = mark(cwd);

  expect(run(cwd).status).toBe(0);

  // R2: only the steps declaring rerunOnResume run again.
  expect(traceSince(cwd, before)).toEqual(["context", "prepare", "quality", "report"]);
});

test("W11: an output repaired by hand is never adopted: its step runs again", () => {
  const cwd = scratchRoute();
  failWithPartialImplement(cwd);
  heal(cwd, "implement");
  writeArtifact(cwd, "impl.md", "repaired by hand\n");
  const before = mark(cwd);

  expect(run(cwd, "--fresh").status).toBe(0);

  expect(traceSince(cwd, before)).toContain("implement");
  expect(readArtifact(cwd, "impl.md")).toStartWith("implement ");
});
