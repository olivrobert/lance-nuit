import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "../model/run.js";
import { ConsoleRunReporter } from "../output/console-reporter.js";
import { buildRunReport } from "../output/run-report.js";
import { readRunEvents } from "./run-journal.js";
import { makeRunStep } from "./run-step.js";
import {
  abortRun,
  absorbStepFailure,
  finalizeRun,
  recordStepVerdict,
  type RunOutcome,
  stopRun,
  updateStep,
} from "./run-transitions.js";

const outcome: RunOutcome = {
  failed: false,
  stopped: false,
  budgetExceeded: false,
  costUnaccounted: false,
  costUnaccountedStop: false,
  cumulativeCost: 0.3,
};

test("report: validates the integration contract", () => {
  const runDir = mkdtempSync(join(tmpdir(), "report-"));
  const run: Run = {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: runDir,
    steps: [
      makeRunStep(
        { id: "a", name: "A", command: "true", runner: "bash" },
        { status: "done", control: { duration_ms: 100, total_cost_usd: 0.3 }, usage: { output_tokens: 42 } },
      ),
    ],
  };
  finalizeRun(run);
  const saved = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"));
  expect(saved).toMatchObject({
    total_control: { duration_ms: 100, total_cost_usd: 0.3 },
    total_usage: { output_tokens: 42 },
  });
  expect(saved.steps[0].stats).toBeUndefined();

  let output = "";
  new ConsoleRunReporter(
    {
      write: (text) => {
        output += text;
      },
    },
    runDir,
  ).report(buildRunReport(run, outcome, { statsPath: "/tmp/run-stats.json" }));
  expect(output).toContain("✓ SUCCESS · p");
  expect(output).toContain("1 completed");
  expect(output).toContain("stats   /tmp/run-stats.json");
});

function reportOf(failKind: "verdict" | "technical"): string {
  const runDir = mkdtempSync(join(tmpdir(), "report-"));
  const run: Run = {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: runDir,
    steps: [
      makeRunStep(
        { id: "reuse-audit", name: "Reuse Audit", command: "true", runner: "agent", backend: { id: "claude" } },
        { status: "failed", errors: "1 reuse contract violation", fail_kind: failKind },
      ),
    ],
  };
  finalizeRun(run, { failed: true, stopped: false, budgetExceeded: false, cumulativeCost: 0 });

  let output = "";
  new ConsoleRunReporter(
    {
      write: (text) => {
        output += text;
      },
    },
    runDir,
  ).report(buildRunReport(run, { failed: true, stopped: false, budgetExceeded: false, cumulativeCost: 0 }));
  return output;
}

test("report: validates the integration contract", () => {
  const output = reportOf("verdict");
  expect(output).toContain("! ACTION REQUIRED");
  expect(output).toContain("Quality check failed: Reuse Audit");
  expect(output).toContain("Verdict\n  1 reuse contract violation");
  expect(output).not.toContain("Technical error");
});

test("report: validates the integration contract", () => {
  const output = reportOf("technical");
  expect(output).toContain("✗ FAILURE");
  expect(output).toContain("Technical error during Reuse Audit");
  expect(output).toContain("Diagnostic\n  1 reuse contract violation");
});

test("report: validates the integration contract", () => {
  const runDir = mkdtempSync(join(tmpdir(), "report-"));
  const run: Run = {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: runDir,
    steps: [
      // The snapshot of a previous run: `errors` survived the resume round trip.
      makeRunStep(
        { id: "implement-lots", name: "Implement lots", command: "true", runner: "bash" },
        { status: "failed", errors: "process killed: timeout (900s)" },
      ),
    ],
  };
  const step = run.steps[0]!;

  updateStep(run, step, "running");
  expect(step.errors).toBeUndefined();
  updateStep(run, step, "failed", "AC-4 is not satisfied");

  finalizeRun(run, { failed: true, stopped: false, budgetExceeded: false, cumulativeCost: 0 });
  const saved = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"));
  expect(saved.outcome.reason).toBe("AC-4 is not satisfied");
  expect(Date.parse(saved.outcome.at)).toBeGreaterThan(0);
});

test("report: fail_cause reaches the run outcome, the journal, and the resumed generation", () => {
  const runDir = mkdtempSync(join(tmpdir(), "report-failcause-"));
  const run: Run = {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: runDir,
    steps: [makeRunStep({ id: "deploy", name: "Deploy", command: "true", runner: "bash" }, { status: "pending" })],
  };
  const step = run.steps[0]!;

  step.fail_cause = "blocked";
  updateStep(run, step, "failed", "the release branch does not exist");
  expect(run.outcome?.failCause).toBe("blocked");
  const changed = readRunEvents(runDir).filter((event) => event.type === "step.status.changed");
  expect(changed.at(-1)).toMatchObject({ stepId: "deploy", status: "failed", failCause: "blocked" });

  finalizeRun(run, { failed: true, stopped: false, budgetExceeded: false, cumulativeCost: 0 });
  const saved = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"));
  expect(saved.outcome.failCause).toBe("blocked");
  expect(saved.steps[0].fail_cause).toBe("blocked");

  // A replay once the obstacle is lifted clears both the step field and the
  // event, so the next report cannot claim the run is still blocked.
  updateStep(run, step, "running");
  expect(step.fail_cause).toBeUndefined();
  const running = readRunEvents(runDir).filter((event) => event.type === "step.status.changed");
  expect(running.at(-1)).toMatchObject({ status: "running" });
  expect(running.at(-1)).not.toHaveProperty("failCause");
});

test("report: a run STOPPED by a block keeps the cause, the kind and the stop", () => {
  const runDir = mkdtempSync(join(tmpdir(), "report-stopped-blocked-"));
  const run: Run = {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: runDir,
    steps: [
      makeRunStep(
        { id: "deploy", name: "Deploy", command: "true", runner: "bash" },
        { status: "failed", fail_kind: "verdict", fail_cause: "blocked", errors: "the release branch is missing" },
      ),
    ],
  };
  // What `resolveOutcome` leaves behind on the canonical blocked path: the step
  // marked failed, then a clean stop that outranks the failure as the run status.
  stopRun(run, run.steps[0]!, "the release branch is missing", {
    kind: "blocked",
    detail: "the release branch is missing",
  });

  finalizeRun(run, { failed: false, stopped: true, budgetExceeded: false, cumulativeCost: 0 });

  const saved = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"));
  expect(saved.status).toBe("STOPPED");
  // Finalization rebuilds the outcome. Dropping these three here made the blocked
  // path the one case where `outcome.failCause` was never written — and left a
  // composed parent, which reads its child's FINALIZED outcome, unable to see it.
  expect(saved.outcome.failCause).toBe("blocked");
  expect(saved.outcome.failKind).toBe("verdict");
  expect(saved.outcome.stop).toEqual({ kind: "blocked", detail: "the release branch is missing" });
  const finished = readRunEvents(runDir).filter((event) => event.type === "run.finished");
  expect((finished[0] as unknown as { outcome: Record<string, unknown> }).outcome.failCause).toBe("blocked");
});

// --- The accounting stop, as the console prints it ---------------------------

/** A capped run that spent tokens no table could price, with one step still
 *  pending: the exact shape the step loop reports as `costUnaccounted`. */
function unaccountedReport(overrides: Partial<RunOutcome> = {}): string {
  const runDir = mkdtempSync(join(tmpdir(), "report-cost-"));
  const run: Run = {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: runDir,
    ticket: "T-1",
    max_cost_usd: 5,
    cost_unaccounted: true,
    steps: [
      makeRunStep(
        { id: "a", name: "A", command: "go", runner: "agent", backend: { id: "claude" } },
        {
          status: "done",
          control: { duration_ms: 10, total_cost_usd: 0, cost_unknown: true },
          usage: { output_tokens: 100 },
        },
      ),
      makeRunStep({ id: "b", name: "B", command: "true", runner: "bash" }, { status: "pending" }),
    ],
  };
  const outcome: RunOutcome = {
    failed: false,
    stopped: false,
    budgetExceeded: false,
    costUnaccounted: true,
    // The admission gate withheld step "b": the accounting stop is the REASON the
    // run ended, which is what earns the headline and the recovery command.
    costUnaccountedStop: true,
    cumulativeCost: 0,
    ...overrides,
  };
  finalizeRun(run, outcome);

  let output = "";
  new ConsoleRunReporter({ write: (text) => (output += text) }, runDir).report(buildRunReport(run, outcome));
  return output;
}

test("report: an accounting stop gets its own headline and the exact recovery command", () => {
  const output = unaccountedReport();
  expect(output).toContain("! COST UNACCOUNTED");
  expect(output).toContain("Spending unaccounted");
  // Not the budget wording: raising the ceiling cannot price a closed attempt.
  expect(output).not.toContain("BUDGET EXCEEDED");
  expect(output).not.toContain("Increase the budget");
  expect(output).toContain("↻ lancenuit run T-1 --pipeline p --allow-unmetered");
  expect(output).toContain("cost unaccounted");
});

test("report: an unknown spend is never printed as an exact zero", () => {
  const output = unaccountedReport();
  // Both the ledger line and the step metrics carry the lower-bound mark.
  expect(output).toContain("Budget ≥ $0.00 / $5.00");
  expect(output).toContain("≥ $0.00");
  expect(output).not.toMatch(/[^≥] \$0\.00/);
});

test("report: a step that failed for its own reason is not headlined as an accounting stop", () => {
  // The ledger is a lower bound here too — the same unpriced attempt is in it —
  // but no gate withheld anything: the step failed on its own merits and that is
  // what an operator has to act on. "Spending unaccounted" would send them to
  // `--allow-unmetered` for a failure the authorization does not touch.
  const output = unaccountedReport({ failed: true, costUnaccountedStop: false });
  expect(output).toContain("FAILURE");
  expect(output).not.toContain("COST UNACCOUNTED");
  expect(output).not.toContain("--allow-unmetered");
  // The `≥` convention is untouched: the total is still a lower bound.
  expect(output).toContain("Budget ≥ $0.00 / $5.00");
});

test("report: a reached ceiling still outranks the accounting stop", () => {
  // `costDecision`'s precedence, all the way to the headline: the known lower
  // bound is the harder fact and the one `--budget` can act on.
  const output = unaccountedReport({ budgetExceeded: true });
  expect(output).toContain("! BUDGET EXCEEDED");
  expect(output).not.toContain("COST UNACCOUNTED");
  expect(output).not.toContain("--allow-unmetered");
});

// --- The stop, as a value on the outcome ------------------------------------

/** Finalize a two-step run whose first step failed, and return what a
 *  post-mortem reads: the snapshot outcome and the `run.finished` payload. */
function finalizedStop(overrides: Partial<RunOutcome>): {
  outcome: Record<string, unknown>;
  finished: Record<string, unknown>;
} {
  const runDir = mkdtempSync(join(tmpdir(), "report-stopkind-"));
  const run: Run = {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: runDir,
    max_cost_usd: 0.05,
    steps: [
      makeRunStep(
        { id: "fix-standard", name: "Fix standard", command: "go", runner: "agent", backend: { id: "claude" } },
        {
          status: "failed",
          // The exact shape a live guard kill leaves behind: a technical failure
          // whose reason is a sentence, which is all a reader used to get.
          errors: "process killed: budget exceeded ($0.11 estimated > $0.05 remaining)",
          fail_kind: "technical",
          control: { duration_ms: 10, total_cost_usd: 0.02, cost_estimated: true },
        },
      ),
      makeRunStep({ id: "verify", name: "Verify", command: "true", runner: "bash" }, { status: "pending" }),
    ],
  };
  finalizeRun(run, {
    failed: true,
    stopped: false,
    budgetExceeded: false,
    cumulativeCost: 0.02,
    ...overrides,
  });
  const saved = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"));
  const finished = readRunEvents(runDir).filter((event) => event.type === "run.finished");
  expect(finished).toHaveLength(1);
  return { outcome: saved.outcome, finished: finished[0] as unknown as Record<string, unknown> };
}

test("report: a budget stop is recorded as a typed stop kind, not only as a sentence", () => {
  const { outcome, finished } = finalizedStop({ budgetExceeded: true });
  expect(outcome.stopKind).toBe("budget-exceeded");
  // The sentence and the step kind are unchanged: the step really was killed, and
  // `failKind` still drives retry policy at step level.
  expect(String(outcome.reason)).toContain("budget exceeded");
  expect(outcome.failKind).toBe("technical");
  // `run.finished` inherits the whole outcome, so the journal carries the stop.
  expect((finished.outcome as Record<string, unknown>).stopKind).toBe("budget-exceeded");
});

test("report: an accounting stop is recorded as its own stop kind", () => {
  const { outcome, finished } = finalizedStop({ costUnaccounted: true, costUnaccountedStop: true });
  expect(outcome.stopKind).toBe("cost-unaccounted");
  expect((finished.outcome as Record<string, unknown>).stopKind).toBe("cost-unaccounted");
});

test("report: a plain technical failure records no stop kind", () => {
  // The distinction the field exists for: nothing about the cost policy ended
  // this run, so nothing claims it did.
  const { outcome, finished } = finalizedStop({});
  expect(outcome.stopKind).toBeUndefined();
  expect((finished.outcome as Record<string, unknown>).stopKind).toBeUndefined();
});

test("report: an unknown ledger beside a step failure is not a stop kind", () => {
  // `costUnaccounted` alone says the total is a lower bound; only a gate that
  // WITHHELD work makes the accounting the reason the run ended. Same precedence
  // as `reportKind`.
  const { outcome } = finalizedStop({ costUnaccounted: true });
  expect(outcome.stopKind).toBeUndefined();
});

test("report: a reached ceiling outranks the accounting stop in the stop kind too", () => {
  const { outcome } = finalizedStop({
    budgetExceeded: true,
    costUnaccounted: true,
    costUnaccountedStop: true,
  });
  expect(outcome.stopKind).toBe("budget-exceeded");
});

// --- Transition ownership -----------------------------------------------------

function twoStepRun(prefix: string): Run {
  const runDir = mkdtempSync(join(tmpdir(), prefix));
  return {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: runDir,
    steps: [
      makeRunStep({ id: "a", name: "A", command: "true", runner: "bash" }, { status: "done" }),
      makeRunStep({ id: "b", name: "B", command: "true", runner: "bash" }, { status: "pending" }),
    ],
  };
}

function snapshotOf(run: Run): string {
  return readFileSync(join(run.run_dir, "state.json"), "utf-8");
}

test("recordStepVerdict: set on failure, cleared on success and by the next attempt", () => {
  const run = twoStepRun("transitions-verdict-");
  const step = run.steps[1]!;

  recordStepVerdict(run, step, { ok: false, failKind: "verdict", failCause: "blocked" });
  expect(step.fail_kind).toBe("verdict");
  expect(step.fail_cause).toBe("blocked");
  // Not a persisted transition on its own: the status change that follows is.
  expect(() => snapshotOf(run)).toThrow();

  updateStep(run, step, "failed", "the release branch is missing");
  expect(run.outcome).toMatchObject({ phase: "b", failKind: "verdict", failCause: "blocked" });

  recordStepVerdict(run, step, { ok: false, failKind: "technical" });
  expect(step.fail_kind).toBe("technical");
  expect(step.fail_cause).toBeUndefined();

  recordStepVerdict(run, step, { ok: true, failKind: "technical", failCause: "blocked" });
  expect(step.fail_kind).toBeUndefined();
  expect(step.fail_cause).toBeUndefined();

  recordStepVerdict(run, step, { ok: false, failKind: "verdict", failCause: "blocked" });
  updateStep(run, step, "running");
  expect(step.fail_kind).toBeUndefined();
  expect(step.fail_cause).toBeUndefined();
});

test("absorbStepFailure: the step is done, the reason stays, the journal event is unchanged", () => {
  const run = twoStepRun("transitions-absorb-");
  const step = run.steps[1]!;
  updateStep(run, step, "running");

  absorbStepFailure(run, step, "lint warnings");

  expect(step.status).toBe("done");
  expect(step.errors).toBe("lint warnings");
  expect(run.status).toBe("RUNNING");
  expect(run.outcome).toBeUndefined();
  const changed = readRunEvents(run.run_dir).filter((event) => event.type === "step.status.changed");
  expect(changed.at(-1)).toMatchObject({ stepId: "b", status: "done" });
  expect(changed.at(-1)).not.toHaveProperty("reason");
  expect(JSON.parse(snapshotOf(run)).steps[1]).toMatchObject({ status: "done", errors: "lint warnings" });
});

test("stopRun: the run stops, the remaining work is preserved, finalization keeps STOPPED", () => {
  const run = twoStepRun("transitions-stop-");
  const step = run.steps[1]!;

  stopRun(run, step, "needs a decision", { kind: "needs-decision", detail: "needs a decision", subject: "go" });

  expect(run.status).toBe("STOPPED");
  expect(run.stopped_reason).toBe("needs a decision");
  expect(step.status).toBe("pending");
  expect(run.outcome).toMatchObject({ phase: "b", resumable: true, stop: { kind: "needs-decision", subject: "go" } });

  finalizeRun(run, { stopped: true });
  const saved = JSON.parse(snapshotOf(run));
  expect(saved.status).toBe("STOPPED");
  expect(saved.steps[1].status).toBe("pending");
  expect(saved.outcome).toMatchObject({ phase: "b", reason: "needs a decision", stop: { subject: "go" } });
  expect(readRunEvents(run.run_dir).map((event) => event.type)).toEqual(["run.stopped", "run.finished"]);
});

test("finalizeRun: success and failure, from the steps and the loop signals", () => {
  const passed = twoStepRun("transitions-pass-");
  updateStep(passed, passed.steps[1]!, "running");
  updateStep(passed, passed.steps[1]!, "done");
  finalizeRun(passed, { failed: false, stopped: false, budgetExceeded: false });
  expect(passed.status).toBe("PASS");
  expect(passed.outcome).toMatchObject({ phase: null, reason: null, resumable: false });
  expect(JSON.parse(snapshotOf(passed)).status).toBe("PASS");

  const failed = twoStepRun("transitions-fail-");
  updateStep(failed, failed.steps[1]!, "running");
  recordStepVerdict(failed, failed.steps[1]!, { ok: false, failKind: "technical" });
  updateStep(failed, failed.steps[1]!, "failed", "exit code 2");
  finalizeRun(failed, { failed: true });
  expect(failed.status).toBe("FAIL");
  expect(failed.outcome).toMatchObject({ phase: "b", reason: "exit code 2", failKind: "technical", resumable: true });
  expect(JSON.parse(snapshotOf(failed)).outcome.failKind).toBe("technical");
});

test("finalizeRun: a run that crashed between its last step and its verdict is finalized from its steps", () => {
  // What resume hands over: every step settled, status still RUNNING, no outcome.
  const run = twoStepRun("transitions-crash-");
  run.steps[1]!.status = "done";
  run.status = "RUNNING";

  finalizeRun(run);

  expect(run.status as string).toBe("PASS");
  expect(run.outcome).toMatchObject({ phase: null, reason: null, resumable: false });
  expect(run.total_control).toBeDefined();
  const saved = JSON.parse(snapshotOf(run));
  expect(saved.status).toBe("PASS");
  expect(Date.parse(saved.outcome.at)).toBeGreaterThan(0);
  expect(readRunEvents(run.run_dir).map((event) => event.type)).toEqual(["run.finished"]);
});

test("after an interruption, the refused transitions change neither memory nor snapshot", () => {
  const run = twoStepRun("transitions-aborted-");
  const step = run.steps[1]!;
  updateStep(run, step, "running");
  abortRun(run, "SIGINT");
  expect(run.aborted).toBe(true);
  expect(step.status).toBe("aborted");
  const memory = JSON.stringify({ run: { ...run, steps: undefined }, steps: run.steps });
  const snapshot = snapshotOf(run);
  const events = readRunEvents(run.run_dir).length;

  updateStep(run, step, "failed", "late failure");
  updateStep(run, step, "done");
  recordStepVerdict(run, step, { ok: false, failKind: "technical", failCause: "blocked" });
  absorbStepFailure(run, step, "absorbed late");
  stopRun(run, step, "late stop", { kind: "needs-human", detail: "late stop" });

  expect(JSON.stringify({ run: { ...run, steps: undefined }, steps: run.steps })).toBe(memory);
  expect(snapshotOf(run)).toBe(snapshot);
  expect(readRunEvents(run.run_dir)).toHaveLength(events);
});

test("after an interruption, finalization keeps ABORTED and completes the outcome, totals and snapshot", () => {
  const run = twoStepRun("transitions-aborted-final-");
  const step = run.steps[1]!;
  updateStep(run, step, "running");
  abortRun(run, "SIGTERM");
  // The loop reports what it learned before the signal; none of it outranks the
  // interruption.
  finalizeRun(run, { failed: true, stopped: true, budgetExceeded: true });

  expect(run.status).toBe("ABORTED");
  expect(run.aborted).toBe(true);
  expect(run.outcome).toMatchObject({ phase: "b", reason: "SIGTERM: run interrupted manually", resumable: true });
  expect(run.outcome).not.toHaveProperty("stopKind");
  expect(Date.parse(run.outcome!.at!)).toBeGreaterThan(0);
  expect(run.total_control).toBeDefined();
  const saved = JSON.parse(snapshotOf(run));
  expect(saved.status).toBe("ABORTED");
  expect(saved.aborted).toBe(true);
  expect(saved.outcome.at).toBe(run.outcome!.at);
  expect(readRunEvents(run.run_dir).map((event) => event.type)).toEqual([
    "step.status.changed",
    "step.status.changed",
    "run.aborted",
    "run.finished",
  ]);
});
