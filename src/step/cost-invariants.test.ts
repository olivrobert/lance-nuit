// Cost and attempt invariants of a run, pinned through the phases that move
// money: the attempt lifecycle, the cost gates, the step loop, the signal
// handler's closure, the resume seed and a composed child's reconciliation.
//
// The figures are binary fractions (0.125, 0.25, …) so every sum is exact: an
// equality below states an accounting rule, not a rounding accident.

import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandRegistries } from "../commands/registries.ts";
import type { AgentBackend, AgentBackendFactory, AgentSession } from "../contracts/backends.ts";
import { AgentBackendRegistry } from "../engine/registry.ts";
import type { StepResult } from "../exec/runners.ts";
import type { PipelineContext } from "../model/context.ts";
import type { PipelineStep } from "../model/definition.ts";
import type { PersistedPipelineChildRef } from "../model/persisted.ts";
import type { Run, RunStep } from "../model/run.ts";
import { buildRunReport } from "../output/run-report.ts";
import { buildPipelineContext } from "../pipeline/context.ts";
import type { RunBudget } from "../run-record/budget.ts";
import {
  aggregateControl,
  chargeChildReconciliation,
  controlForRun,
  costIsLowerBound,
} from "../run-record/cost-accounting.ts";
import { readRunEvents } from "../run-record/run-journal.ts";
import { settleCrashedAttempts } from "../run-record/run-projection.ts";
import { readRunSnapshot } from "../run-record/run-snapshot.ts";
import { makeRunStep, type StepStateInput } from "../run-record/run-step.ts";
import { abortRun, finalizeRun } from "../run-record/run-transitions.ts";
import { createAbortScope } from "../runtime/abort.ts";
import { NULL_RUN_OUTPUT } from "../runtime/run-output.ts";
import { type FixLoopDeps, runFixLoop } from "./fix-loop.ts";
import { rerunHandler } from "./on-failure.ts";
import { childLaunchGate } from "./pipeline-orchestration-child.ts";
import { runAttempt, runTrackedAttempt } from "./step-attempt.ts";
import { admitStep, executeRunSteps, type StepLoopDeps } from "./step-loop.ts";
import { resolveOutcome } from "./step-outcome.ts";

// Captured and silenced: the warnings are part of what is pinned.
const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
afterEach(() => stderr.mockClear());

function warnings(): string[] {
  return stderr.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("Cost not computable"));
}

function makeRun(steps: RunStep[], maxCost?: number): Run {
  const dir = mkdtempSync(join(tmpdir(), "cost-invariants-"));
  return { name: "p", pipeline: "p", pipeline_path: "p.ts", run_dir: dir, max_cost_usd: maxCost, steps };
}

function bashStep(id: string, def: Partial<PipelineStep> = {}, state: StepStateInput = {}): RunStep {
  return makeRunStep({ id, name: id, command: `echo ${id}`, runner: "bash", ...def }, state);
}

function agentStep(id: string, state: StepStateInput = {}): RunStep {
  return makeRunStep({ id, name: id, command: "work", runner: "agent", backend: { id: "claude" } }, state);
}

function stepSpend(run: Run): number {
  return aggregateControl(run.steps).total_cost_usd ?? 0;
}

function eventsOf(run: Run, ...types: string[]): Array<Record<string, unknown>> {
  return (readRunEvents(run.run_dir) as unknown as Array<Record<string, unknown>>).filter((event) =>
    types.includes(event.type as string),
  );
}

/** Step loop dependencies whose attempts answer from a script, in order. */
function scriptedDeps(script: Array<Partial<StepResult> | ((step: RunStep) => Partial<StepResult>)>): StepLoopDeps {
  let index = 0;
  return {
    executeStep: async (step) => {
      const entry = script[index++] ?? { ok: true };
      const r = typeof entry === "function" ? entry(step) : entry;
      return { output: "", ok: r.ok ?? true, stats: r.stats ?? { duration_ms: 1 }, ...r } as StepResult;
    },
    extractErrors: async () => ({ hasErrors: false, errors: "" }),
    runFixLoop: async () => ({ failed: true }),
    output: NULL_RUN_OUTPUT,
  };
}

const LOOP = { resuming: false } as const;

/* ------------------------------------------------------------------------- *
 * The ledger and the step totals.
 * ------------------------------------------------------------------------- */

test("every attempt the loop closes reaches the ledger and the step total by the same figure", async () => {
  const run = makeRun([bashStep("a", { on_failure: { max_retries: 1 } }), bashStep("b")], 10);
  const deps = scriptedDeps([
    { ok: false, failReason: "exit 1", stats: { duration_ms: 1, total_cost_usd: 0.125 } },
    { ok: true, stats: { duration_ms: 1, total_cost_usd: 0.25 } },
    { ok: true, stats: { duration_ms: 1, total_cost_usd: 0.5 } },
  ]);

  const outcome = await executeRunSteps(run, undefined, undefined, LOOP, deps);

  expect(outcome.cumulativeCost).toBe(0.875);
  expect(stepSpend(run)).toBe(0.875);
  expect(run.steps[0]!.attempts!.map((attempt) => attempt.control?.total_cost_usd)).toEqual([0.125, 0.25]);
  finalizeRun(run, outcome);
  expect(run.total_control?.total_cost_usd).toBe(0.875);
  expect(buildRunReport(run, outcome).budget?.spent).toBe(0.875);
});

test("a resumed run seeds its ledger with the spend its steps carry", async () => {
  const run = makeRun(
    [
      bashStep("a", {}, { status: "done", control: { duration_ms: 1, total_cost_usd: 0.75 } }),
      bashStep("b"),
      bashStep("c"),
    ],
    1,
  );
  const deps = scriptedDeps([{ ok: true, stats: { duration_ms: 1, total_cost_usd: 0.25 } }]);

  const outcome = await executeRunSteps(run, undefined, undefined, { resuming: true }, deps);

  expect(outcome.budgetExceeded).toBe(true);
  expect(outcome.cumulativeCost).toBe(1);
  expect(run.steps[2]!.status).toBe("pending");
  expect(eventsOf(run, "run.budget.exceeded")).toEqual([
    expect.objectContaining({ stepId: "c", cumulativeUsd: 1, maxCostUsd: 1, estimated: false, remainingSteps: 1 }),
  ]);
});

// The ledger is seeded through `controlForRun`, which prefers a materialized
// total: it stands for spend the step totals do not carry.
test("a materialized run total seeds the ledger in place of the step totals", async () => {
  const run = makeRun([bashStep("a", {}, { status: "done" }), bashStep("b"), bashStep("c")], 1);
  run.total_control = { duration_ms: 1, total_cost_usd: 0.75 };
  const deps = scriptedDeps([{ ok: true, stats: { duration_ms: 1, total_cost_usd: 0.25 } }]);

  const outcome = await executeRunSteps(run, undefined, undefined, { resuming: true }, deps);

  expect(outcome.budgetExceeded).toBe(true);
  expect(outcome.cumulativeCost).toBe(1);
  // The charge dropped the materialized total; the steps alone say 0.25.
  expect(run.total_control).toBeUndefined();
  expect(stepSpend(run)).toBe(0.25);
});

test("a signal closes the killed attempt on the step total, not on the ledger, and the report shows the step total", async () => {
  const run = makeRun(
    [bashStep("z", {}, { status: "done", control: { duration_ms: 1, total_cost_usd: 0.25 } }), bashStep("a")],
    10,
  );
  const deps = scriptedDeps([
    () => {
      abortRun(run, "SIGINT", { estimatedCostUsd: 0.375 });
      // The backend resolves while its process drains: this figure arrives after
      // the signal handler closed the attempt, and must be charged nowhere.
      return { ok: true, stats: { duration_ms: 1, total_cost_usd: 0.5 } };
    },
  ]);

  const outcome = await executeRunSteps(run, undefined, undefined, { resuming: true }, deps);

  expect(outcome.cumulativeCost).toBe(0.25);
  const killed = run.steps[1]!;
  expect(killed.attempts!.map((attempt) => [attempt.status, attempt.control?.total_cost_usd])).toEqual([
    ["aborted", 0.375],
  ]);
  expect(stepSpend(run)).toBe(0.625);
  finalizeRun(run, outcome);
  expect(run.status).toBe("ABORTED");
  expect(run.total_control?.total_cost_usd).toBe(0.625);
  // The report prints the step total, ahead of the ledger by the killed attempt.
  expect(buildRunReport(run, outcome).budget?.spent).toBe(0.625);
  // The next generation seeds from the step totals, so the estimate is counted.
  expect(controlForRun(run).total_cost_usd).toBe(0.625);
  expect(readRunSnapshot(join(run.run_dir, "state.json"))?.total_control?.total_cost_usd).toBe(0.625);
});

test("a composed child is charged to the parent ledger and the node total by the same difference", () => {
  const node = bashStep("node", {}, { status: "running" });
  const parent = makeRun([
    bashStep("a", {}, { status: "done", control: { duration_ms: 1, total_cost_usd: 0.25 } }),
    node,
  ]);
  const budget: RunBudget = { cumulative: 0.25 };
  const ref = {
    key: "c",
    kind: "main",
    pipeline: "child",
    status: "running",
    accountedCostUsd: 0,
  } as PersistedPipelineChildRef;
  const child = makeRun([bashStep("x", {}, { status: "done", control: { duration_ms: 1, total_cost_usd: 0.5 } })]);
  const reconcile = () => chargeChildReconciliation({ parent, step: node, ref, child, budget, fallbackCost: 0 });

  expect(reconcile()).toBe(0.5);
  expect(budget.cumulative).toBe(0.75);
  expect(stepSpend(parent)).toBe(0.75);

  // A resumed child re-reports its whole history: only what it added is charged.
  child.steps[0]!.control = { duration_ms: 1, total_cost_usd: 0.625 };
  expect(reconcile()).toBe(0.125);
  expect(reconcile()).toBe(0);
  expect(budget.cumulative).toBe(0.875);
  expect(stepSpend(parent)).toBe(0.875);
  expect(eventsOf(parent, "pipeline.child.cost.reconciled").map((event) => event.deltaCostUsd)).toEqual([
    0.5, 0.125, 0,
  ]);
});

/* ------------------------------------------------------------------------- *
 * Unknown cost: a lower bound, and a stop only on evidence.
 * ------------------------------------------------------------------------- */

test("an unpriced attempt latches the run, warns once, and the next gate stops a capped run", async () => {
  const run = makeRun([bashStep("a"), bashStep("b")], 1);
  const deps = scriptedDeps([
    { ok: true, stats: { duration_ms: 1, cost_unknown: true, input_tokens: 100, model: "m-unpriced" } },
  ]);

  const outcome = await executeRunSteps(run, undefined, undefined, LOOP, deps);

  expect(outcome.costUnaccounted).toBe(true);
  expect(outcome.costUnaccountedStop).toBe(true);
  expect(outcome.cumulativeCost).toBe(0);
  expect(run.cost_unaccounted).toBe(true);
  expect(run.steps[1]!.status).toBe("pending");
  expect(warnings()).toHaveLength(1);
  expect(warnings()[0]).toContain("m-unpriced: no pricing entry");
  expect(eventsOf(run, "step.attempt.finished", "step.cost.unaccounted", "run.cost.unaccounted")).toEqual([
    expect.objectContaining({ type: "step.attempt.finished", stepId: "a" }),
    expect.objectContaining({ type: "step.cost.unaccounted", stepId: "a", model: "m-unpriced" }),
    expect.objectContaining({ type: "run.cost.unaccounted", stepId: "b", cumulativeUsd: 0, maxCostUsd: 1 }),
  ]);
  finalizeRun(run, outcome);
  expect(buildRunReport(run, outcome).budget).toEqual({ spent: 0, limit: 1, costUnknown: true });
});

test("a metered attempt that failed before reporting a figure is a lower bound, not a stop", async () => {
  const step = agentStep("a", { status: "running" });
  const run = makeRun([step], 1);
  const budget: RunBudget = { cumulative: 0 };

  await runAttempt(run, step, {
    command: "work",
    context: buildPipelineContext({ cwd: process.cwd() }),
    budget,
    executeStep: async () => ({ output: "", ok: false, failReason: "transport closed" }) as StepResult,
  });

  expect(step.control?.cost_unknown).toBe(true);
  // Nothing charged and nothing latched: the remaining budget is what spawn saw.
  expect(budget).toEqual({ cumulative: 0, remaining: 1 });
  expect(run.cost_unaccounted).toBeUndefined();
  expect(costIsLowerBound(run)).toBe(true);
  expect(warnings()).toHaveLength(1);
  expect(warnings()[0]).toContain("no usage reported by the attempt");
  expect(warnings()[0]).toContain("the $1 ceiling is no longer guaranteed");
  expect(eventsOf(run, "step.cost.unaccounted")).toHaveLength(1);
});

test("an attempt the runner died in is settled unpriced on resume and does not stop the replay", async () => {
  // A fix pass is metered whatever the step runs, so the crash leaves `cost_unknown`.
  const step = bashStep("a", {}, { status: "running", attempts: [] });
  step.attempts = [
    {
      attempt: 1,
      kind: "fix",
      status: "running",
      started_at: new Date().toISOString(),
      log_path: "steps/a/attempt-001/output.log",
    },
  ];
  const run = makeRun([step], 1);

  expect(settleCrashedAttempts(run)).toBe(true);
  expect(step.attempts[0]).toMatchObject({ status: "failed", interrupted: true });
  expect(step.control?.cost_unknown).toBe(true);

  const deps = scriptedDeps([{ ok: true, stats: { duration_ms: 1, total_cost_usd: 0.25 } }]);
  const outcome = await executeRunSteps(run, undefined, undefined, { resuming: true, replayInterrupted: true }, deps);

  expect(outcome.costUnaccounted).toBe(false);
  expect(outcome.cumulativeCost).toBe(0.25);
  expect(step.status).toBe("done");
  expect(run.cost_unaccounted).toBeUndefined();
  expect(costIsLowerBound(run)).toBe(true);
});

test("a live guard kill records both stops after the attempt's closure, in one order", async () => {
  const step = bashStep("a", {}, { status: "running" });
  const run = makeRun([step, bashStep("b")], 1);
  const budget: RunBudget = { cumulative: 0 };

  await runAttempt(run, step, {
    command: "echo a",
    context: buildPipelineContext({ cwd: process.cwd() }),
    budget,
    executeStep: async () =>
      ({
        output: "",
        ok: false,
        failReason: "process killed",
        budgetExceeded: true,
        costUnaccounted: true,
        stats: { duration_ms: 1, total_cost_usd: 0.125 },
      }) as StepResult,
  });

  expect(budget).toMatchObject({
    cumulative: 0.125,
    exceeded: true,
    costUnknown: true,
    unaccountedStop: true,
    exceededJournaled: true,
    unaccountedJournaled: true,
  });
  expect(run).toMatchObject({ budget_exceeded: true, cost_unaccounted: true });
  expect(readRunEvents(run.run_dir).map((event) => event.type)).toEqual([
    "step.attempt.started",
    "step.attempt.finished",
    "run.budget.exceeded",
    "run.cost.unaccounted",
    "step.cost.unaccounted",
  ]);
  expect(eventsOf(run, "run.budget.exceeded")[0]).toMatchObject({ stepId: "a", cumulativeUsd: 0.125, estimated: true });
  expect(warnings()).toHaveLength(1);
  // The snapshot carries the closure and both latches.
  expect(readRunSnapshot(join(run.run_dir, "state.json"))).toMatchObject({
    budget_exceeded: true,
    cost_unaccounted: true,
    steps: [
      expect.objectContaining({ control: expect.objectContaining({ total_cost_usd: 0.125 }) }),
      expect.anything(),
    ],
  });
});

/* ------------------------------------------------------------------------- *
 * Opening an attempt.
 * ------------------------------------------------------------------------- */

test("an attempt is numbered past the journal's holes and persisted before it spawns", async () => {
  const step = bashStep("a", {}, { status: "running", last_attempt: 2 });
  step.attempts = [
    {
      attempt: 1,
      kind: "step",
      status: "failed",
      started_at: "2026-01-01T00:00:00.000Z",
      log_path: "steps/a/attempt-001/output.log",
    },
    {
      attempt: 3,
      kind: "step",
      status: "failed",
      started_at: "2026-01-01T00:00:00.000Z",
      log_path: "steps/a/attempt-003/output.log",
    },
  ];
  const run = makeRun([step]);
  let persistedBeforeSpawn: unknown;

  await runAttempt(run, step, {
    command: "echo a --flag",
    context: buildPipelineContext({ cwd: process.cwd() }),
    budget: { cumulative: 0 },
    spawn: { session: { provider: "claude", id: "s-1", resumable: true } },
    executeStep: async () => {
      persistedBeforeSpawn = readRunSnapshot(join(run.run_dir, "state.json"))?.steps[0];
      return { output: "", ok: true, stats: { duration_ms: 1 } } as StepResult;
    },
  });

  expect(persistedBeforeSpawn).toMatchObject({ last_attempt: 4, status: "running" });
  expect(step.attempts.at(-1)).toMatchObject({
    attempt: 4,
    kind: "step",
    status: "done",
    log_path: "steps/a/attempt-004/output.log",
  });
  expect(Bun.file(join(run.run_dir, "steps/a/attempt-004/command.txt")).text()).resolves.toBe("echo a --flag");
  expect(eventsOf(run, "step.attempt.started")).toEqual([
    expect.objectContaining({
      stepId: "a",
      attempt: 4,
      kind: "step",
      sessionId: "s-1",
      logPath: "steps/a/attempt-004/output.log",
    }),
  ]);
});

test("a fix attempt names only the session it resumes, a step attempt the one it runs in", async () => {
  const session: AgentSession = { provider: "claude", id: "s-step", resumable: true };
  const resumed: AgentSession = { provider: "claude", id: "s-resumed", resumable: true };
  const step = bashStep("a", {}, { status: "running" });
  const run = makeRun([step]);
  const invoke = async () => ({ ok: true, stats: { duration_ms: 1 } });
  const budget: RunBudget = { cumulative: 0 };

  await runTrackedAttempt({ run, step, kind: "fix", command: "fix", budget, spawn: { session }, invoke });
  await runTrackedAttempt({
    run,
    step,
    kind: "fix",
    command: "fix",
    budget,
    spawn: { session, resumeSession: resumed },
    invoke,
  });
  await runTrackedAttempt({
    run,
    step,
    kind: "step",
    command: "run",
    budget,
    spawn: { resumeSession: resumed },
    invoke,
  });

  expect(eventsOf(run, "step.attempt.started").map((event) => event.sessionId)).toEqual([
    null,
    "s-resumed",
    "s-resumed",
  ]);
});

/* ------------------------------------------------------------------------- *
 * The six cost gates: same budget, same record.
 * ------------------------------------------------------------------------- */

type BudgetState = "ceiling" | "guard" | "unaccounted";

function budgetIn(state: BudgetState): RunBudget {
  if (state === "ceiling") return { cumulative: 1 };
  if (state === "guard") return { cumulative: 0.5, exceeded: true };
  return { cumulative: 0.5, costUnknown: true };
}

const EXPECTED: Record<BudgetState, { events: Array<Record<string, unknown>>; budget: Partial<RunBudget> }> = {
  ceiling: {
    events: [{ type: "run.budget.exceeded", stepId: "s", cumulativeUsd: 1, maxCostUsd: 1, estimated: false }],
    budget: { exceededJournaled: true },
  },
  guard: {
    events: [{ type: "run.budget.exceeded", stepId: "s", cumulativeUsd: 0.5, maxCostUsd: 1, estimated: true }],
    budget: { exceeded: true, exceededJournaled: true },
  },
  unaccounted: {
    events: [{ type: "run.cost.unaccounted", stepId: "s", cumulativeUsd: 0.5, maxCostUsd: 1 }],
    budget: { costUnknown: true, unaccountedStop: true, unaccountedJournaled: true },
  },
};

/** The stop as recorded: its journal events (without `remainingSteps`, which
 *  counts the gate's own run) and the latches on the ledger and the run. */
interface StopRecord {
  events: Array<Record<string, unknown>>;
  budget: Partial<RunBudget>;
  run: Pick<Run, "budget_exceeded" | "cost_unaccounted">;
}

function stopRecord(run: Run, budget: RunBudget): StopRecord {
  return {
    events: eventsOf(run, "run.budget.exceeded", "run.cost.unaccounted").map(
      ({ type, stepId, cumulativeUsd, maxCostUsd, estimated }) => ({
        type,
        stepId,
        cumulativeUsd,
        maxCostUsd,
        ...(estimated !== undefined ? { estimated } : {}),
      }),
    ),
    budget: {
      exceeded: budget.exceeded,
      exceededJournaled: budget.exceededJournaled,
      costUnknown: budget.costUnknown,
      unaccountedStop: budget.unaccountedStop,
      unaccountedJournaled: budget.unaccountedJournaled,
    },
    run: { budget_exceeded: run.budget_exceeded, cost_unaccounted: run.cost_unaccounted },
  };
}

function expectedRecord(state: BudgetState): StopRecord {
  const { events, budget } = EXPECTED[state];
  return {
    events,
    budget: {
      exceeded: undefined,
      exceededJournaled: undefined,
      costUnknown: undefined,
      unaccountedStop: undefined,
      unaccountedJournaled: undefined,
      ...budget,
    },
    run: { budget_exceeded: undefined, cost_unaccounted: undefined },
  };
}

function fakeFixBackend(id: string): AgentBackendFactory {
  const capabilities = {
    structuredOutput: true,
    streaming: true,
    resume: true,
    usageTokens: true,
    cost: "exact" as const,
    configurationAxes: ["model", "effort"] as const,
  };
  const backend: AgentBackend = {
    id,
    capabilities,
    sessionSizeKb: () => 0,
    applyEscalation: (options) => options,
    applyConfigAxes: (options) => options,
    run: async () => {
      throw new Error("the fake backend never spawns");
    },
  };
  return { id, capabilities, create: () => backend };
}

function fixDeps(onFix: () => void): FixLoopDeps {
  return {
    runWithAgent: async () => {
      onFix();
      return { ok: true, stats: { duration_ms: 1, total_cost_usd: 0 } };
    },
    executeStep: async () => {
      throw new Error("the gate withholds the replay");
    },
    extractErrors: async () => ({ hasErrors: true, errors: "err" }),
    registry: new AgentBackendRegistry().register(fakeFixBackend("claude"), { default: true }),
  };
}

const context = (): PipelineContext => buildPipelineContext({ ...commandRegistries(), cwd: process.cwd() });

const GATES: Record<string, (state: BudgetState) => Promise<{ run: Run; budget: RunBudget }>> = {
  "step admission": async (state) => {
    const step = bashStep("s");
    const run = makeRun([step], 1);
    const budget = budgetIn(state);
    await admitStep({ run, step, baseCtx: context(), budget, output: NULL_RUN_OUTPUT });
    return { run, budget };
  },
  "re-ask of a refused capture": async (state) => {
    const session: AgentSession = { provider: "claude", id: "sess", resumable: true };
    const step = agentStep("s", { status: "running", session });
    const run = makeRun([step], 1);
    const budget = budgetIn(state);
    const stepLog = join(run.run_dir, "output.log");
    writeFileSync(stepLog, "");
    await resolveOutcome({
      run,
      step,
      command: "work",
      baseCtx: context(),
      budget,
      abort: createAbortScope(),
      result: { ok: false, output: "", failReason: "refused", captureRefused: true },
      stepLog,
      deps: {
        executeStep: async () => {
          throw new Error("the gate withholds the re-ask");
        },
        extractErrors: async () => ({ errors: "", hasErrors: false }),
        runFixLoop: async () => ({ failed: true }),
      },
      output: NULL_RUN_OUTPUT,
    });
    return { run, budget };
  },
  "rerun of a failed step": async (state) => {
    const step = bashStep("s", { on_failure: { max_retries: 1 } }, { status: "running" });
    const run = makeRun([step], 1);
    const budget = budgetIn(state);
    await rerunHandler({
      run,
      step,
      command: "echo s",
      output: "",
      baseCtx: context(),
      budget,
      abort: createAbortScope(),
      timedOut: false,
      runOutput: NULL_RUN_OUTPUT,
      deps: {
        executeStep: async () => {
          throw new Error("the gate withholds the rerun");
        },
        runFixLoop: async () => ({ failed: true }),
      },
    });
    return { run, budget };
  },
  "repair pass": async (state) => {
    const step = bashStep("s", { on_failure: { fix_prompt: "fix", max_retries: 1 } }, { status: "running" });
    const run = makeRun([step], 1);
    const budget = budgetIn(state);
    await runFixLoop(run, step, "echo s", "out", context(), budget, "r0", {
      deps: fixDeps(() => {
        throw new Error("the gate withholds the repair");
      }),
      output: NULL_RUN_OUTPUT,
      abort: createAbortScope(),
    });
    return { run, budget };
  },
  "replay after a repair": async (state) => {
    const step = bashStep("s", { on_failure: { fix_prompt: "fix", max_retries: 1 } }, { status: "running" });
    const run = makeRun([step], 1);
    const budget: RunBudget = { cumulative: 0 };
    // The repair itself costs nothing; what it leaves is the state under test.
    await runFixLoop(run, step, "echo s", "out", context(), budget, "r0", {
      deps: fixDeps(() => Object.assign(budget, budgetIn(state))),
      output: NULL_RUN_OUTPUT,
      abort: createAbortScope(),
    });
    return { run, budget };
  },
  "composed child launch": async (state) => {
    const run = makeRun([bashStep("s", {}, { status: "running" })], 1);
    const budget = budgetIn(state);
    childLaunchGate(run, budget, "child c", "s");
    return { run, budget };
  },
};

for (const state of ["ceiling", "guard", "unaccounted"] as const) {
  test(`every cost gate records the same stop for the same budget: ${state}`, async () => {
    for (const [gate, run] of Object.entries(GATES)) {
      const { run: stopped, budget } = await run(state);
      expect({ gate, ...stopRecord(stopped, budget) }).toEqual({ gate, ...expectedRecord(state) });
    }
  });
}

test("a stop is journaled once per generation, however many gates observe it", async () => {
  const step = bashStep("s");
  const run = makeRun([step], 1);
  const budget = budgetIn("unaccounted");
  await admitStep({ run, step, baseCtx: context(), budget, output: NULL_RUN_OUTPUT });
  childLaunchGate(run, budget, "child c", "s");
  await admitStep({ run, step, baseCtx: context(), budget, output: NULL_RUN_OUTPUT });

  expect(stopRecord(run, budget)).toEqual(expectedRecord("unaccounted"));
});
