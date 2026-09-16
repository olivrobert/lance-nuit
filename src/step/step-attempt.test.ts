import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { artifact, textArtifact } from "../dsl/artifact.ts";
import type { AgentSession } from "../contracts/backends.ts";
import type { executeStep, runWithAgent } from "../exec/runners.ts";
import type { ArtifactRef, WorkItemArtifactStore } from "../model/artifact-ports.ts";
import type { PipelineStep } from "../model/definition.ts";
import type { Run, RunStep } from "../model/run.ts";
import { buildPipelineContext } from "../pipeline/context.ts";
import { settleAttemptStats } from "../state/attempt-closure.ts";
import type { RunBudget } from "../state/budget.ts";
import { chargeAttemptToLedger } from "../state/cost-accounting.ts";
import { sha256Text } from "../state/hash.ts";
import { PROVENANCE_PREFIX, readProvenance, writeProvenance } from "../state/provenance.ts";
import { readRunEvents } from "../state/run-journal.ts";
import { attemptLogPath, nextAttemptLogPath } from "../state/run-timeline.ts";
import { abortRun } from "../state/run-transitions.ts";
import { makeRunStep, type StepStateInput } from "../state/run-step.ts";
import { applyStepSession, runAttempt, runFixAttempt } from "./step-attempt.ts";

const CLAUDE_SESSION = (id: string): AgentSession => ({ provider: "claude", id, resumable: true });
import { createDefaultAgentBackendRegistry } from "../engine/default-registry.ts";
import { commandRegistries } from "../commands/registries.js";

/** Explicit registry: a fix spawn no longer resolves one from a singleton. */
const REGISTRY = createDefaultAgentBackendRegistry();

type ExecuteStep = typeof executeStep;
type FixWithAgent = typeof runWithAgent;

/** Fake backend: the fix gate requires one, but its identity is irrelevant here. */
const FIX_SPEC = { id: "claude" } as const;

const baseCtx = buildPipelineContext({ ...commandRegistries(), cwd: ".", runnerBin: "", runnerDir: "" });

function artifactFixture(initial?: unknown) {
  let value = initial === undefined ? undefined : JSON.stringify(initial);
  const store: WorkItemArtifactStore = {
    exists: async () => value !== undefined,
    readText: async () => value,
    readJson: async <T>(_ref: ArtifactRef, parse: (raw: unknown) => T) =>
      value === undefined ? undefined : parse(JSON.parse(value)),
    writeText: async (_ref, next) => {
      value = next;
    },
    remove: async () => {
      value = undefined;
    },
  };
  return {
    ctx: buildPipelineContext({ ...commandRegistries(), cwd: ".", ticket: "PROJ-1", artifacts: store }),
    write: (next: unknown) => {
      value = JSON.stringify(next);
    },
    read: () => value,
  };
}

const verdictArtifact = artifact("verdict.json", (value) => {
  if (!value || typeof value !== "object" || typeof (value as { ready?: unknown }).ready !== "boolean") {
    throw new Error("verdict.json: invalid ready field");
  }
  return value as { ready: boolean };
});

function makeRun(step: RunStep, maxCost?: number): Run {
  const dir = mkdtempSync(join(tmpdir(), "stepattempt-"));
  return {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: dir,
    max_cost_usd: maxCost,
    steps: [step],
  };
}

function makeStep(def: Partial<PipelineStep> = {}, state: StepStateInput = {}): RunStep {
  return makeRunStep(
    { id: "verify", name: "Verify", command: "make test", runner: "bash", ...def },
    { status: "running", ...state },
  );
}

test("applyStepSession: validates the contract", () => {
  const step = makeStep({ runner: "agent", backend: { id: "claude" } }, { session: CLAUDE_SESSION("sess-old") });
  applyStepSession(step, { ok: false });
  // An attempt that reports no session leaves the step session alone.
  expect(step.session).toEqual(CLAUDE_SESSION("sess-old"));
  applyStepSession(step, { ok: false, session: CLAUDE_SESSION("sess-x") });
  expect(step.session).toEqual(CLAUDE_SESSION("sess-x"));
});

test("settleAttemptStats + the ledger charge: validates the ledger contract", () => {
  const step = makeStep({}, { session: CLAUDE_SESSION("step-session") });
  const { control, usage } = settleAttemptStats(step, "step", true, {
    duration_ms: 2,
    total_cost_usd: 0.25,
    input_tokens: 10,
  });
  const budget: RunBudget = { cumulative: 1 };
  chargeAttemptToLedger(makeRun(step, 10), budget, control, usage);
  expect(budget.cumulative).toBe(1.25);
  expect(control.total_cost_usd).toBe(0.25);
  expect(usage?.input_tokens).toBe(10);
  // The ledger path writes neither the step nor its session.
  expect(step.control).toBeUndefined();
  expect(step.session).toEqual(CLAUDE_SESSION("step-session"));
});

test("an attempt settling after abort is not charged twice", async () => {
  const step = makeStep();
  const run = makeRun(step, 10);
  let release!: (value: Awaited<ReturnType<ExecuteStep>>) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const executeStep: ExecuteStep = async () => {
    markStarted();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const budget = { cumulative: 0 };
  const pending = runAttempt(run, step, { command: "make test", context: baseCtx, budget, executeStep });
  await started;

  abortRun(run, "SIGINT", { estimatedCostUsd: 0.4 });
  release({ ok: false, output: "killed", stats: { duration_ms: 10, total_cost_usd: 0.5 } });
  await pending;

  expect(step.control?.total_cost_usd).toBe(0.4);
  expect(step.attempts[0]?.control?.total_cost_usd).toBe(0.4);
  expect(budget.cumulative).toBe(0);
});

test("a fix pass settling after abort is not charged twice either", async () => {
  const step = makeStep();
  const run = makeRun(step, 10);
  let release!: (value: Awaited<ReturnType<FixWithAgent>>) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const fixWithAgent: FixWithAgent = async () => {
    markStarted();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const budget = { cumulative: 0 };
  const pending = runFixAttempt(run, step, {
    prompt: "corrige",
    budget,
    fixWithAgent,
    backendSpec: FIX_SPEC,
    registry: REGISTRY,
  });
  await started;

  abortRun(run, "SIGINT", { estimatedCostUsd: 0.4 });
  release({ ok: false, stats: { duration_ms: 10, total_cost_usd: 0.5 } });
  await pending;

  expect(step.attempts).toHaveLength(1);
  expect(step.attempts[0]).toMatchObject({ kind: "fix", status: "aborted" });
  expect(step.control?.total_cost_usd).toBe(0.4);
  expect(step.attempts[0]?.control?.total_cost_usd).toBe(0.4);
  expect(budget.cumulative).toBe(0);
  const finished = readRunEvents(run.run_dir).filter((event) => event.type === "step.attempt.finished");
  expect(finished).toHaveLength(1);
  expect(finished[0]).toMatchObject({ kind: "fix", status: "aborted" });
});

test("abort on a step without totals yet: the step total is the aborted attempt itself", () => {
  const step = makeStep({ runner: "agent", backend: { id: "claude" } });
  const run = makeRun(step, 10);
  nextAttemptLogPath(run, step, "step");

  abortRun(run, "SIGINT", { estimatedCostUsd: 0.4 });

  const attempt = step.attempts[0]!;
  expect(attempt.status).toBe("aborted");
  expect(attempt.control).toMatchObject({ total_cost_usd: 0.4, cost_estimated: true });
  expect(attempt.control?.cost_unknown).toBeUndefined();
  expect(step.control).toEqual(attempt.control);
  expect(step.control?.cost_estimated).toBe(true);
});

test("abort on a step already charged: the estimate is added and the total flagged as estimated", () => {
  const step = makeStep(
    { runner: "agent", backend: { id: "claude" } },
    { control: { duration_ms: 5, total_cost_usd: 1, model: "m", provider: "claude" } },
  );
  const run = makeRun(step, 10);
  nextAttemptLogPath(run, step, "step");

  abortRun(run, "SIGINT", { estimatedCostUsd: 0.4 });

  expect(step.attempts[0]?.control).toMatchObject({ total_cost_usd: 0.4, model: "m", provider: "claude" });
  expect(step.control).toMatchObject({ total_cost_usd: 1.4, model: "m", provider: "claude", cost_estimated: true });
  expect(step.control?.duration_ms).toBeGreaterThanOrEqual(5);
  expect(step.control?.cost_unknown).toBeUndefined();
  const finished = readRunEvents(run.run_dir).find((event) => event.type === "step.attempt.finished");
  expect(finished).toMatchObject({
    stepId: "verify",
    attempt: 1,
    kind: "step",
    status: "aborted",
    model: "m",
    provider: "claude",
    control: { total_cost_usd: 0.4, cost_estimated: true },
    logPath: step.attempts[0]?.log_path,
    reason: "SIGINT: run interrupted manually",
  });
});

test("abort without a live estimate on an agent step is an unaccounted spend", () => {
  const step = makeStep({ runner: "agent", backend: { id: "claude" } });
  const run = makeRun(step, 10);
  nextAttemptLogPath(run, step, "step");

  abortRun(run, "SIGINT");

  expect(step.attempts[0]?.control?.cost_unknown).toBe(true);
  expect(step.attempts[0]?.control?.total_cost_usd).toBeUndefined();
  expect(step.control?.cost_unknown).toBe(true);
  expect(step.control?.cost_estimated).toBe(true);
  expect(step.control?.total_cost_usd).toBeUndefined();
  const finished = readRunEvents(run.run_dir).find((event) => event.type === "step.attempt.finished");
  expect(finished).toMatchObject({ status: "aborted", control: { cost_unknown: true } });
});

test("abort without a live estimate on a bash step stays free", () => {
  const step = makeStep();
  const run = makeRun(step, 10);
  nextAttemptLogPath(run, step, "step");

  abortRun(run, "SIGINT");

  expect(step.attempts[0]?.status).toBe("aborted");
  expect(step.attempts[0]?.control?.cost_unknown).toBeUndefined();
  expect(step.control?.cost_unknown).toBeUndefined();
  expect(step.control?.cost_estimated).toBe(true);
});

test("a backend resolving after abort does not rotate the step session nor rewrite the verdict", async () => {
  // Resume after a manual interruption promises a fresh attempt with no session
  // resume. A session recorded by the draining backend would break that promise,
  // and a verdict recorded from its late result would describe an attempt the
  // resumed step is going to replay anyway.
  const step = makeStep(
    { runner: "agent", backend: { id: "claude" } },
    { session: CLAUDE_SESSION("old"), fail_kind: "verdict" },
  );
  const run = makeRun(step, 10);
  let release!: (value: Awaited<ReturnType<ExecuteStep>>) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const executeStep: ExecuteStep = async () => {
    markStarted();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const pending = runAttempt(run, step, { command: "do it", context: baseCtx, budget: { cumulative: 0 }, executeStep });
  await started;

  abortRun(run, "SIGINT", { estimatedCostUsd: 0.1 });
  const snapshotAfterAbort = readFileSync(join(run.run_dir, "state.json"), "utf-8");
  // Cross the millisecond boundary: a snapshot rewritten by the late result
  // would differ by its `updatedAt` alone, which a same-millisecond resolve hides.
  await new Promise((resolve) => setTimeout(resolve, 5));
  release({
    ok: false,
    output: "killed",
    session: CLAUDE_SESSION("drained"),
    failKind: "technical",
    failCause: "blocked",
    stats: { duration_ms: 10 },
  });
  await pending;

  expect(step.session).toEqual(CLAUDE_SESSION("old"));
  expect(step.attempts[0]?.session).toBeUndefined();
  expect(step.fail_kind).toBe("verdict");
  expect(step.fail_cause).toBeUndefined();
  // Nothing of the late result reached the snapshot either.
  expect(readFileSync(join(run.run_dir, "state.json"), "utf-8")).toBe(snapshotAfterAbort);
});

test("an agent attempt killed before its first usage event is an unaccounted spend, not a free one", async () => {
  // Timeout, straggler kill, or transport break before the first usage message:
  // the backend returns no tokens and no price. Same rule as `abortRun`.
  const step = makeStep({ runner: "agent", backend: { id: "claude" } });
  const run = makeRun(step, 10);
  const executeStep: ExecuteStep = async () => ({
    output: "",
    ok: false,
    timedOut: true,
    failReason: "process killed: timeout (60s)",
    stats: { duration_ms: 60_000, model: "claude-opus-4-6" },
  });
  const budget: RunBudget = { cumulative: 0 };

  await runAttempt(run, step, { command: "do it", context: baseCtx, budget, executeStep });

  expect(step.control?.cost_unknown).toBe(true);
  expect(step.attempts[0]?.control?.cost_unknown).toBe(true);
  expect(readRunEvents(run.run_dir).some((event) => event.type === "step.cost.unaccounted")).toBe(true);
  // But the run is NOT latched: nothing was measured, so nothing proves the
  // ceiling became unenforceable. Latching here would deny the step the retries
  // that are the only way back to a priced attempt — one transient transport
  // break would freeze a capped run until a human passed `--allow-unmetered`.
  expect(budget.costUnknown).toBeUndefined();
  expect(run.cost_unaccounted).toBeUndefined();
});

test("an attempt that measured unpriceable spend latches the run, unlike one that measured nothing", async () => {
  // The other half of the rule: tokens counted with no rate to apply is evidence,
  // and evidence stops a capped run.
  const step = makeStep({ runner: "agent", backend: { id: "claude" } });
  const run = makeRun(step, 10);
  const executeStep: ExecuteStep = async () => ({
    output: "",
    ok: true,
    stats: { duration_ms: 10, input_tokens: 1000, output_tokens: 100, model: "unlisted-model" },
  });
  const budget: RunBudget = { cumulative: 0 };

  await runAttempt(run, step, { command: "do it", context: baseCtx, budget, executeStep });

  expect(step.control?.cost_unknown).toBe(true);
  expect(budget.costUnknown).toBe(true);
  expect(run.cost_unaccounted).toBe(true);
});

test("a live guard kill for unpriceable usage latches the run even without usable stats", async () => {
  // The guard killed the process on usage it proved unpriceable, so the mapper
  // may return nothing a ledger can read. The record, not the figures, is the
  // evidence here.
  const step = makeStep({ runner: "agent", backend: { id: "claude" } });
  const run = makeRun(step, 10);
  const executeStep: ExecuteStep = async () => ({
    output: "",
    ok: false,
    costUnaccounted: true,
    failReason: "cost unaccounted: unpriceable usage",
    stats: { duration_ms: 5 },
  });
  const budget: RunBudget = { cumulative: 0 };

  await runAttempt(run, step, { command: "do it", context: baseCtx, budget, executeStep });

  expect(budget.costUnknown).toBe(true);
  expect(run.cost_unaccounted).toBe(true);
  // A kill is withheld work, exactly like its budget sibling: the guard is the
  // reason the run ends, so the report must headline the accounting stop instead
  // of the process it had to kill to reach it.
  expect(budget.unaccountedStop).toBe(true);
  const events = readRunEvents(run.run_dir).filter((event) => event.type === "run.cost.unaccounted");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ stepId: step.id, maxCostUsd: 10 });
});

test("a measured unpriced attempt latches the run without claiming a stop", async () => {
  // The distinction the two events keep apart: the ledger became a lower bound
  // (`step.cost.unaccounted`, per attempt), but nothing has been withheld yet.
  // Whether the run stops is the next gate's decision, and its event.
  const step = makeStep({ runner: "agent", backend: { id: "claude" } });
  const run = makeRun(step, 10);
  const executeStep: ExecuteStep = async () => ({
    output: "",
    ok: true,
    stats: { duration_ms: 10, output_tokens: 1000, model: "unlisted-model" },
  });
  const budget: RunBudget = { cumulative: 0 };

  await runAttempt(run, step, { command: "do it", context: baseCtx, budget, executeStep });

  expect(budget.costUnknown).toBe(true);
  expect(budget.unaccountedStop).toBeUndefined();
  const types = readRunEvents(run.run_dir).map((event) => event.type);
  expect(types).toContain("step.cost.unaccounted");
  expect(types).not.toContain("run.cost.unaccounted");
});

test("a live budget guard kill journals the ceiling stop once, as an estimate", async () => {
  const step = makeStep({ runner: "agent", backend: { id: "claude" } });
  const run = makeRun(step, 1);
  const executeStep: ExecuteStep = async () => ({
    output: "",
    ok: false,
    budgetExceeded: true,
    failReason: "process killed: budget exceeded ($1.10 estimated > $1.00 remaining)",
    // The settled figure lands UNDER the ceiling: the ledger alone would read the
    // remaining budget as affordable, which is why the event says `estimated`.
    stats: { duration_ms: 5, total_cost_usd: 0.3, cost_estimated: true },
  });
  const budget: RunBudget = { cumulative: 0 };

  await runAttempt(run, step, { command: "do it", context: baseCtx, budget, executeStep });

  expect(budget.exceeded).toBe(true);
  expect(run.budget_exceeded).toBe(true);
  const events = readRunEvents(run.run_dir).filter((event) => event.type === "run.budget.exceeded");
  expect(events).toHaveLength(1);
  // `cumulativeUsd` is the ledger after the killed attempt was charged — $0.30,
  // under the $1 ceiling. The pair (figure under the ceiling, `estimated: true`)
  // is what tells a reader the stop rests on the guard and not on the ledger.
  expect(events[0]).toMatchObject({ stepId: step.id, maxCostUsd: 1, estimated: true, cumulativeUsd: 0.3 });
});

test("a bash step failing without tokens is still free", async () => {
  const step = makeStep();
  const run = makeRun(step, 10);
  const executeStep: ExecuteStep = async () => ({ output: "", ok: false, stats: { duration_ms: 3 } });
  const budget: RunBudget = { cumulative: 0 };

  await runAttempt(run, step, { command: "make test", context: baseCtx, budget, executeStep });

  expect(step.control?.cost_unknown).toBeUndefined();
  expect(budget.costUnknown).toBeUndefined();
});

test("fail_cause follows fail_kind's life cycle: written on failure, cleared by the next attempt and by success", async () => {
  const step = makeStep({ runner: "agent", backend: { id: "claude" } });
  const run = makeRun(step, 10);
  const budget: RunBudget = { cumulative: 0 };
  const blocked: ExecuteStep = async () => ({
    output: "",
    ok: false,
    failReason: "the release branch does not exist",
    failKind: "verdict",
    failCause: "blocked",
    stats: { duration_ms: 1 },
  });

  await runAttempt(run, step, { command: "do it", context: baseCtx, budget, executeStep: blocked });
  expect(step.fail_kind).toBe("verdict");
  expect(step.fail_cause).toBe("blocked");

  // A later attempt that fails for another reason must not leave the step marked
  // blocked: the obstacle was lifted, the failure is now the code's.
  const failed: ExecuteStep = async () => ({
    output: "",
    ok: false,
    failReason: "3 tests failed",
    failKind: "verdict",
    stats: { duration_ms: 1 },
  });
  await runAttempt(run, step, { command: "do it", context: baseCtx, budget, executeStep: failed });
  expect(step.fail_kind).toBe("verdict");
  expect(step.fail_cause).toBeUndefined();

  // And a success clears both.
  step.fail_cause = "blocked";
  step.fail_kind = "verdict";
  const ok: ExecuteStep = async () => ({ output: "", ok: true, stats: { duration_ms: 1 } });
  await runAttempt(run, step, { command: "do it", context: baseCtx, budget, executeStep: ok });
  expect(step.fail_kind).toBeUndefined();
  expect(step.fail_cause).toBeUndefined();
});

test("a fix pass never rewrites the step's fail_cause: it repairs, it does not judge", async () => {
  const step = makeStep({}, { session: CLAUDE_SESSION("step-session") });
  const run = makeRun(step, 10);
  step.fail_cause = "blocked";
  const fixWithAgent: FixWithAgent = async () => ({
    ok: false,
    failReason: "the fix pass could not run",
    stats: { duration_ms: 1 },
  });

  await runFixAttempt(run, step, {
    prompt: "corrige",
    budget: { cumulative: 0 },
    fixWithAgent,
    backendSpec: FIX_SPEC,
    registry: REGISTRY,
  });

  expect(step.fail_cause).toBe("blocked");
});

test("invalid provider costs never poison or credit the ledger", () => {
  const step = makeStep();
  const run = makeRun(step, 10);
  const nan = settleAttemptStats(step, "step", true, { duration_ms: 1, total_cost_usd: Number.NaN }).control;
  const negative = settleAttemptStats(step, "step", true, { duration_ms: 1, total_cost_usd: -3 }).control;
  const nanBudget: RunBudget = { cumulative: 2 };
  const negativeBudget: RunBudget = { cumulative: 2 };
  chargeAttemptToLedger(run, nanBudget, nan, undefined);
  chargeAttemptToLedger(run, negativeBudget, negative, undefined);
  expect(nanBudget.cumulative).toBe(2);
  expect(negativeBudget.cumulative).toBe(2);
  expect(nan.cost_unknown).toBe(true);
  expect(negative.cost_unknown).toBe(true);
});

test("runAttempt: validates the contract", async () => {
  const step = makeStep();
  const run = makeRun(step, 10);
  const seen: Array<number | undefined> = [];
  const executeStep: ExecuteStep = async (_s, _c, budget) => {
    seen.push(budget?.budgetRemaining);
    return { output: "", ok: true, stats: { duration_ms: 1, total_cost_usd: 2 } };
  };

  // One ledger for both attempts: the second reads the cumulative data written by
  // the first, without the caller passing it around.
  const budget = { cumulative: 1 };
  await runAttempt(run, step, { command: "make test", context: baseCtx, budget, executeStep });
  expect(seen).toEqual([9]);
  expect(budget.cumulative).toBe(3);

  await runAttempt(run, step, { command: "make test", context: baseCtx, budget, executeStep });
  expect(seen).toEqual([9, 7]);
  expect(budget.cumulative).toBe(5);
  const finished = readRunEvents(run.run_dir).find((event) => event.type === "step.attempt.finished");
  expect(finished).toMatchObject({
    kind: "step",
    status: "done",
    control: { duration_ms: 1, total_cost_usd: 2 },
  });
});

test("the ledger charge belongs to the attempt lifecycle, not to the chain: validates the contract", async () => {
  const step = makeStep();
  const run = makeRun(step, 10);
  const seen: Array<number | undefined> = [];
  const executeStep: ExecuteStep = async (_s, _c, budget) => {
    seen.push(budget?.budgetRemaining);
    return { output: "", ok: true, stats: { duration_ms: 1, total_cost_usd: 2 }, sessionId: "sess-y" };
  };

  const budget = { cumulative: 1 };
  await runAttempt(run, step, { command: "make test", context: baseCtx, budget, executeStep, middlewares: [] });

  // No middleware at all: nothing computes the remaining budget and nothing
  // rotates the session...
  expect(seen).toEqual([undefined]);
  expect(step.session).toBeUndefined();
  // ...but the closure still writes the step total and the ledger is still
  // charged with the same figures, whatever the chain looks like.
  expect(budget.cumulative).toBe(3);
  expect(step.control?.total_cost_usd).toBe(2);
  expect(step.attempts[0]?.control?.total_cost_usd).toBe(2);
});

test("runAttempt: validates the contract", async () => {
  const step = makeStep({ runner: "fn" });
  const run = makeRun(step);
  let received: unknown = "absent";
  const executeStep: ExecuteStep = async (_s, _c, _b, ctx) => {
    received = ctx;
    return { output: "", ok: true, stats: { duration_ms: 1 } };
  };

  await runAttempt(run, step, { command: "", context: baseCtx, budget: { cumulative: 0 }, executeStep });
  expect(received).toBe(baseCtx);
});

test("runAttempt: validates the contract", async () => {
  const fixture = artifactFixture({ ready: false });
  const step = makeStep({ outputs: [verdictArtifact] });
  const run = makeRun(step);
  let staleWasRemoved = false;
  const executeStep: ExecuteStep = async () => {
    staleWasRemoved = fixture.read() === undefined;
    fixture.write({ ready: true });
    return { output: "ok", ok: true, stats: { duration_ms: 1 } };
  };

  const attempt = await runAttempt(run, step, {
    command: "produce",
    context: fixture.ctx,
    budget: { cumulative: 0 },
    executeStep,
  });

  expect(staleWasRemoved).toBe(true);
  expect(attempt.ok).toBe(true);
  expect(await verdictArtifact.require(fixture.ctx)).toEqual({ ready: true });
});

test("runAttempt: validates the contract", async () => {
  const missing = artifactFixture({ ready: true });
  const missingStep = makeStep({ outputs: [verdictArtifact] });
  const missingAttempt = await runAttempt(makeRun(missingStep), missingStep, {
    command: "produce",
    context: missing.ctx,
    budget: { cumulative: 0 },
    executeStep: async () => ({ output: "agent finished", ok: true, stats: { duration_ms: 1 } }),
  });
  // The reason names the expected location: "missing" and "written elsewhere" have
  // the same symptom here, and only the path distinguishes them.
  expect(missingAttempt.ok).toBe(false);
  expect(String(missingAttempt.failReason)).toMatch(
    /^verdict\.json not found \(expected at: .*PROJ-1\/artifacts\/verdict\.json\)$/,
  );

  const invalid = artifactFixture();
  const invalidStep = makeStep({ outputs: [verdictArtifact] });
  const invalidAttempt = await runAttempt(makeRun(invalidStep), invalidStep, {
    command: "produce",
    context: invalid.ctx,
    budget: { cumulative: 0 },
    executeStep: async () => {
      invalid.write({ ready: "oui" });
      return { output: "agent finished", ok: true, stats: { duration_ms: 1 } };
    },
  });
  expect(invalidAttempt).toMatchObject({ ok: false, failReason: "verdict.json: invalid ready field" });
});

test("runAttempt: validates the contract", async () => {
  const fixture = artifactFixture({ ready: true });
  const step = makeStep({ outputs: [verdictArtifact] });
  const attempt = await runAttempt(makeRun(step), step, {
    command: "produce",
    context: fixture.ctx,
    budget: { cumulative: 0 },
    executeStep: async () => ({ output: "529", ok: false, failReason: "API 529", stats: { duration_ms: 1 } }),
  });
  expect(attempt).toMatchObject({ ok: false, failReason: "API 529" });
  expect(fixture.read()).toBeUndefined();
});

/** Blank step-log file in the run directory, used to observe what the chain writes. */
test("runFixAttempt: validates the contract", async () => {
  const step = makeStep({}, { session: CLAUDE_SESSION("step-session") });
  const run = makeRun(step, 10);
  const seen: Array<number | undefined> = [];
  const fixWithAgent: FixWithAgent = async (_p, _s, _o, budget) => {
    seen.push(budget?.budgetRemaining);
    return { ok: true, stats: { duration_ms: 1, total_cost_usd: 2 }, sessionId: "fix-session" };
  };

  const budget = { cumulative: 1 };
  await runFixAttempt(run, step, {
    prompt: "corrige",
    budget,
    fixWithAgent,
    backendSpec: FIX_SPEC,
    registry: REGISTRY,
  });
  expect(seen).toEqual([9]);
  expect(budget.cumulative).toBe(3);

  await runFixAttempt(run, step, {
    prompt: "corrige",
    budget,
    fixWithAgent,
    backendSpec: FIX_SPEC,
    registry: REGISTRY,
  });
  expect(seen).toEqual([9, 7]);
  // A fix session never replaces the step session: only the resumed-fix path of
  // the fix loop writes a fork back, and onto the resumed step.
  expect(step.session).toEqual(CLAUDE_SESSION("step-session"));
});

test("runFixAttempt leaves step outputs untouched: validates the contract", async () => {
  const fixture = artifactFixture({ ready: true });
  const step = makeStep({ outputs: [verdictArtifact] });
  const run = makeRun(step);

  await runFixAttempt(run, step, {
    prompt: "corrige",
    budget: { cumulative: 0 },
    backendSpec: FIX_SPEC,
    registry: REGISTRY,
    fixWithAgent: async () => ({ ok: true, stats: { duration_ms: 1 } }),
  });

  expect(await verdictArtifact.require(fixture.ctx)).toEqual({ ready: true });
});

test("runFixAttempt: validates the contract", async () => {
  const step = makeStep();
  const run = makeRun(step);
  let received: unknown;
  const fixWithAgent: FixWithAgent = async (prompt, _spec, agentOptions, budget) => {
    received = { prompt, agentOptions, budget };
    return { ok: true, stats: { duration_ms: 1 } };
  };

  await runFixAttempt(run, step, {
    prompt: "corrige ceci",
    budget: { cumulative: 0 },
    fixWithAgent,
    backendSpec: FIX_SPEC,
    registry: REGISTRY,
    agentOptions: { model: "opus" },
    spawn: { resumeSession: CLAUDE_SESSION("coder-1") },
  });

  expect(received).toEqual({
    prompt: "corrige ceci",
    agentOptions: { model: "opus" },
    // The spawn budget carries the registry: it is explicit down to the runner.
    budget: {
      resumeSession: CLAUDE_SESSION("coder-1"),
      stepLogPath: attemptLogPath(run, step, 1),
      budgetRemaining: undefined,
      // No ceiling on this run, so nothing for a live accounting guard to enforce.
      strictCostAccounting: false,
      registry: REGISTRY,
    },
  });
});

test("banner: validates the contract", async () => {
  const step = makeStep();
  const run = makeRun(step);

  const executeStep: ExecuteStep = async () => ({ output: "", ok: false, stats: { duration_ms: 1 } });
  const fixWithAgent: FixWithAgent = async () => ({ ok: true, stats: { duration_ms: 1 } });

  // Each attempt writes to ITS log: the separator is identical on both sides.
  mkdirSync(dirname(attemptLogPath(run, step, 1)), { recursive: true });
  await runAttempt(run, step, {
    command: "make test",
    context: baseCtx,
    budget: { cumulative: 0 },
    executeStep,
    banner: "rerun 1/3",
  });
  mkdirSync(dirname(attemptLogPath(run, step, 2)), { recursive: true });
  await runFixAttempt(run, step, {
    prompt: "corrige",
    budget: { cumulative: 0 },
    fixWithAgent,
    backendSpec: FIX_SPEC,
    registry: REGISTRY,
    banner: "fix 1/3 (resume coder)",
  });

  expect(readFileSync(attemptLogPath(run, step, 1), "utf8")).toBe("\n--- rerun 1/3 ---\n");
  expect(readFileSync(attemptLogPath(run, step, 2), "utf8")).toBe("\n--- fix 1/3 (resume coder) ---\n");
});

test("banner: validates the contract", async () => {
  const step = makeStep();
  const run = makeRun(step);
  const log = attemptLogPath(run, step, 1);
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, "");
  const executeStep: ExecuteStep = async () => ({ output: "", ok: true, stats: { duration_ms: 1 } });

  await runAttempt(run, step, {
    command: "make test",
    context: baseCtx,
    budget: { cumulative: 0 },
    executeStep,
  });

  expect(readFileSync(log, "utf8")).toBe("");
});

test("inaccessible step logs do not fail the attempt: validates the contract", async () => {
  const step = makeStep();
  const run = makeRun(step);
  let spawned = 0;
  const executeStep: ExecuteStep = async () => {
    spawned++;
    return { output: "", ok: true, stats: { duration_ms: 1, total_cost_usd: 0.5 } };
  };

  // The attempt directory is not created, so the banner write fails.
  const budget = { cumulative: 0 };
  const outcome = await runAttempt(run, step, {
    command: "make test",
    context: baseCtx,
    budget,
    executeStep,
    banner: "rerun 1/3",
  });

  expect(spawned).toBe(1);
  expect(outcome.ok).toBe(true);
  // The cost is still counted: the next middleware is not carried away by the first one's failure.
  expect(budget.cumulative).toBe(0.5);
});

test("step-attempt: validates the integration contract", async () => {
  const cases = [
    {
      kind: "step" as const,
      run: () => {
        const step = makeStep();
        const run = makeRun(step);
        const error = new Error("spawn step indisponible");
        const executeStep: ExecuteStep = async () => {
          throw error;
        };
        return {
          run,
          step,
          error,
          invoke: () =>
            runAttempt(run, step, {
              command: "make test",
              context: baseCtx,
              budget: { cumulative: 0 },
              executeStep,
            }),
        };
      },
    },
    {
      kind: "fix" as const,
      run: () => {
        const step = makeStep();
        const run = makeRun(step);
        const error = new Error("spawn fix indisponible");
        const fixWithAgent: FixWithAgent = async () => {
          throw error;
        };
        return {
          run,
          step,
          error,
          invoke: () =>
            runFixAttempt(run, step, {
              prompt: "corrige",
              budget: { cumulative: 0 },
              fixWithAgent,
              backendSpec: FIX_SPEC,
              registry: REGISTRY,
            }),
        };
      },
    },
  ];

  for (const expected of cases) {
    const { run, step, error, invoke } = expected.run();
    await expect(invoke()).rejects.toBe(error);
    expect(step.attempts).toHaveLength(1);
    expect(step.attempts?.[0]).toMatchObject({
      kind: expected.kind,
      status: "failed",
      errors: error.message,
    });
    // A rejected attempt takes the same exit as a returned record: a metered
    // attempt (a fix pass; a bash step is not metered) that measured nothing is
    // closed unpriced and says so in the journal.
    expect(readRunEvents(run.run_dir).map((event) => event.type)).toEqual([
      "step.attempt.started",
      "step.attempt.finished",
      ...(expected.kind === "fix" ? (["step.cost.unaccounted"] as const) : []),
    ]);
  }
});

test("a repair that rejects invalidates the materialized run totals like one returning a negative verdict", async () => {
  // A finalized run resumed into new work carries `total_control` / `total_usage`
  // from its previous generation. Any new attempt makes them stale, whichever way
  // it ends: both endings below start from the same materialized totals and
  // measure nothing, so they must leave the run in the same state.
  const endings = [
    {
      name: "negative verdict",
      fixWithAgent: (async () => ({
        ok: false,
        stats: { duration_ms: 0 },
        failReason: "transport down",
      })) as FixWithAgent,
      rejects: false,
    },
    {
      name: "exception",
      fixWithAgent: (async () => {
        throw new Error("transport down");
      }) as FixWithAgent,
      rejects: true,
    },
  ];

  for (const ending of endings) {
    const step = makeStep();
    const run = makeRun(step, 10);
    run.total_control = { duration_ms: 5, total_cost_usd: 3 };
    run.total_usage = { input_tokens: 40 };
    const budget: RunBudget = { cumulative: 3 };
    const invoke = () =>
      runFixAttempt(run, step, {
        prompt: "corrige",
        budget,
        fixWithAgent: ending.fixWithAgent,
        backendSpec: FIX_SPEC,
        registry: REGISTRY,
      });

    if (ending.rejects) await expect(invoke()).rejects.toThrow("transport down");
    else expect((await invoke()).ok).toBe(false);

    // The attempt and the step carry the closure precaution in both cases.
    expect(step.attempts[0]?.control?.cost_unknown, ending.name).toBe(true);
    expect(step.control?.cost_unknown, ending.name).toBe(true);
    // The materialized totals no longer describe the run once a new attempt closed.
    expect(run.total_control, ending.name).toBeUndefined();
    expect(run.total_usage, ending.name).toBeUndefined();
    // No figure was measured: the money does not move and nothing proves
    // unpriceable consumption, so neither the latch nor the stop fires.
    expect(budget.cumulative, ending.name).toBe(3);
    expect(budget.costUnknown, ending.name).toBeUndefined();
    expect(run.cost_unaccounted, ending.name).toBeUndefined();
  }
});

const ticketArtifact = textArtifact("ticket.md");
const specArtifact = textArtifact("spec.md");

/** Map-keyed store: input freshness reads and writes several artifacts per attempt. */
function multiArtifactFixture(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  const store: WorkItemArtifactStore = {
    exists: async (ref: ArtifactRef) => values.has(ref.name),
    readText: async (ref: ArtifactRef) => values.get(ref.name),
    readJson: async <T>(ref: ArtifactRef, parse: (raw: unknown) => T) => {
      const raw = values.get(ref.name);
      return raw === undefined ? undefined : parse(JSON.parse(raw));
    },
    writeText: async (ref: ArtifactRef, next: string) => {
      values.set(ref.name, next);
    },
    remove: async (ref: ArtifactRef) => {
      values.delete(ref.name);
    },
  };
  return {
    values,
    ctx: buildPipelineContext({ ...commandRegistries(), cwd: ".", ticket: "PROJ-1", artifacts: store }),
  };
}

test("runAttempt: fingerprints are recorded only once the outputs are verified", async () => {
  const { values, ctx } = multiArtifactFixture({ "ticket.md": "one" });
  const step = makeStep({ sources: [ticketArtifact], outputs: [specArtifact] });
  const run = makeRun(step, 10);

  // The command succeeds but writes nothing: `require` fails, so nothing is recorded.
  const failing = await runAttempt(run, step, {
    command: "write the spec",
    context: ctx,
    budget: { cumulative: 0 },
    executeStep: async () => ({ output: "", ok: true, stats: { duration_ms: 1 } }),
  });
  expect(failing.ok).toBe(false);
  expect(values.has(`${PROVENANCE_PREFIX}spec.md.json`)).toBe(false);

  const ok = await runAttempt(run, step, {
    command: "write the spec",
    context: ctx,
    budget: { cumulative: 0 },
    executeStep: async () => {
      values.set("spec.md", "written");
      return { output: "", ok: true, stats: { duration_ms: 1 } };
    },
  });

  expect(ok.ok).toBe(true);
  const record = await readProvenance(ctx, specArtifact);
  expect(record?.producedBy).toBe("verify");
  expect(record?.inputs).toEqual({ "artifacts/ticket.md": sha256Text("one") });
});

test("runAttempt: an output declared as input is revised in place, not erased", async () => {
  const { values, ctx } = multiArtifactFixture({ "ticket.md": "answered", "spec.md": "previous draft" });
  const step = makeStep({ sources: [ticketArtifact, specArtifact], outputs: [specArtifact] });
  const run = makeRun(step, 10);
  await writeProvenance(ctx, specArtifact, "spec", { "artifacts/ticket.md": sha256Text("one") });

  let seenBeforeSpawn: string | undefined;
  await runAttempt(run, step, {
    command: "amend the spec",
    context: ctx,
    budget: { cumulative: 0 },
    executeStep: async () => {
      seenBeforeSpawn = values.get("spec.md");
      values.set("spec.md", "amended draft");
      return { output: "", ok: true, stats: { duration_ms: 1 } };
    },
  });

  // The agent amends what is already there instead of rewriting it from nothing.
  expect(seenBeforeSpawn).toBe("previous draft");
  const record = await readProvenance(ctx, specArtifact);
  // The first producer survives the revision; only the fingerprints move on.
  expect(record?.producedBy).toBe("spec");
  expect(record?.inputs).toEqual({ "artifacts/ticket.md": sha256Text("answered") });
});

test("runAttempt: erasing an output erases the record that vouched for it", async () => {
  const { values, ctx } = multiArtifactFixture({ "ticket.md": "one", "spec.md": "stale" });
  const step = makeStep({ sources: [ticketArtifact], outputs: [specArtifact] });
  const run = makeRun(step, 10);
  await writeProvenance(ctx, specArtifact, "spec", { "artifacts/ticket.md": sha256Text("gone") });

  let recordDuringSpawn: string | undefined;
  await runAttempt(run, step, {
    command: "write the spec",
    context: ctx,
    budget: { cumulative: 0 },
    executeStep: async () => {
      recordDuringSpawn = values.get(`${PROVENANCE_PREFIX}spec.md.json`);
      values.set("spec.md", "fresh");
      return { output: "", ok: true, stats: { duration_ms: 1 } };
    },
  });

  expect(recordDuringSpawn).toBeUndefined();
  expect((await readProvenance(ctx, specArtifact))?.inputs).toEqual({ "artifacts/ticket.md": sha256Text("one") });
});

test("runAttempt: a step without declared inputs keeps the previous behavior", async () => {
  const { values, ctx } = multiArtifactFixture({ "spec.md": "stale" });
  const step = makeStep({ outputs: [specArtifact] });
  const run = makeRun(step, 10);

  let seenBeforeSpawn: string | undefined;
  await runAttempt(run, step, {
    command: "write the spec",
    context: ctx,
    budget: { cumulative: 0 },
    executeStep: async () => {
      seenBeforeSpawn = values.get("spec.md");
      values.set("spec.md", "fresh");
      return { output: "", ok: true, stats: { duration_ms: 1 } };
    },
  });

  expect(seenBeforeSpawn).toBeUndefined();
  expect(values.has(`${PROVENANCE_PREFIX}spec.md.json`)).toBe(false);
});

/* ------------------------------------------------------------------------- *
 * `capture`: the agent RETURNS a value in its structured output, the runner
 * persists it. Written before `require`, so the captured artifact is proven like
 * any other output; failures land as `ok: false` with a reason, like `require`.
 * ------------------------------------------------------------------------- */

const commitMessage = textArtifact("commit-message.md", (raw) => {
  if (!raw.trim()) throw new Error("commit-message.md: empty");
  return raw;
});
const branch = artifact("branch.json", (value) => {
  if (!value || typeof value !== "object" || typeof (value as { name?: unknown }).name !== "string") {
    throw new Error("branch.json: name must be a string");
  }
  return value as { name: string };
});

function captureStep(captures: PipelineStep["captures"], extra: Partial<PipelineStep> = {}): RunStep {
  return makeStep({
    runner: "agent",
    backend: { id: "claude" },
    output_format: "json",
    captures,
    outputs: captures!.map((capture) => capture.artifact),
    ...extra,
  });
}

const textCapture = { field: "commit", artifact: commitMessage, schema: { type: "string" }, text: true };
const jsonCapture = {
  field: "branch",
  artifact: branch,
  schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  text: false,
};

test("capture: a text field is written as-is and a JSON field through the artifact", async () => {
  const { values, ctx } = multiArtifactFixture({ "commit-message.md": "stale" });
  const step = captureStep([textCapture, jsonCapture]);
  let staleErased = false;

  const attempt = await runAttempt(makeRun(step), step, {
    command: "write",
    context: ctx,
    budget: { cumulative: 0 },
    executeStep: async () => {
      staleErased = !values.has("commit-message.md");
      return {
        output: "",
        ok: true,
        stats: { duration_ms: 1 },
        structuredOutput: { success: true, reason: "ok", commit: "feat: add capture", branch: { name: "feat/x" } },
      };
    },
  });

  expect(attempt.ok).toBe(true);
  // Erased before spawn like every output: the agent cannot pass off a stale one.
  expect(staleErased).toBe(true);
  expect(values.get("commit-message.md")).toBe("feat: add capture");
  expect(await branch.require(ctx)).toEqual({ name: "feat/x" });
  expect(values.get("branch.json")).toBe(`${JSON.stringify({ name: "feat/x" }, null, 2)}\n`);
});

test("capture: a field absent from the structured output fails the attempt with its name", async () => {
  const { values, ctx } = multiArtifactFixture();
  const step = captureStep([textCapture]);
  for (const structuredOutput of [{ success: true }, { success: true, commit: null }, undefined]) {
    const attempt = await runAttempt(makeRun(step), step, {
      command: "write",
      context: ctx,
      budget: { cumulative: 0 },
      executeStep: async () => ({ output: "", ok: true, stats: { duration_ms: 1 }, structuredOutput }),
    });
    expect(attempt).toMatchObject({
      ok: false,
      failReason: 'capture "commit": absent from the agent\'s structured output',
    });
    // No fail kind: same treatment as a missing `require`, the fix loop decides.
    expect(attempt.failKind).toBeUndefined();
    expect(values.has("commit-message.md")).toBe(false);
  }
});

test("capture: a value the artifact parser refuses fails on this step, nothing is written", async () => {
  const { values, ctx } = multiArtifactFixture();
  const step = captureStep([textCapture, jsonCapture]);
  const run = makeRun(step);
  const structuredOutput = { success: true, commit: "feat: ok", branch: { name: 42 } };
  const attempt = await runAttempt(run, step, {
    command: "write",
    context: ctx,
    budget: { cumulative: 0 },
    executeStep: async () => ({ output: "", ok: true, stats: { duration_ms: 1 }, structuredOutput }),
  });
  expect(attempt).toMatchObject({ ok: false, failReason: "branch.json: name must be a string", captureRefused: true });
  // Every capture is validated BEFORE any write: the first, valid one is not on
  // disk either, so a fix pass (which erases nothing) cannot mistake it for good.
  expect(values.has("commit-message.md")).toBe(false);
  expect(values.has("branch.json")).toBe(false);
  // The refused object is kept where the attempt's output lands: the structured
  // output travels through a tool call the live log never sees, so this entry is
  // its only trace.
  const log = readFileSync(attemptLogPath(run, step, 1), "utf8");
  expect(log).toContain("--- capture refused: branch.json: name must be a string ---");
  expect(log).toContain(JSON.stringify(structuredOutput, null, 2));
  // The flag is in-memory: the persisted attempt carries the reason and no more.
  expect(step.attempts[0]).not.toHaveProperty("captureRefused");
  expect(step.attempts[0]?.errors).toBe("branch.json: name must be a string");
});

test("capture: a missing structured output is a refusal too, logged as such", async () => {
  const { ctx } = multiArtifactFixture();
  const step = captureStep([textCapture]);
  const run = makeRun(step);
  const attempt = await runAttempt(run, step, {
    command: "write",
    context: ctx,
    budget: { cumulative: 0 },
    executeStep: async () => ({ output: "", ok: true, stats: { duration_ms: 1 } }),
  });
  expect(attempt.captureRefused).toBe(true);
  expect(readFileSync(attemptLogPath(run, step, 1), "utf8")).toContain("(no structured output)");
});

test("capture: a missing `require` is not a refusal — there is nothing to re-ask for", async () => {
  const { ctx } = multiArtifactFixture();
  // The capture lands; the other declared output was never written by the agent.
  const step = captureStep([textCapture], { outputs: [commitMessage, specArtifact] });
  const attempt = await runAttempt(makeRun(step), step, {
    command: "write",
    context: ctx,
    budget: { cumulative: 0 },
    executeStep: async () => ({
      output: "",
      ok: true,
      stats: { duration_ms: 1 },
      structuredOutput: { success: true, commit: "feat: ok" },
    }),
  });
  expect(attempt.ok).toBe(false);
  expect(attempt.captureRefused).toBeUndefined();
});

test("capture: a write error is not a refusal — the agent's object was accepted", async () => {
  const store: WorkItemArtifactStore = {
    exists: async () => false,
    readText: async () => undefined,
    readJson: async () => undefined,
    writeText: async () => {
      throw new Error("disk full");
    },
    remove: async () => {},
  };
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: ".", ticket: "PROJ-1", artifacts: store });
  const step = captureStep([textCapture]);
  const attempt = await runAttempt(makeRun(step), step, {
    command: "write",
    context: ctx,
    budget: { cumulative: 0 },
    executeStep: async () => ({
      output: "",
      ok: true,
      stats: { duration_ms: 1 },
      structuredOutput: { success: true, commit: "feat: ok" },
    }),
  });
  expect(attempt).toMatchObject({ ok: false, failReason: "disk full" });
  expect(attempt.captureRefused).toBeUndefined();
});

test("capture: the short form refuses a non-string value", async () => {
  const { values, ctx } = multiArtifactFixture();
  const step = captureStep([textCapture]);
  const attempt = await runAttempt(makeRun(step), step, {
    command: "write",
    context: ctx,
    budget: { cumulative: 0 },
    executeStep: async () => ({
      output: "",
      ok: true,
      stats: { duration_ms: 1 },
      structuredOutput: { success: true, commit: { subject: "feat: x" } },
    }),
  });
  expect(attempt).toMatchObject({
    ok: false,
    failReason: 'capture "commit": text artifact "commit-message.md" expects a string, received a object',
  });
  expect(values.has("commit-message.md")).toBe(false);
});

test("capture: a failed attempt keeps its own reason and writes nothing", async () => {
  const { values, ctx } = multiArtifactFixture();
  const step = captureStep([textCapture]);
  const attempt = await runAttempt(makeRun(step), step, {
    command: "write",
    context: ctx,
    budget: { cumulative: 0 },
    executeStep: async () => ({
      output: "",
      ok: false,
      failReason: "tests failed",
      failKind: "verdict",
      stats: { duration_ms: 1 },
      structuredOutput: { success: false, reason: "tests failed", commit: "feat: x" },
    }),
  });
  expect(attempt).toMatchObject({ ok: false, failReason: "tests failed", failKind: "verdict" });
  expect(values.has("commit-message.md")).toBe(false);
});

test("capture: provenance is recorded after the capture, on the captured artifact", async () => {
  const { ctx } = multiArtifactFixture({ "ticket.md": "one" });
  const step = captureStep([textCapture], { sources: [ticketArtifact] });
  const attempt = await runAttempt(makeRun(step), step, {
    command: "write",
    context: ctx,
    budget: { cumulative: 0 },
    executeStep: async () => ({
      output: "",
      ok: true,
      stats: { duration_ms: 1 },
      structuredOutput: { success: true, commit: "feat: x" },
    }),
  });
  expect(attempt.ok).toBe(true);
  const record = await readProvenance(ctx, commitMessage);
  expect(record?.producedBy).toBe("verify");
  expect(record?.inputs).toEqual({ "artifacts/ticket.md": sha256Text("one") });
});

test("capture: a fix pass touches no captured artifact", async () => {
  const { values, ctx } = multiArtifactFixture({ "commit-message.md": "kept" });
  void ctx;
  const step = captureStep([textCapture]);
  await runFixAttempt(makeRun(step), step, {
    prompt: "corrige",
    budget: { cumulative: 0 },
    backendSpec: FIX_SPEC,
    registry: REGISTRY,
    fixWithAgent: async () => ({ ok: true, stats: { duration_ms: 1 } }),
  });
  expect(values.get("commit-message.md")).toBe("kept");
});

test("capture: a step without captures ignores the structured output entirely", async () => {
  const { values, ctx } = multiArtifactFixture();
  const step = makeStep({ runner: "agent", backend: { id: "claude" }, output_format: "json" });
  const attempt = await runAttempt(makeRun(step), step, {
    command: "write",
    context: ctx,
    budget: { cumulative: 0 },
    executeStep: async () => ({
      output: "",
      ok: true,
      stats: { duration_ms: 1 },
      structuredOutput: { success: true, commit: "feat: x" },
    }),
  });
  expect(attempt.ok).toBe(true);
  expect(values.size).toBe(0);
});

// Invariant: one attempt's price reaches three places — the attempt record, the
// step total and the run ledger — and the three agree after any number of
// attempts. The journal holds the same figures, so a resume reprojects the same
// total. A cost refactor that moves these writes must keep all four equal.
test("invariant: after several attempts, the step total, the ledger and the journal all equal the sum of the attempts", async () => {
  const step = makeStep();
  const run = makeRun(step, 100);
  const costs = [2, 0.5, 1.25];
  const tokens = [10, 20, 30];
  let call = 0;
  const executeStep: ExecuteStep = async () => {
    const i = call++;
    return {
      output: "",
      ok: i === costs.length - 1,
      stats: { duration_ms: 1, total_cost_usd: costs[i]!, input_tokens: tokens[i]! },
    };
  };

  const budget = { cumulative: 0 };
  for (let i = 0; i < costs.length; i++) {
    await runAttempt(run, step, { command: "make test", context: baseCtx, budget, executeStep });
  }

  const sumCost = costs.reduce((a, b) => a + b, 0);
  const sumTokens = tokens.reduce((a, b) => a + b, 0);
  expect(step.attempts).toHaveLength(costs.length);
  expect(step.attempts.map((attempt) => attempt.control?.total_cost_usd)).toEqual(costs);
  expect(step.control?.total_cost_usd).toBeCloseTo(sumCost);
  expect(step.usage?.input_tokens).toBe(sumTokens);
  expect(budget.cumulative).toBeCloseTo(sumCost);

  const journaled = readRunEvents(run.run_dir).filter((event) => event.type === "step.attempt.finished");
  expect(journaled.map((event) => event.control?.total_cost_usd)).toEqual(costs);
  expect(journaled.map((event) => event.usage?.input_tokens)).toEqual(tokens);
});
