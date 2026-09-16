import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBackend, AgentBackendFactory, AgentSession } from "../contracts/backends.ts";
import { AgentBackendRegistry } from "../engine/registry.ts";
import type { StepResult } from "../exec/runners.ts";
import type { PipelineContext } from "../model/context.ts";
import type { PipelineStep, StepFailure } from "../model/definition.ts";
import type { Run, RunStep } from "../model/run.ts";
import { buildPipelineContext } from "../pipeline/context.ts";
import { buildFixContext, type FixLoopDeps, runFixLoop } from "./fix-loop.ts";
import { chooseFixBackend } from "./fix-loop-runtime.ts";
import { makeRunStep } from "../state/run-step.ts";
import { executeRunSteps, type StepLoopDeps } from "./step-loop.ts";
import { commandRegistries } from "../commands/registries.js";
import { createAbortScope } from "../runtime/abort.js";
import { NULL_RUN_OUTPUT, type RunOutput } from "../runtime/run-output.js";

/** Observable backend: the loop asks it for resumption, session size, and
 *  escalation translation. No spawn; `runWithAgent` remains stubbed separately. */
function fakeBackendFactory(id: string, opts: { sizeKb?: number; resume?: boolean } = {}): AgentBackendFactory {
  const capabilities = {
    structuredOutput: true,
    streaming: true,
    resume: opts.resume ?? true,
    usageTokens: true,
    cost: "exact" as const,
    configurationAxes: ["model", "effort"] as const,
  };
  const backend: AgentBackend = {
    id,
    capabilities,
    sessionSizeKb: (_session: AgentSession) => opts.sizeKb ?? 0,
    applyEscalation: (options, escalation) => {
      const base = (options ?? {}) as Record<string, unknown>;
      if (escalation.rung === "model" && escalation.model) return { ...base, model: escalation.model };
      if (escalation.rung === "effort" && escalation.effort) return { ...base, effort: escalation.effort };
      return options;
    },
    applyConfigAxes: (options, axes) => ({ ...((options ?? {}) as Record<string, unknown>), ...axes }),
    run: async () => {
      throw new Error("the fake backend never spawns");
    },
  };
  return { id, capabilities, create: () => backend };
}

const baseCtx: PipelineContext = buildPipelineContext({
  ...commandRegistries(),
  cwd: ".",
  runnerBin: "",
  runnerDir: "",
});

function makeRun(step: RunStep, maxCost?: number): Run {
  const dir = mkdtempSync(join(tmpdir(), "fixloop-"));
  return {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: dir,
    max_cost_usd: maxCost,
    steps: [step],
  };
}

/** Agent step named by `resumeSession: "implement"`, placed before the gate. Without
 *  `session` it models a step that recorded nothing: skipped by `when`, or a first
 *  attempt whose backend returned no session id. */
function resumeTarget(run: Run, session?: AgentSession): RunStep {
  const implement = makeRunStep(
    {
      id: "implement",
      name: "Implement",
      command: "implement",
      runner: "agent",
      backend: { id: session?.provider ?? "claude" },
    },
    session ? { status: "done", session } : { status: "done" },
  );
  run.steps.unshift(implement);
  return implement;
}

function makeStep(onFailure: StepFailure, def: Partial<PipelineStep> = {}): RunStep {
  return makeRunStep(
    { id: "verify", name: "Verify", command: "make test", runner: "bash", on_failure: onFailure, ...def },
    { status: "running" },
  );
}

/** Programmable results and call counters. */
function fakes(opts: {
  fix?: Array<{ ok: boolean; sessionId?: string; cost?: number; failReason?: string }>;
  retry?: Array<Partial<StepResult>>;
  extract?: Array<{ hasErrors: boolean; errors: string }>;
  sizeKb?: number;
}) {
  const calls = {
    fix: [] as any[],
    retry: 0,
    retryCtx: [] as unknown[],
    extract: 0,
    extractOutputs: [] as string[],
  };
  let fi = 0,
    ri = 0,
    ei = 0;
  const deps: FixLoopDeps = {
    runWithAgent: async (_p, spec, agentOptions, budget) => {
      const r = opts.fix?.[fi++] ?? { ok: true };
      calls.fix.push({ spec, agentOptions, budget });
      return {
        ok: r.ok,
        stats: { duration_ms: 1, total_cost_usd: r.cost ?? 0 },
        ...(r.sessionId ? { session: { provider: spec.id, id: r.sessionId, resumable: true } } : {}),
        failReason: r.failReason,
      };
    },
    executeStep: async (_s, _c, _b, ctx) => {
      calls.retry++;
      calls.retryCtx.push(ctx);
      const r = opts.retry?.[ri++] ?? { ok: true, output: "" };
      return {
        output: r.output ?? "",
        ok: r.ok ?? true,
        stats: r.stats ?? { duration_ms: 1 },
        session: r.session,
        timedOut: r.timedOut,
        failReason: r.failReason,
      };
    },
    extractErrors: async (_s, output) => {
      calls.extract++;
      calls.extractOutputs.push(output);
      return opts.extract?.[ei++] ?? { hasErrors: true, errors: "err" };
    },
    registry: new AgentBackendRegistry()
      .register(fakeBackendFactory("claude", { sizeKb: opts.sizeKb }), { default: true })
      .register(fakeBackendFactory("codex", { sizeKb: opts.sizeKb })),
  };
  return { deps, calls };
}

const FIX: StepFailure = { fix_prompt: "fix", max_retries: 2 };
const RESUMED = "implement";

test("runner failure reason precedes extracted errors: validates the contract", () => {
  const ctx = buildFixContext(baseCtx, "output", "extracted error", undefined, "triage.json not found");
  expect(ctx.errors).toBe("triage.json not found\n\nextracted error");
});

test("buildFixContext keeps the work-item gateway lazy", () => {
  const context = buildPipelineContext({
    ...commandRegistries(),
    config: {
      ...baseCtx.config,
      workItem: { ...baseCtx.config.workItem, provider: "provider-qui-nexiste-pas" as never },
    },
  });

  const fix = buildFixContext(context, "output", "error");
  expect(fix.errors).toBe("error");
  expect(() => fix.workItem).toThrow(/provider-qui-nexiste-pas/);
});

test("fix loop: validates the contract", async () => {
  const step = makeStep(FIX);
  const run = makeRun(step);
  const { deps, calls } = fakes({ fix: [{ ok: true }], retry: [{ ok: true }] });
  const res = await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });
  expect(res.failed).toBe(false);
  expect(step.status).toBe("done");
  expect(step.retries).toBe(1);
  expect(calls.retry).toBe(1);
});

test("fix loop: validates the contract", async () => {
  const step = makeStep(FIX);
  const run = makeRun(step);
  const { deps, calls } = fakes({ fix: [{ ok: false }] });
  const res = await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });
  expect(res.failed).toBe(true);
  expect(step.status).toBe("failed");
  expect(step.retries).toBe(1);
  expect(calls.retry).toBe(0);
});

test("fix loop: validates the contract", async () => {
  const step = makeStep(FIX);
  const run = makeRun(step, 1);
  const { deps, calls } = fakes({});
  const res = await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 5 }, "r0", {
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });
  expect(res.failed).toBe(true);
  expect(step.retries).toBe(0);
  expect(calls.fix.length).toBe(0);
  expect(step.errors).toBe("r0");
});

test("fix loop: validates the contract", async () => {
  const step = makeStep(FIX);
  const run = makeRun(step, 1);
  const { deps, calls } = fakes({ fix: [{ ok: true, cost: 2 }] });
  const budget = { cumulative: 0 };
  const res = await runFixLoop(run, step, "make test", "out", baseCtx, budget, "r0", {
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });
  expect(res.failed).toBe(true);
  expect(calls.fix.length).toBe(1);
  expect(calls.retry).toBe(0);
  expect(budget.cumulative).toBe(2);
});

test("a single fix attempt: validates the contract", async () => {
  const step = makeStep({ fix_prompt: "fix", max_retries: 1 });
  const run = makeRun(step);
  const { deps, calls } = fakes({
    fix: [{ ok: true }],
    retry: [{ ok: false, failReason: "constraints still failing" }],
  });

  const res = await runFixLoop(run, step, "make check", "out", baseCtx, { cumulative: 0 }, "r0", {
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });

  expect(res.failed).toBe(true);
  expect(step.status).toBe("failed");
  expect(step.errors).toBe("constraints still failing");
  expect(calls.retry).toBe(1);
});

test("resumed fix: validates the contract", async () => {
  const step = makeStep({ resume_session: RESUMED, fix_prompt: "fix", max_retries: 1 });
  const run = makeRun(step);
  resumeTarget(run); // the target step recorded no session
  const { deps, calls } = fakes({ fix: [{ ok: true }], retry: [{ ok: true }] });
  await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    resumeSession: RESUMED,
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });
  expect(calls.fix[0].budget.resumeSession?.id).toBeUndefined();
});

test("resumed fix: validates the contract", async () => {
  const step = makeStep({
    resume_session: RESUMED,
    fix_prompt: "fix",
    max_retries: 1,
    resume_size_threshold_kb: 100,
  });
  const run = makeRun(step);
  resumeTarget(run, { provider: "claude", id: "coder-1", resumable: true });
  const { deps, calls } = fakes({ fix: [{ ok: true }], retry: [{ ok: true }], sizeKb: 500 });
  await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    resumeSession: RESUMED,
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });
  expect(calls.fix[0].budget.resumeSession?.id).toBeUndefined();
});

test("resumed fix: validates the contract", async () => {
  const step = makeStep({
    resume_session: RESUMED,
    fix_prompt: "fix",
    max_retries: 1,
    resume_size_threshold_kb: 500,
  });
  const run = makeRun(step);
  resumeTarget(run, { provider: "claude", id: "coder-1", resumable: true });
  const { deps, calls } = fakes({ fix: [{ ok: true }], retry: [{ ok: true }], sizeKb: 100 });
  await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    resumeSession: RESUMED,
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });
  expect(calls.fix[0].budget.resumeSession?.id).toBe("coder-1");
});

test("resumed fix: validates the contract", async () => {
  const step = makeStep(
    { resume_session: RESUMED, fix_prompt: "fix", max_retries: 1 },
    { runner: "agent", backend: { id: "codex" }, output_format: "json" },
  );
  const run = makeRun(step);
  resumeTarget(run, { provider: "claude", id: "claude-1", resumable: true });
  const { deps } = fakes({ retry: [{ ok: true }] });
  const resumes: Array<string | undefined> = [];
  deps.runWithAgent = async (_prompt, _spec, _options, budget) => {
    resumes.push(budget?.resumeSession?.id);
    return {
      ok: true,
      stats: { duration_ms: 1, provider: "codex" },
      session: { provider: "codex", id: "codex-fix", resumable: true },
    };
  };

  await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    resumeSession: RESUMED,
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });

  expect(resumes).toEqual([undefined]);
});

test("resumed fix: validates the contract", async () => {
  const step = makeStep({ resume_session: RESUMED, fix_prompt: "fix", max_retries: 2 });
  const run = makeRun(step);
  const implement = resumeTarget(run, { provider: "claude", id: "coder-1", resumable: true });
  const { deps, calls } = fakes({
    fix: [
      { ok: true, sessionId: "fork-1" },
      { ok: true, sessionId: "fork-2" },
    ],
    retry: [{ ok: false, output: "encore KO" }, { ok: true }],
    sizeKb: 100,
  });

  await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    resumeSession: RESUMED,
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });

  expect(calls.fix.map((call) => call.budget.resumeSession?.id)).toEqual(["coder-1", "fork-1"]);
  // Each fork lands on the resumed step, never on the gate.
  expect(implement.session).toEqual({ provider: "claude", id: "fork-2", resumable: true });
  expect(step.session).toBeUndefined();
});

test("a resumed fix on a bash step follows the resumed session provider", async () => {
  // DEMO-386 shape: lot written by Codex, `make test-report` gate without a backend.
  // The repair must resume the Codex session, not open an empty default session.
  const step = makeStep({ resume_session: RESUMED, fix_prompt: "fix", max_retries: 1 });
  const run = makeRun(step);
  const implement = resumeTarget(run, { provider: "codex", id: "codex-1", resumable: true });
  const { deps, calls } = fakes({ fix: [{ ok: true, sessionId: "codex-1-fork" }], retry: [{ ok: true }], sizeKb: 100 });

  const res = await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    resumeSession: RESUMED,
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });

  expect(res.failed).toBe(false);
  expect(calls.fix[0].spec.id).toBe("codex");
  expect(calls.fix[0].budget.resumeSession?.id).toBe("codex-1");
  // No fix profile: load-time options were shaped for the default backend and are dropped.
  expect(calls.fix[0].agentOptions).toBeUndefined();
  expect(implement.session).toEqual({ provider: "codex", id: "codex-1-fork", resumable: true });
});

test("a resumed fix on a bash step re-reads the fix profile on the resumed session provider", async () => {
  const step = makeStep({
    resume_session: RESUMED,
    fix_prompt: "fix",
    max_retries: 1,
    fix_profile: "coder",
    // Materialized at load time for the default backend (claude).
    backend_options: { model: "opus", effort: "medium" },
  });
  const run = makeRun(step);
  resumeTarget(run, { provider: "codex", id: "codex-1", resumable: true });
  const { deps, calls } = fakes({ fix: [{ ok: true }], retry: [{ ok: true }], sizeKb: 100 });

  await runFixLoop(run, step, "make check", "out", baseCtx, { cumulative: 0 }, "r0", {
    resumeSession: RESUMED,
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });

  expect(calls.fix[0].spec.id).toBe("codex");
  expect(calls.fix[0].budget.resumeSession?.id).toBe("codex-1");
  // profiles.coder.backends.codex, not the claude axes baked at load time.
  expect(calls.fix[0].agentOptions).toEqual({ model: "gpt-5.6-luna", effort: "medium" });
});

test("a resumed fix keeps the default backend when the fix profile has no policy for the resumed provider", async () => {
  const step = makeStep({
    resume_session: RESUMED,
    fix_prompt: "fix",
    max_retries: 1,
    fix_profile: "planner",
    backend_options: { model: "opus", effort: "medium" },
  });
  const run = makeRun(step);
  resumeTarget(run, { provider: "codex", id: "codex-1", resumable: true });
  const { deps, calls } = fakes({ fix: [{ ok: true }], retry: [{ ok: true }], sizeKb: 100 });

  await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    resumeSession: RESUMED,
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });

  expect(calls.fix[0].spec.id).toBe("claude");
  expect(calls.fix[0].agentOptions).toEqual({ model: "opus", effort: "medium" });
  expect(calls.fix[0].budget.resumeSession?.id).toBeUndefined();
});

test("a resumed fix keeps the default backend when the resumed session provider is not registered", async () => {
  const step = makeStep({ resume_session: RESUMED, fix_prompt: "fix", max_retries: 1 });
  const run = makeRun(step);
  resumeTarget(run, { provider: "gemini", id: "g-1", resumable: true });
  const { deps, calls } = fakes({ fix: [{ ok: true }], retry: [{ ok: true }], sizeKb: 100 });

  await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    resumeSession: RESUMED,
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });

  expect(calls.fix[0].spec.id).toBe("claude");
  expect(calls.fix[0].budget.resumeSession?.id).toBeUndefined();
});

test("a fresh fix on a bash step ignores the sessions recorded by other steps", async () => {
  // Without resumeSession the repair is a fresh session: the default backend stays in charge.
  const step = makeStep({ ...FIX, backend_options: { model: "opus" } });
  const run = makeRun(step);
  resumeTarget(run, { provider: "codex", id: "codex-1", resumable: true });
  const { deps, calls } = fakes({ fix: [{ ok: true }], retry: [{ ok: true }], sizeKb: 100 });

  await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });

  expect(calls.fix[0].spec.id).toBe("claude");
  expect(calls.fix[0].agentOptions).toEqual({ model: "opus" });
  expect(calls.fix[0].budget.resumeSession?.id).toBeUndefined();
});

test("a fresh fix on a bash step repairs on the backend named by the fix policy", async () => {
  // The author picked the repair provider: it replaces the default backend, in a
  // fresh session, with the options materialized at load time for that provider.
  const step = makeStep({ ...FIX, fix_backend: "codex", backend_options: { model: "gpt" } });
  const run = makeRun(step);
  resumeTarget(run, { provider: "claude", id: "claude-1", resumable: true });
  const { deps, calls } = fakes({ fix: [{ ok: true }], retry: [{ ok: true }], sizeKb: 100 });

  await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });

  expect(calls.fix[0].spec.id).toBe("codex");
  expect(calls.fix[0].agentOptions).toEqual({ model: "gpt" });
  expect(calls.fix[0].budget.resumeSession?.id).toBeUndefined();
});

test("a resumed fix on an agent step keeps the declared backend over the resumed session provider", async () => {
  const step = makeStep(
    { resume_session: RESUMED, fix_prompt: "fix", max_retries: 1, backend_options: { model: "opus" } },
    { runner: "agent", backend: { id: "claude" }, output_format: "json" },
  );
  const run = makeRun(step);
  resumeTarget(run, { provider: "codex", id: "codex-1", resumable: true });
  const { deps, calls } = fakes({ fix: [{ ok: true }], retry: [{ ok: true }], sizeKb: 100 });

  await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    resumeSession: RESUMED,
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });

  expect(calls.fix[0].spec.id).toBe("claude");
  expect(calls.fix[0].agentOptions).toEqual({ model: "opus" });
  expect(calls.fix[0].budget.resumeSession?.id).toBeUndefined();
});

test("fix loop non bloquant: validates the contract", async () => {
  const step = makeStep(FIX, { blocking: false });
  const run = makeRun(step);
  const { deps } = fakes({ fix: [{ ok: false, failReason: "le fix a plante" }] });

  const res = await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });

  expect(res.failed).toBe(false);
  expect(step.status).toBe("done");
  // The retry loop keeps the last command failReason; a failed fix does not replace it.
  expect(step.errors).toBe("r0");
});

test("single fix attempt non bloquant: validates the contract", async () => {
  const step = makeStep({ fix_prompt: "fix", max_retries: 1 }, { blocking: false });
  const run = makeRun(step);
  const { deps } = fakes({
    fix: [{ ok: true }],
    retry: [{ ok: false, failReason: "constraints still failing" }],
  });

  const res = await runFixLoop(run, step, "make check", "out", baseCtx, { cumulative: 0 }, "r0", {
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });

  expect(res.failed).toBe(false);
  expect(step.status).toBe("done");
  expect(step.errors).toBe("constraints still failing");
});

// `escalate_after` counts attempts ALREADY made, matching the rerun loop (issue #8):
// with the default of 2, fixes 1 and 2 use nominal settings and the third escalates.
test("escalade model: validates the contract", async () => {
  const step = makeStep(
    {
      fix_prompt: "fix",
      max_retries: 4,
      escalate_model: "opus",
      backend_options: { model: "sonnet" },
    },
    { runner: "agent", backend: { id: "claude" } },
  );
  const run = makeRun(step);
  // Fix succeeds every time, retry fails three times -> three complete iterations.
  const { deps, calls } = fakes({
    fix: [{ ok: true }, { ok: true }, { ok: true }],
    retry: [{ ok: false }, { ok: false }, { ok: false }],
  });
  await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });
  expect(calls.fix.slice(0, 3).map((call) => call.agentOptions?.model)).toEqual(["sonnet", "sonnet", "opus"]);
});

test("fix-loop: validates the integration contract", async () => {
  const step = makeStep({ fix_prompt: "fix", max_retries: 1 }, { error_extractor: "sample-extractor" });
  const run = makeRun(step);
  // Fix succeeds, retry is killed (timedOut) -> the retry extractor block is bypassed.
  const { deps, calls } = fakes({ fix: [{ ok: true }], retry: [{ ok: false, timedOut: true, output: "tronque" }] });
  await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });
  // extractErrors is called only ONCE per iteration (fix prompt), never on retry.output.
  expect(calls.extract).toBe(1);
  expect(calls.extractOutputs).not.toContain("tronque");
});

// Regression: fix-loop retry attempts received
// `ctx = undefined`, which broke every `actionStep` (the "fn" runner) with an
// on_failure handler. The context must be forwarded.
test("fix-loop: validates the integration contract", async () => {
  const step = makeStep({ fix_prompt: "fix", max_retries: 1 }, { runner: "fn" });
  const run = makeRun(step);
  const { deps, calls } = fakes({ fix: [{ ok: true }], retry: [{ ok: true }] });
  await runFixLoop(run, step, "", "out", baseCtx, { cumulative: 0 }, "r0", {
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });
  expect(calls.retryCtx).toEqual([baseCtx]);
});

// Non-regression for the `onFail` refactor: the ex-`fix-only` shape is now
// `fix: prompt, retries: 1`. The attempt sequence is unchanged (initial command,
// repair, replay), but the step now goes through the retry loop, so it records
// `retries: 1` where `fix-only` left the counter at 0. The drift is assumed.
test("a fix policy with retries: 1 records step, fix, step and one retry", async () => {
  const step = makeRunStep({
    id: "verify",
    name: "Verify",
    command: "make test",
    runner: "bash",
    on_failure: { fix_prompt: "fix", max_retries: 1 },
  });
  const run = makeRun(step);
  // Only the fix pass and the replay run through the fix loop; the initial
  // command attempt belongs to the step loop, hence the real wiring here.
  const { deps: fixDeps, calls } = fakes({ fix: [{ ok: true }], retry: [{ ok: true }] });
  const loopDeps: StepLoopDeps = {
    executeStep: async () => ({
      output: "make test: 1 failure",
      ok: false,
      stats: { duration_ms: 1 },
      failReason: "make test failed",
    }),
    extractErrors: async () => ({ hasErrors: true, errors: "err" }),
    runFixLoop: (r, s, command, output, ctx, budget, reason, opts) =>
      runFixLoop(r, s, command, output, ctx, budget, reason, { ...opts, deps: fixDeps }),
    output: NULL_RUN_OUTPUT,
  };

  const outcome = await executeRunSteps(run, undefined, undefined, { resuming: false }, loopDeps);

  expect(outcome.failed).toBe(false);
  expect(step.attempts?.map((attempt) => attempt.kind)).toEqual(["step", "fix", "step"]);
  expect(step.status).toBe("done");
  expect(step.retries).toBe(1);
  expect(calls.fix.length).toBe(1);
  expect(calls.retry).toBe(1);
});

// `resumeSession` names a step that exists (the load-time rule), but the run may
// still reach the fix without a session — a target skipped by `when`, a first
// attempt that recorded nothing. The repair then falls back to the default backend
// and the loop keeps going.
test("a resumed fix whose target recorded no session falls back to the default backend", async () => {
  const step = makeStep({ resume_session: RESUMED, fix_prompt: "fix", max_retries: 1 });
  const run = makeRun(step);
  resumeTarget(run);
  const { deps, calls } = fakes({ fix: [{ ok: true }], retry: [{ ok: true }] });

  const choice = chooseFixBackend(run, step, baseCtx, deps.registry!, RESUMED);
  expect(choice.spec.id).toBe("claude");
  expect(choice.reason).toBe('default backend (step "implement" has no session)');

  const res = await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    resumeSession: RESUMED,
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });

  expect(res.failed).toBe(false);
  expect(step.status).toBe("done");
  expect(calls.fix[0].spec.id).toBe("claude");
  expect(calls.retry).toBe(1);
});

test("a resumed fix whose target is absent from the run falls back to the default backend", async () => {
  // Same run only: a step id that the run does not carry (nested pipeline, stale
  // snapshot) resolves to no session rather than to another run's conversation.
  const step = makeStep({ resume_session: RESUMED, fix_prompt: "fix", max_retries: 1 });
  const run = makeRun(step);
  const { deps, calls } = fakes({ fix: [{ ok: true }], retry: [{ ok: true }] });

  const res = await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    resumeSession: RESUMED,
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });

  expect(res.failed).toBe(false);
  expect(calls.fix[0].spec.id).toBe("claude");
  expect(calls.fix[0].budget.resumeSession?.id).toBeUndefined();
});

test("two gates resuming the same step: the second one resumes the fork left by the first", async () => {
  const first = makeStep({ resume_session: RESUMED, fix_prompt: "fix", max_retries: 1 }, { id: "lint" });
  const second = makeStep({ resume_session: RESUMED, fix_prompt: "fix", max_retries: 1 }, { id: "test" });
  const run = makeRun(first);
  run.steps.push(second);
  const implement = resumeTarget(run, { provider: "claude", id: "coder-1", resumable: true });
  const { deps, calls } = fakes({
    fix: [
      { ok: true, sessionId: "fork-lint" },
      { ok: true, sessionId: "fork-test" },
    ],
    retry: [{ ok: true }, { ok: true }],
    sizeKb: 100,
  });

  await runFixLoop(run, first, "make lint", "out", baseCtx, { cumulative: 0 }, "r0", {
    resumeSession: RESUMED,
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });
  expect(implement.session?.id).toBe("fork-lint");

  await runFixLoop(run, second, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    resumeSession: RESUMED,
    deps,
    output: NULL_RUN_OUTPUT,
    abort: createAbortScope(),
  });

  expect(calls.fix.map((call) => call.budget.resumeSession?.id)).toEqual(["coder-1", "fork-lint"]);
  expect(implement.session).toEqual({ provider: "claude", id: "fork-test", resumable: true });
  expect(first.session).toBeUndefined();
  expect(second.session).toBeUndefined();
});

/** Recording destination: the announcement of the repair is an output line, so the
 *  only way to assert that no repair was announced is to read what was emitted. */
function messageRecorder(): { output: RunOutput; messages: () => string[] } {
  const messages: string[] = [];
  return {
    output: {
      emit: (event) => {
        if (event.type === "runner.message") messages.push(event.message);
      },
    },
    messages: () => messages,
  };
}

// A step readmitted on resume (`rerun_on_resume`) reaches the fix loop with
// `step.retries` already at `max_retries`: the persisted counter is cumulative by
// design. The loop body never runs, so nothing must claim a repair happened.
test("a fix quota already consumed announces the spent quota and launches no repair", async () => {
  const step = makeStep(FIX);
  step.retries = 2;
  const run = makeRun(step);
  const { deps, calls } = fakes({});
  const { output, messages } = messageRecorder();

  const res = await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    deps,
    output,
    abort: createAbortScope(),
  });

  expect(res.failed).toBe(true);
  expect(calls.fix.length).toBe(0);
  expect(calls.retry).toBe(0);
  // The persisted counter is untouched: only the announcement changed.
  expect(step.retries).toBe(2);
  expect(messages().some((message) => message.includes("Fix backend"))).toBe(false);
  expect(messages().some((message) => message.includes("Fix quota already consumed (2/2 retries)"))).toBe(true);
});

test("the fix backend choice is announced when a repair actually starts", async () => {
  const step = makeStep(FIX);
  const run = makeRun(step);
  const { deps } = fakes({ fix: [{ ok: true }], retry: [{ ok: true }] });
  const { output, messages } = messageRecorder();

  await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 0 }, "r0", {
    deps,
    output,
    abort: createAbortScope(),
  });

  const announcements = messages().filter((message) => message.includes("Fix backend"));
  expect(announcements).toHaveLength(1);
  expect(announcements[0]).toContain("→ Fix backend claude — default backend (fresh fix session)");
});

// A cost stop is not a repair either: the line must not appear before the gate.
test("a cost stop before the first repair announces no fix backend", async () => {
  const step = makeStep(FIX);
  const run = makeRun(step, 1);
  const { deps, calls } = fakes({});
  const { output, messages } = messageRecorder();

  await runFixLoop(run, step, "make test", "out", baseCtx, { cumulative: 5 }, "r0", {
    deps,
    output,
    abort: createAbortScope(),
  });

  expect(calls.fix.length).toBe(0);
  expect(messages().some((message) => message.includes("Fix backend"))).toBe(false);
  expect(messages().some((message) => message.includes("Budget exceeded"))).toBe(true);
});
