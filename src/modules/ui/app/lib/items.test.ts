import { describe, expect, test } from "bun:test";
import { failedBeforeRun, headlineOf, reasonOf, unmeteredResumeCommand, verbLabel } from "./items.js";
import { makeItem, makeLaunch } from "./testing.js";

describe("reasonOf and headlineOf", () => {
  test("an alive launch outranks whatever the disk still says", () => {
    const item = makeItem({ status: "FAIL", group: "failure", launch: makeLaunch({ alive: true, verb: "fresh" }) });
    expect(reasonOf(item)).toBe("launched by olivier (start fresh)");
  });

  test("a decision reads its stop detail, a failure its phase and reason", () => {
    expect(reasonOf(makeItem({ stop: { detail: "needs a call" } }))).toBe("needs a call");
    expect(reasonOf(makeItem({ group: "decision", stop: undefined }))).toBe("stopped");
    expect(
      reasonOf(makeItem({ group: "failure", status: "FAIL", failure: { phase: "build", reason: "exit 1" } })),
    ).toBe("build — exit 1");
    expect(reasonOf(makeItem({ group: "failure", status: "ABORTED" }))).toBe("aborted");
  });

  test("a timeout is called out ahead of the failing phase", () => {
    const item = makeItem({
      group: "failure",
      status: "FAIL",
      failure: { phase: "agent", reason: "Timeout after 5m" },
    });
    expect(headlineOf(item)).toBe("Execution timed out");
    expect(headlineOf(makeItem({ group: "failure", status: "ABORTED" }))).toBe("Execution interrupted");
    expect(headlineOf(makeItem({ group: "decision", stop: { detail: "x", subject: "plan" } }))).toBe("Review plan");
  });
});

describe("closed runs and verb labels", () => {
  test("a closed run reads as closed by hand", () => {
    const item = makeItem({ status: "FAIL", group: "done", closed: { at: "2026-09-06T08:00:00.000Z", by: "Olivier" } });
    expect(headlineOf(item)).toBe("Closed by hand");
    expect(reasonOf(item)).toBe("closed by Olivier");
  });

  test("the unmetered resume is shown as a command, worktree flag included", () => {
    const item = makeItem({
      status: "FAIL",
      group: "failure",
      costUnaccounted: true,
      worktree: true,
      pipelineRef: "/srv/web/flows/other.ts",
    });
    expect(unmeteredResumeCommand(item)).toBe(
      "lancenuit run ABC-1 --pipeline /srv/web/flows/other.ts --allow-unmetered --worktree",
    );
  });

  test("a verb the browser does not know falls through to its own name", () => {
    expect(verbLabel("approve")).toBe("approve only");
    expect(verbLabel("teleport")).toBe("teleport");
  });
});

describe("failedBeforeRun", () => {
  test("true when the launch died and the run never moved after it", () => {
    const item = makeItem({
      updatedAt: "2026-01-10T10:00:00.000Z",
      launch: makeLaunch({ at: "2026-01-10T11:00:00.000Z", exitCode: 1 }),
    });
    expect(failedBeforeRun(item)).toBe(true);
  });

  test("false when the run moved after the launch: the failure is the run's", () => {
    const item = makeItem({
      updatedAt: "2026-01-10T11:30:00.000Z",
      launch: makeLaunch({ at: "2026-01-10T11:00:00.000Z", exitCode: 1 }),
    });
    expect(failedBeforeRun(item)).toBe(false);
  });

  test("false with no launch, a live launch, or a clean exit", () => {
    expect(failedBeforeRun(makeItem())).toBe(false);
    expect(failedBeforeRun(makeItem({ launch: makeLaunch({ alive: true }) }))).toBe(false);
    expect(failedBeforeRun(makeItem({ launch: makeLaunch({ exitCode: 0 }) }))).toBe(false);
  });

  test("an aborted launch with no exit code still counts as failed before the run", () => {
    const item = makeItem({
      updatedAt: "2026-01-10T09:00:00.000Z",
      launch: makeLaunch({ exitCode: null }),
    });
    expect(failedBeforeRun(item)).toBe(true);
  });

  test("an unparsable run timestamp does not hide the launch failure", () => {
    const item = makeItem({ updatedAt: "n/a", launch: makeLaunch({ exitCode: 2 }) });
    expect(failedBeforeRun(item)).toBe(true);
  });
});
