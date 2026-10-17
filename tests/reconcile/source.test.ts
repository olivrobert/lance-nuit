// External sources, rows X1 to X3 of the reconciliation matrix. `tree`, a
// `dsl.source` over `git rev-parse HEAD; git diff HEAD --binary`, joins the input
// of `implement`: a change to the repository then makes `implement` and what
// depends on it stale, while `triage` and `plan`, which never read it, stay fresh.

import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  cleanupScratch,
  editTracked,
  eventsSince,
  failAt,
  heal,
  latestRunId,
  mark,
  provenanceInputs,
  run,
  scratchRoute,
  skipsSince,
  snapshot,
  trace,
  traceSince,
} from "./harness.ts";

setDefaultTimeout(60_000);

afterEach(cleanupScratch);

const FULL = ["context", "branch", "triage", "plan", "prepare", "implement", "quality", "commit", "publish", "report"];
const CHEAP = ["context", "prepare", "quality", "report"];
/** What a moved source replays: `implement` and every step reading what it rewrote, around the CHEAP steps. */
const FROM_IMPLEMENT = ["context", "prepare", "implement", "quality", "commit", "publish", "report"];

/** What admission says when a step's outputs match its inputs. */
const UP_TO_DATE = "outputs up to date with declared inputs";
/** What admission says, in reconcile mode, when a step without input finds every output it declares. */
const PRESENT = "outputs present";

/** Provenance key of the `tree` source, beside the `artifacts/<name>` keys. */
const TREE_KEY = "source:tree";

const SHA256 = /^[a-f0-9]{64}$/;

function reasons(cwd: string, since: ReturnType<typeof mark>): { stepId: string; reason: string }[] {
  return skipsSince(cwd, since).map(({ stepId, reason }) => ({ stepId, reason }));
}

function upToDate(...ids: string[]): { stepId: string; reason: string }[] {
  return ids.map((stepId) => ({ stepId, reason: UP_TO_DATE }));
}

function passedRun(cwd: string): string {
  const first = run(cwd);
  expect(first.status).toBe(0);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(trace(cwd)).toEqual(FULL);
  return latestRunId(cwd);
}

/** A relaunch that changes nothing pays only the CHEAP steps: the source's fingerprint is stable. */
function expectFreeRelaunch(cwd: string, ...args: string[]): void {
  const before = mark(cwd);
  const again = run(cwd, ...args);
  expect(again.status).toBe(0);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, before)).toEqual(CHEAP);
  expect(reasons(cwd, before)).toEqual([
    { stepId: "branch", reason: PRESENT },
    ...upToDate("triage", "plan", "implement", "commit", "publish"),
  ]);
}

test("X1: a committed change replays implement and what follows it, not triage or plan", () => {
  const cwd = scratchRoute({ reconcile: true, source: true });
  passedRun(cwd);
  const recorded = provenanceInputs(cwd, "impl.md");
  // Keyed apart from the artifacts: a source named like an artifact cannot shadow it.
  expect(Object.keys(recorded).sort()).toEqual(["artifacts/plan.md", TREE_KEY]);
  expect(recorded[TREE_KEY]).toMatch(SHA256);
  expectFreeRelaunch(cwd);
  editTracked(cwd);
  const firstRun = latestRunId(cwd);
  const before = mark(cwd);

  const second = run(cwd);

  expect(second.status).toBe(0);
  expect(latestRunId(cwd)).not.toBe(firstRun);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, before)).toEqual(FROM_IMPLEMENT);
  expect(reasons(cwd, before)).toEqual([{ stepId: "branch", reason: PRESENT }, ...upToDate("triage", "plan")]);
  const rerecorded = provenanceInputs(cwd, "impl.md");
  expect(rerecorded[TREE_KEY]).toMatch(SHA256);
  expect(rerecorded[TREE_KEY]).not.toBe(recorded[TREE_KEY]);
  expect(rerecorded["artifacts/plan.md"]).toBe(recorded["artifacts/plan.md"]);
  expectFreeRelaunch(cwd);
});

test("X1: an uncommitted change replays implement too, once --allow-dirty admits the run", () => {
  const cwd = scratchRoute({ reconcile: true, source: true });
  passedRun(cwd);
  editTracked(cwd, { commit: false });
  const before = mark(cwd);

  // The clean tree guard is the runner's, not the source's: it refuses before any step.
  const refused = run(cwd);
  expect(refused.status).not.toBe(0);
  expect(traceSince(cwd, before)).toEqual([]);

  const second = run(cwd, "--allow-dirty");

  expect(second.status).toBe(0);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, before)).toEqual(FROM_IMPLEMENT);
  expect(reasons(cwd, before)).toEqual([{ stepId: "branch", reason: PRESENT }, ...upToDate("triage", "plan")]);
  // The diff did not move since: the same dirty tree is fresh.
  expectFreeRelaunch(cwd, "--allow-dirty");
});

test("X1: a change made while a run is failed re-admits implement on the resume of that same run", () => {
  const cwd = scratchRoute({ reconcile: true, source: true });
  failAt(cwd, "commit");
  const failed = run(cwd);
  expect(failed.status).not.toBe(0);
  expect(snapshot(cwd).status).toBe("FAIL");
  const failedRun = latestRunId(cwd);
  heal(cwd, "commit");
  editTracked(cwd);
  const before = mark(cwd);

  const resumed = run(cwd);

  expect(resumed.status).toBe(0);
  expect(latestRunId(cwd)).toBe(failedRun);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, before)).toEqual(FROM_IMPLEMENT);
  expect(reasons(cwd, before)).toEqual([{ stepId: "branch", reason: PRESENT }, ...upToDate("triage", "plan")]);
});

test("X1: a step that changes its own source is not stale because of it, only because of someone else's change", () => {
  const cwd = scratchRoute({ reconcile: true, source: "written" });
  passedRun(cwd);
  // implement left tracked.txt edited: from here on the tree is dirty.
  // The source is read after the attempt, so the record already holds that edit.
  expectFreeRelaunch(cwd, "--allow-dirty");
  editTracked(cwd, { commit: false });
  const before = mark(cwd);

  const second = run(cwd, "--allow-dirty");

  expect(second.status).toBe(0);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, before)).toEqual(FROM_IMPLEMENT);
  expectFreeRelaunch(cwd, "--allow-dirty");
});

test("X1 (legacy): a source works without .reconcile(), branch replaying as in S1", () => {
  const cwd = scratchRoute({ source: true });
  passedRun(cwd);
  editTracked(cwd);
  const before = mark(cwd);

  const second = run(cwd);

  expect(second.status).toBe(0);
  expect(snapshot(cwd).status).toBe("PASS");
  expect(traceSince(cwd, before)).toEqual([
    "context",
    "branch",
    "prepare",
    "implement",
    "quality",
    "commit",
    "publish",
    "report",
  ]);
  expect(reasons(cwd, before)).toEqual(upToDate("triage", "plan"));
});

test("X2: a source whose command fails leaves freshness unknown: the step runs and the journal says why", () => {
  const cwd = scratchRoute({ reconcile: true, source: "failable" });
  passedRun(cwd);
  failAt(cwd, "tree");
  const before = mark(cwd);

  const second = run(cwd);

  expect(second.status).toBe(0);
  expect(snapshot(cwd).status).toBe("PASS");
  // Nothing moved but the source cannot vouch for it: the safe bias is to run.
  expect(traceSince(cwd, before)).toEqual(FROM_IMPLEMENT);
  expect(reasons(cwd, before)).toEqual([{ stepId: "branch", reason: PRESENT }, ...upToDate("triage", "plan")]);
  const unavailable = eventsSince(cwd, before, "step.source.unavailable");
  // Once at admission, once when the successful attempt reads it again to record it.
  expect(unavailable).toHaveLength(2);
  for (const event of unavailable) {
    expect(event).toMatchObject({ stepId: "implement", source: "tree" });
    expect(String(event.reason)).toContain("tree: forced failure");
  }
  expect(second.stdout + second.stderr).toContain(`source "tree" unavailable`);
  // What implement was produced from is recorded as unknown, never as a fingerprint.
  expect(provenanceInputs(cwd, "impl.md")[TREE_KEY]).toBeNull();
  heal(cwd, "tree");
  const beforeHeal = mark(cwd);

  const healed = run(cwd);

  // An output produced while its source was unreadable is not trusted once it reads again.
  expect(healed.status).toBe(0);
  expect(traceSince(cwd, beforeHeal)).toEqual(FROM_IMPLEMENT);
  expect(eventsSince(cwd, beforeHeal, "step.source.unavailable")).toEqual([]);
  expect(provenanceInputs(cwd, "impl.md")[TREE_KEY]).toMatch(SHA256);
  expectFreeRelaunch(cwd);
});

test("X3: a source declared as output is a build error, before any step and any run", () => {
  const cwd = scratchRoute({ reconcile: true, source: "output" });

  const refused = run(cwd);

  expect(refused.status).toBe(1);
  expect(trace(cwd)).toEqual([]);
  expect(mark(cwd).runId).toBeUndefined();
  const message = refused.stdout + refused.stderr;
  expect(message).toContain(`Step "implement"`);
  expect(message).toContain(`source "tree" cannot be an output`);
});
