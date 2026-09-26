import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeClosureAt } from "../../state/closure.ts";
import { listItems, readItem, titleOfTicketMarkdown } from "./items.ts";
import {
  cleanupTempDirs,
  makeProject,
  makeTempDir,
  SPEC_PATH,
  workItemDir,
  writeArtifact,
  writeDecision,
  writeHistory,
  writeProjectsFile,
  writeRun,
} from "./test-harness.ts";

const originalHome = process.env.PIPELINE_HOME;

function home(): string {
  const dir = makeTempDir("read-model-home-");
  process.env.PIPELINE_HOME = dir;
  return dir;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.PIPELINE_HOME;
  else process.env.PIPELINE_HOME = originalHome;
  cleanupTempDirs();
});

/** A project listed for the dashboard, ready to receive work items. */
function listedProject(name = "demo-app"): string {
  const kit = home();
  const project = makeProject(name);
  writeProjectsFile(kit, [project]);
  return project;
}

test("items: each status lands in its group, decisions first and done last", async () => {
  const project = listedProject();
  writeRun(project, "DEMO-1", "feature", {
    runId: "r-stopped",
    status: "STOPPED",
    updatedAt: "2026-09-05T08:00:00.000Z",
    outcome: { phase: "review", reason: "waiting", logPath: null, resumable: true, stop: { detail: "waiting" } },
  });
  writeRun(project, "DEMO-2", "feature", { runId: "r-fail", status: "FAIL", updatedAt: "2026-09-05T07:00:00.000Z" });
  writeRun(project, "DEMO-3", "feature", {
    runId: "r-aborted",
    status: "ABORTED",
    updatedAt: "2026-09-05T09:00:00.000Z",
  });
  writeRun(project, "DEMO-4", "feature", {
    runId: "r-running",
    status: "RUNNING",
    updatedAt: "2026-09-05T06:00:00.000Z",
  });
  writeRun(project, "DEMO-5", "feature", { runId: "r-pass", status: "PASS", updatedAt: "2026-09-05T05:00:00.000Z" });

  const items = await listItems();

  expect(items.map((item) => [item.key, item.group])).toEqual([
    ["demo-app/DEMO-1", "decision"],
    ["demo-app/DEMO-3", "failure"],
    ["demo-app/DEMO-2", "failure"],
    ["demo-app/DEMO-4", "running"],
    ["demo-app/DEMO-5", "done"],
  ]);
});

test("items: identity, cost, and the effective directory of a run in the main clone", async () => {
  const project = listedProject();
  writeRun(project, "DEMO-7", "feature", {
    runId: "r-1",
    status: "RUNNING",
    updatedAt: "2026-09-05T08:00:00.000Z",
    total_control: { duration_ms: 12_000, total_cost_usd: 1.25, cost_estimated: true },
  });

  const [item] = await listItems();

  expect(item.ticket).toBe("DEMO-7");
  expect(item.pipeline).toBe("feature");
  expect(item.runId).toBe("r-1");
  expect(item.status).toBe("RUNNING");
  expect(item.cost).toEqual({ usd: 1.25, estimated: true });
  expect(item.updatedAt).toBe("2026-09-05T08:00:00.000Z");
  expect(item.worktree).toBe(false);
  expect(item.effectiveWorkItemDir).toBe(join(project, SPEC_PATH, "DEMO-7"));
  expect(item.project).toEqual({ name: "demo-app", cwd: project, provider: "jira" });
  expect(item.branch).toBeUndefined();
  expect(item.launch).toBeUndefined();
});

test("items: a run with no reported cost is not read as free", async () => {
  const project = listedProject();
  writeRun(project, "DEMO-8", "feature", { runId: "r-1", status: "PASS", updatedAt: "2026-09-05T08:00:00.000Z" });

  const [item] = await listItems();

  expect(item.cost).toEqual({ estimated: false });
});

test("items: a stop carries its subject and kind, an older run only its raw reason", async () => {
  const project = listedProject();
  writeRun(project, "DEMO-1", "feature", {
    runId: "r-1",
    status: "STOPPED",
    updatedAt: "2026-09-05T08:00:00.000Z",
    outcome: {
      phase: "plan",
      reason: "escalated: plan needs approval",
      logPath: null,
      resumable: true,
      stop: { subject: "plan", kind: "needs-decision", detail: "plan needs approval" },
    },
  });
  writeRun(project, "DEMO-2", "feature", {
    runId: "r-2",
    status: "STOPPED",
    updatedAt: "2026-09-05T07:00:00.000Z",
    stopped_reason: "escalated: blocked on a missing credential",
  });

  const [current, older] = await listItems();

  expect(current.stop).toEqual({ subject: "plan", kind: "needs-decision", detail: "plan needs approval" });
  expect(older.stop).toEqual({ detail: "escalated: blocked on a missing credential" });
  expect(older.approval).toBeUndefined();
});

test("items: a failure exposes its phase, reason, fail kind and fail cause", async () => {
  const project = listedProject();
  writeRun(project, "DEMO-1", "feature", {
    runId: "r-1",
    status: "FAIL",
    updatedAt: "2026-09-05T08:00:00.000Z",
    outcome: { phase: "tests", reason: "3 tests failed", logPath: null, resumable: true, failKind: "verdict" },
  });
  writeRun(project, "DEMO-2", "feature", {
    runId: "r-2",
    status: "ABORTED",
    updatedAt: "2026-09-05T07:00:00.000Z",
    outcome: { phase: "coder", reason: "budget exceeded", logPath: null, resumable: true, failKind: "technical" },
  });
  // A run that FAILED with a cause no repair could clear: its retry budget was
  // spent and the last rerun came back blocked, so the run failed rather than
  // stopping. A STOPPED run exposes `stop` instead, which already carries `kind`.
  writeRun(project, "DEMO-3", "feature", {
    runId: "r-3",
    status: "FAIL",
    updatedAt: "2026-09-05T06:00:00.000Z",
    outcome: {
      phase: "deploy",
      reason: "the release branch is missing",
      logPath: null,
      resumable: true,
      failKind: "verdict",
      failCause: "blocked",
    },
  });

  const items = await listItems();
  const byTicket = (ticket: string) => items.find((item) => item.ticket === ticket)!;
  const failed = byTicket("DEMO-1");
  const aborted = byTicket("DEMO-2");
  const blocked = byTicket("DEMO-3");

  expect(failed.failure).toEqual({ phase: "tests", reason: "3 tests failed", failKind: "judgment" });
  expect(aborted.failure).toEqual({ phase: "coder", reason: "budget exceeded", failKind: "incident" });
  expect(failed.stop).toBeUndefined();
  // The cause sits beside the kind, not folded into it: the judgment says the
  // agent decided, the cause says no repair could change the decision.
  expect(blocked.failure).toEqual({
    phase: "deploy",
    reason: "the release branch is missing",
    failKind: "judgment",
    failCause: "blocked",
  });
});

test("items: the pending approval is absent, fresh, or stale", async () => {
  const project = listedProject();
  const stopped = (ticket: string, runId: string, updatedAt: string) =>
    writeRun(project, ticket, "feature", {
      runId,
      status: "STOPPED",
      updatedAt,
      outcome: {
        phase: "plan",
        reason: "plan needs approval",
        logPath: null,
        resumable: true,
        stop: { subject: "plan", kind: "needs-decision", detail: "plan needs approval" },
      },
    });

  stopped("DEMO-1", "r-1", "2026-09-05T09:00:00.000Z");
  stopped("DEMO-2", "r-2", "2026-09-05T08:00:00.000Z");
  writeArtifact(project, "DEMO-2", "plan.md", "# plan\n");
  writeDecision(project, "DEMO-2", "plan", "plan.md", "# plan\n");
  stopped("DEMO-3", "r-3", "2026-09-05T07:00:00.000Z");
  writeArtifact(project, "DEMO-3", "plan.md", "# plan, rewritten\n");
  writeDecision(project, "DEMO-3", "plan", "plan.md", "# plan\n");

  const [absent, fresh, stale] = await listItems();

  expect(absent.approval).toEqual({ subject: "plan", state: "absent" });
  expect(fresh.approval).toEqual({
    subject: "plan",
    state: "fresh",
    decidedAt: "2026-09-05T08:00:00.000Z",
    decidedBy: "Olivier",
  });
  expect(stale.approval?.state).toBe("stale");
});

test("items: a worktree run reads its approval from the worktree copy", async () => {
  const project = listedProject();
  const worktree = join(makeTempDir("read-model-worktree-"), "demo-app");
  mkdirSync(worktree, { recursive: true });

  writeRun(project, "DEMO-1", "feature", {
    runId: "r-1",
    status: "STOPPED",
    updatedAt: "2026-09-05T08:00:00.000Z",
    worktree: true,
    cwd: worktree,
    outcome: {
      phase: "plan",
      reason: "plan needs approval",
      logPath: null,
      resumable: true,
      stop: { subject: "plan", kind: "needs-decision", detail: "plan needs approval" },
    },
  });
  // The main clone holds the artifact the run started from; the approval was
  // granted inside the worktree, on the copy the run actually reads.
  writeArtifact(project, "DEMO-1", "plan.md", "# plan\n");
  writeArtifact(worktree, "DEMO-1", "plan.md", "# plan approved in the worktree\n");
  writeDecision(worktree, "DEMO-1", "plan", "plan.md", "# plan approved in the worktree\n");

  const [item] = await listItems();

  expect(item.worktree).toBe(true);
  expect(item.effectiveWorkItemDir).toBe(join(worktree, SPEC_PATH, "DEMO-1"));
  expect(item.approval).toMatchObject({ subject: "plan", state: "fresh" });
});

test("items: a ticket that ran on two pipelines yields one item, the most recent run", async () => {
  const project = listedProject();
  writeRun(project, "DEMO-1", "feature", { runId: "r-old", status: "PASS", updatedAt: "2026-09-04T08:00:00.000Z" });
  writeRun(project, "DEMO-1", "quality", { runId: "r-new", status: "FAIL", updatedAt: "2026-09-05T08:00:00.000Z" });

  const items = await listItems();

  expect(items).toHaveLength(1);
  expect(items[0].pipeline).toBe("quality");
  expect(items[0].runId).toBe("r-new");
});

test("items: a nested work item is shown through its parent, never as an item", async () => {
  const project = listedProject();
  writeRun(project, "DEMO-28", "feature", { runId: "r-1", status: "PASS", updatedAt: "2026-09-05T08:00:00.000Z" });
  writeRun(project, join("DEMO-28", "US-01"), "feature", {
    runId: "r-2",
    status: "STOPPED",
    updatedAt: "2026-09-05T09:00:00.000Z",
  });
  // A work item without any run is not an item either.
  mkdirSync(join(workItemDir(project, "DEMO-29"), "artifacts"), { recursive: true });

  expect((await listItems()).map((item) => item.key)).toEqual(["demo-app/DEMO-28"]);
});

test("items: the branch comes from the central history, matched on the run id", async () => {
  const project = listedProject();
  writeRun(project, "DEMO-1", "feature", { runId: "r-1", status: "PASS", updatedAt: "2026-09-05T08:00:00.000Z" });
  writeHistory(project, [
    { runId: "r-other", branch: "feature/other" },
    { runId: "r-1", branch: "feature/DEMO-1" },
  ]);

  const [item] = await listItems();

  expect(item.branch).toBe("feature/DEMO-1");
});

test("items: a project whose path disappeared contributes nothing and stops nothing", async () => {
  const kit = home();
  const alive = makeProject("demo-app");
  const gone = makeProject("gone");
  rmSync(gone, { recursive: true, force: true });
  writeProjectsFile(kit, [gone, alive]);
  writeRun(alive, "DEMO-1", "feature", { runId: "r-1", status: "PASS", updatedAt: "2026-09-05T08:00:00.000Z" });

  expect((await listItems()).map((item) => item.key)).toEqual(["demo-app/DEMO-1"]);
});

test("items: a pipeline directory without a latest link yields no item", async () => {
  const project = listedProject();
  mkdirSync(join(workItemDir(project, "DEMO-1"), "runs", "feature"), { recursive: true });

  expect(await listItems()).toEqual([]);
});

test("readItem: one item by project and ticket, undefined for anything unknown", async () => {
  const project = listedProject();
  writeRun(project, "DEMO-1", "feature", { runId: "r-1", status: "PASS", updatedAt: "2026-09-05T08:00:00.000Z" });

  expect((await readItem("demo-app", "DEMO-1"))?.runId).toBe("r-1");
  expect(await readItem("demo-app", "DEMO-404")).toBeUndefined();
  expect(await readItem("unknown", "DEMO-1")).toBeUndefined();
});

test("items: an accounting stop is reported apart from a budget stop, with a lower-bound cost", async () => {
  const project = listedProject();
  // The current shape: the run-level latch plus the under-counted total.
  writeRun(project, "DEMO-1", "feature", {
    runId: "r-1",
    status: "FAIL",
    updatedAt: "2026-09-05T09:00:00.000Z",
    max_cost_usd: 5,
    cost_unaccounted: true,
    total_control: { duration_ms: 10, total_cost_usd: 0, cost_unknown: true },
    // Work left to do is part of the stop: a run that finished had nothing
    // withheld from it.
    steps: [
      { id: "coder", status: "done", retries: 0, control: { duration_ms: 10, total_cost_usd: 0, cost_unknown: true } },
      { id: "review", status: "pending", retries: 0 },
    ],
    outcome: { phase: "coder", reason: "cost unaccounted", logPath: null, resumable: true },
  });
  // A snapshot written before the latch existed: its steps are the evidence.
  writeRun(project, "DEMO-2", "feature", {
    runId: "r-2",
    status: "FAIL",
    updatedAt: "2026-09-05T08:00:00.000Z",
    max_cost_usd: 5,
    total_control: { duration_ms: 10, total_cost_usd: 1.25, cost_unknown: true },
    steps: [
      {
        id: "coder",
        status: "done",
        retries: 0,
        control: { duration_ms: 10, total_cost_usd: 1.25, cost_unknown: true },
        usage: { output_tokens: 900 },
      },
      { id: "review", status: "pending", retries: 0 },
    ],
    outcome: { phase: "coder", reason: "run failed", logPath: null, resumable: true },
  });
  // A genuine budget stop must not gain the accounting flag.
  writeRun(project, "DEMO-3", "feature", {
    runId: "r-3",
    status: "FAIL",
    updatedAt: "2026-09-05T07:00:00.000Z",
    max_cost_usd: 5,
    budget_exceeded: true,
    total_control: { duration_ms: 10, total_cost_usd: 5.4 },
    steps: [
      { id: "coder", status: "done", retries: 0, control: { duration_ms: 10, total_cost_usd: 5.4 } },
      { id: "review", status: "pending", retries: 0 },
    ],
    outcome: { phase: "coder", reason: "budget exceeded", logPath: null, resumable: true },
  });

  const [latched, derived, budget] = await listItems();

  expect(latched.costUnaccounted).toBe(true);
  expect(latched.budgetExceeded).toBeUndefined();
  // `0` is exactly the figure a reader must not be shown bare.
  expect(latched.cost).toEqual({ usd: 0, estimated: false, unknown: true });

  expect(derived.costUnaccounted).toBe(true);
  expect(derived.cost).toEqual({ usd: 1.25, estimated: false, unknown: true });

  expect(budget.budgetExceeded).toBe(true);
  expect(budget.costUnaccounted).toBeUndefined();
  expect(budget.cost.unknown).toBeUndefined();
});

test("items: a run nothing was withheld from keeps its lower bound and gets no accounting banner", async () => {
  const project = listedProject();
  // No ceiling: there is nothing for unpriced spend to make unenforceable, so the
  // run was never stopped and the dashboard must not offer `--allow-unmetered`.
  writeRun(project, "DEMO-1", "feature", {
    runId: "r-uncapped",
    status: "FAIL",
    updatedAt: "2026-09-05T09:00:00.000Z",
    cost_unaccounted: true,
    total_control: { duration_ms: 10, total_cost_usd: 2, cost_unknown: true },
    steps: [
      { id: "coder", status: "done", retries: 0, control: { duration_ms: 10, total_cost_usd: 2, cost_unknown: true } },
      { id: "review", status: "failed", retries: 0 },
    ],
    outcome: { phase: "review", reason: "tests failed", logPath: null, resumable: true },
  });
  // Already authorized: the operator answered the question, the run kept going,
  // and the banner would ask them to answer it again.
  writeRun(project, "DEMO-2", "feature", {
    runId: "r-authorized",
    status: "FAIL",
    updatedAt: "2026-09-05T08:00:00.000Z",
    max_cost_usd: 5,
    allow_unmetered: true,
    cost_unaccounted: true,
    total_control: { duration_ms: 10, total_cost_usd: 2, cost_unknown: true },
    steps: [
      { id: "coder", status: "done", retries: 0, control: { duration_ms: 10, total_cost_usd: 2, cost_unknown: true } },
      { id: "review", status: "failed", retries: 0 },
    ],
    outcome: { phase: "review", reason: "tests failed", logPath: null, resumable: true },
  });
  // Capped, unauthorized, latched — but every step is settled: nothing is left to
  // withhold, so nothing is left to authorize either.
  writeRun(project, "DEMO-3", "feature", {
    runId: "r-finished",
    status: "PASS",
    updatedAt: "2026-09-05T07:00:00.000Z",
    max_cost_usd: 5,
    cost_unaccounted: true,
    total_control: { duration_ms: 10, total_cost_usd: 2, cost_unknown: true },
    steps: [
      { id: "coder", status: "done", retries: 0, control: { duration_ms: 10, total_cost_usd: 2, cost_unknown: true } },
    ],
    outcome: { phase: null, reason: null, logPath: null, resumable: false },
  });

  const [uncapped, authorized, finished] = await listItems();

  expect(uncapped.costUnaccounted).toBeUndefined();
  expect(authorized.costUnaccounted).toBeUndefined();
  expect(finished.costUnaccounted).toBeUndefined();
  // The `≥` marker is a property of the figure and survives all three.
  expect(uncapped.cost.unknown).toBe(true);
  expect(authorized.cost.unknown).toBe(true);
  expect(finished.cost.unknown).toBe(true);
});

test("items: the typed stop kind decides which banner a run gets, over the flags and the sentence", async () => {
  const project = listedProject();
  // A budget stop whose `--budget` resume wiped `budget_exceeded` and whose
  // sentence is the killed step's own: without `stopKind`, this run reads as a
  // plain technical failure and the "Raise budget" verb disappears.
  writeRun(project, "DEMO-1", "feature", {
    runId: "r-kill",
    status: "FAIL",
    updatedAt: "2026-09-05T09:00:00.000Z",
    max_cost_usd: 5,
    steps: [
      { id: "coder", status: "failed", retries: 0, control: { duration_ms: 10, total_cost_usd: 4.2 } },
      { id: "review", status: "pending", retries: 0 },
    ],
    outcome: {
      phase: "coder",
      reason: "process killed: budget exceeded ($5.10 estimated > $0.80 remaining)",
      logPath: null,
      resumable: true,
      failKind: "technical",
      stopKind: "budget-exceeded",
    },
  });
  // Latched and capped — the evidence tiers would say "accounting stop" — but the
  // generation that ended it says the ceiling is what it hit. The typed answer
  // wins, so the reader is sent to `--budget` and not to `--allow-unmetered`.
  writeRun(project, "DEMO-2", "feature", {
    runId: "r-both",
    status: "FAIL",
    updatedAt: "2026-09-05T08:00:00.000Z",
    max_cost_usd: 5,
    cost_unaccounted: true,
    total_control: { duration_ms: 10, total_cost_usd: 5.4, cost_unknown: true },
    steps: [
      {
        id: "coder",
        status: "done",
        retries: 0,
        control: { duration_ms: 10, total_cost_usd: 5.4, cost_unknown: true },
        usage: { output_tokens: 900 },
      },
      { id: "review", status: "pending", retries: 0 },
    ],
    outcome: { phase: "coder", reason: "budget exceeded", logPath: null, resumable: true, stopKind: "budget-exceeded" },
  });
  // An accounting stop that says so: the flag is set and the ceiling is not.
  writeRun(project, "DEMO-3", "feature", {
    runId: "r-cost",
    status: "FAIL",
    updatedAt: "2026-09-05T07:00:00.000Z",
    max_cost_usd: 5,
    cost_unaccounted: true,
    total_control: { duration_ms: 10, total_cost_usd: 1, cost_unknown: true },
    steps: [
      {
        id: "coder",
        status: "done",
        retries: 0,
        control: { duration_ms: 10, total_cost_usd: 1, cost_unknown: true },
        usage: { output_tokens: 900 },
      },
      { id: "review", status: "pending", retries: 0 },
    ],
    outcome: {
      phase: "coder",
      reason: "cost unaccounted",
      logPath: null,
      resumable: true,
      stopKind: "cost-unaccounted",
    },
  });

  const [kill, both, cost] = await listItems();

  expect(kill.budgetExceeded).toBe(true);
  expect(kill.costUnaccounted).toBeUndefined();

  expect(both.budgetExceeded).toBe(true);
  expect(both.costUnaccounted).toBeUndefined();
  // The `≥` is untouched: the total really is a lower bound, whatever ended the run.
  expect(both.cost.unknown).toBe(true);

  expect(cost.costUnaccounted).toBe(true);
  expect(cost.budgetExceeded).toBeUndefined();
});

test("items: a closed failure is done, keeps its status, and reopens when the run moves", async () => {
  const project = listedProject();
  const updatedAt = "2026-09-05T08:00:00.000Z";
  const runDir = writeRun(project, "DEMO-8", "feature", { runId: "r-fail", status: "FAIL", updatedAt });
  writeClosureAt(runDir, {
    schemaVersion: 1,
    closedAt: "2026-09-06T08:00:00.000Z",
    closedBy: "Olivier",
    runUpdatedAt: updatedAt,
  });

  const [closed] = await listItems();
  expect(closed?.group).toBe("done");
  expect(closed?.status).toBe("FAIL");
  expect(closed?.closed).toEqual({ at: "2026-09-06T08:00:00.000Z", by: "Olivier" });

  // The runner rewrote the snapshot after the closure: the closure is stale.
  writeRun(project, "DEMO-8", "feature", { runId: "r-fail", status: "FAIL", updatedAt: "2026-09-07T08:00:00.000Z" });
  const [moved] = await listItems();
  expect(moved?.group).toBe("failure");
  expect(moved?.closed).toBeUndefined();
});

test("items: a closure on a run nobody waits on is ignored", async () => {
  const project = listedProject();
  const updatedAt = "2026-09-05T08:00:00.000Z";
  const runDir = writeRun(project, "DEMO-9", "feature", { runId: "r-run", status: "RUNNING", updatedAt });
  writeClosureAt(runDir, { schemaVersion: 1, closedAt: updatedAt, closedBy: "Olivier", runUpdatedAt: updatedAt });

  const [item] = await listItems();
  expect(item?.group).toBe("running");
  expect(item?.closed).toBeUndefined();
});

test("items: the title is the first heading of ticket.md", async () => {
  const project = listedProject();
  writeRun(project, "DEMO-1", "feature", { runId: "r-1", status: "PASS", updatedAt: "2026-09-05T08:00:00.000Z" });
  writeArtifact(project, "DEMO-1", "ticket.md", "# Fix the login redirect  \n\nDescription.\n\n# Not this one\n");

  const [item] = await listItems();

  expect(item.title).toBe("Fix the login redirect");
});

test("items: the title skips the front matter of ticket.md", async () => {
  const project = listedProject();
  writeRun(project, "DEMO-1", "feature", { runId: "r-1", status: "PASS", updatedAt: "2026-09-05T08:00:00.000Z" });
  writeArtifact(
    project,
    "DEMO-1",
    "ticket.md",
    "---\nurl: https://example.test/DEMO-1\n# not a title\n---\n\n# Export invoices as CSV\n\nBody.\n",
  );

  const [item] = await listItems();

  expect(item.title).toBe("Export invoices as CSV");
});

test("items: no title without a heading or without ticket.md, and the item still loads", async () => {
  const project = listedProject();
  writeRun(project, "DEMO-1", "feature", { runId: "r-1", status: "PASS", updatedAt: "2026-09-05T08:00:00.000Z" });
  writeRun(project, "DEMO-2", "feature", { runId: "r-2", status: "PASS", updatedAt: "2026-09-05T07:00:00.000Z" });
  writeArtifact(project, "DEMO-1", "ticket.md", "Just a description.\n## A second-level heading\n");

  const items = await listItems();

  expect(items.map((item) => item.ticket)).toEqual(["DEMO-1", "DEMO-2"]);
  expect(items.every((item) => !("title" in item))).toBe(true);
});

test("items: a worktree run reads its title from the worktree copy", async () => {
  const project = listedProject();
  const worktree = join(makeTempDir("read-model-worktree-"), "demo-app");
  mkdirSync(worktree, { recursive: true });
  writeRun(project, "DEMO-1", "feature", {
    runId: "r-1",
    status: "PASS",
    updatedAt: "2026-09-05T08:00:00.000Z",
    worktree: true,
    cwd: worktree,
  });
  writeArtifact(project, "DEMO-1", "ticket.md", "# Title in the main clone\n");
  writeArtifact(worktree, "DEMO-1", "ticket.md", "# Title in the worktree\n");

  const [item] = await listItems();

  expect(item.title).toBe("Title in the worktree");
});

test("items: a worktree run whose worktree is gone reads its title from the main clone", async () => {
  const project = listedProject();
  const worktree = join(makeTempDir("read-model-worktree-"), "removed-app");
  writeRun(project, "DEMO-1", "feature", {
    runId: "r-1",
    status: "PASS",
    updatedAt: "2026-09-05T08:00:00.000Z",
    worktree: true,
    cwd: worktree,
  });
  writeArtifact(project, "DEMO-1", "ticket.md", "# Title in the main clone\n");

  const [item] = await listItems();

  expect(item.title).toBe("Title in the main clone");
});

test("items: the title read stays bounded to the head of a long ticket.md", async () => {
  const project = listedProject();
  writeRun(project, "DEMO-1", "feature", { runId: "r-1", status: "PASS", updatedAt: "2026-09-05T08:00:00.000Z" });
  writeRun(project, "DEMO-2", "feature", { runId: "r-2", status: "PASS", updatedAt: "2026-09-05T07:00:00.000Z" });
  const thread = "- a comment in a long exchange\n".repeat(2000);
  writeArtifact(project, "DEMO-1", "ticket.md", `# Long ticket\n\n## Exchanges\n\n${thread}`);
  writeArtifact(project, "DEMO-2", "ticket.md", `${"filler line\n".repeat(2000)}# Heading far below\n`);

  const items = await listItems();

  expect(items.find((item) => item.ticket === "DEMO-1")?.title).toBe("Long ticket");
  expect(items.find((item) => item.ticket === "DEMO-2")?.title).toBeUndefined();
});

test("titleOfTicketMarkdown: heading, front matter, CRLF, and the empty cases", () => {
  expect(titleOfTicketMarkdown("# Title\n")).toBe("Title");
  expect(titleOfTicketMarkdown("\uFEFF---\r\nurl: x\r\n---\r\n\r\n# Title  \r\n")).toBe("Title");
  expect(titleOfTicketMarkdown("#   \nbody\n")).toBeUndefined();
  expect(titleOfTicketMarkdown("#Title\n")).toBeUndefined();
  expect(titleOfTicketMarkdown("---\nurl: x\n# inside an unclosed front matter\n")).toBeUndefined();
  expect(titleOfTicketMarkdown("")).toBeUndefined();
});

test("titleOfTicketMarkdown: drops a leading ticket key and its separator", () => {
  expect(titleOfTicketMarkdown("# PROJ-1 — Sort contracts\n", "PROJ-1")).toBe("Sort contracts");
  expect(titleOfTicketMarkdown("# PROJ-1: Sort contracts\n", "PROJ-1")).toBe("Sort contracts");
  expect(titleOfTicketMarkdown("# PROJ-1 - Sort contracts\n", "PROJ-1")).toBe("Sort contracts");
  expect(titleOfTicketMarkdown("# PROJ-12 — Other\n", "PROJ-1")).toBe("PROJ-12 — Other");
  expect(titleOfTicketMarkdown("# PROJ-1 fixes the list\n", "PROJ-1")).toBe("PROJ-1 fixes the list");
  expect(titleOfTicketMarkdown("# PROJ-1 —\n", "PROJ-1")).toBeUndefined();
});
