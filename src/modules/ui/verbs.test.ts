import { expect, test } from "bun:test";
import type { Item, LaunchRecord } from "../read-model/types.js";
import { actionable, buildArgv, isBusy, MAX_BUDGET_USD, verbsFor } from "./verbs.js";

/** A stopped item at a gate, in a worktree, as the read model would build it. */
function item(overrides: Partial<Item> = {}): Item {
  return {
    key: "demo-app/DEMO-1",
    project: { name: "demo-app", cwd: "/srv/demo-app", provider: "jira" },
    ticket: "DEMO-1",
    pipeline: "feature",
    runId: "r-1",
    status: "STOPPED",
    group: "decision",
    stop: { subject: "plan", kind: "needs-decision", detail: "waiting for the plan" },
    cost: { estimated: false },
    updatedAt: "2026-09-05T08:00:00.000Z",
    worktree: true,
    effectiveWorkItemDir: "/home/x/.lance-nuit/worktrees/demo-app/DEMO-1/.lance-nuit/work-items/DEMO-1",
    ...overrides,
  };
}

function argvOf(result: ReturnType<typeof buildArgv>): string[] {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.argv;
}

test("argv: approve and rerun replays the run's pipeline, subject, and worktree mode", () => {
  expect(argvOf(buildArgv(item(), "approve-and-rerun", { subject: "plan" }))).toEqual([
    "run",
    "DEMO-1",
    "--pipeline",
    "feature",
    "--approve",
    "plan",
    "--worktree",
  ]);
  expect(argvOf(buildArgv(item({ worktree: false }), "approve-and-rerun", { subject: "plan" }))).toEqual([
    "run",
    "DEMO-1",
    "--pipeline",
    "feature",
    "--approve",
    "plan",
  ]);
});

test("argv: approve only goes through the approve verb, worktree included", () => {
  expect(argvOf(buildArgv(item(), "approve", { subject: "plan" }))).toEqual([
    "approve",
    "DEMO-1",
    "plan",
    "--pipeline",
    "feature",
    "--worktree",
  ]);
});

test("argv: the subject must be the pending gate, and a gate is required", () => {
  const other = buildArgv(item(), "approve", { subject: "spec" });
  expect(other).toMatchObject({ ok: false, status: 400 });
  const none = buildArgv(item(), "approve-and-rerun", {});
  expect(none).toMatchObject({ ok: false, status: 400 });
  const blocked = buildArgv(item({ stop: { kind: "blocked", detail: "BLOCKED: no branch" } }), "approve", {
    subject: "plan",
  });
  expect(blocked).toMatchObject({ ok: false, status: 409 });
  const failed = buildArgv(item({ status: "FAIL", group: "failure", stop: undefined }), "approve", {
    subject: "plan",
  });
  expect(failed).toMatchObject({ ok: false, status: 409 });
});

test("argv: rerun resumes a blocked stop or a failure, nothing else", () => {
  const blocked = item({ stop: { kind: "blocked", detail: "BLOCKED: no branch" } });
  expect(argvOf(buildArgv(blocked, "rerun"))).toEqual(["run", "DEMO-1", "--pipeline", "feature", "--worktree"]);
  const failed = item({ status: "FAIL", group: "failure", stop: undefined, worktree: false });
  expect(argvOf(buildArgv(failed, "rerun"))).toEqual(["run", "DEMO-1", "--pipeline", "feature"]);
  const aborted = item({ status: "ABORTED", group: "failure", stop: undefined });
  expect(buildArgv(aborted, "rerun").ok).toBe(true);
  expect(buildArgv(item(), "rerun")).toMatchObject({ ok: false, status: 409 });
  expect(buildArgv(item({ status: "PASS", group: "done", stop: undefined }), "rerun")).toMatchObject({
    ok: false,
    status: 409,
  });
});

test("argv: fresh is allowed on everything that is not running", () => {
  expect(argvOf(buildArgv(item(), "fresh"))).toEqual([
    "run",
    "DEMO-1",
    "--pipeline",
    "feature",
    "--fresh",
    "--worktree",
  ]);
  expect(buildArgv(item({ status: "PASS", group: "done", stop: undefined }), "fresh").ok).toBe(true);
  expect(buildArgv(item({ status: "RUNNING", group: "running", stop: undefined }), "fresh")).toMatchObject({
    ok: false,
    status: 409,
  });
});

test("argv: close targets an open failed or stopped run, reopen a closed one", () => {
  const failed = item({ status: "FAIL", group: "failure", stop: undefined });
  expect(argvOf(buildArgv(failed, "close"))).toEqual(["close", "DEMO-1", "--pipeline", "feature"]);
  expect(buildArgv(item(), "close").ok).toBe(true);
  expect(buildArgv(item({ status: "PASS", group: "done", stop: undefined }), "close")).toMatchObject({
    ok: false,
    status: 409,
  });
  expect(buildArgv(failed, "reopen")).toMatchObject({ ok: false, status: 409 });

  const closed = item({
    status: "FAIL",
    group: "done",
    stop: undefined,
    closed: { at: "2026-09-06T08:00:00.000Z", by: "Olivier" },
  });
  expect(buildArgv(closed, "close")).toMatchObject({ ok: false, status: 409 });
  expect(argvOf(buildArgv(closed, "reopen"))).toEqual(["reopen", "DEMO-1", "--pipeline", "feature"]);
});

test("argv: budget needs a budget stop and a bounded positive amount the server formats", () => {
  const stopped = item({ status: "FAIL", group: "failure", stop: undefined, budgetExceeded: true });
  expect(argvOf(buildArgv(stopped, "budget", { budget: 12.5 }))).toEqual([
    "run",
    "DEMO-1",
    "--pipeline",
    "feature",
    "--budget",
    "12.5",
    "--worktree",
  ]);
  expect(argvOf(buildArgv(stopped, "budget", { budget: "7,00".replace(",", ".") }))).toContain("7");
  expect(buildArgv(stopped, "budget", { budget: -1 })).toMatchObject({ ok: false, status: 400 });
  expect(buildArgv(stopped, "budget", { budget: 0 })).toMatchObject({ ok: false, status: 400 });
  // Positive, but rounds to "0" once formatted for the CLI: refused, not sent.
  expect(buildArgv(stopped, "budget", { budget: 0.001 })).toMatchObject({ ok: false, status: 400 });
  expect(argvOf(buildArgv(stopped, "budget", { budget: 0.005 }))).toContain("0.01");
  expect(buildArgv(stopped, "budget", { budget: MAX_BUDGET_USD + 1 })).toMatchObject({ ok: false, status: 400 });
  expect(buildArgv(stopped, "budget", { budget: "12; rm -rf /" })).toMatchObject({ ok: false, status: 400 });
  expect(buildArgv(item(), "budget", { budget: 5 })).toMatchObject({ ok: false, status: 409 });
});

test("argv: a running item, or one with a live launch of ours, refuses every verb", () => {
  const running = item({ status: "RUNNING", group: "running", stop: undefined });
  expect(isBusy(running)).toBe(true);
  const live = item({ launch: launchOf({ pid: process.pid, alive: true }) });
  expect(isBusy(live)).toBe(true);
  for (const verb of ["approve-and-rerun", "approve", "rerun", "fresh", "budget"] as const) {
    expect(buildArgv(live, verb, { subject: "plan", budget: 1 })).toMatchObject({ ok: false, status: 409 });
  }
  const closed = item({ launch: launchOf({ pid: process.pid, alive: false, exitCode: 0 }) });
  expect(isBusy(closed)).toBe(false);
});

function launchOf(fields: Partial<LaunchRecord> & { alive: boolean }): Item["launch"] {
  return {
    id: "20260905T080000000Z-DEMO-1-rerun",
    at: "2026-09-05T08:00:00.000Z",
    by: "Olivier",
    project: "demo-app",
    ticket: "DEMO-1",
    verb: "rerun",
    argv: ["run", "DEMO-1"],
    cwd: "/srv/demo-app",
    pid: 1,
    ...fields,
  };
}

/** An item outside a worktree with no stop, the base of the offers below. */
function quiet(overrides: Partial<Item> = {}): Item {
  return item({ worktree: false, stop: undefined, ...overrides });
}

const names = (offers: ReturnType<typeof verbsFor>): string[] => offers.map((offer) => offer.verb);

test("offers: a stop with a subject offers approve-and-rerun, approve only, close, and start fresh", () => {
  const offers = verbsFor(quiet({ stop: { subject: "plan", kind: "needs-decision", detail: "gate" } }));
  expect(names(offers)).toEqual(["approve-and-rerun", "approve", "close", "fresh"]);
  expect(offers[0]?.primary).toBe(true);
  expect(offers[0]?.command).toBe("lancenuit run DEMO-1 --pipeline feature --approve plan");
});

test("offers: a gate already approved elsewhere offers a rerun, not another approval", () => {
  const approval = { subject: "plan", state: "fresh" as const, decidedBy: "agent", decidedAt: "2026-09-05T09:00:00Z" };
  const approved = quiet({ stop: { subject: "plan", kind: "needs-decision", detail: "gate" }, approval });
  const offers = verbsFor(approved);
  expect(names(offers)).toEqual(["rerun", "close", "fresh"]);
  expect(offers[0]?.primary).toBe(true);
  expect(argvOf(buildArgv(approved, "rerun"))).toEqual(["run", "DEMO-1", "--pipeline", "feature"]);

  // A stale approval no longer lifts the gate: approving is the question again.
  const stale = quiet({ stop: approved.stop, approval: { ...approval, state: "stale" } });
  expect(names(verbsFor(stale))).toEqual(["approve-and-rerun", "approve", "close", "fresh"]);
  expect(buildArgv(stale, "rerun")).toMatchObject({ ok: false, status: 409 });
});

test("offers: a stop with no subject offers a plain rerun", () => {
  expect(names(verbsFor(quiet()))).toEqual(["rerun", "close", "fresh"]);
});

test("offers: FAIL and ABORTED both rerun from the failure", () => {
  for (const status of ["FAIL", "ABORTED"] as const) {
    const offers = verbsFor(quiet({ status, group: "failure" }));
    expect(names(offers)).toEqual(["rerun", "close", "fresh"]);
    expect(offers[0]?.label).toBe("Rerun from failure");
  }
});

test("offers: a closed run offers only reopen and start fresh", () => {
  const offers = verbsFor(
    quiet({ status: "FAIL", group: "done", closed: { at: "2026-09-06T08:00:00.000Z", by: "O" } }),
  );
  expect(names(offers)).toEqual(["reopen", "fresh"]);
  expect(offers[0]?.command).toBe("lancenuit reopen DEMO-1 --pipeline feature");
});

test("offers: RUNNING offers nothing, PASS only start fresh", () => {
  expect(verbsFor(quiet({ status: "RUNNING", group: "running" }))).toEqual([]);
  const pass = verbsFor(quiet({ status: "PASS", group: "done" }));
  expect(names(pass)).toEqual(["fresh"]);
  expect(pass[0]?.danger).toBe(true);
});

test("offers: a budget ceiling adds its own verb, with the amount left as a placeholder", () => {
  const offers = verbsFor(quiet({ status: "FAIL", group: "failure", budgetExceeded: true, worktree: true }));
  expect(names(offers)).toEqual(["rerun", "budget", "close", "fresh"]);
  expect(offers[1]?.command).toBe("lancenuit run DEMO-1 --pipeline feature --budget <usd> --worktree");
});

test("offers: an accounting stop gets no verb, authorizing unpriced spend is a terminal decision", () => {
  const offers = verbsFor(quiet({ status: "FAIL", group: "failure", costUnaccounted: true }));
  expect(names(offers)).toEqual(["rerun", "close", "fresh"]);
  expect(offers.every((offer) => !offer.command.includes("--allow-unmetered"))).toBe(true);
});

test("offers: every offer is admitted, and its command is the argv the server builds", () => {
  const cases = [
    item(),
    quiet(),
    quiet({ status: "FAIL", group: "failure", budgetExceeded: true, worktree: true }),
    quiet({ status: "ABORTED", group: "failure" }),
    quiet({ status: "FAIL", group: "done", closed: { at: "2026-09-06T08:00:00.000Z", by: "O" } }),
    quiet({ status: "PASS", group: "done" }),
  ];
  for (const subject of cases) {
    for (const offer of verbsFor(subject)) {
      const built = argvOf(buildArgv(subject, offer.verb, { subject: subject.stop?.subject, budget: 5 }));
      const shown = offer.verb === "budget" ? built.map((arg) => (arg === "5" ? "<usd>" : arg)) : built;
      expect(offer.command).toBe(["lancenuit", ...shown].join(" "));
    }
  }
});

test("actionable: an item is served with its offers and whether it is busy", () => {
  const served = actionable(quiet({ status: "RUNNING", group: "running" }));
  expect(served.busy).toBe(true);
  expect(served.verbs).toEqual([]);
  expect(actionable(quiet()).busy).toBe(false);
  expect(names(actionable(quiet()).verbs)).toEqual(["rerun", "close", "fresh"]);
});
