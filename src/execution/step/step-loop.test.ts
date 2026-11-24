import { expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { artifact, source, textArtifact } from "../../definition/dsl/artifact.ts";
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
} from "../../definition/dsl/input.ts";
import { CODEX_MODEL } from "../../agents/backends/codex/types.ts";
import { extractErrors } from "../report-extraction.ts";
import { executeStep, type StepResult } from "../runners.ts";
import type { ArtifactRef, WorkItemArtifactStore } from "../../shared/language/artifact-ports.ts";
import type { PipelineContext, PipelineLot } from "../../shared/language/context.ts";
import type { PipelineStep } from "../../definition/definition.ts";
import type { Run, RunStep } from "../../run/record/run.ts";
import { buildPipelineContext } from "../../definition/pipeline/context.ts";
import { sha256Text } from "../../work-items/store/hash.ts";
import * as stepLock from "../../work-items/store/step-lock.ts";
import { commitPass, readInputs, readLock } from "../../work-items/store/step-lock.ts";
import { runSpend } from "../../run/record/cost-accounting.ts";
import { readRunEvents } from "../../run/record/run-journal.ts";
import { finalizeRun } from "../../run/record/run-transitions.ts";
import { isPersistedRunResumable, pendingSteps } from "../../run/record/run-predicates.ts";
import { readRunSnapshot } from "../../run/record/run-snapshot.ts";
import { makeRunStep, type StepStateInput } from "../../run/record/run-step.ts";
import { admitStep } from "./step-admission.ts";
import { executeRunSteps, type StepLoopDeps } from "./step-loop.ts";
import { loadOrCreateRun } from "./load-or-create-run.ts";
import { resolveRunDir } from "../../run/record/stores/run-storage.ts";
import { resolveOutcome } from "./step-outcome.ts";
import { builtinRegistries } from "../../../tests/builtin-registries.ts";
import { createDefaultAgentBackendRegistry } from "../../agents/default-registry.ts";
import { createAbortScope } from "../abort.js";
import { humanReview } from "../../definition/builtin-steps/lib/human-review.js";
import { createInternalWorkItemSourceStep, bashStep as dslBashStep, pipeline } from "../../definition/dsl.js";
import { pendingRejection, readDecision, recordApproval, recordRejection } from "../../work-items/store/decisions.js";
import { NULL_RUN_OUTPUT } from "../run-output.js";

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
        costUnaccounted: r.costUnaccounted,
        failReason: r.failReason,
        failCause: r.failCause,
      };
    },
    extractErrors: async () => ({ hasErrors: false, errors: "" }),
    runWithAgent: () => Promise.reject(new Error("no fix expected")),
    registry: createDefaultAgentBackendRegistry(),
    output: NULL_RUN_OUTPUT,
  };
  return { deps, calls };
}

test("admitStep: validates the contract", async () => {
  // The command template may read artifacts: a stopped admission never renders it.
  let rendered = 0;
  const step = bashStep("a", "", { command: () => `echo ${++rendered}` });
  const run = makeRun([step], 1);

  const admission = await admitStep({
    run,
    step,
    baseCtx: buildPipelineContext({}),
    budget: { cumulative: 1 },
    output: NULL_RUN_OUTPUT,
  });

  expect(admission.kind).toBe("budget-exceeded");
  expect(rendered).toBe(0);
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
  let rendered = 0;
  const step = bashStep("a", "", { command: () => `echo ${++rendered}` });
  const run = makeRun([step], 5);

  const admission = await admitStep({
    run,
    step,
    baseCtx: buildPipelineContext({}),
    // $1 of priced spend under a $5 cap: affordable on the ledger alone, which is
    // exactly why the ceiling cannot be trusted once an attempt went unpriced.
    budget: { cumulative: 1, costUnknown: true },
    output: NULL_RUN_OUTPUT,
  });

  expect(admission.kind).toBe("cost-unaccounted");
  // Same treatment as a budget stop: unfunded, not skipped, so the run resumes
  // where it stopped instead of replaying and repaying settled steps.
  expect(step.status).toBe("pending");
  expect(rendered).toBe(0);
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
    baseCtx: buildPipelineContext({}),
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

  const outcome = await executeRunSteps(run, { resuming: true }, deps, buildPipelineContext({}));

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

  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: run.run_dir });
  const outcome = await executeRunSteps(run, { resuming: false }, deps, ctx);

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

  const outcome = await executeRunSteps(run, { resuming: true }, deps, buildPipelineContext({}));

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

  const outcome = await executeRunSteps(run, { resuming: true }, deps, buildPipelineContext({}));

  expect(outcome.costUnaccounted).toBe(false);
  expect(outcome.failed).toBe(false);
});

test("admitStep: validates the contract", async () => {
  // Use case: build the command from an artifact that only asynchronous reading
  // can provide. Without await here, the command would be "[object Promise]"
  // and the step would run this string unchanged.
  const step = bashStep("a", "", { command: async (ctx) => `echo ${ctx.ticket ?? "sans-ticket"}` });
  const run = makeRun([step]);

  const admission = await admitStep({
    run,
    step,
    baseCtx: buildPipelineContext({ ticket: "PROJ-9" }),
    budget: { cumulative: 0 },
    output: NULL_RUN_OUTPUT,
  });

  expect(admission.kind).toBe("ready");
  expect(admission.kind === "ready" ? admission.command : "").toBe("echo PROJ-9");
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
    baseCtx: buildPipelineContext({}),
    budget: { cumulative: 0 },
    output: NULL_RUN_OUTPUT,
  });

  expect(admission.kind).toBe("skip");
  // Rendering would have thrown on the missing artifact: the skip came first.
  expect(step.status).toBe("skipped");
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
    baseCtx: buildPipelineContext({ ticket: "PROJ-9" }),
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
  const ctx = buildPipelineContext({});

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
    baseCtx: buildPipelineContext({}),
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

  const outcome = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({ ticket: "PROJ-9" }));

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
    baseCtx: buildPipelineContext({}),
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
    baseCtx: buildPipelineContext({}),
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
    baseCtx: buildPipelineContext({}),
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
    baseCtx: buildPipelineContext({}),
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
    baseCtx: buildPipelineContext({}),
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
  deps.runWithAgent = async () => {
    fixCalled = true;
    return { ok: true, stats: { duration_ms: 1 } };
  };

  const outcome = await resolveOutcome({
    run,
    step,
    command: "cmd",
    baseCtx: buildPipelineContext({}),
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

  expect(outcome.kind).toBe("stopped");
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
  deps.runWithAgent = async () => {
    fixCalled = true;
    return { ok: true, stats: { duration_ms: 1 } };
  };

  const outcome = await resolveOutcome({
    run,
    step,
    command: "cmd",
    baseCtx: buildPipelineContext({}),
    budget: { cumulative: 0 },
    abort: createAbortScope(),
    output: NULL_RUN_OUTPUT,
    result: { ok: false, output: "", failReason: "BLOCKED: app unavailable" },
    stepLog: "steps/visual/attempt-001/output.log",
    deps,
  });

  // A result that reaches the loop with a prefix and no cause never came through
  // a backend: every production path normalizes it at `invokeBackend`.
  expect(outcome.kind).toBe("done");
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
    baseCtx: buildPipelineContext({}),
    budget: { cumulative: 0 },
    abort: createAbortScope(),
    output: NULL_RUN_OUTPUT,
    result: { ok: false, output: "", failCause: "blocked" },
    stepLog: "steps/visual/attempt-001/output.log",
    deps,
  });

  expect(outcome.kind).toBe("stopped");
  expect(run.outcome?.stop?.kind).toBe("blocked");
  expect(run.outcome?.stop?.detail).toBe("blocked by an obstacle outside the code");
});

test("run nominal: validates the contract", async () => {
  const steps = [bashStep("a", "echo a"), bashStep("b", "echo b")];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: true }, { ok: true }]);
  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));
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

  const result = await executeRunSteps(run, { resuming: false }, deps, agentContext());

  expect(result.failed).toBe(false);
  expect(step.session).toEqual({ provider: "codex", id: "thread-1", resumable: true });
  expect(step.control?.provider).toBe("codex");
});

test("input skip: validates the contract", async () => {
  const steps = [bashStep("a", "echo a", { inputs: [skipUnlessCommand("false")] }), bashStep("b", "echo b")];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: true }]);
  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));
  expect(out.failed).toBe(false);
  expect(steps[0]!.status).toBe("skipped");
  expect(steps[1]!.status).toBe("done");
  expect(calls.ids).toEqual(["b"]);
});

test("resume: a failed step its when now skips ends skipped and keeps the spend of its pass", async () => {
  // Regression for PROJ-327: `plan` was killed before its verdict in the previous run (plan.md
  // written, costing $5.40) and then, on resume, its idempotency precondition sees
  // its own artifact. The pass never completed, so the step is skipped, not done;
  // its $5.40 stays counted in `control` so budget and totals still see it.
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
  const out = await executeRunSteps(run, { resuming: true }, deps, buildPipelineContext({}));
  expect(out.failed).toBe(false);
  expect(steps[0]!.status).toBe("skipped");
  expect(steps[0]!.control?.total_cost_usd).toBe(5.4);
  expect(calls.ids).toEqual(["b"]);
});

test("resume: a failed step its when now skips is not replayed and leaves its artifact untouched", async () => {
  // The failed pass spent $5.40 and never completed: skipped, its spend kept in `control`.
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

  const out = await executeRunSteps(run, { resuming: true }, deps, buildPipelineContext({}));

  expect(out.failed).toBe(false);
  expect(calls.exec).toBe(0);
  expect(plan.status).toBe("skipped");
  expect(plan.control?.total_cost_usd).toBe(5.4);
  expect(readFileSync(artifact, "utf-8")).toBe(original);
});

test("resume: a failed step its when now skips is persisted skipped without its previous error", async () => {
  const step = bashStep(
    "plan",
    "echo plan",
    { inputs: [skipIf(() => true, "deliverable exists")] },
    {
      status: "failed",
      errors: "agent exited 1",
      fail_kind: "technical",
      control: { duration_ms: 5, total_cost_usd: 0.3 },
    },
  );
  const run = makeRun([step]);
  const { deps } = fakeDeps();

  await executeRunSteps(run, { resuming: true }, deps, buildPipelineContext({}));

  const persisted = readRunSnapshot(join(run.run_dir, "state.json"))!.steps.find((s) => s.id === "plan")!;
  expect(persisted.status).toBe("skipped");
  expect(persisted.errors).toBeUndefined();
  expect(persisted.fail_kind).toBeUndefined();
  expect(persisted.control?.total_cost_usd).toBe(0.3);
});

test("input skip without control: validates the contract", async () => {
  const steps = [bashStep("a", "echo a", { inputs: [skipUnlessCommand("false")] })];
  const run = makeRun(steps);
  const { deps } = fakeDeps([]);
  await executeRunSteps(run, { resuming: true }, deps, buildPipelineContext({}));
  expect(steps[0]!.status).toBe("skipped");
});

test("input stop: validates the contract", async () => {
  const steps = [bashStep("a", "echo a", { inputs: [stopUnlessCommand("false")] }), bashStep("b", "echo b")];
  const run = makeRun(steps);
  const { deps } = fakeDeps();
  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));
  expect(out.stopped).toBe(true);
  expect(out.failed).toBe(false);
  expect(run.stopped_reason).toBeTruthy();
  // A clean stop preserves the work left to do, so the run stays resumable.
  expect(steps[1]!.status).toBe("pending");
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
  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));
  expect(out.failed).toBe(false);
  expect(steps[0]!.status).toBe("skipped");
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
  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));
  expect(out.stopped).toBe(true);
  expect(run.stopped_reason).toBe("escalated: cannot reproduce");
});

test("input TS true: validates the contract", async () => {
  const steps = [bashStep("a", "echo a", { inputs: [skipUnless(() => true)] })];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: true }]);
  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));
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
  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));
  expect(out.failed).toBe(false);
  expect(steps[0]!.status).toBe("skipped");
  expect(calls.ids).toEqual(["b"]);
});

test("step-loop: validates the integration contract", async () => {
  const steps = [bashStep("a", "echo a", { inputs: [failUnlessCommand("false")] }), bashStep("b", "echo b")];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps();
  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));
  expect(out.failed).toBe(true);
  expect(steps[0]!.status).toBe("failed");
  expect(calls.exec).toBe(0);
});

test("step-loop: validates the integration contract", async () => {
  const steps = [bashStep("a", "cmd", { on_failure: { max_retries: 2 } })];
  const run = makeRun(steps);
  // attempt initial KO, first rerun OK.
  const { deps, calls } = fakeDeps([{ ok: false }, { ok: true }]);
  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));
  expect(out.failed).toBe(false);
  expect(steps[0]!.status).toBe("done");
  expect(steps[0]!.retries).toBe(1);
  expect(calls.exec).toBe(2);
});

test("step-loop: validates the integration contract", async () => {
  const steps = [bashStep("a", "cmd", { on_failure: { max_retries: 2 } })];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: false }, { ok: false }, { ok: false }]);
  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));
  expect(out.failed).toBe(true);
  expect(steps[0]!.status).toBe("failed");
  expect(steps[0]!.retries).toBe(2);
  expect(calls.exec).toBe(3); // 1 initial + 2 reruns
});

test("step-loop: validates the integration contract", async () => {
  const steps = [bashStep("a", "cmd"), bashStep("b", "cmd")];
  const run = makeRun(steps, 1);
  // Step a costs 2 -> the budget (1) is exceeded before b.
  const { deps, calls } = fakeDeps([{ ok: true, stats: { duration_ms: 1, total_cost_usd: 2 } }]);
  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));
  expect(out.budgetExceeded).toBe(true);
  expect(steps[0]!.status).toBe("done");
  expect(steps[1]!.status).toBe("pending");
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
  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));
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
  const again = await executeRunSteps(resumed, { resuming: true }, second.deps, buildPipelineContext({}));
  expect(again.budgetExceeded).toBe(true);
  expect(second.calls.exec).toBe(0);
  expect(resumedSteps[1]!.status).toBe("pending");
  // A new generation decides again and journals again — one fact per stop, and
  // this one rests on the flag the previous kill left behind.
  const resumedEvents = readRunEvents(resumed.run_dir).filter((event) => event.type === "run.budget.exceeded");
  expect(resumedEvents).toHaveLength(1);
  expect(resumedEvents[0]).toMatchObject({ stepId: "a", estimated: true });
});

// `blocking: false` absorbs a step's own failure; a cost stop is not one. Absorbed
// as done, the killed step was skipped by every later resume — `--budget` included —
// and its work silently lost while the run could end PASS.
test("step-loop: a non-blocking step killed by the live guard stays failed and replays after --budget", async () => {
  const steps = [bashStep("a", "cmd", { blocking: false }), bashStep("b", "cmd")];
  const run = makeRun(steps, 1);
  const { deps, calls } = fakeDeps([
    {
      ok: false,
      budgetExceeded: true,
      failReason: "process killed: budget exceeded ($1.10 estimated > $1.00 remaining)",
      stats: { duration_ms: 1, total_cost_usd: 0.3, cost_estimated: true },
    },
  ]);

  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));

  expect(out.budgetExceeded).toBe(true);
  expect(calls.ids).toEqual(["a"]);
  expect(steps[0]!.status).toBe("failed");
  expect(steps[0]!.errors).toContain("budget exceeded");
  expect(steps[1]!.status).toBe("pending");
  finalizeRun(run, out);
  const snapshot = readRunSnapshot(join(run.run_dir, "state.json"));
  expect(snapshot?.status).not.toBe("PASS");
  expect(snapshot?.outcome?.stopKind).toBe("budget-exceeded");
  expect(isPersistedRunResumable(snapshot)).toBe(true);
  expect(snapshot?.steps.find((state) => state.id === "a")?.status).toBe("failed");

  // `--budget 5`: the ceiling is raised and the guard latch wiped (execution/step/load-or-create-run.ts).
  const resumedSteps = [
    bashStep("a", "cmd", { blocking: false }, { status: "failed", control: { duration_ms: 1, total_cost_usd: 0.3 } }),
    bashStep("b", "cmd"),
  ];
  const resumed = makeRun(resumedSteps, 5);
  const second = fakeDeps([{ ok: true }, { ok: true }]);
  const again = await executeRunSteps(resumed, { resuming: true }, second.deps, buildPipelineContext({}));

  expect(again.failed).toBe(false);
  expect(again.budgetExceeded).toBe(false);
  expect(second.calls.ids).toEqual(["a", "b"]);
  expect(resumedSteps[0]!.status).toBe("done");
});

test("step-loop: a non-blocking step killed for unpriceable usage stays failed and replays once authorized", async () => {
  const steps = [bashStep("a", "cmd", { blocking: false }), bashStep("b", "cmd")];
  const run = makeRun(steps, 5);
  const { deps, calls } = fakeDeps([
    {
      ok: false,
      costUnaccounted: true,
      failReason: "process killed: cost unaccounted (no rate for model)",
      stats: { duration_ms: 1, cost_unknown: true },
    },
  ]);

  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));

  expect(out.costUnaccountedStop).toBe(true);
  expect(calls.ids).toEqual(["a"]);
  expect(steps[0]!.status).toBe("failed");
  expect(steps[1]!.status).toBe("pending");
  finalizeRun(run, out);
  const snapshot = readRunSnapshot(join(run.run_dir, "state.json"));
  expect(snapshot?.outcome?.stopKind).toBe("cost-unaccounted");
  expect(isPersistedRunResumable(snapshot)).toBe(true);

  // `--allow-unmetered`: the authorization is persisted on the run.
  const resumedSteps = [
    bashStep("a", "cmd", { blocking: false }, { status: "failed", control: { duration_ms: 1, cost_unknown: true } }),
    bashStep("b", "cmd"),
  ];
  const resumed: Run = { ...makeRun(resumedSteps, 5), cost_unaccounted: true, allow_unmetered: true };
  const second = fakeDeps([{ ok: true }, { ok: true }]);
  const again = await executeRunSteps(resumed, { resuming: true }, second.deps, buildPipelineContext({}));

  expect(again.failed).toBe(false);
  expect(second.calls.ids).toEqual(["a", "b"]);
  expect(resumedSteps[0]!.status).toBe("done");
});

test("resume: validates the contract", async () => {
  const steps = [
    bashStep("normal", "cmd", {}, { status: "done" }),
    bashStep("branch", "cmd", { rerun_on_resume: true }, { status: "done" }),
    bashStep("next", "cmd"),
  ];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: true }, { ok: true }]);
  const out = await executeRunSteps(run, { resuming: true }, deps, buildPipelineContext({}));
  expect(out.failed).toBe(false);
  expect(calls.ids).toEqual(["branch", "next"]);
});

test("step-loop: validates the integration contract", async () => {
  const steps = [bashStep("a", "cmd", { on_failure: { fix_prompt: "x", max_retries: 1 } })];
  const run = makeRun(steps);
  let fixCalled = false;
  const { deps } = fakeDeps([{ ok: false }]);
  deps.runWithAgent = async () => {
    fixCalled = true;
    return { ok: true, stats: { duration_ms: 1 } };
  };
  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));
  expect(fixCalled).toBe(true);
  expect(out.failed).toBe(false);
});

test("preflight KO: validates the contract", async () => {
  const steps = [bashStep("visual", "cmd", { preflight: "exit 7" }), bashStep("next", "cmd")];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: true }, { ok: true }]);
  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));
  expect(out.failed).toBe(true);
  expect(steps[0]!.status).toBe("failed");
  expect(steps[0]!.errors).toContain("preflight");
  expect(calls.ids).toEqual([]);
});

test("preflight KO on step non blocking: validates the contract", async () => {
  const steps = [bashStep("visual", "cmd", { preflight: "exit 7", blocking: false }), bashStep("next", "cmd")];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: true }]);
  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));
  expect(out.failed).toBe(false);
  expect(steps[0]!.status).toBe("done");
  expect(calls.ids).toEqual(["next"]);
});

test("preflight OK: validates the contract", async () => {
  const steps = [bashStep("visual", "cmd", { preflight: "true" })];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: true }]);
  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));
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
  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));
  expect(out.failed).toBe(false);
  expect(steps[0]!.status).toBe("skipped");
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
  deps.runWithAgent = async () => {
    fixCalled = true;
    return { ok: true, stats: { duration_ms: 1 } };
  };

  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));

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
  deps.runWithAgent = async () => {
    fixCalled = true;
    return { ok: true, stats: { duration_ms: 1 } };
  };

  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));

  expect(fixCalled).toBe(false);
  expect(out.stopped).toBe(false);
  expect(steps[0]!.status).toBe("done");
  expect(calls.ids).toEqual(["visual", "next"]);
});

test("step-loop: validates the integration contract", async () => {
  const steps = [bashStep("visual", "cmd", { on_failure: { fix_prompt: "x", max_retries: 1 } })];
  const run = makeRun(steps);
  let fixCalled = false;
  const { deps } = fakeDeps([{ ok: false, failReason: "UI-002: expected label is missing" }]);
  deps.runWithAgent = async () => {
    fixCalled = true;
    return { ok: true, stats: { duration_ms: 1 } };
  };

  await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));

  expect(fixCalled).toBe(true);
});

test("step-loop: validates the integration contract", async () => {
  const steps = [bashStep("static-analysis", "cmd", { error_extractor: "sample-extractor" })];
  const run = makeRun(steps);
  const { deps } = fakeDeps([{ ok: false, output: "fatal tool crash" }]);
  deps.extractErrors = async () => ({ hasErrors: false, errors: "" });

  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));

  expect(out.failed).toBe(true);
  expect(steps[0]!.status).toBe("failed");
});

test("check non blocking: validates the contract", async () => {
  const steps = [bashStep("warn", "cmd", { blocking: false }), bashStep("next", "cmd")];
  const run = makeRun(steps);
  const { deps, calls } = fakeDeps([{ ok: false, failReason: "lint facultatif" }, { ok: true }]);

  const out = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));

  expect(out.failed).toBe(false);
  expect(calls.ids).toEqual(["warn", "next"]);
  expect(steps[0]).toMatchObject({ status: "done", errors: "lint facultatif" });
  expect(steps[0]!.def.blocking).toBe(false);
  expect(steps[1]!.status).toBe("done");
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

  await executeRunSteps(run, { resuming: false }, deps, agentContext());

  expect(seen).toEqual([undefined]);
});

/** Agent steps resolve their backend on the context: the registry is explicit,
 * nothing falls back to the built-in composition. */
const agentContext = () => buildPipelineContext({ ...builtinRegistries(), cwd: "." });

const ticketArtifact = textArtifact("ticket.md");
const specArtifact = textArtifact("spec.md");

/** Map-keyed artifact store over a scratch work item: the freshness lock lives on
 *  disk under its `artifacts/`, the artifacts in memory. */
function artifactContext(
  initial: Record<string, string> = {},
  extra: Partial<Parameters<typeof buildPipelineContext>[0]> = {},
): {
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
    ctx: buildPipelineContext({
      ...builtinRegistries(),
      cwd: mkdtempSync(join(tmpdir(), "steploop-item-")),
      ticket: "PROJ-1",
      artifacts: store,
      ...extra,
    }),
  };
}

/** The attempt erases declared outputs before spawn: the fake writes them back. */
function writing(
  deps: StepLoopDeps,
  values: Map<string, string>,
  written: Record<string, [string, string][]>,
): StepLoopDeps {
  const execute = deps.executeStep;
  return {
    ...deps,
    executeStep: async (step, command, budget, context) => {
      for (const [name, content] of written[step.id] ?? []) values.set(name, content);
      return execute(step, command, budget, context);
    },
  };
}

const lockOf = (ctx: PipelineContext) => readLock(ctx.paths.workItemDir!);

/** Stamp `def` as a pass settled `done` now would. */
async function stampAsIs(ctx: PipelineContext, def: PipelineStep): Promise<void> {
  const inputs = (await readInputs(ctx, def.sources ?? [])).fingerprints;
  const outputs = (await readInputs(ctx, def.outputs ?? [])).fingerprints as Record<string, string>;
  commitPass(ctx, def.id, { pipeline: "p", runId: "r", stampedAt: "2026-01-01T00:00:00.000Z", inputs, outputs }, []);
}

const derivedStep = (state: StepStateInput = {}, def: Partial<PipelineStep> = {}): RunStep =>
  bashStep("spec", "cmd", { sources: [ticketArtifact], outputs: [specArtifact], ...def }, state);

/** A first invocation that produces `spec.md` from the ticket and stamps it. */
async function producedOnce(ctx: PipelineContext, values: Map<string, string>, step: RunStep): Promise<Run> {
  const run = makeRun([step]);
  const { deps } = fakeDeps();
  await executeRunSteps(run, { resuming: false }, writing(deps, values, { spec: [["spec.md", "written"]] }), ctx);
  expect(lockOf(ctx).steps.spec).toBeDefined();
  return run;
}

test("lock: a pass settled done writes one stamp, artifact inputs as admitted, sources and outputs after the done (L6, L15)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steploop-tree-"));
  const tree = join(dir, "tree.txt");
  writeFileSync(tree, "before");
  const { values, ctx } = artifactContext({ "ticket.md": "one" });
  const step = derivedStep(
    {},
    { sources: [ticketArtifact, source("tree", { command: `cat ${JSON.stringify(tree)}` })] },
  );
  const run = makeRun([step]);
  const { deps } = fakeDeps();
  deps.executeStep = async () => {
    // An implementation edits the tree it reads; a concurrent edit of an artifact
    // input is not what the step was given.
    writeFileSync(tree, "after");
    values.set("ticket.md", "two");
    values.set("spec.md", "written");
    return { output: "", ok: true, stats: { duration_ms: 1 } };
  };

  await executeRunSteps(run, { resuming: false }, deps, ctx);

  expect(step.status).toBe("done");
  expect(lockOf(ctx).steps.spec).toMatchObject({
    pipeline: "p",
    runId: basename(run.run_dir),
    inputs: { "artifacts/ticket.md": sha256Text("one"), "source:tree": sha256Text("after") },
    outputs: { "artifacts/spec.md": sha256Text("written") },
  });
  expect(lockOf(ctx).steps.spec).not.toHaveProperty("absorbed");
});

test("lock: a stamped step's key is absent from lock.json at the first spawn of its pass (L3)", async () => {
  const { values, ctx } = artifactContext({ "ticket.md": "one" });
  const step = derivedStep();
  await producedOnce(ctx, values, step);
  values.set("ticket.md", "two");
  const seen: boolean[] = [];
  const { deps } = fakeDeps();
  const resumed = writing(deps, values, { spec: [["spec.md", "rewritten"]] });
  const execute = resumed.executeStep;
  resumed.executeStep = async (...args) => {
    seen.push("spec" in lockOf(ctx).steps);
    return execute(...args);
  };

  await executeRunSteps(makeRun([derivedStep({ status: "done" })]), { resuming: true }, resumed, ctx);

  expect(seen).toEqual([false]);
  expect(lockOf(ctx).steps.spec?.inputs["artifacts/ticket.md"]).toBe(sha256Text("two"));
});

test("lock: a stamp that cannot be cleared fails the step before any spawn (L3)", async () => {
  const { ctx } = artifactContext({ "ticket.md": "one" });
  mkdirSync(join(ctx.paths.workItemDir!, "artifacts", "lock.json.lock"), { recursive: true });
  const step = derivedStep();
  const { deps, calls } = fakeDeps();

  const outcome = await executeRunSteps(makeRun([step]), { resuming: false }, deps, ctx);

  expect(calls.exec).toBe(0);
  expect(outcome.failed).toBe(true);
  expect(step.status).toBe("failed");
  expect(step.errors).toContain("freshness lock");
});

test("lock: blocking: false does not absorb a stamp that cannot be cleared (L3)", async () => {
  const { ctx } = artifactContext({ "ticket.md": "one" });
  mkdirSync(join(ctx.paths.workItemDir!, "artifacts", "lock.json.lock"), { recursive: true });
  const step = derivedStep({}, { blocking: false });
  const { deps, calls } = fakeDeps();

  const outcome = await executeRunSteps(makeRun([step]), { resuming: false }, deps, ctx);

  expect(calls.exec).toBe(0);
  expect(outcome.failed).toBe(true);
  expect(step.status).toBe("failed");
});

test("lock: a failed pass clears the stamp; a fresh skip, a when refusal, a stop and an admission refusal leave it (L4)", async () => {
  const { values, ctx } = artifactContext({ "ticket.md": "one" });
  await producedOnce(ctx, values, derivedStep());
  const stamp = JSON.stringify(lockOf(ctx).steps.spec);
  const resume = async (step: RunStep, results: Array<Partial<StepResult>> = []) => {
    const { deps, calls } = fakeDeps(results);
    await executeRunSteps(makeRun([step]), { resuming: true }, deps, ctx);
    return calls.exec;
  };

  expect(await resume(derivedStep({ status: "done" }))).toBe(0);
  expect(JSON.stringify(lockOf(ctx).steps.spec)).toBe(stamp);

  values.set("ticket.md", "two");
  expect(await resume(derivedStep({ status: "done" }, { inputs: [skipIf(() => true, "not now")] }))).toBe(0);
  expect(await resume(derivedStep({ status: "done" }, { inputs: [stopIf(() => true, "wait")] }))).toBe(0);
  expect(await resume(derivedStep({ status: "done" }, { preflight: "false" }))).toBe(0);
  expect(await resume(derivedStep({ status: "done" }, { preflight: "false", blocking: false }))).toBe(0);
  expect(JSON.stringify(lockOf(ctx).steps.spec)).toBe(stamp);

  expect(await resume(derivedStep({ status: "done" }), [{ ok: false, failReason: "broken" }])).toBe(1);
  expect(lockOf(ctx).steps.spec).toBeUndefined();
});

test("lock: an interrupted pass leaves no stamp, and the next invocation runs the step (L4)", async () => {
  const { values, ctx } = artifactContext({ "ticket.md": "one" });
  await producedOnce(ctx, values, derivedStep());
  values.set("ticket.md", "two");
  const abort = createAbortScope();
  const step = derivedStep({ status: "done" });
  const { deps } = fakeDeps();
  deps.executeStep = async () => {
    values.set("spec.md", "half");
    abort.requestAbort("SIGINT");
    return { output: "", ok: true, stats: { duration_ms: 1 } };
  };

  await executeRunSteps(makeRun([step]), { resuming: true, abort }, deps, ctx);

  expect(lockOf(ctx).steps.spec).toBeUndefined();
});

test("lock: an absorbed failure is stamped absorbed, outputs {}, if and only if the step declares no output (L5)", async () => {
  const { ctx } = artifactContext({ "ticket.md": "one" });
  const withOutput = bashStep("with-output", "cmd", {
    sources: [ticketArtifact],
    outputs: [specArtifact],
    blocking: false,
  });
  const withoutOutput = bashStep("without-output", "cmd", { sources: [ticketArtifact], blocking: false });
  const run = makeRun([withOutput, withoutOutput]);
  const { deps } = fakeDeps([
    { ok: false, failReason: "audit failed" },
    { ok: false, failReason: "audit failed" },
  ]);

  await executeRunSteps(run, { resuming: false }, deps, ctx);

  expect([withOutput.status, withoutOutput.status]).toEqual(["done", "done"]);
  expect(withOutput.errors).toBe("audit failed");
  expect(lockOf(ctx).steps["with-output"]).toBeUndefined();
  expect(lockOf(ctx).steps["without-output"]).toMatchObject({
    inputs: { "artifacts/ticket.md": sha256Text("one") },
    outputs: {},
    absorbed: true,
  });
});

test("lock: a step with input and no output is stamped outputs {}, skipped while fresh, run once its input changed (L9)", async () => {
  const { values, ctx } = artifactContext({ "ticket.md": "one" });
  const check = () => bashStep("check", "cmd", { sources: [ticketArtifact] }, { status: "done" });
  const first = fakeDeps();
  await executeRunSteps(
    makeRun([bashStep("check", "cmd", { sources: [ticketArtifact] })]),
    { resuming: false },
    first.deps,
    ctx,
  );
  expect(lockOf(ctx).steps.check).toMatchObject({ outputs: {} });

  const fresh = fakeDeps();
  await executeRunSteps(makeRun([check()]), { resuming: true }, fresh.deps, ctx);
  expect(fresh.calls.exec).toBe(0);

  values.set("ticket.md", "two");
  const stale = fakeDeps();
  await executeRunSteps(makeRun([check()]), { resuming: true }, stale.deps, ctx);
  expect(stale.calls.ids).toEqual(["check"]);
});

test("lock: a fresh stamped step costs no attempt and stays done (L8)", async () => {
  const { values, ctx } = artifactContext({ "ticket.md": "one" });
  await producedOnce(ctx, values, derivedStep());
  const step = derivedStep({ status: "done", control: { duration_ms: 1, total_cost_usd: 0.4 } });
  const run = makeRun([step]);

  const { deps, calls } = fakeDeps();
  await executeRunSteps(run, { resuming: true }, deps, ctx);

  expect(calls.exec).toBe(0);
  expect(step.status).toBe("done");
  expect(step.attempts ?? []).toEqual([]);
  expect(runSpend(run).usd).toBe(0.4);
  expect(readRunEvents(run.run_dir).find((event) => event.type === "step.skipped")).toMatchObject({
    stepId: "spec",
    reason: "up to date",
  });
});

test("lock: a stamp's output hash is the artifactSha256 an approval records on the same bytes (L13)", async () => {
  const { values, ctx } = artifactContext({ "ticket.md": "one" });
  await producedOnce(ctx, values, derivedStep());

  await recordApproval(ctx, "spec", specArtifact);

  expect(readDecision(ctx, "spec")?.artifactSha256).toBe(lockOf(ctx).steps.spec?.outputs["artifacts/spec.md"]);
});

test("lock: a run carrying a lot stamps its steps under <lot.id>/<stepId>", async () => {
  const lot = { id: "LOT-1", title: "Lot", risk: 1 } as PipelineLot;
  const { values, ctx } = artifactContext({ "ticket.md": "one" }, { lot });
  const run = makeRun([derivedStep()]);
  const { deps } = fakeDeps();

  await executeRunSteps(run, { resuming: false }, writing(deps, values, { spec: [["spec.md", "written"]] }), ctx);

  expect(Object.keys(lockOf(ctx).steps)).toEqual(["LOT-1/spec"]);
});

test("onStale stop: a stale step with a stamp stops the run for a decision without spawning, its stamp kept (L10)", async () => {
  const { values, ctx } = artifactContext({ "ticket.md": "one" });
  await producedOnce(ctx, values, derivedStep());
  const stamp = JSON.stringify(lockOf(ctx).steps.spec);
  values.set("ticket.md", "two");
  const run = makeRun([derivedStep({ status: "done" }, { on_stale: "stop" }), bashStep("next", "cmd", {})]);
  const { deps, calls } = fakeDeps();

  const outcome = await executeRunSteps(run, { resuming: true }, deps, ctx);

  expect(calls.exec).toBe(0);
  expect(outcome.stopped).toBe(true);
  const detail = "inputs of spec changed since it succeeded: --start-at spec to run it again";
  expect(run.outcome?.stop).toEqual({ kind: "needs-decision", detail });
  expect(run.steps[0]!.status).toBe("done");
  expect(run.steps[1]!.status).toBe("pending");
  expect(JSON.stringify(lockOf(ctx).steps.spec)).toBe(stamp);
});

test("onStale stop: a step without a stamp runs, a fresh one is skipped, and a fork's start step runs (L10)", async () => {
  const { values, ctx } = artifactContext({ "ticket.md": "one" });
  const first = fakeDeps();
  await executeRunSteps(
    makeRun([derivedStep({}, { on_stale: "stop" })]),
    { resuming: false },
    writing(first.deps, values, { spec: [["spec.md", "written"]] }),
    ctx,
  );
  expect(first.calls.ids).toEqual(["spec"]);

  const fresh = fakeDeps();
  await executeRunSteps(
    makeRun([derivedStep({ status: "done" }, { on_stale: "stop" })]),
    { resuming: true },
    fresh.deps,
    ctx,
  );
  expect(fresh.calls.exec).toBe(0);

  values.set("ticket.md", "two");
  const fork = makeRun([derivedStep({}, { on_stale: "stop" })]);
  fork.startAt = "spec";
  const forced = fakeDeps();
  await executeRunSteps(fork, { resuming: true }, writing(forced.deps, values, { spec: [["spec.md", "again"]] }), ctx);
  expect(forced.calls.ids).toEqual(["spec"]);
  expect(lockOf(ctx).steps.spec?.inputs["artifacts/ticket.md"]).toBe(sha256Text("two"));
});

/** `ui` reads the tree but not what `recheck` does to it; `recheck` edits the tree. */
function ignoringPipeline(treeFile: string, recheck: Partial<PipelineStep> = {}) {
  const tree = source("tree", { command: `cat ${JSON.stringify(treeFile)}` });
  return {
    ui: (state: StepStateInput = {}) => bashStep("ui", "cmd", { sources: [tree.ignoring("recheck")] }, state),
    recheck: (state: StepStateInput = {}) => bashStep("recheck", "cmd", { sources: [tree], ...recheck }, state),
  };
}

function editingTree(deps: StepLoopDeps, treeFile: string, edits: Record<string, string>): StepLoopDeps {
  const execute = deps.executeStep;
  return {
    ...deps,
    executeStep: async (step, command, budget, context) => {
      if (edits[step.id] !== undefined) writeFileSync(treeFile, edits[step.id]!);
      return execute(step, command, budget, context);
    },
  };
}

test("ignoring: the consumer's tree moves with the ignored step, in one commitPass, and it is fresh next time (L11)", async () => {
  const treeFile = join(mkdtempSync(join(tmpdir(), "steploop-tree-")), "tree.txt");
  writeFileSync(treeFile, "a");
  const { ctx } = artifactContext({ "ticket.md": "one" });
  const steps = ignoringPipeline(treeFile);
  const commits = spyOn(stepLock, "commitPass");
  const first = fakeDeps();

  await executeRunSteps(
    makeRun([steps.ui(), steps.recheck()]),
    { resuming: false },
    editingTree(first.deps, treeFile, { recheck: "b" }),
    ctx,
  );

  expect(first.calls.ids).toEqual(["ui", "recheck"]);
  const recheckCommits = commits.mock.calls.filter(([, key]) => key === "recheck");
  commits.mockRestore();
  expect(recheckCommits).toHaveLength(1);
  expect(recheckCommits[0]![2]).toBeDefined();
  expect(recheckCommits[0]![3]).toEqual([
    { key: "ui", source: "source:tree", before: sha256Text("a"), after: sha256Text("b") },
  ]);
  expect(lockOf(ctx).steps.ui?.inputs).toEqual({ "source:tree": sha256Text("b") });
  expect(lockOf(ctx).steps.recheck?.inputs).toEqual({ "source:tree": sha256Text("b") });

  const again = fakeDeps();
  await executeRunSteps(
    makeRun([steps.ui({ status: "done" }), steps.recheck({ status: "done" })]),
    { resuming: true },
    again.deps,
    ctx,
  );
  expect(again.calls.exec).toBe(0);
});

test("ignoring: a tree moved by something else before the ignored step leaves the consumer's stamp alone (L11)", async () => {
  const treeFile = join(mkdtempSync(join(tmpdir(), "steploop-tree-")), "tree.txt");
  writeFileSync(treeFile, "a");
  const { ctx } = artifactContext({ "ticket.md": "one" });
  const steps = ignoringPipeline(treeFile);
  await executeRunSteps(makeRun([steps.ui(), steps.recheck()]), { resuming: false }, fakeDeps().deps, ctx);
  const recorded = JSON.stringify(lockOf(ctx).steps.ui);

  writeFileSync(treeFile, "hand edit");
  const resumed = fakeDeps();
  await executeRunSteps(
    makeRun([steps.ui({ status: "done" }), steps.recheck({ status: "done" })]),
    { resuming: true, stepFilter: ["recheck"] },
    editingTree(resumed.deps, treeFile, { recheck: "c" }),
    ctx,
  );

  expect(resumed.calls.ids).toEqual(["recheck"]);
  expect(JSON.stringify(lockOf(ctx).steps.ui)).toBe(recorded);
  const next = fakeDeps();
  await executeRunSteps(makeRun([steps.ui({ status: "done" })]), { resuming: true }, next.deps, ctx);
  expect(next.calls.ids).toEqual(["ui"]);
});

test("ignoring: an unstamped ignored step still reads the tree at admission and moves the consumer's (L11)", async () => {
  const treeFile = join(mkdtempSync(join(tmpdir(), "steploop-tree-")), "tree.txt");
  writeFileSync(treeFile, "a");
  const { ctx } = artifactContext({ "ticket.md": "one" });
  const steps = ignoringPipeline(treeFile, { sources: undefined, rerun_on_resume: true });
  await executeRunSteps(makeRun([steps.ui()]), { resuming: false }, fakeDeps().deps, ctx);
  const stampBefore = lockOf(ctx).steps.ui!;

  await executeRunSteps(
    makeRun([steps.ui({ status: "done" }), steps.recheck()]),
    { resuming: true },
    editingTree(fakeDeps().deps, treeFile, { recheck: "b" }),
    ctx,
  );

  expect(lockOf(ctx).steps.recheck).toBeUndefined();
  expect(lockOf(ctx).steps.ui).toEqual({ ...stampBefore, inputs: { "source:tree": sha256Text("b") } });
});

test("ignoring: a lot moves the consumer's stamp under its lot key (L11)", async () => {
  const treeFile = join(mkdtempSync(join(tmpdir(), "steploop-tree-")), "tree.txt");
  writeFileSync(treeFile, "a");
  const lot = { id: "LOT-1", title: "Lot", risk: 1 } as PipelineLot;
  const { ctx } = artifactContext({ "ticket.md": "one" }, { lot });
  const steps = ignoringPipeline(treeFile);

  await executeRunSteps(
    makeRun([steps.ui(), steps.recheck()]),
    { resuming: false },
    editingTree(fakeDeps().deps, treeFile, { recheck: "b" }),
    ctx,
  );

  expect(lockOf(ctx).steps["LOT-1/ui"]?.inputs).toEqual({ "source:tree": sha256Text("b") });
});

test("fork: the start step runs even when its stamp holds, and only once (F5, F7)", async () => {
  const { values, ctx } = artifactContext({ "ticket.md": "one" });
  await producedOnce(ctx, values, derivedStep());
  const run = makeRun([derivedStep()]);
  run.startAt = "spec";

  const first = fakeDeps();
  await executeRunSteps(run, { resuming: true }, writing(first.deps, values, { spec: [["spec.md", "again"]] }), ctx);
  expect(first.calls.ids).toEqual(["spec"]);

  const second = fakeDeps();
  await executeRunSteps(run, { resuming: true }, writing(second.deps, values, { spec: [["spec.md", "again"]] }), ctx);
  expect(second.calls.ids).toEqual([]);
});

test("fork: the steps after the start step are admitted by the lock, not forced (§9.6)", async () => {
  const { values, ctx } = artifactContext({ "ticket.md": "one" });
  await producedOnce(ctx, values, derivedStep());
  const run = makeRun([replayable("implement"), derivedStep()]);
  run.startAt = "implement";

  const { deps, calls } = fakeDeps();
  await executeRunSteps(run, { resuming: true }, writing(deps, values, { spec: [["spec.md", "again"]] }), ctx);

  expect(calls.ids).toEqual(["implement"]);
  expect(run.steps[1]!.status).toBe("skipped");
});

test("resume: a step skipped by its own admission is re-admitted", async () => {
  const { ctx } = artifactContext({ "ticket.md": "one" });
  const run = makeRun([derivedStep({ status: "skipped" })]);

  const { deps, calls } = fakeDeps();
  await executeRunSteps(run, { resuming: true }, deps, ctx);

  // No stamp, so the re-admitted step runs.
  expect(calls.ids).toEqual(["spec"]);
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
      runWithAgent: async () => {
        fixCalls++;
        return { ok: true, stats: { duration_ms: 1 } };
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
  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: dir });
  const { deps, fixCalls } = realSpawnDeps();

  const outcome = await executeRunSteps(run, { resuming: false }, deps, ctx);

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
  // The closed attempt and its uncertain spend survive in the snapshot: the next
  // invocation numbers its attempt and seeds the ledger from them.
  expect(snapshot?.steps[0]).toMatchObject({
    status: "failed",
    attempts: [{ attempt: 1, status: "failed", control: { cost_unknown: true } }],
  });
  expect(snapshot?.steps[0]?.control).toMatchObject({ cost_unknown: true });

  // 4. The verdict names the timeout and keeps the run resumable.
  finalizeRun(run, outcome);
  const finalized = readRunSnapshot(join(run.run_dir, "state.json"));
  expect(finalized?.status).toBe("FAIL");
  expect(String(finalized?.outcome?.reason)).toContain("timeout");
  expect(finalized?.outcome?.resumable).toBe(true);
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

  const outcome = await executeRunSteps(run, { resuming: true }, deps, buildPipelineContext({}));

  expect(outcome.failed).toBe(false);
  // The paid step is neither replayed nor repaid; the interrupted one restarts.
  expect(calls.ids).toEqual(["interrupted", "never-started"]);
  expect(steps[0]!.status).toBe("done");
  expect(steps[0]!.attempts).toHaveLength(0);
  // The replay opens a second attempt rather than reopening the aborted one.
  expect(steps[1]!.attempts?.map((attempt) => attempt.status)).toEqual(["aborted", "done"]);
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

  const outcome = await executeRunSteps(run, { resuming: true }, deps, buildPipelineContext({}));

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

  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: run.run_dir });
  const outcome = await executeRunSteps(run, { resuming: false }, deps, ctx);

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

  const outcome = await executeRunSteps(run, { resuming: false }, deps, buildPipelineContext({}));

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
    executeRunSteps(runA, { resuming: false, abort: scopeA }, depsA, buildPipelineContext({})),
    executeRunSteps(runB, { resuming: false, abort: scopeB }, depsB, buildPipelineContext({})),
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

// --- Reject and rework -------------------------------------------------------

const reviewedPlan = textArtifact("plan.md");

/** Writer of the reviewed plan, then its humanReview gate declaring the rework. */
function reworkRun(writerState: StepStateInput): Run {
  const built = pipeline("p")
    .add(
      dslBashStep({
        id: "write",
        name: "Write",
        command: async (c) => `rework: ${(await pendingRejection(c, "plan"))?.reason}`,
      }).output(reviewedPlan),
      humanReview<string>({
        id: "plan",
        artifact: reviewedPlan,
        kind: "needs-decision",
        blocked: () => false,
        approval: { subject: "plan" },
        rework: { step: "write" },
        reason: () => "plan to review",
      }),
    )
    .build();
  return makeRun(built.steps.map((def) => makeRunStep(def, def.id === "write" ? writerState : {})));
}

function reworkContext(initial: Record<string, string>) {
  return artifactContext(initial);
}

test("resume: a rejected artifact replays its rework step with the reason, then the gate asks again", async () => {
  const { values, ctx } = reworkContext({ "plan.md": "v1" });
  await recordRejection(ctx, "plan", reviewedPlan, "split step 2", 3);
  const run = reworkRun({ status: "done", control: { duration_ms: 1 } });

  const { deps, calls } = fakeDeps();
  const commands: string[] = [];
  deps.executeStep = async (step, command) => {
    calls.ids.push(step.id);
    commands.push(command);
    values.set("plan.md", "v2");
    return { output: "", ok: true, stats: { duration_ms: 1 } };
  };
  const outcome = await executeRunSteps(run, { resuming: true }, deps, ctx);

  expect(calls.ids).toEqual(["write"]);
  expect(commands).toEqual(["rework: split step 2"]);
  expect(outcome.stopped).toBe(true);
  expect(run.steps.find((step) => step.id === "plan-gate")?.status).not.toBe("done");
});

test("resume: a rework interrupted after its outputs were erased replays, and the gate never passes in between", async () => {
  const { values, ctx } = reworkContext({ "plan.md": "v1" });
  await recordRejection(ctx, "plan", reviewedPlan, "split step 2", 3);
  const run = reworkRun({ status: "done", control: { duration_ms: 1 } });

  const failing = fakeDeps([{ ok: false }]);
  await executeRunSteps(run, { resuming: true }, failing.deps, ctx);
  expect(values.has("plan.md")).toBe(false);
  expect(run.steps.find((step) => step.id === "plan-gate")?.status).not.toBe("done");

  // Even recorded as done, a rework whose artifact is absent must replay rather
  // than let the gate read the erased artifact as an answer.
  const write = run.steps.find((step) => step.id === "write")!;
  write.status = "done";
  const { deps, calls } = fakeDeps();
  const outcome = await executeRunSteps(run, { resuming: true }, deps, ctx);
  expect(calls.ids).toEqual(["write"]);
  expect(outcome.stopped || outcome.failed).toBe(true);
  expect(run.steps.find((step) => step.id === "plan-gate")?.status).not.toBe("done");
});

// --- Reconcile mode ------------------------------------------------------------
//
// The status a previous invocation recorded no longer stands for the work: every
// settled step is re-admitted, and its stamp decides.

const branchArtifact = textArtifact("branch.json");

/** A step that produces `branch.json` from nothing it declares. */
const branchStep = (state: StepStateInput = {}, def: Partial<PipelineStep> = {}): RunStep =>
  bashStep("branch", "cmd", { outputs: [branchArtifact], ...def }, state);

test("reconcile: a done step whose stamp holds is not paid twice, and its spend still counts", async () => {
  const { ctx, values } = artifactContext();
  const first = fakeDeps();
  await executeRunSteps(
    makeRun([branchStep()]),
    { resuming: false },
    writing(first.deps, values, { branch: [["branch.json", "{}"]] }),
    ctx,
  );
  const step = branchStep({ status: "done", control: { duration_ms: 1, total_cost_usd: 0.4 } });
  const later = bashStep("later", "cmd", { rerun_on_resume: true });
  const run = makeRun([step, later]);

  const { deps, calls } = fakeDeps();
  await executeRunSteps(run, { resuming: true }, deps, ctx);

  expect(calls.ids).toEqual(["later"]);
  expect(step.status).toBe("done");
  expect(runSpend(run).usd).toBe(0.4);
});

test("reconcile: a deliverable present without a stamp is produced again", async () => {
  const { ctx, values } = artifactContext({ "branch.json": "{}" });
  const step = branchStep();

  const { deps, calls } = fakeDeps();
  await executeRunSteps(
    makeRun([step]),
    { resuming: false },
    writing(deps, values, { branch: [["branch.json", "{}"]] }),
    ctx,
  );

  expect(calls.ids).toEqual(["branch"]);
  expect(step.status).toBe("done");
});

test("reconcile: a done step whose deliverable was deleted runs again", async () => {
  const { ctx, values } = artifactContext();
  const first = fakeDeps();
  await executeRunSteps(
    makeRun([branchStep()]),
    { resuming: false },
    writing(first.deps, values, { branch: [["branch.json", "{}"]] }),
    ctx,
  );
  values.delete("branch.json");
  const step = branchStep({ status: "done", control: { duration_ms: 1 } });

  const { deps, calls } = fakeDeps();
  await executeRunSteps(
    makeRun([step]),
    { resuming: true },
    writing(deps, values, { branch: [["branch.json", "{}"]] }),
    ctx,
  );

  expect(calls.ids).toEqual(["branch"]);
  expect(step.status).toBe("done");
});

test("reconcile: an absorbed failure with outputs has no stamp, so it runs again", async () => {
  const { ctx } = artifactContext();
  const check = branchStep({}, { blocking: false });
  const gate = bashStep("gate", "test -f ok", { rerun_on_resume: true });
  const run = makeRun([check, gate]);
  const first = fakeDeps([{ ok: false, failReason: "audit failed" }, { ok: false }]);
  await executeRunSteps(run, { resuming: false }, first.deps, ctx);
  expect(check.status).toBe("done");
  expect(check.errors).toBe("audit failed");

  const { deps, calls } = fakeDeps([{ ok: false, failReason: "audit failed" }]);
  await executeRunSteps(run, { resuming: true }, deps, ctx);

  expect(calls.ids).toEqual(["branch", "gate"]);
});

test("reconcile: a materialized orchestration node keeps the authority of its status", async () => {
  const { ctx } = artifactContext();
  const node = makeRunStep(
    {
      id: "children",
      name: "Children",
      command: "",
      runner: "pipeline",
      orchestration: { kind: "runPipeline", pipeline: "child" },
      // Missing: were the node answering to its outputs, it would run again.
      outputs: [branchArtifact],
    },
    {
      status: "done",
      orchestration: {
        kind: "runPipeline",
        children: [{ key: "main", kind: "main", pipeline: "child", status: "done", accountedCostUsd: 0 }],
      },
    },
  );
  const run = makeRun([node]);

  const { deps, calls } = fakeDeps();
  const outcome = await executeRunSteps(run, { resuming: true }, deps, ctx);

  // Re-admitted, the node would relaunch its child pipeline, which does not exist here.
  expect(outcome.failed).toBe(false);
  expect(calls.exec).toBe(0);
  expect(node.status).toBe("done");
  expect(readRunEvents(run.run_dir).some((event) => event.type === "step.skipped")).toBe(false);
});

test("D3: a done work-item source step keeps the authority of its status on resume", async () => {
  const { ctx } = artifactContext();
  const built = pipeline("p")
    .add(createInternalWorkItemSourceStep({ dir: () => "/tmp/work-items", queue: "featureTodo" }))
    .add(dslBashStep({ id: "work", name: "Work", command: "work", rerunOnResume: true }))
    .build();
  const run = makeRun(built.steps.map((def) => makeRunStep(def, { status: "done", control: { duration_ms: 1 } })));

  const { deps, calls } = fakeDeps();
  await executeRunSteps(run, { resuming: true }, deps, ctx);

  expect(calls.ids).toEqual(["work"]);
  expect(run.steps[0]!.status).toBe("done");
});

test("D3: a work-item source step declaring an output is never stamped nor re-admitted", async () => {
  const { values, ctx } = artifactContext();
  const built = pipeline("p")
    .add(
      createInternalWorkItemSourceStep({ dir: () => "/tmp/work-items", queue: "featureTodo" }).output(ticketArtifact),
    )
    .build();
  const sourceStepId = built.work_item_source!.step_id;
  const { deps, calls } = fakeDeps();
  const written = writing(deps, values, { [sourceStepId]: [["ticket.md", "# ticket"]] });

  const run = makeRun(built.steps.map((def) => makeRunStep(def)));
  await executeRunSteps(run, { resuming: false, workItemSourceStepId: sourceStepId }, written, ctx);
  expect(run.steps[0]!.status).toBe("done");
  expect(lockOf(ctx).steps).toEqual({});

  const resumed = makeRun(built.steps.map((def) => makeRunStep(def, { status: "done", control: { duration_ms: 1 } })));
  await executeRunSteps(resumed, { resuming: true, workItemSourceStepId: sourceStepId }, written, ctx);
  expect(calls.ids).toEqual([sourceStepId]);
  expect(lockOf(ctx).steps).toEqual({});
});

test("lock: a run without a ticket stamps nothing, so a step declaring a source runs on every invocation", async () => {
  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: mkdtempSync(join(tmpdir(), "steploop-noticket-")) });
  expect(ctx.paths.workItemDir).toBeUndefined();
  const step = bashStep("lint", "lint", { sources: [source("tree", { command: "echo stable" })] });
  const { deps, calls } = fakeDeps();

  const first = await executeRunSteps(makeRun([step]), { resuming: false }, deps, ctx);
  const again = await executeRunSteps(makeRun([step]), { resuming: true }, deps, ctx);

  expect(first.failed).toBe(false);
  expect(again.failed).toBe(false);
  expect(calls.ids).toEqual(["lint", "lint"]);
  expect(step.status).toBe("done");
});

test("reconcile: a skipped orchestration node declaring rerunOnResume stays skipped", async () => {
  const { ctx } = artifactContext();
  const node = makeRunStep(
    {
      id: "children",
      name: "Children",
      command: "",
      runner: "pipeline",
      orchestration: { kind: "runPipeline", pipeline: "child" },
      // Were the node re-admitted on it, it would launch a child pipeline that does not exist here.
      rerun_on_resume: true,
    },
    { status: "skipped" },
  );
  const run = makeRun([node]);

  const { deps, calls } = fakeDeps();
  const outcome = await executeRunSteps(run, { resuming: true }, deps, ctx);

  expect(outcome.failed).toBe(false);
  expect(calls.exec).toBe(0);
  expect(node.status).toBe("skipped");
});

/** A completed `runPipeline` node declaring `rerunOnResume`, whose child pipeline does not exist here. */
function doneNodeRerunOnResume(): RunStep {
  return makeRunStep(
    {
      id: "children",
      name: "Children",
      command: "",
      runner: "pipeline",
      orchestration: { kind: "runPipeline", pipeline: "child" },
      rerun_on_resume: true,
    },
    {
      status: "done",
      orchestration: {
        kind: "runPipeline",
        children: [{ key: "main", kind: "main", pipeline: "child", status: "done", accountedCostUsd: 0 }],
      },
    },
  );
}

test("reconcile: a done orchestration node declaring rerunOnResume keeps its status", async () => {
  const { ctx } = artifactContext();
  const node = doneNodeRerunOnResume();
  const run = makeRun([node]);

  const outcome = await executeRunSteps(run, { resuming: true }, fakeDeps().deps, ctx);

  expect(outcome.failed).toBe(false);
  expect(node.status).toBe("done");
  expect(readRunEvents(run.run_dir).map((event) => event.type)).toEqual([]);
});

test("reconcile: a done humanReview gate checks its approval again on every invocation", async () => {
  const { values, ctx } = reworkContext({ "plan.md": "v1" });
  await recordApproval(ctx, "plan", reviewedPlan);
  const built = pipeline("p")
    .add(
      dslBashStep({ id: "write", name: "Write", command: "write" }).output(reviewedPlan),
      humanReview<string>({
        id: "plan",
        artifact: reviewedPlan,
        kind: "needs-decision",
        blocked: () => true,
        approval: { subject: "plan" },
        reason: () => "plan to review",
      }),
    )
    .build();
  const run = makeRun(built.steps.map((def) => makeRunStep(def, { status: "done", control: { duration_ms: 1 } })));
  const gate = run.steps.find((step) => step.id === "plan-gate")!;
  await stampAsIs(ctx, run.steps.find((step) => step.id === "write")!.def);

  const approved = await executeRunSteps(run, { resuming: true }, fakeDeps().deps, ctx);
  expect(approved.stopped).toBe(false);
  expect(gate.status).toBe("done");
  const attempts = readRunEvents(run.run_dir).filter((event) => event.type === "step.attempt.started");
  expect(attempts.map((event) => (event as { stepId?: string }).stepId)).toEqual(["plan-gate"]);

  // The plan changed after its approval: the done gate must not wave it through.
  values.set("plan.md", "v2");
  await stampAsIs(ctx, run.steps.find((step) => step.id === "write")!.def);
  const stale = await executeRunSteps(run, { resuming: true }, fakeDeps().deps, ctx);
  expect(stale.stopped).toBe(true);
  expect(run.outcome?.phase).toBe("plan-gate");
});

// --- Reconcile mode: selectors last one invocation ---------------------------
//
// Boot persists no exclusion in reconcile mode; the loop applies this
// invocation's `--steps`, `--skip` and `--start-at` and reports what they left out.

const replayable = (id: string, state: StepStateInput = {}): RunStep =>
  bashStep(id, "cmd", { rerun_on_resume: true }, state);

function selectionSkips(run: Run): Array<{ stepId?: unknown; reason?: unknown }> {
  return readRunEvents(run.run_dir)
    .filter((event) => event.type === "step.skipped")
    .map((event) => ({ stepId: event.stepId, reason: event.reason }));
}

test("reconcile: --skip sets a step aside whatever its status, journals why, and persists no exclusion", async () => {
  const { ctx } = artifactContext();
  const done = replayable("context", { status: "done", control: { duration_ms: 1 } });
  const owed = replayable("quality");
  const kept = replayable("report");
  const run = makeRun([done, owed, kept]);
  try {
    const { deps, calls } = fakeDeps();
    const outcome = await executeRunSteps(run, { resuming: true, skipFilter: ["context", "quality"] }, deps, ctx);

    expect(calls.ids).toEqual(["report"]);
    expect(outcome.setAside).toEqual(["context", "quality"]);
    expect(outcome.stopped).toBe(false);
    // A done step keeps the status its pass earned; a pending one settles as skipped.
    expect(done.status).toBe("done");
    expect(owed.status).toBe("skipped");
    expect(selectionSkips(run)).toEqual([
      { stepId: "context", reason: "operator selection" },
      { stepId: "quality", reason: "operator selection" },
    ]);
    const persisted = readRunSnapshot(join(run.run_dir, "state.json"))!;
    expect(persisted.steps.some((step) => "excluded" in step)).toBe(false);
  } finally {
    rmSync(run.run_dir, { recursive: true, force: true });
  }
});

test("reconcile: --steps sets aside every step it does not name, prefixes included", async () => {
  const { ctx } = artifactContext();
  const run = makeRun([replayable("checks.lint"), replayable("checks.types"), replayable("report")]);
  try {
    const { deps, calls } = fakeDeps();
    const outcome = await executeRunSteps(run, { resuming: false, stepFilter: ["checks"] }, deps, ctx);

    expect(calls.ids).toEqual(["checks.lint", "checks.types"]);
    expect(outcome.setAside).toEqual(["report"]);
    expect(run.steps[2]!.status).toBe("skipped");
  } finally {
    rmSync(run.run_dir, { recursive: true, force: true });
  }
});

test("fork: before its pending start step, only the steps that rerun on resume are admitted (F5)", async () => {
  const { ctx } = artifactContext({ "ticket.md": "edited by hand" });
  const branch = replayable("branch", { status: "done" });
  // Stale against the edited ticket, and without a stamp: admitted, it would run.
  const kept = derivedStep({ status: "done" });
  const target = replayable("implement");
  const run = makeRun([branch, kept, target]);
  run.startAt = "implement";
  try {
    const { deps, calls } = fakeDeps();
    const outcome = await executeRunSteps(run, { resuming: true }, deps, ctx);

    expect(calls.ids).toEqual(["branch", "implement"]);
    expect(kept.status).toBe("done");
    expect(outcome.setAside).toEqual([]);
  } finally {
    rmSync(run.run_dir, { recursive: true, force: true });
  }
});

test("reconcile: a step left out whose last pass is unfinished keeps its status, and the run stops for a decision", async () => {
  const { ctx } = artifactContext();
  const failed = replayable("quality", { status: "failed", errors: "boom" });
  const interrupted = replayable("publish", { status: "running" });
  interrupted.attempts = [
    {
      attempt: 1,
      kind: "step",
      status: "aborted",
      started_at: "2026-10-16T00:00:00Z",
      log_path: "x",
      interrupted: true,
    },
  ];
  const kept = replayable("report");
  const run = makeRun([failed, interrupted, kept]);
  try {
    const { deps, calls } = fakeDeps();
    const outcome = await executeRunSteps(run, { resuming: true, skipFilter: ["quality", "publish"] }, deps, ctx);

    expect(calls.ids).toEqual(["report"]);
    expect(outcome.setAside).toEqual(["quality", "publish"]);
    // The status is what the next admission reads: settled, it would let freshness
    // adopt the failed pass's outputs and replay the interrupted one unasked.
    expect(failed.status).toBe("failed");
    expect(failed.errors).toBe("boom");
    expect(interrupted.status).toBe("running");
    expect(outcome.stopped).toBe(true);
    expect(run.outcome?.stop?.kind).toBe("needs-decision");
    expect(run.outcome?.phase).toBe("quality");
    expect(selectionSkips(run)).toEqual([
      { stepId: "quality", reason: "operator selection" },
      { stepId: "publish", reason: "operator selection" },
    ]);
  } finally {
    rmSync(run.run_dir, { recursive: true, force: true });
  }
});

test("reconcile: a step left out with an unfinished pass does not turn a failure later in the run into a stop", async () => {
  const { ctx } = artifactContext();
  const failed = replayable("quality", { status: "failed", errors: "boom" });
  const run = makeRun([failed, replayable("report")]);
  try {
    const { deps } = fakeDeps([{ ok: false }]);
    const outcome = await executeRunSteps(run, { resuming: true, skipFilter: ["quality"] }, deps, ctx);

    expect(outcome.failed).toBe(true);
    expect(outcome.stopped).toBe(false);
    expect(failed.status).toBe("failed");
    expect(run.outcome?.stop).toBeUndefined();
  } finally {
    rmSync(run.run_dir, { recursive: true, force: true });
  }
});

test("reconcile: a requeued step whose last attempt was interrupted keeps pending when left out, and the run stops", async () => {
  const { ctx } = artifactContext();
  const requeued = replayable("publish", { status: "pending" });
  requeued.attempts = [
    {
      attempt: 1,
      kind: "step",
      status: "aborted",
      started_at: "2026-10-16T00:00:00Z",
      log_path: "x",
      interrupted: true,
    },
  ];
  const run = makeRun([requeued, replayable("report")]);
  try {
    const { deps, calls } = fakeDeps();
    const outcome = await executeRunSteps(run, { resuming: true, skipFilter: ["publish"] }, deps, ctx);

    expect(calls.ids).toEqual(["report"]);
    // Settled as skipped, it would lose the interruption the next admission must see.
    expect(requeued.status).toBe("pending");
    expect(outcome.stopped).toBe(true);
    expect(run.outcome?.stop?.kind).toBe("needs-decision");
    expect(run.outcome?.stop?.detail).toContain("--replay-interrupted");
  } finally {
    rmSync(run.run_dir, { recursive: true, force: true });
  }
});

test("reconcile: an --until bound left out unfinished is reached, and its stop outranks the selection's", async () => {
  const { ctx } = artifactContext();
  const bound = replayable("plan", { status: "failed", errors: "boom" });
  const run = makeRun([replayable("context"), bound, replayable("implement")]);
  try {
    const { deps, calls } = fakeDeps();
    const outcome = await executeRunSteps(run, { resuming: true, skipFilter: ["plan"], until: "plan" }, deps, ctx);

    expect(calls.ids).toEqual(["context"]);
    expect(outcome.untilStop).toBe(true);
    expect(run.outcome?.stop?.kind).toBe("until");
    expect(bound.status).toBe("failed");
    expect(run.steps[2]!.status).toBe("pending");
  } finally {
    rmSync(run.run_dir, { recursive: true, force: true });
  }
});

test("reconcile: a step set aside before the --until bound settles it, later steps stay pending", async () => {
  const { ctx } = artifactContext();
  const run = makeRun([replayable("context"), replayable("plan"), replayable("report")]);
  try {
    const { deps, calls } = fakeDeps();
    const outcome = await executeRunSteps(run, { resuming: false, skipFilter: ["plan"], until: "plan" }, deps, ctx);

    expect(calls.ids).toEqual(["context"]);
    expect(outcome.untilStop).toBe(true);
    expect(outcome.setAside).toEqual(["plan"]);
    expect(run.steps.map((step) => step.status)).toEqual(["done", "skipped", "pending"]);
  } finally {
    rmSync(run.run_dir, { recursive: true, force: true });
  }
});

// A cost stop outranks the selection's: the run did not go to the end, so the
// stop that withheld work is the one the operator must act on.
for (const gate of [
  { name: "budget", maxCost: 1, unaccounted: false },
  { name: "unpriced spend", maxCost: 5, unaccounted: true },
] as const) {
  test(`reconcile: a ${gate.name} stop after a step left out unfinished keeps its own kind`, async () => {
    const { ctx } = artifactContext();
    // The failed pass spent the budget; its spend still counts though it is set aside.
    const failed = replayable("quality", {
      status: "failed",
      errors: "boom",
      control: { duration_ms: 1, total_cost_usd: 2, ...(gate.unaccounted ? { cost_unknown: true } : {}) },
    });
    const run = makeRun([failed, replayable("report")], gate.maxCost);
    if (gate.unaccounted) run.cost_unaccounted = true;
    try {
      const { deps, calls } = fakeDeps();
      const outcome = await executeRunSteps(run, { resuming: true, skipFilter: ["quality"] }, deps, ctx);

      expect(calls.ids).toEqual([]);
      expect(outcome.setAside).toEqual(["quality"]);
      expect(outcome.budgetExceeded).toBe(!gate.unaccounted);
      expect(outcome.costUnaccountedStop).toBe(gate.unaccounted);
      expect(outcome.stopped).toBe(false);
      expect(run.outcome?.stop?.kind).not.toBe("needs-decision");
      expect(failed.status).toBe("failed");
      expect(run.steps[1]!.status).toBe("pending");
    } finally {
      rmSync(run.run_dir, { recursive: true, force: true });
    }
  });
}

test("reconcile: an interruption after a step left out unfinished is not turned into a selection stop", async () => {
  const { ctx } = artifactContext();
  const failed = replayable("quality", { status: "failed", errors: "boom" });
  const run = makeRun([failed, replayable("report"), replayable("publish")]);
  const abort = createAbortScope();
  try {
    const { deps, calls } = fakeDeps();
    const executeStep = deps.executeStep;
    // The signal lands while report runs, before the handler persists the abort.
    deps.executeStep = async (...args) => {
      abort.requestAbort("SIGINT");
      return executeStep(...args);
    };
    const outcome = await executeRunSteps(run, { resuming: true, abort, skipFilter: ["quality"] }, deps, ctx);

    expect(calls.ids).toEqual(["report"]);
    expect(outcome.stopped).toBe(false);
    expect(run.stopped_reason).toBeUndefined();
    expect(run.outcome?.stop).toBeUndefined();
  } finally {
    rmSync(run.run_dir, { recursive: true, force: true });
  }
});

for (const selection of [{ stepFilter: ["c"] }, { skipFilter: ["b"] }] as const) {
  test(`${Object.keys(selection)[0]} sets an aborted step aside without running it, and the run stops for a decision`, async () => {
    const { ctx } = artifactContext();
    const aborted = replayable("b", { status: "aborted" });
    const run = makeRun([replayable("a", { status: "done", control: { duration_ms: 1 } }), aborted, replayable("c")]);
    try {
      const { deps, calls } = fakeDeps();
      const outcome = await executeRunSteps(run, { resuming: true, ...selection }, deps, ctx);

      expect(calls.ids).not.toContain("b");
      expect(calls.ids).toContain("c");
      expect(outcome.setAside).toContain("b");
      expect(aborted.status).toBe("aborted");
      expect(outcome.stopped).toBe(true);
      expect(run.outcome?.stop?.kind).toBe("needs-decision");
    } finally {
      rmSync(run.run_dir, { recursive: true, force: true });
    }
  });
}

test("the resume selectors apply to a step added to the definition after the snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "steploop-new-step-"));
  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: root, ticket: "T-new" });
  const definition = (file: string, ids: string[]) => {
    const path = join(root, file);
    const steps = ids.map(
      (id) =>
        `  .add(actionStep({ id: "${id}", name: "${id}", run: () => {}, describe: "${id}", rerunOnResume: true }))`,
    );
    writeFileSync(path, `export default ({ pipeline, actionStep }) => pipeline("p")\n${steps.join("\n")}\n  .build();`);
    return path;
  };
  try {
    const dir = resolveRunDir("p", "T-new", undefined, true, ctx);
    // A distinct file per revision: the loader imports the module, and an import
    // is cached for the process.
    await loadOrCreateRun({
      pipelinePath: definition("before.ts", ["a", "b"]),
      ticket: "T-new",
      runDir: dir,
      fresh: false,
      context: ctx,
      worktree: false,
    });
    const { run } = await loadOrCreateRun({
      pipelinePath: definition("after.ts", ["a", "b", "deploy"]),
      ticket: "T-new",
      runDir: dir,
      fresh: false,
      context: ctx,
      worktree: false,
    });
    const { deps, calls } = fakeDeps();
    const outcome = await executeRunSteps(run, { resuming: true, stepFilter: ["a"] }, deps, ctx);

    expect(calls.ids).toEqual(["a"]);
    expect(outcome.setAside).toEqual(["b", "deploy"]);
    expect(run.steps.find((step) => step.id === "deploy")?.status).toBe("skipped");
    expect(outcome.stopped).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The signal handler persists the abort only on the runs it can reach, so a run can
// see the request on its scope while `run.aborted` is still false. These tests hold
// it there: `resolveOutcome` reads `run.aborted` alone, so only the loop's own
// re-checks stand between a late result and a verdict on an interrupted run.
for (const [label, result] of [
  ["success", { ok: true }],
  ["failure", { ok: false, failReason: "killed by the signal" }],
] as const) {
  test(`executeRunSteps: a ${label} returned after the abort request is not read as a verdict`, async () => {
    const step = bashStep("a", "cmd");
    const run = makeRun([step, bashStep("b", "cmd")]);
    const abort = createAbortScope();
    const { deps, calls } = fakeDeps([result]);
    const executeStep = deps.executeStep;
    deps.executeStep = async (...args) => {
      abort.requestAbort("SIGINT");
      return executeStep(...args);
    };

    const outcome = await executeRunSteps(run, { resuming: false, abort }, deps, buildPipelineContext({}));

    expect(calls.ids).toEqual(["a"]);
    expect(step.status).toBe("running");
    expect(outcome.failed).toBe(false);
    expect(outcome.stopped).toBe(false);
  });
}

test("executeRunSteps: an abort requested while the verdict is read does not report a failure", async () => {
  const step = bashStep("a", "cmd", { error_extractor: "x" });
  const run = makeRun([step, bashStep("b", "cmd")]);
  const abort = createAbortScope();
  const { deps, calls } = fakeDeps([{ ok: false, failReason: "boom" }]);
  deps.extractErrors = async () => {
    abort.requestAbort("SIGINT");
    return { hasErrors: false, errors: "" };
  };

  const outcome = await executeRunSteps(run, { resuming: false, abort }, deps, buildPipelineContext({}));

  expect(calls.ids).toEqual(["a"]);
  expect(outcome.failed).toBe(false);
  expect(outcome.stopped).toBe(false);
});

test("executeRunSteps: an absorbed failure interrupted while its verdict is read is not stamped", async () => {
  const { ctx } = artifactContext({ "ticket.md": "v1" });
  const check = bashStep("check", "cmd", { sources: [ticketArtifact], blocking: false, error_extractor: "x" });
  const run = makeRun([check]);
  const abort = createAbortScope();
  const { deps, calls } = fakeDeps([{ ok: false, failReason: "audit failed" }]);
  deps.extractErrors = async () => {
    abort.requestAbort("SIGINT");
    return { hasErrors: false, errors: "" };
  };

  await executeRunSteps(run, { resuming: false, abort }, deps, ctx);

  expect(calls.ids).toEqual(["check"]);
  expect(lockOf(ctx).steps.check).toBeUndefined();
});

test("executeRunSteps: announces each step with its place in the pipeline", async () => {
  const run = makeRun([bashStep("a", "cmd"), bashStep("b", "cmd")]);
  const { deps } = fakeDeps();
  const started: Array<{ id: string; index: number; total: number }> = [];
  const output: StepLoopDeps["output"] = {
    emit: (event) => {
      if (event.type === "step.started") started.push({ id: event.step.id, index: event.index, total: event.total });
    },
  };

  await executeRunSteps(run, { resuming: false }, { ...deps, output }, buildPipelineContext({}));

  expect(started).toEqual([
    { id: "a", index: 1, total: 2 },
    { id: "b", index: 2, total: 2 },
  ]);
});

test("executeRunSteps: every started step is ended, even one that stops the run without a verdict event", async () => {
  const run = makeRun([bashStep("a", "cmd"), bashStep("b", "cmd")]);
  const { deps } = fakeDeps([{ ok: true }, { ok: false, output: "", failReason: "app down", failCause: "blocked" }]);
  const seen: string[] = [];
  const output: StepLoopDeps["output"] = {
    emit: (event) => {
      if (event.type.startsWith("step.") && event.type !== "step.logs" && "step" in event)
        seen.push(`${event.type} ${event.step.id}`);
    },
  };

  const outcome = await executeRunSteps(run, { resuming: false }, { ...deps, output }, buildPipelineContext({}));

  expect(outcome.stopped).toBe(true);
  expect(seen).toEqual(["step.started a", "step.done a", "step.ended a", "step.started b", "step.ended b"]);
});
