import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifact, textArtifact } from "../dsl/artifact.ts";
import {
  failIf,
  failUnlessCommand,
  freezeOnStart,
  type StepInputCondition,
  skipIf,
  skipUnless,
  skipUnlessCommand,
  stopIf,
  stopUnless,
  stopUnlessCommand,
} from "../dsl/input.ts";
import { CODEX_MODEL } from "../engine/backends/codex/types.ts";
import { extractErrors } from "../exec/report-extraction.ts";
import { executeStep, type StepResult } from "../exec/runners.ts";
import type { ArtifactRef, WorkItemArtifactStore } from "../model/artifact-ports.ts";
import type { PipelineContext } from "../model/context.ts";
import type { PipelineStep } from "../model/definition.ts";
import type { Run, RunStep } from "../model/run.ts";
import { buildPipelineContext } from "../pipeline/context.ts";
import { sha256Text } from "../state/hash.ts";
import { writeProvenance } from "../state/provenance.ts";
import { readRunEvents } from "../state/run-journal.ts";
import { finalizeRun } from "../state/run-transitions.ts";
import { isPersistedRunResumable, pendingSteps } from "../state/run-predicates.ts";
import { readRunSnapshot } from "../state/run-snapshot.ts";
import { makeRunStep, type StepStateInput } from "../state/run-step.ts";
import { admitStep, buildContext, executeRunSteps, resolveOutcome, type StepLoopDeps } from "./step-loop.ts";
import { commandRegistries } from "../commands/registries.js";
import { createAbortScope } from "../runtime/abort.js";
import { NULL_RUN_OUTPUT } from "../runtime/run-output.js";

function makeRun(steps: RunStep[], maxCost?: number): Run {
  const dir = mkdtempSync(join(tmpdir(), "steploop-"));
  return { name: "p", pipeline: "p", pipeline_path: "p.ts", run_dir: dir, max_cost_usd: maxCost, steps };
}

function bashStep(id: string, command: string, def: Partial<PipelineStep> = {}, state: StepStateInput = {}): RunStep {
  return makeRunStep({ id, name: id, command, runner: "bash", ...def }, state);
}

/** Dependencies with programmable executeStep results and counters. */
function fakeDeps(results: Array<Partial<StepResult>> = []): {
  deps: StepLoopDeps;
  calls: { exec: number; ids: string[] };
} {
  const calls = { exec: 0, ids: [] as string[] };
  let i = 0;
  const deps: StepLoopDeps = {
    executeStep: async (step, _c, _b) => {
      calls.exec++;
      calls.ids.push(step.id);
      const r = results[i++] ?? { ok: true };
      return {
        output: r.output ?? "",
        ok: r.ok ?? true,
        stats: r.stats ?? { duration_ms: 1 },
        session: r.session,
        timedOut: r.timedOut,
        budgetExceeded: r.budgetExceeded,
        failReason: r.failReason,
        failCause: r.failCause,
      };
    },
    extractErrors: async () => ({ hasErrors: false, errors: "" }),
    runFixLoop: async () => ({ failed: false }),
    output: NULL_RUN_OUTPUT,
  };
  return { deps, calls };
}

test("admitStep: validates the contract", async () => {
  const step = bashStep("a", "echo a");
  const run = makeRun([step], 1);

  const admission = await admitStep({
    run,
    step,
    baseCtx: buildContext(undefined, undefined),
    budget: { cumulative: 1 },
    output: NULL_RUN_OUTPUT,
  });

  expect(admission.kind).toBe("budget-exceeded");
  expect(step.last_command).toBeUndefined();
  // Unfunded, not skipped: the step stays executable so raising the ceiling and
  // resuming picks it up instead of replaying the whole pipeline.
  expect(step.status).toBe("pending");
  // The ledger of closed attempts is what reached the ceiling here, so the figure
  // is not an estimate — unlike a live guard kill.
  const events = readRunEvents(run.run_dir).filter((event) => event.type === "run.budget.exceeded");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    stepId: "a",
    cumulativeUsd: 1,
    maxCostUsd: 1,
    estimated: false,
    remainingSteps: 1,
  });
});

test("admitStep: an unpriced attempt stops a capped run with its own reason", async () => {
  const step = bashStep("a", "echo a");
  const run = makeRun([step], 5);

  const admission = await admitStep({
    run,
    step,
    baseCtx: buildContext(undefined, undefined),
    // $1 of priced spend under a $5 cap: affordable on the ledger alone, which is
    // exactly why the ceiling cannot be trusted once an attempt went unpriced.
    budget: { cumulative: 1, costUnknown: true },
    output: NULL_RUN_OUTPUT,
  });

  expect(admission.kind).toBe("cost-unaccounted");
  // Same treatment as a budget stop: unfunded, not skipped, so the run resumes
  // where it stopped instead of replaying and repaying settled steps.
  expect(step.status).toBe("pending");
  expect(step.last_command).toBeUndefined();
  // The stop is a journal fact, not only a console sentence: `cumulativeUsd` is
  // the lower bound the gate refused to spend past.
  const events = readRunEvents(run.run_dir).filter((event) => event.type === "run.cost.unaccounted");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    stepId: "a",
    cumulativeUsd: 1,
    maxCostUsd: 5,
    remainingSteps: 1,
  });
});

test("admitStep: an uncapped run keeps admitting work despite unknown spend", async () => {
  const step = bashStep("a", "echo a");
  const run = makeRun([step]);

  const admission = await admitStep({
    run,
    step,
    baseCtx: buildContext(undefined, undefined),
    budget: { cumulative: 1, costUnknown: true },
    output: NULL_RUN_OUTPUT,
  });

  expect(admission.kind).toBe("ready");
});

test("executeRunSteps: an unpriced attempt recorded in the totals stops the next step", async () => {
  // The resume path: uncertainty is restored with the totals it belongs to, so a
  // fresh generation cannot launder it by starting a new ledger over the same
  // spend.
  const done = bashStep(
    "spent",
    "cmd",
    {},
    { status: "done", control: { duration_ms: 1, total_cost_usd: 1, cost_unknown: true } },
  );
  const next = bashStep("next", "cmd");
  const run = makeRun([done, next], 5);
  const { deps, calls } = fakeDeps();

  const outcome = await executeRunSteps(run, undefined, undefined, { resuming: true }, deps);

  expect(calls.exec).toBe(0);
  expect(outcome.costUnaccounted).toBe(true);
  expect(outcome.budgetExceeded).toBe(false);
  expect(next.status).toBe("pending");
  // One event for the stop, and the typed reason on the finalized outcome. A
  // `--budget` resume would clear neither: the journal is append-only and
  // `stopKind` is rewritten from the decision of the generation that took it.
  const events = readRunEvents(run.run_dir).filter((event) => event.type === "run.cost.unaccounted");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ stepId: "next", cumulativeUsd: 1, maxCostUsd: 5, remainingSteps: 1 });
  expect(readRunEvents(run.run_dir).filter((event) => event.type === "run.budget.exceeded")).toHaveLength(0);
  finalizeRun(run, outcome);
  expect(readRunSnapshot(join(run.run_dir, "state.json"))?.outcome?.stopKind).toBe("cost-unaccounted");
});

test("executeRunSteps: a transport failure before the first usage event does not deny the step its retries", async () => {
  // The B1 case: an agent attempt that reported no tokens and no price is flagged
  // `cost_unknown` at closure so the total stays a lower bound. Nothing was
  // measured, so nothing proves the ceiling unenforceable — and latching here
  // would withhold the very retries that produce a priced attempt, freezing a
  // capped run on one transient transport break.
  const agent = makeRunStep({
    id: "implement",
    name: "implement",
    command: "go",
    runner: "agent",
    backend: { id: "claude" },
    on_failure: { max_retries: 3 },
  });
  const next = bashStep("after", "cmd");
  const run = makeRun([agent, next], 5);
  const { deps, calls } = fakeDeps([
    { ok: false, failReason: "process killed: timeout (60s)", stats: { duration_ms: 60_000 } },
    { ok: true, stats: { duration_ms: 5, total_cost_usd: 0.5 } },
  ]);

  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: run.run_dir });
  const outcome = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps, ctx);

  expect(calls.ids).toEqual(["implement", "implement", "after"]);
  expect(agent.retries).toBe(1);
  expect(outcome.costUnaccounted).toBe(false);
  expect(outcome.failed).toBe(false);
  expect(run.cost_unaccounted).toBeUndefined();
  // The uncertainty is still reported: the first attempt's control says so, which
  // is what keeps the run total a `≥`.
  expect(agent.attempts[0]?.control?.cost_unknown).toBe(true);
});

test("executeRunSteps: a non-blocking step cannot absorb an accounting stop", async () => {
  const done = bashStep(
    "spent",
    "cmd",
    {},
    { status: "done", control: { duration_ms: 1, total_cost_usd: 1, cost_unknown: true } },
  );
  const next = bashStep("next", "cmd", { blocking: false });
  const run = makeRun([done, next], 5);
  const { deps, calls } = fakeDeps();

  const outcome = await executeRunSteps(run, undefined, undefined, { resuming: true }, deps);

  expect(calls.exec).toBe(0);
  expect(outcome.costUnaccounted).toBe(true);
  expect(next.status).toBe("pending");
});

test("executeRunSteps: a completed run is not failed after the fact for unknown spend", async () => {
  // Nothing is left to withhold: the run did its work, the warning already fired,
  // and the totals stay marked as a lower bound.
  const done = bashStep(
    "spent",
    "cmd",
    {},
    { status: "done", control: { duration_ms: 1, total_cost_usd: 1, cost_unknown: true } },
  );
  const run = makeRun([done], 5);
  const { deps } = fakeDeps();

  const outcome = await executeRunSteps(run, undefined, undefined, { resuming: true }, deps);

  expect(outcome.costUnaccounted).toBe(false);
  expect(outcome.failed).toBe(false);
});

test("admitStep: validates the contract", async () => {
  // Use case: build the command from an artifact that only asynchronous reading
  // can provide. Without await here, `last_command` would be "[object Promise]"
  // and the step would run this string unchanged.
  const step = bashStep("a", "", { command: async (ctx) => `echo ${ctx.ticket ?? "sans-ticket"}` });
  const run = makeRun([step]);

  const admission = await admitStep({
    run,
    step,
    baseCtx: buildContext("PROJ-9", undefined),
    budget: { cumulative: 0 },
    output: NULL_RUN_OUTPUT,
  });

  expect(admission.kind).toBe("ready");
  expect(admission.kind === "ready" ? admission.command : "").toBe("echo PROJ-9");
  expect(step.last_command).toBe("echo PROJ-9");
});

test("admitStep: validates the contract", async () => {
  const required = artifact("missing.json", (value) => value as { command: string });
  const step = bashStep("a", "", {
    command: async (ctx) => (await required.require(ctx)).command,
    inputs: [skipIf(() => true)],
  });
  const run = makeRun([step]);

  const admission = await admitStep({
    run,
    step,
    baseCtx: buildContext(undefined, undefined),
    budget: { cumulative: 0 },
    output: NULL_RUN_OUTPUT,
  });

  expect(admission.kind).toBe("skip");
  expect(step.status).toBe("skipped");
  expect(step.last_command).toBeUndefined();
});

test("admitStep: validates the contract", async () => {
  // An async `.command()` reading a missing artifact type-checks perfectly
  // (`AsyncTemplated` accepts any function): this is the only possible safety net.
  // Without it, the exception escapes the run loop, the step never becomes
  // `failed`, and its `on_failure` policy never runs.
  const required = artifact("missing.json", (value) => value as { command: string });
  const step = bashStep("a", "", { command: async (ctx) => (await required.require(ctx)).command });
  const run = makeRun([step]);

  const admission = await admitStep({
    run,
    step,
    baseCtx: buildContext("PROJ-9", undefined),
    budget: { cumulative: 0 },
    output: NULL_RUN_OUTPUT,
  });

  expect(admission.kind).toBe("failed");
  expect(admission.kind === "failed" ? admission.reason : "").toMatch(/^admission: /);
  expect(step.status).toBe("failed");
});

test("admitStep: validates the contract", async () => {
  // Unlike the previous test, `.input()` already declares what to do with a
  // A failing predicate is caught by `skipIf`/`failIf` and applied. The
  // `admitStep` safety net therefore covers only inputs without a declared action.
  const skipped = bashStep("a", "echo a", {
    inputs: [
      skipIf(() => {
        throw new Error("invalid JSON parse");
      }),
    ],
  });
  const failed = bashStep("b", "echo b", {
    inputs: [
      failIf(() => {
        throw new Error("invalid JSON parse");
      }),
    ],
  });
  const run = makeRun([skipped, failed]);
  const ctx = buildContext(undefined, undefined);

  expect(
    (await admitStep({ run, step: skipped, baseCtx: ctx, budget: { cumulative: 0 }, output: NULL_RUN_OUTPUT })).kind,
  ).toBe("skip");
  const admission = await admitStep({
    run,
    step: failed,
    baseCtx: ctx,
    budget: { cumulative: 0 },
    output: NULL_RUN_OUTPUT,
  });
  expect(admission.kind).toBe("failed");
  expect(admission.kind === "failed" ? admission.reason : "").toBe("invalid JSON parse");
});

test("admitStep: validates the contract", async () => {
  // As with preflight, `blocking(false)` means this step does not have to
  // permission to mark a run failed, regardless of which guard gives way.
  const step = bashStep("a", "", {
    blocking: false,
    command: () => {
      throw new Error("tracker injoignable");
    },
  });
  const run = makeRun([step]);

  const admission = await admitStep({
    run,
    step,
    baseCtx: buildContext(undefined, undefined),
    budget: { cumulative: 0 },
    output: NULL_RUN_OUTPUT,
  });

  expect(admission.kind).toBe("skip");
  expect(step.status).toBe("done");
  expect(step.errors).toMatch(/tracker injoignable/);
});

test("executeRunSteps: validates the contract", async () => {
  // The loop counterpart: an admission failure is an ordered run failure.
  // (persisted statuses, later steps intact), rather than a process that dies.
  const boom = bashStep("boom", "", {
    command: () => {
      throw new Error("artifact missing");
    },
  });
  const jamais = bashStep("jamais", "echo b");
  const run = makeRun([boom, jamais]);
  const { deps, calls } = fakeDeps();

  const outcome = await executeRunSteps(run, "PROJ-9", undefined, { resuming: false }, deps);

  expect(outcome.failed).toBe(true);
  expect(calls.exec).toBe(0);
  expect(boom.status).toBe("failed");
  expect(jamais.status).toBe("pending");
});

function startedOrchestrationStep(inputs: StepInputCondition[]) {
  return makeRunStep(
    {
      id: "children",
      name: "Children",
      command: "",
      runner: "pipeline",
      inputs,
      orchestration: { kind: "runPipeline", pipeline: "child" },
    },
    {
      orchestration: {
        kind: "runPipeline",
        children: [
          {
            key: "main",
            kind: "main",
            pipeline: "child",
            status: "running",
            accountedCostUsd: 0,
          },
        ],
      },
    },
  );
}

test("admitStep: validates the contract", async () => {
  let evaluations = 0;
  const step = startedOrchestrationStep([
    freezeOnStart(
      skipUnless(() => {
        evaluations += 1;
        return false;
      }),
    ),
  ]);
  const run = makeRun([step]);

  const admission = await admitStep({
    run,
    step,
    baseCtx: buildContext(undefined, undefined),
    budget: { cumulative: 0 },
    output: NULL_RUN_OUTPUT,
  });

  expect(admission.kind).toBe("ready");
  expect(evaluations).toBe(0);
});

test("admitStep: validates the contract", async () => {
  let evaluations = 0;
  const step = startedOrchestrationStep([
    stopUnless(() => {
      evaluations += 1;
      return false;
    }, "recovery guard"),
  ]);
  const run = makeRun([step]);

  const admission = await admitStep({
    run,
    step,
    baseCtx: buildContext(undefined, undefined),
    budget: { cumulative: 0 },
    output: NULL_RUN_OUTPUT,
  });

  expect(admission.kind).toBe("stopped");
  expect(evaluations).toBe(1);
});

test("admitStep: validates the contract", async () => {
  const step = bashStep("a", "echo a", { preflight: async () => "exit 3" });
  const run = makeRun([step]);

  const admission = await admitStep({
    run,
    step,
    baseCtx: buildContext(undefined, undefined),
    budget: { cumulative: 0 },
    output: NULL_RUN_OUTPUT,
  });

  expect(admission.kind).toBe("failed");
  expect(step.status).toBe("failed");
  expect(admission.kind === "failed" ? admission.reason : "").toContain("preflight");
});

test("input: validates the contract", async () => {
  const visited: string[] = [];
  const step = bashStep("a", "echo a", {
    inputs: [
      skipIf(() => {
        visited.push("first");
        return false;
      }),
      failIf(() => {
        visited.push("second");
        return { ok: true, reason: "invalid artifact" };
      }),
      stopIf(() => {
        visited.push("third");
        return true;
      }),
    ],
  });
  const run = makeRun([step]);

  const admission = await admitStep({
    run,
    step,
    baseCtx: buildContext(undefined, undefined),
    budget: { cumulative: 0 },
    output: NULL_RUN_OUTPUT,
  });

  expect(admission).toEqual({ kind: "failed", reason: "invalid artifact" });
  expect(visited).toEqual(["first", "second"]);
  expect(step.errors).toBe("input failed: invalid artifact");
});

test("skipUnlessCommand short-circuits composed conditions: validates the contract", async () => {
  let evaluated = false;
  const step = bashStep("a", "echo a", {
    inputs: [
      skipUnlessCommand("printf 'contract missing' && false"),
      failIf(() => {
        evaluated = true;
        return true;
      }),
    ],
  });
  const run = makeRun([step]);

  const admission = await admitStep({
    run,
    step,
    baseCtx: buildContext(undefined, undefined),
    budget: { cumulative: 0 },
    output: NULL_RUN_OUTPUT,
  });

  expect(admission.kind).toBe("skip");
  expect(step.status).toBe("skipped");
  expect(evaluated).toBe(false);
});

test("resolveOutcome: validates the contract", async () => {
  const step = bashStep("visual", "cmd", {
    on_failure: { fix_prompt: "fix", max_retries: 2 },
  });
  const run = makeRun([step]);
  const { deps } = fakeDeps();
  let fixCalled = false;
  deps.runFixLoop = async () => {
    fixCalled = true;
    return { failed: false };
  };

  const outcome = await resolveOutcome({
    run,
    step,
    command: "cmd",
    baseCtx: buildContext(undefined, undefined),
    budget: { cumulative: 0 },
    abort: createAbortScope(),
    output: NULL_RUN_OUTPUT,
    // The loop reads `failCause` and never the reason's prose. The two boundaries
    // that translate a `BLOCKED:` prefix into this field are covered by
    // `verdict.test.ts` and `runners.test.ts`.
    result: { ok: false, output: "", failReason: "app unavailable", failCause: "blocked" },
    stepLog: "steps/visual/attempt-001/output.log",
    deps,
  });

  expect(outcome).toBe("stopped");
  expect(fixCalled).toBe(false);
  expect(run.stopped_reason).toBe("app unavailable");
  // An obstacle outside the code is a stop kind of its own: no subject approves
  // it away, the environment has to be fixed.
  expect(run.outcome?.stop).toEqual({ kind: "blocked", detail: "app unavailable" });
});

test("resolveOutcome: a BLOCKED: prefix without the cause no longer stops the run on its own", async () => {
  const step = bashStep("visual", "cmd", { on_failure: { fix_prompt: "fix", max_retries: 2 } });
  const run = makeRun([step]);
  const { deps } = fakeDeps();
  let fixCalled = false;
  deps.runFixLoop = async () => {
    fixCalled = true;
    return { failed: false };
  };

  const outcome = await resolveOutcome({
    run,
    step,
    command: "cmd",
    baseCtx: buildContext(undefined, undefined),
    budget: { cumulative: 0 },
    abort: createAbortScope(),
    output: NULL_RUN_OUTPUT,
    result: { ok: false, output: "", failReason: "BLOCKED: app unavailable" },
    stepLog: "steps/visual/attempt-001/output.log",
    deps,
  });

  // A result that reaches the loop with a prefix and no cause never came through
  // a backend: every production path normalizes it at `invokeBackend`.
  expect(outcome).toBe("continue");
  expect(fixCalled).toBe(true);
  expect(run.outcome?.stop).toBeUndefined();
});

test("resolveOutcome: a blocked cause without a reason still gets a readable stop detail", async () => {
  const step = bashStep("visual", "cmd");
  const run = makeRun([step]);
  const { deps } = fakeDeps();

  const outcome = await resolveOutcome({
    run,
    step,
    command: "cmd",
    baseCtx: buildContext(undefined, undefined),
    budget: { cumulative: 0 },
    abort: createAbortScope(),
    output: NULL_RUN_OUTPUT,
    result: { ok: false, output: "", failCause: "blocked" },
    stepLog: "steps/visual/attempt-001/output.log",
    deps,
  });

  expect(outcome).toBe("stopped");
  expect(run.outcome?.stop?.kind).toBe("blocked");
  expect(run.outcome?.stop?.detail).toBe("blocked by an obstacle outside the code");
});

test("run nominal: validates the contract", async () => {
  const steps = [bashStep("a", "echo a"), bashStep("b", "echo b")];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: true }, { ok: true }]);
  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);
  expect(out.failed).toBe(false);
  expect(out.stopped).toBe(false);
  expect(steps.every((s) => s.status === "done")).toBe(true);
  expect(calls.ids).toEqual(["a", "b"]);
});

test("agent steps preserve provider-aware state: validates the contract", async () => {
  const step = makeRunStep({
    id: "codex",
    name: "Codex",
    command: "analyse",
    runner: "agent",
    backend: { id: "codex" },
    output_format: "json",
  });
  const run = makeRun([step]);
  const { deps } = fakeDeps();
  deps.executeStep = async () => ({
    output: '{"success":true}',
    ok: true,
    session: { provider: "codex", id: "thread-1", resumable: true },
    stats: { duration_ms: 1, provider: "codex", model: CODEX_MODEL.GPT_5_CODEX, input_tokens: 10, output_tokens: 5 },
  });

  const result = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps, agentContext());

  expect(result.failed).toBe(false);
  expect(step.session).toEqual({ provider: "codex", id: "thread-1", resumable: true });
  expect(step.control?.provider).toBe("codex");
});

test("input skip: validates the contract", async () => {
  const steps = [bashStep("a", "echo a", { inputs: [skipUnlessCommand("false")] }), bashStep("b", "echo b")];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: true }]);
  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);
  expect(out.failed).toBe(false);
  expect(steps[0].status).toBe("skipped");
  expect(steps[1].status).toBe("done");
  expect(calls.ids).toEqual(["b"]);
});

test("step-loop: validates the integration contract", async () => {
  // Regression for PROJ-327: `plan` was killed before its verdict in the previous run (plan.md
  // written, costing $5.40) and then, on resume, its idempotency precondition sees
  // its own artifact. Status must reflect the work performed; otherwise status
  // analysis reads "never executed" for a step that cost $5.40.
  const steps = [
    bashStep(
      "plan",
      "echo plan",
      { inputs: [skipUnlessCommand("false")] },
      {
        status: "failed",
        control: { duration_ms: 241_000, total_cost_usd: 5.4 },
      },
    ),
    bashStep("b", "echo b"),
  ];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: true }]);
  const out = await executeRunSteps(run, undefined, undefined, { resuming: true }, deps);
  expect(out.failed).toBe(false);
  expect(steps[0].status).toBe("done");
  expect(steps[0].control?.total_cost_usd).toBe(5.4);
  expect(calls.ids).toEqual(["b"]);
});

test("step-loop: validates the integration contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-resume-"));
  const artifact = join(dir, "plan.md");
  const original = "# plan already produced\n";
  writeFileSync(artifact, original);
  const plan = bashStep(
    "plan",
    "generate-plan",
    {
      inputs: [skipUnless(() => !existsSync(artifact))],
    },
    {
      status: "failed",
      control: { duration_ms: 241_000, total_cost_usd: 5.4 },
    },
  );
  const run = makeRun([plan]);
  const { deps, calls } = fakeDeps();

  const out = await executeRunSteps(run, undefined, undefined, { resuming: true }, deps);

  expect(out.failed).toBe(false);
  expect(calls.exec).toBe(0);
  expect(plan.status).toBe("done");
  expect(readFileSync(artifact, "utf-8")).toBe(original);
});

test("input skip without control: validates the contract", async () => {
  const steps = [bashStep("a", "echo a", { inputs: [skipUnlessCommand("false")] })];
  const run = makeRun(steps);
  const { deps } = fakeDeps([]);
  await executeRunSteps(run, undefined, undefined, { resuming: true }, deps);
  expect(steps[0].status).toBe("skipped");
});

test("input stop: validates the contract", async () => {
  const steps = [bashStep("a", "echo a", { inputs: [stopUnlessCommand("false")] }), bashStep("b", "echo b")];
  const run = makeRun(steps);
  const { deps } = fakeDeps();
  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);
  expect(out.stopped).toBe(true);
  expect(out.failed).toBe(false);
  expect(run.stopped_reason).toBeTruthy();
  // A clean stop preserves the work left to do, so the run stays resumable.
  expect(steps[1].status).toBe("pending");
  expect(isPersistedRunResumable(readRunSnapshot(join(run.run_dir, "state.json")))).toBe(true);
});

test("input TS skip: validates the contract", async () => {
  const steps = [
    bashStep("a", "echo a", {
      inputs: [skipUnless(() => ({ ok: false, reason: "voie standard" }))],
    }),
    bashStep("b", "echo b"),
  ];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: true }]);
  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);
  expect(out.failed).toBe(false);
  expect(steps[0].status).toBe("skipped");
  expect(calls.ids).toEqual(["b"]);
});

test("input TS stop: validates the contract", async () => {
  const steps = [
    bashStep("a", "echo a", {
      inputs: [stopUnless(() => ({ ok: false, reason: "escalated: cannot reproduce" }))],
    }),
    bashStep("b", "echo b"),
  ];
  const run = makeRun(steps);
  const { deps } = fakeDeps();
  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);
  expect(out.stopped).toBe(true);
  expect(run.stopped_reason).toBe("escalated: cannot reproduce");
});

test("input TS true: validates the contract", async () => {
  const steps = [bashStep("a", "echo a", { inputs: [skipUnless(() => true)] })];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: true }]);
  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);
  expect(out.failed).toBe(false);
  expect(calls.ids).toEqual(["a"]);
});

test("input TS that throw: validates the contract", async () => {
  const steps = [
    bashStep("a", "echo a", {
      inputs: [
        skipUnless(() => {
          throw new Error("JSON corrompu");
        }),
      ],
    }),
    bashStep("b", "echo b"),
  ];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: true }]);
  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);
  expect(out.failed).toBe(false);
  expect(steps[0].status).toBe("skipped");
  expect(calls.ids).toEqual(["b"]);
});

test("step-loop: validates the integration contract", async () => {
  const steps = [bashStep("a", "echo a", { inputs: [failUnlessCommand("false")] }), bashStep("b", "echo b")];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps();
  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);
  expect(out.failed).toBe(true);
  expect(steps[0].status).toBe("failed");
  expect(calls.exec).toBe(0);
});

test("step-loop: validates the integration contract", async () => {
  const steps = [bashStep("a", "cmd", { on_failure: { max_retries: 2 } })];
  const run = makeRun(steps);
  // attempt initial KO, first rerun OK.
  const { deps, calls } = fakeDeps([{ ok: false }, { ok: true }]);
  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);
  expect(out.failed).toBe(false);
  expect(steps[0].status).toBe("done");
  expect(steps[0].retries).toBe(1);
  expect(calls.exec).toBe(2);
});

test("step-loop: validates the integration contract", async () => {
  const steps = [bashStep("a", "cmd", { on_failure: { max_retries: 2 } })];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: false }, { ok: false }, { ok: false }]);
  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);
  expect(out.failed).toBe(true);
  expect(steps[0].status).toBe("failed");
  expect(steps[0].retries).toBe(2);
  expect(calls.exec).toBe(3); // 1 initial + 2 reruns
});

test("step-loop: validates the integration contract", async () => {
  const steps = [bashStep("a", "cmd"), bashStep("b", "cmd")];
  const run = makeRun(steps, 1);
  // Step a costs 2 -> the budget (1) is exceeded before b.
  const { deps, calls } = fakeDeps([{ ok: true, stats: { duration_ms: 1, total_cost_usd: 2 } }]);
  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);
  expect(out.budgetExceeded).toBe(true);
  expect(steps[0].status).toBe("done");
  expect(steps[1].status).toBe("pending");
  expect(calls.ids).toEqual(["a"]);
  // The already-paid step must not be replayed on the next invocation.
  expect(isPersistedRunResumable(readRunSnapshot(join(run.run_dir, "state.json")))).toBe(true);
});

test("step-loop: a live guard kill is a durable budget stop, not a replayable failure", async () => {
  const steps = [bashStep("a", "cmd"), bashStep("b", "cmd")];
  const run = makeRun(steps, 1);
  // The guard killed step a on a live estimate above the $1 ceiling; the figure
  // the backend settled on afterwards ($0.30) lands under it.
  const { deps, calls } = fakeDeps([
    {
      ok: false,
      budgetExceeded: true,
      failReason: "process killed: budget exceeded ($1.10 estimated > $1.00 remaining)",
      stats: { duration_ms: 1, total_cost_usd: 0.3, cost_estimated: true },
    },
  ]);
  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);
  expect(out.budgetExceeded).toBe(true);
  expect(calls.ids).toEqual(["a"]);
  // The stop survives the snapshot: the ledger alone ($0.30 < $1) would not.
  expect(readRunSnapshot(join(run.run_dir, "state.json"))?.budget_exceeded).toBe(true);

  // …and it survives as a VALUE, in the journal and on the outcome. Without them
  // the only machine-readable trace of the kill is a step whose `failKind` reads
  // `technical` and whose `errors` is a sentence, and `budget_exceeded` is wiped
  // by the `--budget` resume that answers it.
  const killEvents = readRunEvents(run.run_dir).filter((event) => event.type === "run.budget.exceeded");
  expect(killEvents).toHaveLength(1);
  expect(killEvents[0]).toMatchObject({
    stepId: "a",
    maxCostUsd: 1,
    // The guard fires on its own running total; the settled figure landed under
    // the ceiling, which is exactly why the flag and not the ledger is the stop.
    estimated: true,
    remainingSteps: 1,
  });
  finalizeRun(run, out);
  expect(readRunSnapshot(join(run.run_dir, "state.json"))?.outcome?.stopKind).toBe("budget-exceeded");
  const finished = readRunEvents(run.run_dir).filter((event) => event.type === "run.finished");
  expect(finished).toHaveLength(1);
  const finishedOutcome = (finished[0] as { outcome?: { stopKind?: string; reason?: string } }).outcome;
  expect(finishedOutcome?.stopKind).toBe("budget-exceeded");
  // The sentence stays exactly what it was; the kind is what a reader can act on.
  expect(String(finishedOutcome?.reason)).toContain("budget exceeded");

  // Resumed without --budget: same ledger, and the loop must not spawn anything.
  const resumedSteps = [
    bashStep("a", "cmd", {}, { status: "failed", control: { duration_ms: 1, total_cost_usd: 0.3 } }),
    bashStep("b", "cmd"),
  ];
  const resumed: Run = { ...makeRun(resumedSteps, 1), budget_exceeded: true };
  const second = fakeDeps([{ ok: true }, { ok: true }]);
  const again = await executeRunSteps(resumed, undefined, undefined, { resuming: true }, second.deps);
  expect(again.budgetExceeded).toBe(true);
  expect(second.calls.exec).toBe(0);
  expect(resumedSteps[1].status).toBe("pending");
  // A new generation decides again and journals again — one fact per stop, and
  // this one rests on the flag the previous kill left behind.
  const resumedEvents = readRunEvents(resumed.run_dir).filter((event) => event.type === "run.budget.exceeded");
  expect(resumedEvents).toHaveLength(1);
  expect(resumedEvents[0]).toMatchObject({ stepId: "a", estimated: true });
});

test("resume: validates the contract", async () => {
  const steps = [
    bashStep("normal", "cmd", {}, { status: "done" }),
    bashStep("branch", "cmd", { rerun_on_resume: true }, { status: "done" }),
    bashStep("next", "cmd"),
  ];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: true }, { ok: true }]);
  const out = await executeRunSteps(run, undefined, undefined, { resuming: true }, deps);
  expect(out.failed).toBe(false);
  expect(calls.ids).toEqual(["branch", "next"]);
});

test("step-loop: validates the integration contract", async () => {
  const steps = [bashStep("a", "cmd", { on_failure: { fix_prompt: "x", max_retries: 1 } })];
  const run = makeRun(steps);
  let fixCalled = false;
  const { deps } = fakeDeps([{ ok: false }]);
  deps.runFixLoop = async () => {
    fixCalled = true;
    return { failed: false };
  };
  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);
  expect(fixCalled).toBe(true);
  expect(out.failed).toBe(false);
});

test("preflight KO: validates the contract", async () => {
  const steps = [bashStep("visual", "cmd", { preflight: "exit 7" }), bashStep("next", "cmd")];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: true }, { ok: true }]);
  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);
  expect(out.failed).toBe(true);
  expect(steps[0].status).toBe("failed");
  expect(steps[0].errors).toContain("preflight");
  expect(calls.ids).toEqual([]);
});

test("preflight KO on step non blocking: validates the contract", async () => {
  const steps = [bashStep("visual", "cmd", { preflight: "exit 7", blocking: false }), bashStep("next", "cmd")];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: true }]);
  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);
  expect(out.failed).toBe(false);
  expect(steps[0].status).toBe("done");
  expect(calls.ids).toEqual(["next"]);
});

test("preflight OK: validates the contract", async () => {
  const steps = [bashStep("visual", "cmd", { preflight: "true" })];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: true }]);
  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);
  expect(out.failed).toBe(false);
  expect(calls.ids).toEqual(["visual"]);
});

test("step-loop: validates the integration contract", async () => {
  const steps = [
    bashStep("visual", "cmd", {
      inputs: [skipUnlessCommand("false")],
      preflight: "exit 7",
    }),
  ];
  const run = makeRun(steps);
  const { deps } = fakeDeps();
  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);
  expect(out.failed).toBe(false);
  expect(steps[0].status).toBe("skipped");
});

test("step-loop: validates the integration contract", async () => {
  const steps = [
    bashStep("visual", "cmd", { on_failure: { fix_prompt: "x", max_retries: 2 } }),
    bashStep("next", "cmd"),
  ];
  const run = makeRun(steps);
  let fixCalled = false;
  const { deps, calls } = fakeDeps([
    { ok: false, failReason: "app unreachable at https://app.localhost", failCause: "blocked" },
  ]);
  deps.runFixLoop = async () => {
    fixCalled = true;
    return { failed: false };
  };

  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);

  expect(fixCalled).toBe(false);
  expect(out.stopped).toBe(true);
  expect(run.stopped_reason).toContain("app unreachable");
  expect(run.steps[0]!.fail_cause).toBe("blocked");
  expect(calls.ids).toEqual(["visual"]); // 'next' jamais atteint
});

test("step-loop: validates the integration contract", async () => {
  const steps = [
    bashStep("visual", "cmd", {
      blocking: false,
      on_failure: { fix_prompt: "x", max_retries: 2 },
    }),
    bashStep("next", "cmd"),
  ];
  const run = makeRun(steps);
  let fixCalled = false;
  const { deps, calls } = fakeDeps([{ ok: false, failReason: "app unreachable", failCause: "blocked" }, { ok: true }]);
  deps.runFixLoop = async () => {
    fixCalled = true;
    return { failed: false };
  };

  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);

  expect(fixCalled).toBe(false);
  expect(out.stopped).toBe(false);
  expect(steps[0].status).toBe("done");
  expect(calls.ids).toEqual(["visual", "next"]);
});

test("step-loop: validates the integration contract", async () => {
  const steps = [bashStep("visual", "cmd", { on_failure: { fix_prompt: "x", max_retries: 1 } })];
  const run = makeRun(steps);
  let fixCalled = false;
  const { deps } = fakeDeps([{ ok: false, failReason: "UI-002: expected label is missing" }]);
  deps.runFixLoop = async () => {
    fixCalled = true;
    return { failed: false };
  };

  await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);

  expect(fixCalled).toBe(true);
});

test("step-loop: validates the integration contract", async () => {
  const steps = [bashStep("static-analysis", "cmd", { error_extractor: "sample-extractor" })];
  const run = makeRun(steps);
  const { deps } = fakeDeps([{ ok: false, output: "fatal tool crash" }]);
  deps.extractErrors = async () => ({ hasErrors: false, errors: "" });

  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);

  expect(out.failed).toBe(true);
  expect(steps[0].status).toBe("failed");
});

test("check non blocking: validates the contract", async () => {
  const steps = [bashStep("warn", "cmd", { blocking: false }), bashStep("next", "cmd")];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: false, failReason: "lint facultatif" }, { ok: true }]);

  const out = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);

  expect(out.failed).toBe(false);
  expect(calls.ids).toEqual(["warn", "next"]);
  expect(steps[0]).toMatchObject({ status: "done", errors: "lint facultatif" });
  expect(steps[0].def.blocking).toBe(false);
  expect(steps[1].status).toBe("done");
});

test("step-loop: validates the integration contract", async () => {
  const steps: RunStep[] = [
    makeRunStep({
      id: "implement",
      name: "implement",
      command: "code",
      runner: "agent",
      backend: { id: "claude", options: { model: "opus" } },
    }),
  ];
  const run = makeRun(steps);
  const seen: Array<unknown> = [];
  const exceeded = { ok: false, stats: { duration_ms: 1, num_turns: 4 } };
  const { deps } = fakeDeps([exceeded]);
  const inner = deps.executeStep;
  deps.executeStep = async (step, cmd, budget, ctx) => {
    seen.push(budget?.agentOptions);
    return inner(step, cmd, budget, ctx);
  };

  await executeRunSteps(run, undefined, undefined, { resuming: false }, deps, agentContext());

  expect(seen).toEqual([undefined]);
});

/** Agent steps resolve their backend on the context: the registry is explicit,
 * nothing falls back to the built-in composition. */
const agentContext = () => buildPipelineContext({ ...commandRegistries(), cwd: "." });

const ticketArtifact = textArtifact("ticket.md");
const specArtifact = textArtifact("spec.md");

/** Map-keyed artifact store: freshness compares several artifacts at once. */
function artifactContext(initial: Record<string, string> = {}): {
  values: Map<string, string>;
  ctx: PipelineContext;
} {
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

const derivedStep = (state: StepStateInput = {}): RunStep =>
  bashStep("spec", "cmd", { sources: [ticketArtifact], outputs: [specArtifact] }, state);

test("resume: a done step with fresh declared inputs is re-admitted at zero cost", async () => {
  const { ctx } = artifactContext({ "ticket.md": "one", "spec.md": "written" });
  const step = derivedStep({ status: "done", control: { duration_ms: 1 } });
  const run = makeRun([step]);
  await writeProvenance(ctx, specArtifact, "spec", { "artifacts/ticket.md": sha256Text("one") });

  const { deps, calls } = fakeDeps();
  await executeRunSteps(run, "PROJ-1", undefined, { resuming: true }, deps, ctx);

  expect(calls.exec).toBe(0);
  expect(step.status).toBe("done");
  const skipped = readRunEvents(run.run_dir).find((event) => event.type === "step.skipped");
  expect(skipped).toMatchObject({ stepId: "spec", reason: "outputs up to date with declared inputs" });
});

test("resume: a done step whose declared input changed is replayed", async () => {
  const { ctx } = artifactContext({ "ticket.md": "answered", "spec.md": "written" });
  const step = derivedStep({ status: "done", control: { duration_ms: 1 } });
  const run = makeRun([step]);
  await writeProvenance(ctx, specArtifact, "spec", { "artifacts/ticket.md": sha256Text("one") });

  const { deps, calls } = fakeDeps();
  await executeRunSteps(run, "PROJ-1", undefined, { resuming: true }, deps, ctx);

  expect(calls.ids).toEqual(["spec"]);
});

test("resume: a step skipped by its own admission is re-admitted, an excluded one is not", async () => {
  const { ctx } = artifactContext({ "ticket.md": "one" });
  const admitted = derivedStep({ status: "skipped" });
  const excluded = bashStep(
    "plan",
    "cmd",
    { sources: [ticketArtifact], outputs: [textArtifact("plan.md")] },
    { status: "skipped", excluded: true },
  );
  const run = makeRun([admitted, excluded]);

  const { deps, calls } = fakeDeps();
  await executeRunSteps(run, "PROJ-1", undefined, { resuming: true }, deps, ctx);

  // The outputs are missing, so the re-admitted step runs; the operator exclusion holds.
  expect(calls.ids).toEqual(["spec"]);
  expect(excluded.status).toBe("skipped");
});

test("resume: a when refusal over stale inputs says the outputs were kept", async () => {
  const { ctx } = artifactContext({ "ticket.md": "answered", "spec.md": "written" });
  const step = bashStep(
    "spec",
    "cmd",
    { sources: [ticketArtifact], outputs: [specArtifact], inputs: [skipIf(() => true, "already committed")] },
    { status: "done", control: { duration_ms: 1 } },
  );
  const run = makeRun([step]);
  await writeProvenance(ctx, specArtifact, "spec", { "artifacts/ticket.md": sha256Text("one") });

  const { deps, calls } = fakeDeps();
  await executeRunSteps(run, "PROJ-1", undefined, { resuming: true }, deps, ctx);

  expect(calls.exec).toBe(0);
  const skipped = readRunEvents(run.run_dir).find((event) => event.type === "step.skipped");
  expect(skipped).toMatchObject({
    stepId: "spec",
    reason: "already committed (inputs changed, outputs kept)",
    freshness: "stale",
  });
});

// --- Agent step timeout, end to end ----------------------------------------
//
// One test for the three facts a timeout must produce together, through the real
// spawn: the process tree dies, the attempt is closed, and the run stays
// resumable. Proving them separately would let the loop report a closed attempt
// while a grandchild keeps writing to the repository.

/** Dependencies with the real spawn and extraction, and a fix loop that only
 *  records: a step without `on_failure` must not reach a repair pass. */
function realSpawnDeps(): { deps: StepLoopDeps; fixCalls: () => number } {
  let fixCalls = 0;
  return {
    deps: {
      executeStep,
      extractErrors,
      runFixLoop: async () => {
        fixCalls++;
        return { failed: false };
      },
      output: NULL_RUN_OUTPUT,
    },
    fixCalls: () => fixCalls,
  };
}

test("step-loop: an agent step timeout kills the process tree, closes the attempt, and leaves the run resumable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steploop-agent-timeout-"));
  const bin = join(dir, "fake-opencode");
  const pidFile = join(dir, "descendant.pid");
  // A CLI that spawns its own worker, exactly what a real agent does when it
  // shells out. The `wait` keeps the direct child alive so the deadline is the
  // supervisor's, not the script's.
  writeFileSync(bin, `${["#!/bin/sh", "sleep 30 >/dev/null 2>&1 &", `echo $! > '${pidFile}'`, "wait"].join("\n")}\n`);
  chmodSync(bin, 0o755);
  const agent = makeRunStep(
    {
      id: "implement",
      name: "Implement",
      command: "work",
      runner: "agent",
      backend: { id: "opencode", options: { bin } },
      timeout: 1,
    },
    {},
  );
  const next = bashStep("after", "echo never");
  const run = makeRun([agent, next]);
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: dir });
  const { deps, fixCalls } = realSpawnDeps();

  const outcome = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps, ctx);

  // 1. The tree is gone, the grandchild included.
  const descendant = Number(readFileSync(pidFile, "utf8").trim());
  expect(Number.isInteger(descendant)).toBe(true);
  try {
    process.kill(descendant, 0);
    throw new Error(`descendant ${descendant} outlived the timeout`);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
  }

  // 2. The attempt is closed, as failed, with the timeout named and the spend
  //    flagged unaccounted: an agent killed before its first usage event still
  //    burned tokens.
  expect(outcome.failed).toBe(true);
  expect(agent.status).toBe("failed");
  expect(agent.attempts).toHaveLength(1);
  expect(agent.attempts[0]).toMatchObject({ kind: "step", status: "failed" });
  expect(agent.attempts[0]?.finished_at).toBeDefined();
  expect(String(agent.attempts[0]?.errors)).toContain("timeout");
  expect(agent.attempts[0]?.control).toMatchObject({ cost_unknown: true, cost_estimated: true });
  expect(fixCalls()).toBe(0);
  const finished = readRunEvents(run.run_dir).filter((event) => event.type === "step.attempt.finished");
  expect(finished).toHaveLength(1);
  expect(finished[0]).toMatchObject({ stepId: "implement", status: "failed" });

  // 3. The next step was never launched and the persisted run can be resumed.
  expect(next.status).toBe("pending");
  const snapshot = readRunSnapshot(join(run.run_dir, "state.json"));
  expect(isPersistedRunResumable(snapshot)).toBe(true);
  expect(pendingSteps(snapshot).map((step) => step.id)).toEqual(["implement", "after"]);
  // The snapshot carries no attempt list on purpose (the journal does), so what
  // must survive here is the attempt count and the uncertain spend that seeds the
  // ledger on the next invocation.
  expect(snapshot?.steps[0]).toMatchObject({ status: "failed", last_attempt: 1 });
  expect(snapshot?.steps[0]?.control).toMatchObject({ cost_unknown: true });
  expect(String(snapshot?.outcome?.reason)).toContain("timeout");
  expect(snapshot?.outcome?.resumable).toBe(true);
}, 30_000);

test("step-loop: a run resumed after an interruption replays the aborted step and nothing already done", async () => {
  const steps = [
    bashStep("done-before", "cmd", {}, { status: "done", control: { duration_ms: 1, total_cost_usd: 0.4 } }),
    // The shape `abortRun` leaves behind: the step that was in flight is aborted
    // and its attempt is already closed.
    bashStep(
      "interrupted",
      "cmd",
      {},
      {
        status: "aborted",
        errors: "SIGTERM: run interrupted manually",
        attempts: [
          {
            attempt: 1,
            kind: "step",
            status: "aborted",
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            log_path: "steps/interrupted/1.log",
          },
        ],
      },
    ),
    bashStep("never-started", "cmd"),
  ];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: true }, { ok: true }]);

  const outcome = await executeRunSteps(run, undefined, undefined, { resuming: true }, deps);

  expect(outcome.failed).toBe(false);
  // The paid step is neither replayed nor repaid; the interrupted one restarts.
  expect(calls.ids).toEqual(["interrupted", "never-started"]);
  expect(steps[0].status).toBe("done");
  expect(steps[0].attempts).toHaveLength(0);
  // The replay opens a second attempt rather than reopening the aborted one.
  expect(steps[1].attempts?.map((attempt) => attempt.status)).toEqual(["aborted", "done"]);
});

test("executeRunSteps: the persisted authorization feeds the ledger and the latch survives it", async () => {
  const done = bashStep(
    "spent",
    "cmd",
    {},
    { status: "done", control: { duration_ms: 1, total_cost_usd: 1, cost_unknown: true } },
  );
  const next = bashStep("next", "cmd");
  // `allow_unmetered` on the run is the only difference from the stop scenario
  // above: the loop reads it into `RunBudget.allowUnmetered`, no flag and no
  // environment switch involved.
  const run: Run = { ...makeRun([done, next], 5), allow_unmetered: true };
  const { deps, calls } = fakeDeps([{ ok: true }]);

  const outcome = await executeRunSteps(run, undefined, undefined, { resuming: true }, deps);

  expect(outcome.costUnaccounted).toBe(false);
  expect(calls.ids).toEqual(["next"]);
  // Authorized is not accounted: the latch is still written, so the report and
  // every later reader keep treating the total as a lower bound.
  expect(run.cost_unaccounted).toBe(true);
  expect(readRunSnapshot(join(run.run_dir, "state.json"))?.cost_unaccounted).toBe(true);
});

test("executeRunSteps: a retry withheld for unaccounted spend is journaled once and named on the outcome", async () => {
  // The gate inside `on_failure`: it breaks the loop without reporting upward, so
  // the shared ledger and the journal are the only places the refusal can be
  // read. Three retries were declared; none is paid for.
  const agent = makeRunStep({
    id: "implement",
    name: "implement",
    command: "go",
    runner: "agent",
    backend: { id: "claude" },
    on_failure: { max_retries: 3 },
  });
  const next = bashStep("after", "cmd");
  const run = makeRun([agent, next], 5);
  const { deps, calls } = fakeDeps([
    // Measured consumption with no price: 1100 tokens the table could not cost.
    { ok: false, failReason: "assertion failed", stats: { duration_ms: 5, output_tokens: 1100 } },
  ]);

  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: run.run_dir });
  const outcome = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps, ctx);

  expect(calls.ids).toEqual(["implement"]);
  expect(agent.retries).toBe(0);
  expect(outcome.costUnaccountedStop).toBe(true);
  expect(outcome.budgetExceeded).toBe(false);
  const events = readRunEvents(run.run_dir).filter((event) => event.type === "run.cost.unaccounted");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ stepId: "implement", maxCostUsd: 5 });
  // The per-attempt event is untouched and says something else: the attempt's
  // price is unknown. This one says the run stopped over it.
  expect(readRunEvents(run.run_dir).filter((event) => event.type === "step.cost.unaccounted")).toHaveLength(1);
  finalizeRun(run, outcome);
  expect(readRunSnapshot(join(run.run_dir, "state.json"))?.outcome?.stopKind).toBe("cost-unaccounted");
  expect(next.status).toBe("pending");
});

test("executeRunSteps: a plain technical failure claims no cost stop", async () => {
  // The control case for the whole mechanism: a capped run, a failing step, fully
  // priced spend. Nothing about the cost policy ended it, so no stop event and no
  // stop kind — a post-mortem filtering on them sees only real cost stops.
  const steps = [bashStep("a", "cmd"), bashStep("b", "cmd")];
  const run = makeRun(steps, 5);
  const { deps } = fakeDeps([{ ok: false, failReason: "exit 1", stats: { duration_ms: 1, total_cost_usd: 0.2 } }]);

  const outcome = await executeRunSteps(run, undefined, undefined, { resuming: false }, deps);

  expect(outcome.failed).toBe(true);
  expect(outcome.budgetExceeded).toBe(false);
  expect(outcome.costUnaccounted).toBe(false);
  expect(outcome.costUnaccountedStop).toBe(false);
  const events = readRunEvents(run.run_dir).map((event) => event.type);
  expect(events).not.toContain("run.budget.exceeded");
  expect(events).not.toContain("run.cost.unaccounted");
  finalizeRun(run, outcome);
  expect(readRunSnapshot(join(run.run_dir, "state.json"))?.outcome?.stopKind).toBeUndefined();
});

test("executeRunSteps: an abort requested on one scope leaves a run under another scope untouched", async () => {
  // Two executions in one process, each under its own scope: the interruption of
  // the first stops it before its second step and is invisible to the second.
  const scopeA = createAbortScope();
  const scopeB = createAbortScope();
  const runA = makeRun([bashStep("a1", "cmd"), bashStep("a2", "cmd")]);
  const runB = makeRun([bashStep("b1", "cmd"), bashStep("b2", "cmd")]);
  const { deps: depsA, calls: callsA } = fakeDeps();
  const originalA = depsA.executeStep;
  depsA.executeStep = (...args) => {
    scopeA.requestAbort("SIGINT");
    return originalA(...args);
  };
  const { deps: depsB, calls: callsB } = fakeDeps();

  const [outcomeA, outcomeB] = await Promise.all([
    executeRunSteps(runA, undefined, undefined, { resuming: false, abort: scopeA }, depsA),
    executeRunSteps(runB, undefined, undefined, { resuming: false, abort: scopeB }, depsB),
  ]);

  expect(callsA.ids).toEqual(["a1"]);
  expect(callsB.ids).toEqual(["b1", "b2"]);
  expect(scopeA.isAbortRequested()).toBe(true);
  expect(scopeB.isAbortRequested()).toBe(false);
  expect(outcomeA.failed).toBe(false);
  expect(outcomeB.failed).toBe(false);
  // Both loops left the scope they registered on.
  expect(scopeA.activeRuns()).toEqual([]);
  expect(scopeB.activeRuns()).toEqual([]);
});
