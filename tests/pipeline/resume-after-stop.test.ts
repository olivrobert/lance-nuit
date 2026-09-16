// Resume after a clean stop or a budget ceiling.
//
// Both paths used to settle every remaining step, which made the snapshot
// non-resumable: the next invocation started a fresh run and replayed — and
// repaid — the steps already completed. These tests pin the resume cursor.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCapabilities, AgentRequest } from "../../src/contracts/backends.js";
import { createDefaultAgentBackendRegistry } from "../../src/engine/default-registry.js";
import { buildPipelineContext } from "../../src/pipeline/context.js";
import { finalizeRun } from "../../src/state/run-transitions.js";
import { loadOrCreateRun } from "../../src/boot/resume.js";
import { NULL_RUN_OUTPUT } from "../../src/runtime/run-output.js";
import { executeRunSteps, stepLoopDeps } from "../../src/step/step-loop.js";

const REGISTRY = createDefaultAgentBackendRegistry();

const trace = (root: string): string[] => readFileSync(join(root, "trace.log"), "utf-8").split("\n").filter(Boolean);

test("a run stopped for human review resumes instead of replaying completed steps", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-stop-"));
  const blocker = join(root, "block.flag");
  writeFileSync(blocker, "blocked");
  const pipelinePath = join(root, "gated.ts");
  writeFileSync(
    pipelinePath,
    `
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const mark = (ctx, what) => appendFileSync(join(ctx.cwd, "trace.log"), what + "\\n");
export default ({ pipeline, actionStep, reject }) => pipeline("gated")
  .add(
    actionStep({ id: "pre", name: "pre", run: (ctx) => mark(ctx, "pre"), describe: "pre" }),
    actionStep({
      id: "gate", name: "gate",
      when: { if: () => existsSync(${JSON.stringify(blocker)}) ? reject("escalated: needs approval") : true, else: "stop" },
      run: (ctx) => mark(ctx, "gate"), describe: "gate",
    }),
    actionStep({ id: "work", name: "work", run: (ctx) => mark(ctx, "work"), describe: "work" }),
  ).build();
`,
  );
  const ctx = buildPipelineContext({ cwd: root, ticket: "P-01", agentBackendRegistry: REGISTRY });

  const first = await loadOrCreateRun(pipelinePath, "P-01", undefined, undefined, undefined, false, undefined, ctx);
  finalizeRun(
    first,
    await executeRunSteps(first, "P-01", undefined, { resuming: false }, stepLoopDeps(NULL_RUN_OUTPUT), ctx),
  );
  expect(first.status).toBe("STOPPED");
  expect(trace(root)).toEqual(["pre"]);

  // The human approves and relaunches.
  rmSync(blocker);
  const second = await loadOrCreateRun(pipelinePath, "P-01", undefined, undefined, undefined, false, undefined, ctx);
  finalizeRun(
    second,
    await executeRunSteps(second, "P-01", undefined, { resuming: true }, stepLoopDeps(NULL_RUN_OUTPUT), ctx),
  );

  expect(second.run_dir).toBe(first.run_dir);
  expect(second.status).toBe("PASS");
  // `pre` was already done: the gate is re-evaluated and the run finishes, but
  // nothing completed before the stop runs a second time.
  expect(trace(root)).toEqual(["pre", "gate", "work"]);
});

const BACKEND = `resume-budget-${process.pid}`;
const capabilities: AgentCapabilities = {
  structuredOutput: true,
  streaming: false,
  resume: false,
  usageTokens: false,
  cost: "exact",
};
if (!REGISTRY.has(BACKEND)) {
  REGISTRY.register({
    id: BACKEND,
    capabilities,
    create(options) {
      const cost = typeof options === "object" && options && "cost" in options ? Number(options.cost) : 0;
      return {
        id: BACKEND,
        capabilities,
        async run(request: AgentRequest) {
          const charged = request.budgetRemaining != null ? Math.min(cost, request.budgetRemaining) : cost;
          return {
            provider: BACKEND,
            output: "",
            ok: charged >= cost,
            stats: { duration_ms: 1, total_cost_usd: charged },
            ...(charged < cost ? { failReason: "budget" } : {}),
          };
        },
      };
    },
  });
}

test("a run stopped by its budget resumes on a --budget approval without repaying", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-budget-"));
  const pipelinePath = join(root, "costly.ts");
  writeFileSync(
    pipelinePath,
    `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
export default ({ pipeline, llmStep, actionStep }) => pipeline("costly")
  .maxCost(0.5)
  .add(
    llmStep({ id: "paid", name: "paid", backend: ${JSON.stringify(BACKEND)}, profile: "coder",
      options: { cost: 0.5 }, command: "go" }),
    actionStep({ id: "rest", name: "rest",
      run: (ctx) => appendFileSync(join(ctx.cwd, "trace.log"), "rest\\n"), describe: "rest" }),
  ).build();
`,
  );
  const runDir = join(root, "run");
  const base = buildPipelineContext({ cwd: root, ticket: "P-01", agentBackendRegistry: REGISTRY });
  const ctx = buildPipelineContext({
    cwd: root,
    ticket: "P-01",
    agentBackendRegistry: REGISTRY,
    config: { ...base.config, profiles: { ...base.config.profiles, coder: { backends: { [BACKEND]: {} } } } },
  });

  const first = await loadOrCreateRun(pipelinePath, "P-01", undefined, undefined, runDir, true, undefined, ctx);
  const firstOutcome = await executeRunSteps(
    first,
    "P-01",
    undefined,
    { resuming: false },
    stepLoopDeps(NULL_RUN_OUTPUT),
    ctx,
  );
  finalizeRun(first, firstOutcome);
  expect(firstOutcome.budgetExceeded).toBe(true);
  expect(first.steps.map((step) => step.status)).toEqual(["done", "pending"]);

  // Resuming without approving hits the same ceiling and changes nothing.
  const retry = await loadOrCreateRun(pipelinePath, "P-01", undefined, undefined, runDir, false, undefined, ctx);
  const retryOutcome = await executeRunSteps(
    retry,
    "P-01",
    undefined,
    { resuming: true },
    stepLoopDeps(NULL_RUN_OUTPUT),
    ctx,
  );
  expect(retryOutcome.budgetExceeded).toBe(true);
  expect(retry.steps.map((step) => step.status)).toEqual(["done", "pending"]);

  // The human approves a higher ceiling: `lancenuit run P-01 --budget 20`.
  const approved = await loadOrCreateRun(pipelinePath, "P-01", undefined, undefined, runDir, false, undefined, ctx, {
    maxCostUsd: 20,
  });
  const approvedOutcome = await executeRunSteps(
    approved,
    "P-01",
    undefined,
    { resuming: true },
    stepLoopDeps(NULL_RUN_OUTPUT),
    ctx,
  );
  finalizeRun(approved, approvedOutcome);

  expect(approved.max_cost_usd).toBe(20);
  expect(approved.status).toBe("PASS");
  // The paid step keeps its cost and is not charged twice.
  expect(approvedOutcome.cumulativeCost).toBe(0.5);
  expect(trace(root)).toEqual(["rest"]);
});

test("a step declaring input is re-checked on resume and replays only what its inputs changed", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-derived-"));
  const workItem = join(root, ".lance-nuit", "work-items", "P-01");
  mkdirSync(join(workItem, "artifacts"), { recursive: true });
  const ticketFile = join(workItem, "artifacts", "ticket.md");
  writeFileSync(ticketFile, "first question\n");
  const blocker = join(root, "block.flag");
  writeFileSync(blocker, "blocked");

  const pipelinePath = join(root, "derived.ts");
  writeFileSync(
    pipelinePath,
    `
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const mark = (ctx, what) => appendFileSync(join(ctx.cwd, "trace.log"), what + "\\n");
export default ({ pipeline, actionStep, textArtifact }) => {
  const ticket = textArtifact("ticket.md");
  const spec = textArtifact("spec.md");
  const plan = textArtifact("plan.md");
  return pipeline("derived")
    .add(
      actionStep({
        id: "spec", name: "spec", input: [ticket], output: [spec], describe: "spec",
        run: async (ctx) => {
          mark(ctx, "spec");
          await spec.write(ctx, "spec of " + (await ticket.require(ctx)));
        },
      }),
      actionStep({
        id: "plan", name: "plan", input: [spec], output: [plan], describe: "plan",
        run: async (ctx) => {
          mark(ctx, "plan");
          await plan.write(ctx, "plan of " + (await spec.require(ctx)));
        },
      }),
      actionStep({
        id: "gate", name: "gate", describe: "gate",
        when: { if: () => !existsSync(${JSON.stringify(blocker)}), else: "stop" },
        run: (ctx) => mark(ctx, "gate"),
      }),
    )
    .build();
};
`,
  );
  const ctx = buildPipelineContext({ cwd: root, ticket: "P-01", agentBackendRegistry: REGISTRY });
  const resume = async (resuming: boolean) => {
    const run = await loadOrCreateRun(pipelinePath, "P-01", undefined, undefined, undefined, false, undefined, ctx);
    finalizeRun(run, await executeRunSteps(run, "P-01", undefined, { resuming }, stepLoopDeps(NULL_RUN_OUTPUT), ctx));
    return run;
  };

  const first = await resume(false);
  expect(first.status).toBe("STOPPED");
  expect(trace(root)).toEqual(["spec", "plan"]);

  // Resuming without touching the ticket costs nothing: both deliverables still
  // match the bytes they were produced from.
  await resume(true);
  expect(trace(root)).toEqual(["spec", "plan"]);

  // The human answers on the ticket: the spec is stale, and the plan follows.
  writeFileSync(ticketFile, "answered question\n");
  await resume(true);
  expect(trace(root)).toEqual(["spec", "plan", "spec", "plan"]);
  expect(readFileSync(join(workItem, "artifacts", "plan.md"), "utf-8")).toContain("answered question");

  // And the run settles again once nothing moved.
  await resume(true);
  expect(trace(root)).toEqual(["spec", "plan", "spec", "plan"]);
});
