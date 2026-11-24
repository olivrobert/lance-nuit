import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentBackend,
  type AgentBackendFactory,
  AgentBackendRegistry,
  type AgentRequest,
  type AgentResult,
  type AgentSession,
} from "../../contracts/backends.ts";
import { textArtifact } from "../../definition/dsl/artifact.ts";
import type { PipelineStep } from "../../definition/definition.ts";
import { buildPipelineContext } from "../../definition/pipeline/context.ts";
import { makeRunStep, type StepStateInput } from "../../run/record/run-step.ts";
import type { Run, RunStep } from "../../run/record/run.ts";
import type { ArtifactRef, WorkItemArtifactStore } from "../../shared/language/artifact-ports.ts";
import type { PipelineContext } from "../../shared/language/context.ts";
import { sha256Text } from "../../work-items/store/hash.ts";
import { readLock } from "../../work-items/store/step-lock.ts";
import { readRunEvents } from "../../run/record/run-journal.ts";
import { builtinRegistries } from "../../../tests/builtin-registries.ts";
import { createAbortScope } from "../abort.ts";
import { NULL_RUN_OUTPUT } from "../run-output.ts";
import type { StepResult } from "../runners.ts";
import { executeRunSteps, type StepLoopDeps } from "./step-loop.ts";

const plan = textArtifact("plan.md");
const audit = textArtifact("audit.md");
const ticket = textArtifact("ticket.md");

/** What the scripted backend answers, in order, per intent. */
interface Script {
  reviews: Array<Partial<AgentResult> & { audit?: string; throws?: string }>;
  fixes: Array<Partial<AgentResult> & { rewrite?: string }>;
  /** Called at every review and fix spawn. */
  observe?: () => void;
}

function scriptedBackend(values: Map<string, string>, script: Script, seen: AgentRequest[]): AgentBackendFactory {
  const capabilities = {
    structuredOutput: true,
    streaming: false,
    resume: true,
    usageTokens: true,
    cost: "exact" as const,
  };
  let minted = 0;
  const backend: AgentBackend = {
    id: "fake",
    capabilities,
    createSession: (): AgentSession => ({ provider: "fake", id: `fresh-${++minted}`, resumable: true }),
    run: async (request) => {
      seen.push(request);
      script.observe?.();
      if (request.intent === "fix") {
        const { rewrite, ...result } = script.fixes.shift() ?? {};
        if (rewrite !== undefined) values.set("plan.md", rewrite);
        const session = { provider: "fake", id: `${request.resumeSession?.id}-fork`, resumable: true };
        return {
          ok: true,
          output: "",
          provider: "fake",
          stats: { duration_ms: 1, total_cost_usd: 0.2 },
          session,
          ...result,
        };
      }
      const { audit: verdict, throws, ...result } = script.reviews.shift() ?? {};
      if (throws) throw new Error(throws);
      return {
        ok: true,
        output: "",
        provider: "fake",
        stats: { duration_ms: 1, total_cost_usd: 0.1 },
        session: request.session,
        structuredOutput: verdict === undefined ? { success: true } : { success: true, audit: verdict },
        ...result,
      };
    },
  };
  return { id: "fake", capabilities, create: () => backend };
}

function reviewContext(script: Script): { values: Map<string, string>; ctx: PipelineContext; seen: AgentRequest[] } {
  const values = new Map<string, string>([["ticket.md", "t"]]);
  const store: WorkItemArtifactStore = {
    exists: async (ref: ArtifactRef) => values.has(ref.name),
    readText: async (ref: ArtifactRef) => values.get(ref.name),
    readJson: async () => undefined,
    writeText: async (ref: ArtifactRef, next: string) => {
      values.set(ref.name, next);
    },
    remove: async (ref: ArtifactRef) => {
      values.delete(ref.name);
    },
  };
  const seen: AgentRequest[] = [];
  const registry = new AgentBackendRegistry().register(scriptedBackend(values, script, seen), { default: true });
  const ctx = buildPipelineContext({
    ...builtinRegistries(),
    agentBackendRegistry: registry,
    cwd: mkdtempSync(join(tmpdir(), "step-review-")),
    ticket: "PROJ-1",
    artifacts: store,
  });
  return { values, ctx, seen };
}

function planStep(def: Partial<PipelineStep> = {}, state: StepStateInput = {}): RunStep {
  return makeRunStep(
    {
      id: "plan",
      name: "Plan",
      command: "write the plan",
      runner: "agent",
      backend: { id: "fake" },
      profile: "planner",
      sources: [ticket],
      outputs: [plan, audit],
      review: {
        command: "review the plan",
        backend: { id: "fake" },
        profile: "reviewer",
        capture: { field: "audit", artifact: audit, schema: { type: "string" }, text: true },
        fix: (review) => ((review as string).includes("defect") ? `fix: ${review}` : undefined),
        retries: 1,
      },
      ...def,
    },
    state,
  );
}

function makeRun(steps: RunStep[], maxCost?: number): Run {
  return {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: mkdtempSync(join(tmpdir(), "step-review-run-")),
    max_cost_usd: maxCost,
    steps,
  };
}

/** The produce attempts: each writes the plan when it succeeds. */
function produceDeps(values: Map<string, string>, results: Array<Partial<StepResult>> = []): StepLoopDeps {
  let produced = 0;
  return {
    executeStep: async () => {
      const result = results.shift() ?? { ok: true };
      produced += 1;
      if (result.ok !== false) values.set("plan.md", `plan v${produced}`);
      return {
        output: "",
        ok: true,
        stats: { duration_ms: 1, total_cost_usd: 1 },
        session: { provider: "fake", id: `plan-${produced}`, resumable: true },
        ...result,
      };
    },
    extractErrors: async () => ({ hasErrors: false, errors: "" }),
    runWithAgent: () => Promise.reject(new Error("no fix expected")),
    output: NULL_RUN_OUTPUT,
  };
}

const kinds = (step: RunStep) => step.attempts.map((attempt) => attempt.kind);
const lockOf = (ctx: PipelineContext) => readLock(ctx.paths.workItemDir!);

test("review: attempts run produce, then review in a fresh session, then one fix in the step's session (R1, R2, R5, R6)", async () => {
  const statuses: string[] = [];
  const script: Script = { reviews: [{ audit: "1 defect" }], fixes: [{ rewrite: "plan fixed" }] };
  const { values, ctx, seen } = reviewContext(script);
  const step = planStep();
  const run = makeRun([step]);
  script.observe = () => statuses.push(step.status);

  const outcome = await executeRunSteps(run, { resuming: false }, produceDeps(values), ctx);

  expect(outcome.failed).toBe(false);
  expect(step.status).toBe("done");
  expect(kinds(step)).toEqual(["step", "review", "fix"]);
  const review = seen.find((request) => request.intent === "step")!;
  expect(review.session?.id).toBe("fresh-2");
  expect(review.outputFields).toEqual({ audit: { type: "string" } });
  expect(seen.find((request) => request.intent === "fix")?.resumeSession?.id).toBe("plan-1");
  expect(step.attempts[1]?.session?.id).toBe("fresh-2");
  expect(step.session?.id).toBe("plan-1-fork");
  expect(values.get("plan.md")).toBe("plan fixed");
  expect(values.get("audit.md")).toBe("1 defect");
  // Nothing settles the step before its review and fix are over.
  expect(statuses).toEqual(["running", "running"]);
});

test("review: no fix when the prompt is empty, and one stamp covers the produce outputs and the capture (R2, R3, R6)", async () => {
  const { values, ctx } = reviewContext({ reviews: [{ audit: "all good" }], fixes: [] });
  const step = planStep();

  await executeRunSteps(makeRun([step]), { resuming: false }, produceDeps(values), ctx);

  expect(kinds(step)).toEqual(["step", "review"]);
  expect(step.status).toBe("done");
  expect(lockOf(ctx).steps.plan).toMatchObject({
    inputs: { "artifacts/ticket.md": sha256Text("t") },
    outputs: { "artifacts/plan.md": sha256Text("plan v1"), "artifacts/audit.md": sha256Text("all good") },
  });
});

test("review: a refused review is rerun up to its retries, each in a new session, then the step fails unstamped (R1, R3)", async () => {
  const { values, ctx, seen } = reviewContext({ reviews: [{}, {}], fixes: [] });
  const step = planStep();

  const outcome = await executeRunSteps(makeRun([step]), { resuming: false }, produceDeps(values), ctx);

  expect(outcome.failed).toBe(true);
  expect(step.status).toBe("failed");
  expect(kinds(step)).toEqual(["step", "review", "review"]);
  expect(seen.map((request) => request.session?.id)).toEqual(["fresh-2", "fresh-3"]);
  expect(lockOf(ctx).steps.plan).toBeUndefined();
});

test("review: a review whose invocation throws is retried like a refused one (R1)", async () => {
  const { values, ctx } = reviewContext({ reviews: [{ throws: "backend crashed" }, { audit: "all good" }], fixes: [] });
  const step = planStep();

  const outcome = await executeRunSteps(makeRun([step]), { resuming: false }, produceDeps(values), ctx);

  expect(outcome.failed).toBe(false);
  expect(step.status).toBe("done");
  expect(kinds(step)).toEqual(["step", "review", "review"]);
  expect(lockOf(ctx).steps.plan).toBeDefined();
});

test("review: a review prompt that fails to render is retried, then the step fails past its retries (R1)", async () => {
  let renders = 0;
  const { values, ctx } = reviewContext({ reviews: [{ audit: "all good" }], fixes: [] });
  const failing = planStep();
  failing.def.review!.command = () => {
    renders += 1;
    throw new Error(`render ${renders} failed`);
  };

  const outcome = await executeRunSteps(makeRun([failing]), { resuming: false }, produceDeps(values), ctx);

  expect(renders).toBe(2);
  expect(outcome.failed).toBe(true);
  expect(failing.errors).toContain("render 2 failed");

  renders = 0;
  const recovering = planStep();
  recovering.def.review!.command = () => {
    renders += 1;
    if (renders === 1) throw new Error("render failed");
    return "review the plan";
  };
  expect((await executeRunSteps(makeRun([recovering]), { resuming: false }, produceDeps(values), ctx)).failed).toBe(
    false,
  );
  expect(recovering.status).toBe("done");
});

test("review: a failed fix fails the step, there is no review after it, and the next invocation starts with a step attempt (R1, R3)", async () => {
  const { values, ctx } = reviewContext({
    reviews: [{ audit: "1 defect" }],
    fixes: [{ ok: false, failReason: "crashed" }],
  });
  const step = planStep();
  const run = makeRun([step]);

  expect((await executeRunSteps(run, { resuming: false }, produceDeps(values), ctx)).failed).toBe(true);
  expect(kinds(step)).toEqual(["step", "review", "fix"]);
  expect(lockOf(ctx).steps.plan).toBeUndefined();

  await executeRunSteps(run, { resuming: true }, produceDeps(values), ctx);
  expect(step.attempts.at(3)?.kind).toBe("step");
});

test("review: the produce phase's own retries come before the review (R1)", async () => {
  const { values, ctx } = reviewContext({ reviews: [{ audit: "1 defect" }], fixes: [{ rewrite: "fixed" }] });
  const step = planStep({ on_failure: { max_retries: 1 } });

  await executeRunSteps(
    makeRun([step]),
    { resuming: false },
    produceDeps(values, [{ ok: false, failReason: "first try" }]),
    ctx,
  );

  expect(kinds(step)).toEqual(["step", "step", "review", "fix"]);
  expect(step.status).toBe("done");
});

test("review: every review and fix attempt is charged to the step and the ledger (R4)", async () => {
  const { values, ctx } = reviewContext({ reviews: [{ audit: "1 defect" }], fixes: [{ rewrite: "fixed" }] });
  const step = planStep();
  const run = makeRun([step]);

  await executeRunSteps(run, { resuming: false }, produceDeps(values), ctx);

  expect(step.attempts.map((attempt) => attempt.control?.total_cost_usd)).toEqual([1, 0.1, 0.2]);
  expect(step.control?.total_cost_usd).toBeCloseTo(1.3);
});

test("review: a ceiling reached before the review stops the run without spawning it (R4)", async () => {
  const { values, ctx, seen } = reviewContext({ reviews: [{ audit: "1 defect" }], fixes: [] });
  const step = planStep();
  const later = makeRunStep({ id: "later", name: "Later", command: "true", runner: "bash", rerun_on_resume: true });

  const run = makeRun([step, later], 0.5);

  const outcome = await executeRunSteps(run, { resuming: false }, produceDeps(values), ctx);

  expect(outcome.failed).toBe(true);
  expect(later.status).toBe("pending");
  expect(readRunEvents(run.run_dir).filter((event) => event.type === "run.budget.exceeded")).toEqual([
    expect.objectContaining({ stepId: "plan" }),
  ]);
  expect(seen).toEqual([]);
  expect(kinds(step)).toEqual(["step"]);
  expect(step.status).toBe("failed");
  expect(lockOf(ctx).steps.plan).toBeUndefined();
});

test("review: a ceiling reached before the fix stops the run without spawning it (R4)", async () => {
  const { values, ctx, seen } = reviewContext({ reviews: [{ audit: "1 defect" }], fixes: [{ rewrite: "fixed" }] });
  const step = planStep();
  const run = makeRun([step], 1.05);

  const outcome = await executeRunSteps(run, { resuming: false }, produceDeps(values), ctx);

  expect(outcome.failed).toBe(true);
  expect(seen.map((request) => request.intent)).toEqual(["step"]);
  expect(kinds(step)).toEqual(["step", "review"]);
  expect(values.get("plan.md")).toBe("plan v1");
  expect(step.status).toBe("failed");
  expect(lockOf(ctx).steps.plan).toBeUndefined();
});

test("review: an interruption during the review leaves no stamp and no done (R3, R6)", async () => {
  const abort = createAbortScope();
  const { values, ctx } = reviewContext({ reviews: [], fixes: [] });
  const step = planStep();
  const deps = produceDeps(values);
  const execute = deps.executeStep;
  deps.executeStep = async (...args) => {
    const result = await execute(...args);
    abort.requestAbort("SIGINT");
    return result;
  };

  await executeRunSteps(makeRun([step]), { resuming: false, abort }, deps, ctx);

  expect(step.status).not.toBe("done");
  expect(lockOf(ctx).steps.plan).toBeUndefined();
});
