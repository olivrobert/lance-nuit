import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepResult } from "../exec/runners.ts";
import type { PipelineStep, StepFailure } from "../model/definition.ts";
import type { Run, RunStep } from "../model/run.ts";
import { buildPipelineContext } from "../pipeline/context.ts";
import { createDefaultAgentBackendRegistry } from "../engine/default-registry.ts";
import { stepLogPath } from "../state/run-timeline.ts";
import { type OnFailureContext, onFailureHandlerFor, rerunHandler } from "./on-failure.ts";
import { makeRunStep } from "../state/run-step.ts";
import { createAbortScope } from "../runtime/abort.js";
import { NULL_RUN_OUTPUT } from "../runtime/run-output.js";

function makeRun(step: RunStep, maxCost?: number): Run {
  const dir = mkdtempSync(join(tmpdir(), "onfailure-"));
  return { name: "p", pipeline: "p", pipeline_path: "p.ts", run_dir: dir, max_cost_usd: maxCost, steps: [step] };
}

function failingStep(on_failure: StepFailure, def: Partial<PipelineStep> = {}): RunStep {
  return makeRunStep(
    { id: "s", name: "s", command: "echo s", runner: "bash", on_failure, ...def },
    { status: "running" },
  );
}

/** Complete handler context with programmable executeStep and counters. */
function makeCtx(
  run: Run,
  step: RunStep,
  results: Array<Partial<StepResult>>,
  overrides: Partial<OnFailureContext> = {},
): { ctx: OnFailureContext; calls: { exec: number; fix: number } } {
  const calls = { exec: 0, fix: 0 };
  let i = 0;
  const stepLog = stepLogPath(run, step);
  // Handlers append their attempt markers; the file must exist.
  writeFileSync(stepLog, "");
  const ctx: OnFailureContext = {
    run,
    step,
    command: "echo s",
    output: "initial output",
    // The retry loop resolves the step backend on the context: a bare object
    // would fail loudly, the registry travels with the run.
    baseCtx: buildPipelineContext({ cwd: process.cwd(), agentBackendRegistry: createDefaultAgentBackendRegistry() }),
    budget: { cumulative: 0 },
    abort: createAbortScope(),
    lastFailReason: "initial failure",
    timedOut: false,
    runOutput: NULL_RUN_OUTPUT,
    deps: {
      executeStep: async () => {
        calls.exec++;
        const r = results[i++] ?? { ok: false };
        return {
          output: r.output ?? "",
          ok: r.ok ?? false,
          stats: r.stats ?? { duration_ms: 1 },
          session: r.session,
          timedOut: r.timedOut,
          failReason: r.failReason,
        };
      },
      runFixLoop: async () => {
        calls.fix++;
        return { failed: false };
      },
    },
    ...overrides,
  };
  return { ctx, calls };
}

test("a fix policy forwards the resumed step id that drives the repair backend choice", async () => {
  // The fix loop moves a bash step's repair onto the resumed session's provider
  // only when `resume_session` names a step; the policy is the single source of it.
  const seen: Array<string | undefined> = [];
  for (const resumeSession of [undefined, "implement"]) {
    const step = failingStep({ resume_session: resumeSession, max_retries: 1, fix_prompt: "fix" });
    const run = makeRun(step);
    const { ctx } = makeCtx(run, step, []);
    ctx.deps.runFixLoop = async (_run, _step, _command, _output, _baseCtx, _budget, _reason, opts) => {
      seen.push(opts.resumeSession);
      return { failed: false };
    };
    await onFailureHandlerFor(step.def.on_failure!)(ctx);
  }
  expect(seen).toEqual([undefined, "implement"]);
});

test("a policy without a fix prompt selects the rerun handler: validates the contract", () => {
  expect(onFailureHandlerFor({ max_retries: 2 })).toBe(rerunHandler);
  expect(onFailureHandlerFor({ max_retries: 2, fix_prompt: "fix" })).not.toBe(rerunHandler);
});

test("on-failure: validates the integration contract", async () => {
  const step = failingStep({ max_retries: 3 });
  const run = makeRun(step);
  const { ctx, calls } = makeCtx(run, step, [{ ok: false }, { ok: true }]);

  const out = await rerunHandler(ctx);

  expect(out.failed).toBe(false);
  expect(step.status).toBe("done");
  expect(step.retries).toBe(2);
  expect(calls.exec).toBe(2);
});

test("on-failure: validates the integration contract", async () => {
  const step = failingStep({ max_retries: 2 });
  const run = makeRun(step);
  const { ctx, calls } = makeCtx(run, step, [{ ok: false }, { ok: false, failReason: "exit code 2" }]);

  const out = await rerunHandler(ctx);

  expect(out.failed).toBe(true);
  expect(step.status).toBe("failed");
  expect(step.retries).toBe(2);
  expect(calls.exec).toBe(2);
  expect(step.errors).toBe("exit code 2");
});

test("on-failure: validates the integration contract", async () => {
  const step = failingStep({ max_retries: 1 }, { blocking: false });
  const run = makeRun(step);
  const { ctx } = makeCtx(run, step, [{ ok: false }]);

  const out = await rerunHandler(ctx);

  expect(out.failed).toBe(false);
  expect(step.status).toBe("done");
  expect(step.errors).toBe("initial failure");
});

test("on-failure: validates the integration contract", async () => {
  const step = failingStep({ max_retries: 3 });
  const run = makeRun(step, 1);
  const { ctx, calls } = makeCtx(run, step, [{ ok: true }], { budget: { cumulative: 5 } });

  const out = await rerunHandler(ctx);

  expect(calls.exec).toBe(0);
  expect(out.failed).toBe(true);
  expect(step.retries).toBe(0);
});

// The starting rung is no longer a parameter: the scale starts at nominal settings
// on every step execution. Stickiness is covered by escalation.test.ts.

test("on-failure: validates the integration contract", async () => {
  const step = failingStep(
    {
      max_retries: 4,
      escalate_after: 2,
      escalate_effort: "high",
      escalate_model: "opus[1m]",
    },
    { runner: "agent", backend: { id: "claude", options: { model: "opus", effort: "medium" } } },
  );
  const run = makeRun(step);
  const seen: Array<{ model?: string; effort?: string }> = [];
  // Every attempt fails: verify all four reruns and rung ordering.
  const { ctx } = makeCtx(run, step, [{ ok: false }, { ok: false }, { ok: false }, { ok: false }]);
  const inner = ctx.deps.executeStep;
  ctx.deps.executeStep = async (s, c, budget, pctx) => {
    seen.push({
      model: (budget?.agentOptions as { model?: string })?.model,
      effort: (budget?.agentOptions as { effort?: string })?.effort,
    });
    return inner(s, c, budget, pctx);
  };

  await rerunHandler(ctx);

  // Reruns 1-2: nominal settings (threshold not reached); rerun 3: effort; rerun 4: model.
  expect(seen).toEqual([
    { model: "opus", effort: "medium" },
    { model: "opus", effort: "medium" },
    { model: "opus", effort: "high" },
    { model: "opus[1m]", effort: "medium" },
  ]);
});

test("on-failure: validates the integration contract", async () => {
  const step = failingStep(
    { max_retries: 1, escalate_effort: "high", escalate_model: "opus[1m]" },
    { runner: "agent", backend: { id: "claude", options: { model: "opus", effort: "medium" } } },
  );
  const run = makeRun(step);
  const seen: Array<{ model?: string; effort?: string }> = [];
  const { ctx } = makeCtx(run, step, [{ ok: true }], { timedOut: true });
  const inner = ctx.deps.executeStep;
  ctx.deps.executeStep = async (s, c, budget, pctx) => {
    seen.push({
      model: (budget?.agentOptions as { model?: string })?.model,
      effort: (budget?.agentOptions as { effort?: string })?.effort,
    });
    return inner(s, c, budget, pctx);
  };

  await rerunHandler(ctx);

  expect(seen).toEqual([{ model: "opus[1m]", effort: "medium" }]);
});

test("on-failure: validates the integration contract", async () => {
  const step = failingStep({ resume_session: "implement", max_retries: 2, fix_prompt: "corrige" });
  const run = makeRun(step);
  const { ctx, calls } = makeCtx(run, step, [{ ok: true }], { timedOut: true });

  const out = await onFailureHandlerFor(step.def.on_failure!)(ctx);

  expect(out.failed).toBe(false);
  expect(step.status).toBe("done");
  expect(calls.exec).toBe(1);
  expect(calls.fix).toBe(0);
  expect(step.timeout_retries).toBe(1);
  expect(step.retries).toBe(0);
});

test("on-failure: validates the integration contract", async () => {
  const step = failingStep({ resume_session: "implement", max_retries: 3, fix_prompt: "corrige" });
  const run = makeRun(step);
  const { ctx, calls } = makeCtx(
    run,
    step,
    [{ ok: false, output: "verdict FAIL authentique", failReason: "AC 3 non satisfait" }],
    { timedOut: true },
  );
  let fixInput: { output: string; reason?: string } | undefined;
  ctx.deps.runFixLoop = async (_run, _step, _cmd, out, _c, _b, reason) => {
    calls.fix++;
    fixInput = { output: out, reason };
    return { failed: false };
  };

  const out = await onFailureHandlerFor(step.def.on_failure!)(ctx);

  expect(out.failed).toBe(false);
  expect(calls.exec).toBe(1);
  expect(calls.fix).toBe(1);
  expect(fixInput).toEqual({ output: "verdict FAIL authentique", reason: "AC 3 non satisfait" });
});

test("on-failure: validates the integration contract", async () => {
  const step = failingStep({ max_retries: 2, fix_prompt: "corrige" });
  const run = makeRun(step);
  const { ctx, calls } = makeCtx(
    run,
    step,
    [
      { ok: false, timedOut: true },
      { ok: false, timedOut: true },
    ],
    { timedOut: true },
  );

  const out = await onFailureHandlerFor(step.def.on_failure!)(ctx);

  expect(out.failed).toBe(true);
  expect(step.status).toBe("failed");
  expect(calls.exec).toBe(2);
  expect(calls.fix).toBe(0);
  expect(step.timeout_retries).toBe(2);
});

// Issue #8: the drain and fix loop shared `step.retries`. A drain that consumed the
// whole quota caused the step to fail "after N attempts" without running a fix pass.
test("on-failure: validates the integration contract", async () => {
  const step = failingStep({ max_retries: 2, fix_prompt: "corrige" });
  const run = makeRun(step);
  const { ctx, calls } = makeCtx(
    run,
    step,
    [
      { ok: false, timedOut: true },
      { ok: false, output: "verdict authentique", failReason: "AC 1 non satisfait" },
    ],
    { timedOut: true },
  );

  const out = await onFailureHandlerFor(step.def.on_failure!)(ctx);

  expect(out.failed).toBe(false);
  expect(calls.exec).toBe(2);
  expect(calls.fix).toBe(1);
  // Two post-timeout reruns consumed; the fix quota remains intact.
  expect(step.timeout_retries).toBe(2);
  expect(step.retries).toBe(0);
});

test("on-failure: validates the integration contract", async () => {
  const step = failingStep({ max_retries: 1, fix_prompt: "corrige" }, { blocking: false });
  const run = makeRun(step);
  const { ctx, calls } = makeCtx(run, step, [{ ok: false, timedOut: true }], { timedOut: true });

  const out = await onFailureHandlerFor(step.def.on_failure!)(ctx);

  expect(out.failed).toBe(false);
  expect(step.status).toBe("done");
  expect(calls.fix).toBe(0);
  expect(step.errors).toBeDefined();
});

test("on-failure: validates the integration contract", async () => {
  const step = failingStep({ resume_session: "implement", max_retries: 2, fix_prompt: "corrige" });
  const run = makeRun(step);
  const { ctx, calls } = makeCtx(run, step, []);

  const out = await onFailureHandlerFor(step.def.on_failure!)(ctx);

  expect(out.failed).toBe(false);
  expect(calls.exec).toBe(0);
  expect(calls.fix).toBe(1);
});

test("on-failure: validates the integration contract", async () => {
  // The fix loop settles blocking vs non-blocking itself (settleStepFailure);
  // the handler propagates its verdict verbatim.
  const step = failingStep({ max_retries: 1, fix_prompt: "corrige" });
  const run = makeRun(step);
  const { ctx } = makeCtx(run, step, []);
  ctx.deps.runFixLoop = async () => ({ failed: true });

  const out = await onFailureHandlerFor(step.def.on_failure!)(ctx);

  expect(out.failed).toBe(true);
});

test("on-failure: an abort requested during a rerun ends the loop without another spawn", async () => {
  // The scope is what an in-process child run reads: its own `aborted` flag is
  // never set by the signal handler while it is still booting. The loop must stop
  // at the next check and leave the verdict to the interruption.
  const step = failingStep({ max_retries: 3 });
  const run = makeRun(step);
  const { ctx, calls } = makeCtx(run, step, [{ ok: false }, { ok: false }, { ok: false }]);
  const original = ctx.deps.executeStep;
  ctx.deps.executeStep = (...args) => {
    ctx.abort.requestAbort("SIGINT");
    return original(...args);
  };

  const out = await rerunHandler(ctx);

  expect(calls.exec).toBe(1);
  expect(step.retries).toBe(1);
  expect(out.failed).toBe(false);
  // Not settled by the loop: the interruption owns the step's final status.
  expect(step.status).toBe("running");
});
