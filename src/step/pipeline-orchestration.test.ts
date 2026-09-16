import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCapabilities, AgentRequest } from "../contracts/backends.js";
import { createDefaultAgentBackendRegistry } from "../engine/default-registry.js";
import type { PipelineContext } from "../model/context.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { appendRunEvent, readRunEvents } from "../state/run-journal.js";
import { abortRun, finalizeRun } from "../state/run-transitions.js";
import { loadOrCreateRun } from "../boot/resume.js";
import { saveRun } from "../state/run-repository.js";
import { updateStep } from "../state/run-transitions.js";
import { readRunSnapshot } from "../state/run-snapshot.js";
import { pipelineRunsDir } from "../state/stores/run-storage.js";
import { createAbortScope } from "../runtime/abort.js";
import { NULL_RUN_OUTPUT } from "../runtime/run-output.js";
import { executeRunSteps, stepLoopDeps } from "./step-loop.js";

const REGISTRY = createDefaultAgentBackendRegistry();
const COST_BACKEND = `pipeline-compose-cost-${process.pid}`;
const costCalls: Array<{ ok: boolean; cost: number }> = [];
const costCapabilities: AgentCapabilities = {
  structuredOutput: true,
  streaming: false,
  resume: false,
  usageTokens: false,
  cost: "exact",
};

if (!REGISTRY.has(COST_BACKEND)) {
  REGISTRY.register({
    id: COST_BACKEND,
    capabilities: costCapabilities,
    create(options) {
      const defaultCost =
        typeof options === "object" && options && "cost" in options && typeof options.cost === "number"
          ? options.cost
          : 0;
      return {
        id: COST_BACKEND,
        capabilities: costCapabilities,
        async run(request: AgentRequest) {
          const planned = costCalls.shift() ?? { ok: true, cost: defaultCost };
          const charged =
            request.budgetRemaining != null ? Math.min(planned.cost, request.budgetRemaining) : planned.cost;
          const overBudget = charged < planned.cost;
          return {
            provider: COST_BACKEND,
            output: "",
            ok: planned.ok && !overBudget,
            stats: { duration_ms: 1, total_cost_usd: charged },
            ...(planned.ok && !overBudget ? {} : { failReason: overBudget ? "budget exceeded" : "planned failure" }),
          };
        },
      };
    },
  });
}

/** A backend that spends tokens and reports no price: the shape `splitAttemptStats`
 *  normalizes into `cost_unknown`. No pricing table can cover it, so a capped run
 *  that used it can only continue under an explicit authorization. */
const UNPRICED_BACKEND = `pipeline-compose-unpriced-${process.pid}`;
/** Every turn the unpriced backend actually ran. A fan-out that kept spawning
 *  children after the ceiling became unenforceable shows up here as extra
 *  entries, which no snapshot field would have made visible. */
const unpricedSpawns: string[] = [];
const unpricedCapabilities: AgentCapabilities = {
  structuredOutput: true,
  streaming: false,
  resume: false,
  usageTokens: true,
  cost: "none",
};

if (!REGISTRY.has(UNPRICED_BACKEND)) {
  REGISTRY.register({
    id: UNPRICED_BACKEND,
    capabilities: unpricedCapabilities,
    create() {
      return {
        id: UNPRICED_BACKEND,
        capabilities: unpricedCapabilities,
        async run(request: AgentRequest) {
          unpricedSpawns.push(request.prompt);
          return {
            provider: UNPRICED_BACKEND,
            output: "",
            ok: true,
            stats: { duration_ms: 1, input_tokens: 1000, output_tokens: 100 },
          };
        },
      };
    },
  });
}

function writePipeline(root: string, name: string, source: string): string {
  const path = join(root, `${name}.ts`);
  writeFileSync(path, source);
  return path;
}

function actionPipelineSource(name: string, label: string): string {
  return `
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export default ({ pipeline, actionStep }) => pipeline(${JSON.stringify(name)})
  .add(actionStep({ id: ${JSON.stringify(label)}, name: ${JSON.stringify(label)},
    run: ctx => { appendFileSync(join(ctx.cwd, "trace.log"), ${JSON.stringify(`${label}:`)} + (ctx.ticket ?? "-") + "\\n"); },
    describe: ${JSON.stringify(label)} }))
  .build();
`;
}

async function executeParent(
  parentPath: string,
  root: string,
  ticket: string,
  runDir: string,
  fresh: boolean,
  contextOverride?: PipelineContext,
) {
  const context = contextOverride ?? buildPipelineContext({ cwd: root, ticket, agentBackendRegistry: REGISTRY });
  const run = await loadOrCreateRun(parentPath, ticket, undefined, undefined, runDir, fresh, undefined, context);
  const outcome = await executeRunSteps(
    run,
    ticket,
    undefined,
    { resuming: !fresh },
    stepLoopDeps(NULL_RUN_OUTPUT),
    context,
  );
  finalizeRun(run, outcome);
  return { run, outcome };
}

test("pipeline-orchestration: reports a child verdict as a verdict on the parent", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-child-verdict-"));
  const childPath = writePipeline(root, "child", actionPipelineSource("child", "child"));
  const parentPath = writePipeline(
    root,
    "parent",
    `
export default ({ pipeline, forEachPipeline }) => pipeline("parent")
  .add(forEachPipeline({
    id: "children", name: "Children", items: ["P-01"], pipeline: "./${childPath.slice(root.length + 1)}",
  })).build();
`,
  );
  const parentRunDir = join(root, "parent-run");
  const parent = await loadOrCreateRun(
    parentPath,
    "P",
    undefined,
    undefined,
    parentRunDir,
    true,
    undefined,
    buildPipelineContext({ cwd: root, ticket: "P", agentBackendRegistry: REGISTRY }),
  );
  const parentStep = parent.steps[0]!;
  const childRunId = "verdict-child";
  const childCtx = buildPipelineContext({ cwd: root, ticket: "P-01", agentBackendRegistry: REGISTRY });
  const childRunDir = join(pipelineRunsDir("child", "P-01", childCtx), childRunId);
  mkdirSync(childRunDir, { recursive: true });
  writeFileSync(
    join(childRunDir, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: childRunId,
      name: "child",
      ticket: "P-01",
      pipeline: "child",
      pipeline_path: childPath,
      status: "FAIL",
      outcome: {
        phase: "child",
        reason: "AC-4 is not satisfied",
        logPath: null,
        resumable: true,
        failKind: "verdict",
      },
      parentRunId: parent.runId,
      parentNodeId: parentStep.id,
      rootRunId: parent.rootRunId,
      budgetScopeId: parent.budgetScopeId,
      // Terminal child: nothing left to rerun, so the parent only relays its
      // outcome.
      steps: [{ id: "child", status: "skipped", retries: 0 }],
    }),
  );
  // The technical cause of a PREVIOUS attempt, which must not survive the one
  // that now stops on a verdict.
  parentStep.status = "failed";
  parentStep.errors = "process killed: timeout (900s)";
  parentStep.fail_kind = "technical";
  parentStep.orchestration = {
    kind: "forEachPipeline",
    items: ["P-01"],
    children: [
      {
        key: "main:0",
        kind: "main",
        pipeline: `./${childPath.slice(root.length + 1)}`,
        ticket: "P-01",
        runId: childRunId,
        status: "running",
        accountedCostUsd: 0,
      },
    ],
  };
  saveRun(parent);

  const resumed = await executeParent(parentPath, root, "P", parentRunDir, false);

  expect(resumed.run.status).toBe("FAIL");
  expect(resumed.run.steps[0]!.fail_kind).toBe("verdict");
  expect(resumed.run.outcome?.failKind).toBe("verdict");
  expect(resumed.run.outcome?.reason).toBe("AC-4 is not satisfied");
});

test("pipeline-orchestration: reports a child blocked by its environment as blocked on the parent", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-child-blocked-"));
  const childPath = writePipeline(root, "child", actionPipelineSource("child", "child"));
  const parentPath = writePipeline(
    root,
    "parent",
    `
export default ({ pipeline, forEachPipeline }) => pipeline("parent")
  .add(forEachPipeline({
    id: "children", name: "Children", items: ["P-01"], pipeline: "./${childPath.slice(root.length + 1)}",
  })).build();
`,
  );
  const parentRunDir = join(root, "parent-run");
  const parent = await loadOrCreateRun(
    parentPath,
    "P",
    undefined,
    undefined,
    parentRunDir,
    true,
    undefined,
    buildPipelineContext({ cwd: root, ticket: "P", agentBackendRegistry: REGISTRY }),
  );
  const parentStep = parent.steps[0]!;
  const childRunId = "blocked-child";
  const childCtx = buildPipelineContext({ cwd: root, ticket: "P-01", agentBackendRegistry: REGISTRY });
  const childRunDir = join(pipelineRunsDir("child", "P-01", childCtx), childRunId);
  mkdirSync(childRunDir, { recursive: true });
  writeFileSync(
    join(childRunDir, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: childRunId,
      name: "child",
      ticket: "P-01",
      pipeline: "child",
      pipeline_path: childPath,
      // A terminal child, reported as-is: the shape `finalizeRun` leaves behind
      // when a step stops the run as blocked. `report.test.ts` pins that
      // finalization; this test pins that the parent reads the cause back out of
      // it, which is the whole point of persisting it on a STOPPED outcome.
      status: "STOPPED",
      stopped_reason: "the release branch is missing",
      outcome: {
        phase: "child",
        reason: "the release branch is missing",
        logPath: null,
        resumable: true,
        failKind: "verdict",
        failCause: "blocked",
        stop: { kind: "blocked", detail: "the release branch is missing" },
      },
      parentRunId: parent.runId,
      parentNodeId: parentStep.id,
      rootRunId: parent.rootRunId,
      budgetScopeId: parent.budgetScopeId,
      steps: [{ id: "child", status: "skipped", retries: 0 }],
    }),
  );
  parentStep.status = "running";
  parentStep.orchestration = {
    kind: "forEachPipeline",
    items: ["P-01"],
    children: [
      {
        key: "main:0",
        kind: "main",
        pipeline: `./${childPath.slice(root.length + 1)}`,
        ticket: "P-01",
        runId: childRunId,
        status: "running",
        accountedCostUsd: 0,
      },
    ],
  };
  saveRun(parent);

  const resumed = await executeParent(parentPath, root, "P", parentRunDir, false);

  // The parent is only the carrier of the child's answer: a subtree stopped by an
  // obstacle outside the code must not send the parent into a repair pass that
  // would hit the same obstacle.
  expect(resumed.run.status).toBe("STOPPED");
  expect(resumed.run.steps[0]!.fail_cause).toBe("blocked");
  expect(resumed.run.outcome?.failCause).toBe("blocked");
  expect(resumed.run.outcome?.reason).toBe("the release branch is missing");
});

test("forEachPipeline: validates the contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-"));
  const childPath = writePipeline(root, "child", actionPipelineSource("child", "child"));
  const afterPath = writePipeline(root, "after", actionPipelineSource("after", "after"));
  const finalizePath = writePipeline(root, "finalize", actionPipelineSource("finalize", "finalize"));
  const parentPath = writePipeline(
    root,
    "parent",
    `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
export default ({ pipeline, forEachPipeline, actionStep }) => pipeline("parent")
  .maxCost(10)
  .add(
    forEachPipeline({
      id: "children",
      name: "Children",
      items: ["P-01", "P-02"],
      pipeline: "./${childPath.slice(root.length + 1)}",
      afterEach: {
        pipeline: "./${afterPath.slice(root.length + 1)}",
        when: ctx => ctx.ticket === "P-01",
        ticket: ctx => ctx.ticket,
      },
      afterAll: {
        pipeline: "./${finalizePath.slice(root.length + 1)}",
        ticket: ctx => ctx.ticket,
      },
    }),
    actionStep({ id: "parent-after", name: "parent-after", run: ctx => { appendFileSync(join(ctx.cwd, "trace.log"), "parent-after:" + (ctx.ticket ?? "-") + "\\n"); }, describe: "parent-after" }),
  )
  .build();
`,
  );
  const runDir = join(root, "parent-run");

  const first = await executeParent(parentPath, root, "P", runDir, true);
  expect(first.outcome.failed).toBe(false);
  expect(first.run.status).toBe("PASS");
  expect(readFileSync(join(root, "trace.log"), "utf8").trim().split("\n")).toEqual([
    "child:P-01",
    "after:P-01",
    "child:P-02",
    "finalize:P",
    "parent-after:P",
  ]);

  const orchestration = first.run.steps[0]!.orchestration!;
  expect(orchestration.children.map((child) => [child.key, child.status, child.ticket])).toEqual([
    ["main:0", "done", "P-01"],
    ["afterEach:0", "done", "P-01"],
    ["main:1", "done", "P-02"],
    ["afterEach:1", "skipped", "P-02"],
    ["afterAll", "done", "P"],
  ]);
  expect(orchestration.children.filter((child) => child.status === "done").every((child) => child.runId)).toBe(true);

  const childRef = orchestration.children.find((child) => child.key === "main:0")!;
  const childStatePath = join(
    pipelineRunsDir(
      "child",
      "P-01",
      buildPipelineContext({ cwd: root, ticket: "P-01", agentBackendRegistry: REGISTRY }),
    ),
    childRef.runId!,
    "state.json",
  );
  expect(existsSync(childStatePath)).toBe(true);
  const childState = JSON.parse(readFileSync(childStatePath, "utf8"));
  expect(childState.parentRunId).toBe(first.run.runId);
  expect(childState.parentNodeId).toBe("children");
  expect(childState.rootRunId).toBe(first.run.rootRunId);
  expect(childState.budgetScopeId).toBe(first.run.budgetScopeId);

  const beforeResume = readFileSync(join(root, "trace.log"), "utf8");
  const resumed = await executeParent(parentPath, root, "P", runDir, false);
  expect(resumed.run.status).toBe("PASS");
  expect(readFileSync(join(root, "trace.log"), "utf8")).toBe(beforeResume);
  expect(resumed.run.steps[0]!.orchestration!.children).toEqual(orchestration.children);
});

test("pipeline-orchestration: preserves a terminal child verdict on resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-terminal-child-"));
  const childPath = writePipeline(root, "child", actionPipelineSource("child", "child"));
  const parentPath = writePipeline(
    root,
    "parent",
    `
export default ({ pipeline, forEachPipeline }) => pipeline("parent")
  .add(forEachPipeline({
    id: "children", name: "Children", items: ["P-01"], pipeline: "./${childPath.slice(root.length + 1)}",
  })).build();
`,
  );
  const parentRunDir = join(root, "parent-run");
  const parent = await loadOrCreateRun(
    parentPath,
    "P",
    undefined,
    undefined,
    parentRunDir,
    true,
    undefined,
    buildPipelineContext({ cwd: root, ticket: "P", agentBackendRegistry: REGISTRY }),
  );
  const parentStep = parent.steps[0]!;
  const childRunId = "stopped-child";
  const childContext = buildPipelineContext({ cwd: root, ticket: "P-01", agentBackendRegistry: REGISTRY });
  const childRunDir = join(pipelineRunsDir("child", "P-01", childContext), childRunId);
  mkdirSync(childRunDir, { recursive: true });
  writeFileSync(
    join(childRunDir, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: childRunId,
      name: "child",
      ticket: "P-01",
      pipeline: "child",
      pipeline_path: childPath,
      status: "STOPPED",
      stopped_reason: "manual stop",
      outcome: { phase: "child", reason: "manual stop", logPath: null, resumable: true },
      parentRunId: parent.runId,
      parentNodeId: parentStep.id,
      rootRunId: parent.rootRunId,
      budgetScopeId: parent.budgetScopeId,
      steps: [{ id: "child", status: "skipped", retries: 0 }],
    }),
  );
  parentStep.status = "failed";
  parentStep.errors = "resume child";
  parentStep.orchestration = {
    kind: "forEachPipeline",
    items: ["P-01"],
    children: [
      {
        key: "main:0",
        kind: "main",
        pipeline: `./${childPath.slice(root.length + 1)}`,
        ticket: "P-01",
        runId: childRunId,
        status: "running",
        accountedCostUsd: 0,
      },
    ],
  };
  saveRun(parent);

  const resumed = await executeParent(parentPath, root, "P", parentRunDir, false);
  const childState = JSON.parse(readFileSync(join(childRunDir, "state.json"), "utf8"));

  expect(resumed.run.status).toBe("STOPPED");
  expect(resumed.run.steps[0]!.orchestration!.children[0]!.status).toBe("failed");
  expect(childState.status).toBe("STOPPED");
  expect(childState.stopped_reason).toBe("manual stop");
});

test("forEachPipeline: validates the contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-lot-"));
  const childPath = writePipeline(
    root,
    "child",
    `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
export default ({ pipeline, actionStep }) => pipeline("child")
  .add(actionStep({ id: "work", name: "work", run: ctx => { appendFileSync(join(ctx.cwd, "trace.log"), (ctx.ticket ?? "-") + ":" + (ctx.lot?.id ?? "-") + "\\n"); }, describe: "work" }))
  .build();
`,
  );
  const parentPath = writePipeline(
    root,
    "parent",
    `
export default ({ pipeline, forEachPipeline }) => pipeline("parent")
  .add(forEachPipeline({
    id: "lots", name: "Lots", items: ["LOT-01", "LOT-02"],
    ticket: ctx => ctx.ticket,
    lot: (_ctx, item) => ({ id: item, title: item, risk: 1, steps: [1], dependsOn: [], acceptanceCriteria: ["AC-1"] }),
    pipeline: "./${childPath.slice(root.length + 1)}",
  })).build();
`,
  );

  const { run, outcome } = await executeParent(parentPath, root, "PROJ-1", join(root, "parent-run"), true);
  expect(outcome.failed).toBe(false);
  expect(readFileSync(join(root, "trace.log"), "utf8").trim().split("\n")).toEqual(["PROJ-1:LOT-01", "PROJ-1:LOT-02"]);
  const children = run.steps[0]!.orchestration!.children.filter((child) => child.kind === "main");
  expect(children.map((child) => child.lot?.id)).toEqual(["LOT-01", "LOT-02"]);
  const state = JSON.parse(
    readFileSync(
      join(
        pipelineRunsDir(
          "child",
          "PROJ-1",
          buildPipelineContext({ cwd: root, ticket: "PROJ-1", agentBackendRegistry: REGISTRY }),
        ),
        children[0]!.runId!,
        "state.json",
      ),
      "utf8",
    ),
  );
  expect(state.lot).toMatchObject({ id: "LOT-01", title: "LOT-01" });
});

test("forEachPipeline: validates the contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-fail-"));
  const childPath = writePipeline(
    root,
    "child",
    `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
export default ({ pipeline, actionStep }) => pipeline("child")
  .add(actionStep({ id: "work", name: "work", run: ctx => {
    appendFileSync(join(ctx.cwd, "trace.log"), "child:" + ctx.ticket + "\\n");
    if (ctx.ticket === "P-02") throw new Error("child failed");
  }, describe: "work" })).build();
`,
  );
  const afterPath = writePipeline(root, "after", actionPipelineSource("after", "after"));
  const parentPath = writePipeline(
    root,
    "parent",
    `
export default ({ pipeline, forEachPipeline }) => pipeline("parent")
  .add(forEachPipeline({
    id: "children", name: "Children", items: ["P-01", "P-02", "P-03"],
    pipeline: "./${childPath.slice(root.length + 1)}",
    afterEach: { pipeline: "./${afterPath.slice(root.length + 1)}" },
    afterAll: { pipeline: "./missing-finalize.ts" },
  })).build();
`,
  );

  const { run, outcome } = await executeParent(parentPath, root, "P", join(root, "parent-run"), true);
  expect(outcome.failed).toBe(true);
  expect(run.status).toBe("FAIL");
  expect(readFileSync(join(root, "trace.log"), "utf8").trim().split("\n")).toEqual([
    "child:P-01",
    "after:P-01",
    "child:P-02",
  ]);
  const state = run.steps[0]!.orchestration!;
  expect(state.children.find((child) => child.key === "main:1")?.status).toBe("failed");
  expect(state.children.some((child) => child.key === "main:2")).toBe(false);
  expect(state.children.some((child) => child.key === "afterAll")).toBe(false);
});

test("pipeline-orchestration: validates the integration contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-recursive-"));
  const projectPipelines = join(root, ".lance-nuit", "pipelines");
  mkdirSync(projectPipelines, { recursive: true });
  writeFileSync(join(projectPipelines, "grand.ts"), actionPipelineSource("grand", "grand"));
  writeFileSync(
    join(projectPipelines, "middle.ts"),
    `
export default ({ pipeline, forEachPipeline }) => pipeline("middle")
  .add(forEachPipeline({
    id: "grandchildren",
    name: "Grandchildren",
    items: ctx => [ctx.ticket + "-grand"],
    pipeline: "./grand.ts",
  })).build();
`,
  );
  const parentPath = writePipeline(
    root,
    "parent",
    `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
export default ({ pipeline, runPipeline, actionStep }) => pipeline("parent")
  .add(
    runPipeline({
      id: "middle",
      name: "Middle",
      pipeline: "middle",
      ticket: ctx => ctx.ticket + "-middle",
    }),
    actionStep({ id: "parent-after", name: "parent-after", run: ctx => { appendFileSync(join(ctx.cwd, "trace.log"), "parent:" + ctx.ticket + "\\n"); }, describe: "parent-after" }),
  )
  .build();
`,
  );

  const { run, outcome } = await executeParent(parentPath, root, "P", join(root, "parent-run"), true);
  expect(outcome.failed).toBe(false);
  expect(run.status).toBe("PASS");
  expect(readFileSync(join(root, "trace.log"), "utf8").trim().split("\n")).toEqual([
    "grand:P-middle-grand",
    "parent:P",
  ]);

  const parentState = run.steps[0]!.orchestration!;
  const middleRef = parentState.children.find((child) => child.key === "main")!;
  expect(middleRef.status).toBe("done");
  expect(middleRef.runId).toBeTruthy();
  const middleStatePath = join(
    pipelineRunsDir(
      "middle",
      "P-middle",
      buildPipelineContext({ cwd: root, ticket: "P-middle", agentBackendRegistry: REGISTRY }),
    ),
    middleRef.runId!,
    "state.json",
  );
  const middleState = JSON.parse(readFileSync(middleStatePath, "utf8"));
  expect(middleState.parentRunId).toBe(run.runId);
  expect(middleState.parentNodeId).toBe("middle");
  expect(middleState.rootRunId).toBe(run.rootRunId);
  expect(middleState.pipelineLineage).toEqual([
    { pipelinePath: parentPath, ticket: "P" },
    { pipelinePath: join(projectPipelines, "middle.ts"), ticket: "P-middle" },
  ]);

  const nestedRef = middleState.steps[0].orchestration.children[0];
  expect(nestedRef.pipeline).toBe("./grand.ts");
  const grandStatePath = join(
    pipelineRunsDir(
      "grand",
      "P-middle-grand",
      buildPipelineContext({ cwd: root, ticket: "P-middle-grand", agentBackendRegistry: REGISTRY }),
    ),
    nestedRef.runId,
    "state.json",
  );
  const grandState = JSON.parse(readFileSync(grandStatePath, "utf8"));
  expect(grandState.parentRunId).toBe(middleRef.runId);
  expect(grandState.parentNodeId).toBe("grandchildren");
  expect(grandState.rootRunId).toBe(run.rootRunId);
  expect(grandState.pipelineLineage).toEqual([
    { pipelinePath: parentPath, ticket: "P" },
    { pipelinePath: join(projectPipelines, "middle.ts"), ticket: "P-middle" },
    { pipelinePath: join(projectPipelines, "grand.ts"), ticket: "P-middle-grand" },
  ]);
});

test("pipeline-orchestration: validates the integration contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-self-cycle-"));
  const pipelinePath = writePipeline(
    root,
    "self",
    `
export default ({ pipeline, runPipeline }) => pipeline("self")
  .add(runPipeline({ id: "again", name: "Again", pipeline: "./self.ts" }))
  .build();
`,
  );

  const { run, outcome } = await executeParent(pipelinePath, root, "P-01", join(root, "parent-run"), true);
  expect(outcome.failed).toBe(true);
  expect(run.steps[0]!.errors).toContain("pipeline/ticket pair already present");
  expect(run.steps[0]!.errors).toContain(`${pipelinePath} [P-01] → ${pipelinePath} [P-01]`);
  expect(run.steps[0]!.orchestration!.children[0]!.runId).toBeUndefined();
});

test("pipeline-orchestration: validates the integration contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-indirect-cycle-"));
  const aPath = writePipeline(
    root,
    "a",
    `
export default ({ pipeline, runPipeline }) => pipeline("a")
  .add(runPipeline({ id: "call-b", name: "Call B", pipeline: "./b.ts" }))
  .build();
`,
  );
  const bPath = writePipeline(
    root,
    "b",
    `
export default ({ pipeline, runPipeline }) => pipeline("b")
  .add(runPipeline({ id: "call-a", name: "Call A", pipeline: "./a.ts" }))
  .build();
`,
  );

  const { run, outcome } = await executeParent(aPath, root, "P-01", join(root, "parent-run"), true);
  expect(outcome.failed).toBe(true);
  expect(run.outcome?.reason).toContain(`${aPath} [P-01] → ${bPath} [P-01] → ${aPath} [P-01]`);
});

test("pipeline-orchestration: validates the integration contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-depth-"));
  const pipelinePath = writePipeline(
    root,
    "recursive",
    `
export default ({ pipeline, runPipeline }) => pipeline("recursive")
  .add(runPipeline({
    id: "next",
    name: "Next",
    pipeline: "./recursive.ts",
    ticket: ctx => String(Number(ctx.ticket) + 1),
    when: ctx => Number(ctx.ticket) < 16,
  }))
  .build();
`,
  );

  const allowed = await executeParent(pipelinePath, root, "1", join(root, "allowed-run"), true);
  expect(allowed.outcome.failed).toBe(false);
  expect(allowed.run.status).toBe("PASS");

  const tooDeepPath = writePipeline(
    root,
    "too-deep",
    `
export default ({ pipeline, runPipeline }) => pipeline("too-deep")
  .add(runPipeline({
    id: "next",
    name: "Next",
    pipeline: "./too-deep.ts",
    ticket: ctx => String(Number(ctx.ticket) + 1),
    when: ctx => Number(ctx.ticket) < 17,
  }))
  .build();
`,
  );
  const rejected = await executeParent(tooDeepPath, root, "1", join(root, "rejected-run"), true);
  expect(rejected.outcome.failed).toBe(true);
  expect(rejected.run.outcome?.reason).toContain("Maximum composition depth (16) exceeded");
  expect(rejected.run.outcome?.reason).toContain(`${tooDeepPath} [1]`);
  expect(rejected.run.outcome?.reason).toContain(`${tooDeepPath} [17]`);
});

test("pipeline-orchestration: validates the integration contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-resume-cost-"));
  costCalls.push({ ok: true, cost: 0.4 });
  const childPath = writePipeline(
    root,
    "child",
    `
export default ({ pipeline, llmStep }) => pipeline("child")
  .maxCost(1)
  .add(llmStep({ id: "work", name: "work", backend: ${JSON.stringify(COST_BACKEND)}, profile: "coder", options: { cost: 0.4 }, command: "work" }))
  .build();
`,
  );
  const parentPath = writePipeline(
    root,
    "parent",
    `
export default ({ pipeline, forEachPipeline }) => pipeline("parent")
  .maxCost(1)
  .add(forEachPipeline({
    id: "children", name: "Children", items: ["P-01"], pipeline: "./${childPath.slice(root.length + 1)}",
  })).build();
`,
  );
  const base = buildPipelineContext({ cwd: root, ticket: "P", agentBackendRegistry: REGISTRY });
  const context = buildPipelineContext({
    cwd: root,
    ticket: "P",
    agentBackendRegistry: REGISTRY,
    config: {
      ...base.config,
      profiles: {
        ...base.config.profiles,
        coder: { backends: { [COST_BACKEND]: {} } },
      },
    },
  });
  const parent = await loadOrCreateRun(
    parentPath,
    "P",
    undefined,
    undefined,
    join(root, "parent-run"),
    true,
    undefined,
    context,
  );
  const parentStep = parent.steps[0]!;
  const childContext = buildPipelineContext({
    cwd: root,
    ticket: "P-01",
    config: context.config,
    agentBackendRegistry: REGISTRY,
  });
  const childRunDir = join(pipelineRunsDir("child", "P-01", childContext), "manual-child");
  const childRun = await loadOrCreateRun(
    childPath,
    "P-01",
    undefined,
    undefined,
    childRunDir,
    true,
    undefined,
    childContext,
    {
      maxCostUsd: 1,
      parentRunId: parent.runId,
      parentNodeId: parentStep.id,
      rootRunId: parent.rootRunId,
      budgetScopeId: parent.budgetScopeId,
    },
  );
  const childOutcome = await executeRunSteps(
    childRun,
    "P-01",
    undefined,
    { resuming: false },
    stepLoopDeps(NULL_RUN_OUTPUT),
    childContext,
  );
  finalizeRun(childRun, childOutcome);
  expect(childRun.status).toBe("PASS");
  expect(costCalls).toHaveLength(0);

  parentStep.status = "failed";
  parentStep.errors = "interruption avant comptabilisation";
  parentStep.orchestration = {
    kind: "forEachPipeline",
    items: ["P-01"],
    children: [
      {
        key: "main:0",
        kind: "main",
        pipeline: `./${childPath.slice(root.length + 1)}`,
        ticket: "P-01",
        runId: "manual-child",
        status: "running",
        accountedCostUsd: 0,
      },
    ],
  };
  saveRun(parent);

  const firstResume = await executeParent(parentPath, root, "P", join(root, "parent-run"), false, context);
  expect(firstResume.outcome.failed).toBe(false);
  expect(firstResume.run.steps[0]!.control?.total_cost_usd).toBeCloseTo(0.4, 10);
  expect(firstResume.run.steps[0]!.orchestration!.children[0]!.status).toBe("done");
  expect(firstResume.run.steps[0]!.orchestration!.children[0]!.accountedCostUsd).toBeCloseTo(0.4, 10);
  expect(costCalls).toHaveLength(0);

  // Interruption after reconciliation: resuming the node must not recharge
  // the cost already charged to the parent step.
  updateStep(firstResume.run, firstResume.run.steps[0]!, "failed", "interruption after accounting");
  const secondResume = await executeParent(parentPath, root, "P", join(root, "parent-run"), false, context);
  expect(secondResume.outcome.failed).toBe(false);
  expect(secondResume.run.steps[0]!.control?.total_cost_usd).toBeCloseTo(0.4, 10);
  expect(secondResume.run.steps[0]!.orchestration!.children[0]!.accountedCostUsd).toBeCloseTo(0.4, 10);
  expect(costCalls).toHaveLength(0);
});

test("pipeline-orchestration: validates the integration contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-budget-"));
  costCalls.push({ ok: false, cost: 0.4 }, { ok: true, cost: 0.4 }, { ok: true, cost: 0.4 });
  const childPath = writePipeline(
    root,
    "child",
    `
export default ({ pipeline, llmStep }) => pipeline("child")
  .maxCost(1)
  .add(llmStep({ id: "work", name: "work", backend: ${JSON.stringify(COST_BACKEND)}, profile: "coder", options: { cost: 0.4 }, command: "work", onFail: { retries: 1 } }))
  .build();
`,
  );
  const afterPath = writePipeline(root, "after", actionPipelineSource("after", "after"));
  const finalizePath = writePipeline(root, "finalize", actionPipelineSource("finalize", "finalize"));
  const parentPath = writePipeline(
    root,
    "parent",
    `
export default ({ pipeline, forEachPipeline }) => pipeline("parent")
  .maxCost(1)
  .add(forEachPipeline({
    id: "children", name: "Children", items: ["P-01", "P-02"],
    pipeline: "./${childPath.slice(root.length + 1)}",
    afterEach: { pipeline: "./${afterPath.slice(root.length + 1)}" },
    afterAll: { pipeline: "./${finalizePath.slice(root.length + 1)}" },
  })).build();
`,
  );
  const base = buildPipelineContext({ cwd: root, ticket: "P", agentBackendRegistry: REGISTRY });
  const context = buildPipelineContext({
    cwd: root,
    ticket: "P",
    agentBackendRegistry: REGISTRY,
    config: {
      ...base.config,
      profiles: {
        ...base.config.profiles,
        coder: { backends: { [COST_BACKEND]: {} } },
      },
    },
  });

  const { run, outcome } = await executeParent(parentPath, root, "P", join(root, "parent-run"), true, context);
  expect(outcome.failed).toBe(true);
  expect(outcome.budgetExceeded).toBe(true);
  expect(run.steps[0]!.control?.total_cost_usd).toBeCloseTo(1, 10);
  expect(run.max_cost_usd).toBe(1);
  expect(readFileSync(join(root, "trace.log"), "utf8").trim().split("\n")).toEqual(["after:P-01"]);

  const state = run.steps[0]!.orchestration!;
  const first = state.children.find((child) => child.key === "main:0")!;
  const second = state.children.find((child) => child.key === "main:1")!;
  expect(first.accountedCostUsd).toBeCloseTo(0.8, 10);
  expect(second.accountedCostUsd).toBeCloseTo(0.2, 10);
  expect(first.status).toBe("done");
  expect(second.status).toBe("failed");
  expect(state.children.some((child) => child.key === "afterEach:1")).toBe(false);
  expect(state.children.some((child) => child.key === "afterAll")).toBe(false);

  const childStateDir = pipelineRunsDir(
    "child",
    "P-02",
    buildPipelineContext({ cwd: root, ticket: "P-02", config: context.config, agentBackendRegistry: REGISTRY }),
  );
  const childState = JSON.parse(readFileSync(join(childStateDir, second.runId!, "state.json"), "utf8"));
  expect(childState.max_cost_usd).toBeCloseTo(0.2, 10);
  expect(childState.steps[0].retries).toBe(0);
});

test("pipeline-orchestration: validates the integration contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-late-error-cost-"));
  costCalls.push({ ok: true, cost: 0.4 });
  const childPath = writePipeline(
    root,
    "paid-child",
    `
export default ({ pipeline, llmStep }) => pipeline("paid-child")
  .add(llmStep({ id: "work", name: "work", backend: ${JSON.stringify(COST_BACKEND)}, profile: "coder", options: { cost: 0.4 }, command: "work" }))
  .build();
`,
  );
  const parentPath = writePipeline(
    root,
    "parent",
    `
export default ({ pipeline, forEachPipeline }) => pipeline("parent")
  .maxCost(2)
  .add(forEachPipeline({
    id: "children",
    name: "Children",
    items: ["P-01"],
    pipeline: "./${childPath.slice(root.length + 1)}",
    afterEach: { pipeline: "./missing-after.ts" },
  }))
  .build();
`,
  );
  const base = buildPipelineContext({ cwd: root, ticket: "P", agentBackendRegistry: REGISTRY });
  const context = buildPipelineContext({
    cwd: root,
    ticket: "P",
    agentBackendRegistry: REGISTRY,
    config: {
      ...base.config,
      profiles: { ...base.config.profiles, coder: { backends: { [COST_BACKEND]: {} } } },
    },
  });
  const runDir = join(root, "parent-run");

  const { run, outcome } = await executeParent(parentPath, root, "P", runDir, true, context);
  expect(outcome.failed).toBe(true);
  expect(outcome.cumulativeCost).toBeCloseTo(0.4, 10);
  expect(run.steps[0]!.control?.total_cost_usd).toBeCloseTo(0.4, 10);
  expect(run.total_control?.total_cost_usd).toBeCloseTo(0.4, 10);
  const snapshot = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  expect(snapshot.steps[0].control.total_cost_usd).toBeCloseTo(0.4, 10);
  expect(snapshot.total_control.total_cost_usd).toBeCloseTo(0.4, 10);
});

test("pipeline-orchestration: --budget on the parent lifts a child's own ceiling on resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-budget-approved-"));
  const childPath = writePipeline(
    root,
    "child",
    `
export default ({ pipeline, llmStep }) => pipeline("child")
  .maxCost(1)
  .add(llmStep({ id: "a", name: "a", backend: ${JSON.stringify(COST_BACKEND)}, profile: "coder", options: { cost: 1 }, command: "a" }))
  .add(llmStep({ id: "b", name: "b", backend: ${JSON.stringify(COST_BACKEND)}, profile: "coder", options: { cost: 1 }, command: "b" }))
  .build();
`,
  );
  const parentPath = writePipeline(
    root,
    "parent",
    `
export default ({ pipeline, runPipeline }) => pipeline("parent")
  .maxCost(5)
  .add(runPipeline({ id: "child", name: "child", pipeline: "./${childPath.slice(root.length + 1)}" }))
  .build();
`,
  );
  const base = buildPipelineContext({ cwd: root, ticket: "P", agentBackendRegistry: REGISTRY });
  const context = buildPipelineContext({
    cwd: root,
    ticket: "P",
    agentBackendRegistry: REGISTRY,
    config: { ...base.config, profiles: { ...base.config.profiles, coder: { backends: { [COST_BACKEND]: {} } } } },
  });
  const runDir = join(root, "parent-run");

  // The child spends its own $1 cap on step "a" and stops with "rerun with --budget".
  const first = await executeParent(parentPath, root, "P", runDir, true, context);
  expect(first.outcome.budgetExceeded).toBe(true);
  expect(first.run.steps[0]!.control?.total_cost_usd).toBeCloseTo(1, 10);

  // A resume without approval keeps the child pinned to its own cap.
  const plain = await executeParent(parentPath, root, "P", runDir, false, context);
  expect(plain.outcome.budgetExceeded).toBe(true);
  expect(plain.run.steps[0]!.control?.total_cost_usd).toBeCloseTo(1, 10);

  // `--budget` on the parent is the answer the message asked for: the child must
  // get to run step "b" under the parent's remaining budget.
  const approvedRun = await loadOrCreateRun(parentPath, "P", undefined, undefined, runDir, false, undefined, context, {
    maxCostUsd: 10,
    budgetApproved: true,
  });
  const approved = await executeRunSteps(
    approvedRun,
    "P",
    undefined,
    { resuming: true },
    stepLoopDeps(NULL_RUN_OUTPUT),
    context,
  );
  finalizeRun(approvedRun, approved);
  expect(approved.budgetExceeded).toBe(false);
  expect(approved.failed).toBe(false);
  expect(approvedRun.budget_approved).toBe(true);
  expect(approvedRun.steps[0]!.control?.total_cost_usd).toBeCloseTo(2, 10);
  expect(approvedRun.steps[0]!.orchestration!.children[0]!.status).toBe("done");
});

/** Parent/child fixture on the unpriced backend: two child steps under a cap, so
 *  the second one can only run if the accounting stop was authorized. */
function unpricedComposition(root: string): { parentPath: string; context: PipelineContext } {
  const childPath = writePipeline(
    root,
    "child",
    `
export default ({ pipeline, llmStep }) => pipeline("child")
  .maxCost(2)
  .add(llmStep({ id: "a", name: "a", backend: ${JSON.stringify(UNPRICED_BACKEND)}, profile: "coder", command: "a" }))
  .add(llmStep({ id: "b", name: "b", backend: ${JSON.stringify(UNPRICED_BACKEND)}, profile: "coder", command: "b" }))
  .build();
`,
  );
  const parentPath = writePipeline(
    root,
    "parent",
    `
export default ({ pipeline, runPipeline }) => pipeline("parent")
  .maxCost(5)
  .add(runPipeline({ id: "child", name: "child", pipeline: "./${childPath.slice(root.length + 1)}" }))
  .build();
`,
  );
  const base = buildPipelineContext({ cwd: root, ticket: "P", agentBackendRegistry: REGISTRY });
  const context = buildPipelineContext({
    cwd: root,
    ticket: "P",
    agentBackendRegistry: REGISTRY,
    config: { ...base.config, profiles: { ...base.config.profiles, coder: { backends: { [UNPRICED_BACKEND]: {} } } } },
  });
  return { parentPath, context };
}

/** A fan-out over three tickets, each running one unpriced agent step, under a
 *  parent ceiling. One child is enough to make that ceiling unenforceable, so the
 *  question is what happens to the other two — and to the callbacks. */
function unpricedFanOut(root: string): { parentPath: string; context: PipelineContext } {
  const childPath = writePipeline(
    root,
    "child",
    `
export default ({ pipeline, llmStep }) => pipeline("child")
  .add(llmStep({ id: "a", name: "a", backend: ${JSON.stringify(UNPRICED_BACKEND)}, profile: "coder", command: "a" }))
  .build();
`,
  );
  const afterPath = writePipeline(
    root,
    "after",
    `
export default ({ pipeline, llmStep }) => pipeline("after")
  .add(llmStep({ id: "a", name: "a", backend: ${JSON.stringify(UNPRICED_BACKEND)}, profile: "coder", command: "after" }))
  .build();
`,
  );
  const parentPath = writePipeline(
    root,
    "parent",
    `
export default ({ pipeline, forEachPipeline }) => pipeline("parent")
  .maxCost(5)
  .add(forEachPipeline({
    id: "tickets",
    name: "Tickets",
    items: ["T-1", "T-2", "T-3"],
    pipeline: "./${childPath.slice(root.length + 1)}",
    afterEach: { pipeline: "./${afterPath.slice(root.length + 1)}" },
    afterAll: { pipeline: "./${afterPath.slice(root.length + 1)}" },
  }))
  .build();
`,
  );
  const base = buildPipelineContext({ cwd: root, ticket: "P", agentBackendRegistry: REGISTRY });
  const context = buildPipelineContext({
    cwd: root,
    ticket: "P",
    agentBackendRegistry: REGISTRY,
    config: { ...base.config, profiles: { ...base.config.profiles, coder: { backends: { [UNPRICED_BACKEND]: {} } } } },
  });
  return { parentPath, context };
}

test("pipeline-orchestration: a fan-out stops spawning children once its ceiling is unenforceable", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-fanout-strict-"));
  const { parentPath, context } = unpricedFanOut(root);
  unpricedSpawns.length = 0;

  const parent = await loadOrCreateRun(
    parentPath,
    "P",
    undefined,
    undefined,
    join(root, "parent-run"),
    true,
    undefined,
    context,
  );
  const outcome = await executeRunSteps(
    parent,
    "P",
    undefined,
    { resuming: false },
    stepLoopDeps(NULL_RUN_OUTPUT),
    context,
  );
  finalizeRun(parent, outcome);

  // Exactly one child ran. The gate is the same decision step admission reads, so
  // the second item, its `afterEach`, and the `afterAll` were all withheld.
  expect(unpricedSpawns).toHaveLength(1);
  expect(outcome.costUnaccounted).toBe(true);
  expect(outcome.costUnaccountedStop).toBe(true);
  expect(outcome.budgetExceeded).toBe(false);
  expect(parent.status).toBe("FAIL");

  // The remaining work is left pending, not skipped and not failed: the fan-out
  // resumes where it stopped once the operator decides.
  const state = parent.steps[0]!.orchestration!;
  expect(state.items).toEqual(["T-1", "T-2", "T-3"]);
  expect(state.children.filter((child) => child.kind === "main")).toHaveLength(1);
  expect(state.children.map((child) => child.status)).toEqual(["done"]);
  expect(String(parent.steps[0]!.errors)).toContain("unaccounted");

  // The refused launches are journaled on the PARENT — the children they would
  // have created have no journal — and journaled ONCE, though three gates
  // (item 2, item 3, the `afterAll`) each observed the same stop.
  const events = readRunEvents(parent.run_dir).filter((event) => event.type === "run.cost.unaccounted");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ stepId: parent.steps[0]!.id, maxCostUsd: 5 });
  expect(readRunEvents(parent.run_dir).filter((event) => event.type === "run.budget.exceeded")).toHaveLength(0);
  // And the stop is the run's typed reason, not the failed node's sentence.
  expect(parent.outcome?.stopKind).toBe("cost-unaccounted");
}, 30_000);

test("pipeline-orchestration: an authorized fan-out runs every item and both callbacks", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-fanout-authorized-"));
  const { parentPath, context } = unpricedFanOut(root);
  unpricedSpawns.length = 0;

  const parent = await loadOrCreateRun(
    parentPath,
    "P",
    undefined,
    undefined,
    join(root, "parent-run"),
    true,
    undefined,
    context,
    { allowUnmetered: true },
  );
  const outcome = await executeRunSteps(
    parent,
    "P",
    undefined,
    { resuming: false },
    stepLoopDeps(NULL_RUN_OUTPUT),
    context,
  );
  finalizeRun(parent, outcome);

  // Three items plus three `afterEach` plus one `afterAll`.
  expect(unpricedSpawns).toHaveLength(7);
  expect(outcome.costUnaccounted).toBe(false);
  expect(outcome.costUnaccountedStop).toBe(false);
  expect(outcome.failed).toBe(false);
  // Authorizing does not launder the uncertainty: the total stays a lower bound.
  expect(parent.cost_unaccounted).toBe(true);
}, 60_000);

test("pipeline-orchestration: re-reconciling a child that costs nothing new keeps its unknown price", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-zero-delta-"));
  const { parentPath, context } = unpricedComposition(root);
  const runDir = join(root, "parent-run");
  unpricedSpawns.length = 0;

  // First pass: the child spends tokens at an unknown price, so the parent stops
  // before the child's second step and the node is reconciled once.
  const parent = await loadOrCreateRun(parentPath, "P", undefined, undefined, runDir, true, undefined, context);
  const outcome = await executeRunSteps(
    parent,
    "P",
    undefined,
    { resuming: false },
    stepLoopDeps(NULL_RUN_OUTPUT),
    context,
  );
  finalizeRun(parent, outcome);
  const ref = parent.steps[0]!.orchestration!.children[0]!;
  expect(parent.steps[0]!.control?.cost_unknown).toBe(true);
  expect(ref.accountedDurationMs).toBeGreaterThan(0);

  // Now force a second reconciliation of the same child with nothing new to
  // charge — the shape a resume produces once the deltas are zero — and with the
  // node's own totals gone, as a snapshot written before this node had control
  // data leaves them. The flag must survive: an unpriced subtree charged at $0.00
  // exact is the same lie in a smaller font.
  const authorizedChild = await loadOrCreateRun(
    join(root, "child.ts"),
    "P",
    undefined,
    undefined,
    join(pipelineRunsDir("child", "P", context), ref.runId!),
    false,
    undefined,
    context,
    { parentRunId: parent.runId, parentNodeId: parent.steps[0]!.id, allowUnmetered: true },
  );
  const childOutcome = await executeRunSteps(
    authorizedChild,
    "P",
    undefined,
    { resuming: true },
    stepLoopDeps(NULL_RUN_OUTPUT),
    context,
  );
  finalizeRun(authorizedChild, childOutcome);
  expect(authorizedChild.status).toBe("PASS");

  ref.status = "running";
  ref.accountedCostUsd = 999;
  ref.accountedDurationMs = 999_999;
  delete parent.steps[0]!.control;
  delete parent.cost_unaccounted;
  updateStep(parent, parent.steps[0]!, "failed", "interruption after accounting");
  saveRun(parent);

  const second = await executeRunSteps(
    parent,
    "P",
    undefined,
    { resuming: true },
    stepLoopDeps(NULL_RUN_OUTPUT),
    context,
  );
  finalizeRun(parent, second);

  const snapshot = readRunSnapshot(join(runDir, "state.json"))!;
  expect(snapshot.steps[0]?.control?.total_cost_usd).toBe(0);
  expect(snapshot.steps[0]?.control?.cost_unknown).toBe(true);
  expect(snapshot.cost_unaccounted).toBe(true);
}, 30_000);

test("pipeline-orchestration: an authorized root propagates the authorization to its children", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-unmetered-root-"));
  const { parentPath, context } = unpricedComposition(root);
  const runDir = join(root, "parent-run");

  const parent = await loadOrCreateRun(parentPath, "P", undefined, undefined, runDir, true, undefined, context, {
    allowUnmetered: true,
  });
  expect(parent.allow_unmetered).toBe(true);
  const outcome = await executeRunSteps(
    parent,
    "P",
    undefined,
    { resuming: false },
    stepLoopDeps(NULL_RUN_OUTPUT),
    context,
  );
  finalizeRun(parent, outcome);

  // The child never had the flag: it received the authorization through the
  // budget scope its root owns, so both of its steps ran.
  expect(outcome.failed).toBe(false);
  expect(outcome.costUnaccounted).toBe(false);
  const childRef = parent.steps[0]!.orchestration!.children[0]!;
  expect(childRef.status).toBe("done");
  const childSnapshot = readRunSnapshot(join(pipelineRunsDir("child", "P", context), childRef.runId!, "state.json"))!;
  expect(childSnapshot.allow_unmetered).toBe(true);
  expect(childSnapshot.cost_unaccounted).toBe(true);
  expect(childSnapshot.steps.map((step) => step.status)).toEqual(["done", "done"]);
  // Authorizing does not launder the uncertainty: the parent inherits it too.
  expect(parent.cost_unaccounted).toBe(true);
}, 30_000);

test("pipeline-orchestration: a composed child cannot authorize itself past a strict ancestor", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-unmetered-child-"));
  const { parentPath, context } = unpricedComposition(root);
  const runDir = join(root, "parent-run");

  // A strict root: the child stops after its first unpriced attempt, and the
  // parent reports the accounting stop rather than a technical failure.
  const parent = await loadOrCreateRun(parentPath, "P", undefined, undefined, runDir, true, undefined, context);
  const outcome = await executeRunSteps(
    parent,
    "P",
    undefined,
    { resuming: false },
    stepLoopDeps(NULL_RUN_OUTPUT),
    context,
  );
  finalizeRun(parent, outcome);
  expect(outcome.costUnaccounted).toBe(true);

  const childRef = parent.steps[0]!.orchestration!.children[0]!;
  const childDir = join(pipelineRunsDir("child", "P", context), childRef.runId!);
  const stopped = readRunSnapshot(join(childDir, "state.json"))!;
  expect(stopped.cost_unaccounted).toBe(true);
  expect(stopped.allow_unmetered).toBeUndefined();
  expect(stopped.steps.map((step) => step.status)).toEqual(["done", "pending"]);

  // Resuming the child DIRECTLY with the flag must not weaken the capped strict
  // policy its ancestor imposed: the authorization belongs to the run that owns
  // the budget scope, and is refused here.
  const childPath = join(root, "child.ts");
  const resumedChild = await loadOrCreateRun(
    childPath,
    "P",
    undefined,
    undefined,
    childDir,
    false,
    undefined,
    context,
    {
      allowUnmetered: true,
    },
  );
  expect(resumedChild.allow_unmetered).toBeUndefined();
  expect(resumedChild.cost_unaccounted).toBe(true);
  const childOutcome = await executeRunSteps(
    resumedChild,
    "P",
    undefined,
    { resuming: true },
    stepLoopDeps(NULL_RUN_OUTPUT),
    context,
  );
  expect(childOutcome.costUnaccounted).toBe(true);
  expect(resumedChild.steps.map((step) => step.status)).toEqual(["done", "pending"]);
}, 30_000);

/** Parent whose orchestration node already names a child run, as the parent
 *  persists it before booting the child. `started` also journals the durable
 *  `pipeline.child.started` fact for that identity. */
async function parentWithNamedChild(root: string, started: boolean) {
  const childPath = writePipeline(root, "child", actionPipelineSource("child", "child"));
  const parentPath = writePipeline(
    root,
    "parent",
    `
export default ({ pipeline, forEachPipeline }) => pipeline("parent")
  .add(forEachPipeline({
    id: "children", name: "Children", items: ["P-01"], pipeline: "./${childPath.slice(root.length + 1)}",
  })).build();
`,
  );
  const parentRunDir = join(root, "parent-run");
  const context = buildPipelineContext({ cwd: root, ticket: "P", agentBackendRegistry: REGISTRY });
  const parent = await loadOrCreateRun(parentPath, "P", undefined, undefined, parentRunDir, true, undefined, context);
  const parentStep = parent.steps[0]!;
  const childRunId = "named-child";
  parentStep.status = "running";
  parentStep.orchestration = {
    kind: "forEachPipeline",
    items: ["P-01"],
    children: [
      {
        key: "main:0",
        kind: "main",
        pipeline: `./${childPath.slice(root.length + 1)}`,
        ticket: "P-01",
        runId: childRunId,
        status: "running",
        accountedCostUsd: 0,
      },
    ],
  };
  saveRun(parent);
  if (started) {
    appendRunEvent(parent, "pipeline.child.started", {
      parentNodeId: parentStep.id,
      childRunId,
      childPipeline: "child",
      childTicket: "P-01",
    });
  }
  const childContext = buildPipelineContext({ cwd: root, ticket: "P-01", agentBackendRegistry: REGISTRY });
  const childRunDir = join(pipelineRunsDir("child", "P-01", childContext), childRunId);
  return { parentPath, parentRunDir, childRunDir };
}

// Invariant: a child identity the parent journaled as started is never reused
// for a fresh child. The parent records the runId before booting the child, so
// the runId alone allows a retry; `pipeline.child.started` forbids it.
test("invariant: a journaled child start with a lost child snapshot never starts a second child under that identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-invariant-child-identity-"));
  const { parentPath, parentRunDir, childRunDir } = await parentWithNamedChild(root, true);

  const { run, outcome } = await executeParent(parentPath, root, "P", parentRunDir, false);

  expect(outcome.failed).toBe(true);
  const child = run.steps[0]!.orchestration!.children[0]!;
  expect(child.status).toBe("failed");
  expect(child.outcome?.reason).toMatch(/Cannot resume selected snapshot/);
  // The child's step never ran, and no run directory was created for the identity.
  expect(existsSync(join(root, "trace.log"))).toBe(false);
  expect(existsSync(childRunDir)).toBe(false);
});

// Invariant: an unreadable parent journal must not read as "child never started".
// The read fails the parent instead of launching a child, since a second child
// under a journaled identity is the one outcome the journal exists to prevent.
test("invariant: an unreadable parent journal launches no child", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-invariant-unreadable-journal-"));
  const { parentPath, parentRunDir, childRunDir } = await parentWithNamedChild(root, false);
  // A directory where the journal file should be: EISDIR, not ENOENT.
  rmSync(join(parentRunDir, "events.jsonl"));
  mkdirSync(join(parentRunDir, "events.jsonl"));

  await expect(executeParent(parentPath, root, "P", parentRunDir, false)).rejects.toThrow(/EISDIR/);

  expect(existsSync(join(root, "trace.log"))).toBe(false);
  expect(existsSync(childRunDir)).toBe(false);
});

// Invariant: a reference bound to a run id the journal never saw started is a
// crash between `bindChildRun` and the child boot. The next generation retries
// the initialization under the SAME id, and the child runs exactly once.
test("invariant: a child bound but never started is retried under the same identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-invariant-child-bound-"));
  const { parentPath, parentRunDir, childRunDir } = await parentWithNamedChild(root, false);

  const { run, outcome } = await executeParent(parentPath, root, "P", parentRunDir, false);

  expect(outcome.failed).toBe(false);
  expect(run.status).toBe("PASS");
  const ref = run.steps[0]!.orchestration!.children[0]!;
  expect(ref).toMatchObject({ status: "done", runId: "named-child" });
  expect(readFileSync(join(root, "trace.log"), "utf8").trim().split("\n")).toEqual(["child:P-01"]);
  expect(existsSync(join(childRunDir, "state.json"))).toBe(true);
  const events = readRunEvents(parentRunDir);
  expect(events.filter((event) => event.type === "pipeline.child.started").map((event) => event.childRunId)).toEqual([
    "named-child",
  ]);
  expect(events.filter((event) => event.type === "pipeline.child.finished")).toHaveLength(1);
});

/** A `runPipeline` parent over a one-step priced child, with the profile the cost
 *  backend needs. */
function pricedComposition(root: string, childCost: number): { parentPath: string; context: PipelineContext } {
  const childPath = writePipeline(
    root,
    "child",
    `
export default ({ pipeline, llmStep }) => pipeline("child")
  .add(llmStep({ id: "a", name: "a", backend: ${JSON.stringify(COST_BACKEND)}, profile: "coder", options: { cost: ${childCost} }, command: "a" }))
  .build();
`,
  );
  const parentPath = writePipeline(
    root,
    "parent",
    `
export default ({ pipeline, runPipeline }) => pipeline("parent")
  .add(runPipeline({ id: "child", name: "child", pipeline: "./${childPath.slice(root.length + 1)}" }))
  .build();
`,
  );
  const base = buildPipelineContext({ cwd: root, ticket: "P", agentBackendRegistry: REGISTRY });
  const context = buildPipelineContext({
    cwd: root,
    ticket: "P",
    agentBackendRegistry: REGISTRY,
    config: { ...base.config, profiles: { ...base.config.profiles, coder: { backends: { [COST_BACKEND]: {} } } } },
  });
  return { parentPath, context };
}

// A crash between the child's own verdict and the parent's settlement: the child
// snapshot is PASS, the parent reference still says `running` and its accounting
// is behind. The resume settles the child WITHOUT running it again, and the
// reconciliation charges the difference the snapshot missed — once.
test("pipeline-orchestration: a child already finished is settled without running again, and charged once", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-finished-child-"));
  const { parentPath, context } = pricedComposition(root, 1);
  const runDir = join(root, "parent-run");
  costCalls.length = 0;

  const first = await executeParent(parentPath, root, "P", runDir, true, context);
  expect(first.run.status).toBe("PASS");
  const firstStep = first.run.steps[0]!;
  const firstDuration = firstStep.control?.duration_ms ?? 0;
  expect(firstStep.control?.total_cost_usd).toBeCloseTo(1, 10);
  expect(firstDuration).toBeGreaterThan(0);
  const ref = firstStep.orchestration!.children[0]!;
  expect(ref.status).toBe("done");
  expect(ref.accountedCostUsd).toBeCloseTo(1, 10);
  expect(ref.accountedDurationMs).toBe(firstDuration);

  // Roll the parent back to the crash window: reference running, nothing charged.
  ref.status = "running";
  ref.accountedCostUsd = 0;
  delete ref.accountedDurationMs;
  delete ref.accountedUsage;
  delete firstStep.control;
  delete firstStep.usage;
  updateStep(first.run, firstStep, "failed", "crash before settlement");
  saveRun(first.run);

  // A second launch of the child would hit this trap and fail the run.
  costCalls.push({ ok: false, cost: 5 });
  const resumed = await executeParent(parentPath, root, "P", runDir, false, context);
  costCalls.length = 0;

  expect(resumed.run.status).toBe("PASS");
  expect(resumed.outcome.cumulativeCost).toBeCloseTo(1, 10);
  const step = resumed.run.steps[0]!;
  expect(step.control?.total_cost_usd).toBeCloseTo(1, 10);
  expect(step.control?.duration_ms).toBe(firstDuration);
  expect(step.orchestration!.children[0]).toMatchObject({
    status: "done",
    runId: ref.runId,
    accountedCostUsd: 1,
    accountedDurationMs: firstDuration,
  });
  const events = readRunEvents(runDir);
  // One child identity, started once per generation, finished once per
  // generation; the second reconciliation posts the difference the snapshot lost.
  expect(new Set(events.filter((e) => e.type === "pipeline.child.started").map((e) => e.childRunId)).size).toBe(1);
  expect(events.filter((e) => e.type === "pipeline.child.finished").map((e) => e.status)).toEqual(["done", "done"]);
  expect(events.filter((e) => e.type === "pipeline.child.cost.reconciled").map((e) => e.deltaCostUsd)).toEqual([1, 1]);
});

function twoStepActionPipelineSource(name: string): string {
  return `
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const trace = (label) => ctx => { appendFileSync(join(ctx.cwd, "trace.log"), label + ":" + (ctx.ticket ?? "-") + "\\n"); };
export default ({ pipeline, actionStep }) => pipeline(${JSON.stringify(name)})
  .add(actionStep({ id: "a", name: "a", run: trace("a"), describe: "a" }))
  .add(actionStep({ id: "b", name: "b", run: trace("b"), describe: "b" }))
  .build();
`;
}

// An interrupted child (SIGINT while its first step ran) is resumed by the parent
// under the same identity: the interrupted step is replayed, the pending one
// runs, and the reference settles `done`.
test("pipeline-orchestration: an interrupted child is resumed under its identity and settled", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-interrupted-child-"));
  const childPath = writePipeline(root, "child", twoStepActionPipelineSource("child"));
  const parentPath = writePipeline(
    root,
    "parent",
    `
export default ({ pipeline, runPipeline }) => pipeline("parent")
  .add(runPipeline({ id: "child", name: "child", pipeline: "./${childPath.slice(root.length + 1)}", ticket: "C-1" }))
  .build();
`,
  );
  const parentRunDir = join(root, "parent-run");
  const context = buildPipelineContext({ cwd: root, ticket: "P", agentBackendRegistry: REGISTRY });
  const parent = await loadOrCreateRun(parentPath, "P", undefined, undefined, parentRunDir, true, undefined, context);
  const parentStep = parent.steps[0]!;
  const childRunId = "interrupted-child";
  const childContext = buildPipelineContext({ cwd: root, ticket: "C-1", agentBackendRegistry: REGISTRY });
  const childRunDir = join(pipelineRunsDir("child", "C-1", childContext), childRunId);
  mkdirSync(childRunDir, { recursive: true });
  writeFileSync(
    join(childRunDir, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: childRunId,
      name: "child",
      ticket: "C-1",
      pipeline: "child",
      pipeline_path: childPath,
      status: "ABORTED",
      aborted: true,
      outcome: { phase: "a", reason: "interrupted", logPath: null, resumable: true },
      parentRunId: parent.runId,
      parentNodeId: parentStep.id,
      rootRunId: parent.rootRunId,
      budgetScopeId: parent.budgetScopeId,
      steps: [
        { id: "a", status: "aborted", retries: 0 },
        { id: "b", status: "pending", retries: 0 },
      ],
    }),
  );
  parentStep.status = "aborted";
  parentStep.orchestration = {
    kind: "runPipeline",
    children: [
      {
        key: "main",
        kind: "main",
        pipeline: `./${childPath.slice(root.length + 1)}`,
        ticket: "C-1",
        runId: childRunId,
        status: "running",
        accountedCostUsd: 0,
      },
    ],
  };
  saveRun(parent);
  appendRunEvent(parent, "pipeline.child.started", {
    parentNodeId: parentStep.id,
    childRunId,
    childPipeline: "child",
    childTicket: "C-1",
  });

  const resumed = await executeParent(parentPath, root, "P", parentRunDir, false, context);

  expect(resumed.run.status).toBe("PASS");
  expect(resumed.run.steps[0]!.orchestration!.children[0]).toMatchObject({ status: "done", runId: childRunId });
  expect(readFileSync(join(root, "trace.log"), "utf8").trim().split("\n")).toEqual(["a:C-1", "b:C-1"]);
  const childState = readRunSnapshot(join(childRunDir, "state.json"))!;
  expect(childState.status).toBe("PASS");
  expect(childState.aborted).toBeFalsy();
  expect(childState.steps.map((step) => step.status)).toEqual(["done", "done"]);
});

/** root ─runPipeline─▶ mid ─runPipeline─▶ leaf. The leaf spends $1 on a priced
 *  step, then fails on an action step until a marker file appears, then spends
 *  $1 more: the whole tree fails once and resumes once. */
function nestedComposition(root: string): { rootPath: string; context: PipelineContext } {
  const leafPath = writePipeline(
    root,
    "leaf",
    `
import { existsSync } from "node:fs";
import { join } from "node:path";

export default ({ pipeline, llmStep, actionStep }) => pipeline("leaf")
  .add(llmStep({ id: "a", name: "a", backend: ${JSON.stringify(COST_BACKEND)}, profile: "coder", options: { cost: 1 }, command: "a" }))
  .add(actionStep({ id: "gate", name: "gate", run: ctx => { if (!existsSync(join(ctx.cwd, "go"))) throw new Error("not yet"); }, describe: "gate" }))
  .add(llmStep({ id: "b", name: "b", backend: ${JSON.stringify(COST_BACKEND)}, profile: "coder", options: { cost: 1 }, command: "b" }))
  .build();
`,
  );
  const midPath = writePipeline(
    root,
    "mid",
    `
export default ({ pipeline, runPipeline }) => pipeline("mid")
  .add(runPipeline({ id: "leaf", name: "leaf", pipeline: "./${leafPath.slice(root.length + 1)}", ticket: "L-1" }))
  .build();
`,
  );
  const rootPath = writePipeline(
    root,
    "root",
    `
export default ({ pipeline, runPipeline }) => pipeline("root")
  .add(runPipeline({ id: "mid", name: "mid", pipeline: "./${midPath.slice(root.length + 1)}", ticket: "M-1" }))
  .build();
`,
  );
  const base = buildPipelineContext({ cwd: root, ticket: "R", agentBackendRegistry: REGISTRY });
  const context = buildPipelineContext({
    cwd: root,
    ticket: "R",
    agentBackendRegistry: REGISTRY,
    config: { ...base.config, profiles: { ...base.config.profiles, coder: { backends: { [COST_BACKEND]: {} } } } },
  });
  return { rootPath, context };
}

function childEvents(runDir: string) {
  const events = readRunEvents(runDir);
  return {
    startedIds: [...new Set(events.filter((e) => e.type === "pipeline.child.started").map((e) => e.childRunId))],
    finished: events.filter((e) => e.type === "pipeline.child.finished").map((e) => e.status),
    deltas: events.filter((e) => e.type === "pipeline.child.cost.reconciled").map((e) => e.deltaCostUsd),
  };
}

// A nested tree resumed from the root: every level re-enters its child under the
// same identity, is charged by difference, and ends with the leaf's figures —
// cost and duration — at every level.
test("pipeline-orchestration: a nested tree resumes under the same identities and is charged once per level", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-nested-"));
  const { rootPath, context } = nestedComposition(root);
  const runDir = join(root, "root-run");
  costCalls.length = 0;

  const first = await executeParent(rootPath, root, "R", runDir, true, context);
  expect(first.run.status).toBe("FAIL");
  expect(first.outcome.cumulativeCost).toBeCloseTo(1, 10);
  const midRef = first.run.steps[0]!.orchestration!.children[0]!;
  expect(midRef.status).toBe("failed");
  expect(midRef.accountedCostUsd).toBeCloseTo(1, 10);
  expect(first.run.steps[0]!.control?.total_cost_usd).toBeCloseTo(1, 10);

  writeFileSync(join(root, "go"), "");
  const resumed = await executeParent(rootPath, root, "R", runDir, false, context);

  expect(resumed.run.status).toBe("PASS");
  expect(resumed.outcome.cumulativeCost).toBeCloseTo(2, 10);
  const rootStep = resumed.run.steps[0]!;
  expect(rootStep.control?.total_cost_usd).toBeCloseTo(2, 10);
  const resumedMidRef = rootStep.orchestration!.children[0]!;
  expect(resumedMidRef).toMatchObject({ status: "done", runId: midRef.runId, accountedCostUsd: 2 });

  // Middle level: same identity for the leaf across both generations, charged
  // $1 then $1, and carrying the leaf's figures.
  const midContext = buildPipelineContext({ cwd: root, ticket: "M-1", agentBackendRegistry: REGISTRY });
  const midRunDir = join(pipelineRunsDir("mid", "M-1", midContext), midRef.runId!);
  const mid = readRunSnapshot(join(midRunDir, "state.json"))!;
  expect(mid.status).toBe("PASS");
  const leafRef = mid.steps[0]!.orchestration!.children[0]!;
  expect(leafRef).toMatchObject({ status: "done", accountedCostUsd: 2 });
  expect(mid.steps[0]!.control?.total_cost_usd).toBeCloseTo(2, 10);
  const leafContext = buildPipelineContext({ cwd: root, ticket: "L-1", agentBackendRegistry: REGISTRY });
  const leaf = readRunSnapshot(join(pipelineRunsDir("leaf", "L-1", leafContext), leafRef.runId!, "state.json"))!;
  expect(leaf.status).toBe("PASS");
  expect(leaf.total_control?.total_cost_usd).toBeCloseTo(2, 10);
  // Durations travel with the dollars: the leaf's time is the mid node's time,
  // and the mid run's time is the root node's time.
  const leafDuration = leaf.total_control!.duration_ms;
  expect(leafDuration).toBeGreaterThan(0);
  expect(mid.steps[0]!.control?.duration_ms).toBe(leafDuration);
  expect(leafRef.accountedDurationMs).toBe(leafDuration);
  expect(rootStep.control?.duration_ms).toBe(mid.total_control!.duration_ms);
  expect(resumedMidRef.accountedDurationMs).toBe(mid.total_control!.duration_ms);

  expect(childEvents(runDir)).toEqual({
    startedIds: [midRef.runId!],
    finished: ["failed", "done"],
    deltas: [1, 1],
  });
  expect(childEvents(midRunDir)).toEqual({
    startedIds: [leafRef.runId!],
    finished: ["failed", "done"],
    deltas: [1, 1],
  });
});

// A SIGINT while a child step runs. The child's action step plays the signal
// handler (`installChildKillHandlers` minus the process exit): it requests the
// abort on the scope the parent and the child share and persists it for every
// active run. Neither loop may spawn anything afterwards, and both snapshots
// must carry the interruption.
test("pipeline-orchestration: an abort during a child step stops the child and the parent without a new spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipeline-compose-abort-"));
  // The pipeline module runs in this process but cannot import the test's scope:
  // it reaches the handler through a per-test global, removed at the end.
  const hook = `lanceNuitAbortHook_${process.pid}`;
  const childPath = writePipeline(
    root,
    "child",
    `
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const trace = (label) => ctx => { appendFileSync(join(ctx.cwd, "trace.log"), label + ":" + (ctx.ticket ?? "-") + "\\n"); };
export default ({ pipeline, actionStep }) => pipeline("child")
  .add(actionStep({ id: "a", name: "a", run: ctx => { trace("a")(ctx); globalThis[${JSON.stringify(hook)}](); }, describe: "a" }))
  .add(actionStep({ id: "b", name: "b", run: trace("b"), describe: "b" }))
  .build();
`,
  );
  const parentPath = writePipeline(
    root,
    "parent",
    `
export default ({ pipeline, runPipeline }) => pipeline("parent")
  .add(runPipeline({ id: "child", name: "child", pipeline: "./${childPath.slice(root.length + 1)}", ticket: "C-1" }))
  .build();
`,
  );
  const runDir = join(root, "parent-run");
  const context = buildPipelineContext({ cwd: root, ticket: "P", agentBackendRegistry: REGISTRY });
  const parent = await loadOrCreateRun(parentPath, "P", undefined, undefined, runDir, true, undefined, context);
  const abort = createAbortScope();
  let activeAtSignal: string[] = [];
  (globalThis as Record<string, unknown>)[hook] = () => {
    abort.requestAbort("SIGINT");
    activeAtSignal = abort.activeRuns().map((active) => active.pipeline);
    for (const active of abort.activeRuns()) abortRun(active, "SIGINT");
  };
  try {
    const outcome = await executeRunSteps(
      parent,
      "P",
      undefined,
      { resuming: false, abort },
      stepLoopDeps(NULL_RUN_OUTPUT),
      context,
    );
    finalizeRun(parent, outcome);
  } finally {
    delete (globalThis as Record<string, unknown>)[hook];
  }

  // Innermost first: the handler persists the child before the parent.
  expect(activeAtSignal).toEqual(["child", "parent"]);
  // Step `b` of the child never ran: no spawn after the request.
  expect(readFileSync(join(root, "trace.log"), "utf8").trim().split("\n")).toEqual(["a:C-1"]);
  expect(parent.status).toBe("ABORTED");
  expect(parent.steps[0]!.status).toBe("aborted");
  const ref = parent.steps[0]!.orchestration!.children[0]!;
  const childContext = buildPipelineContext({ cwd: root, ticket: "C-1", agentBackendRegistry: REGISTRY });
  const child = readRunSnapshot(join(pipelineRunsDir("child", "C-1", childContext), ref.runId!, "state.json"))!;
  expect(child.status).toBe("ABORTED");
  expect(child.aborted).toBe(true);
  expect(child.steps.map((step) => step.status)).toEqual(["aborted", "pending"]);
  // Nothing in the scope once both loops have returned.
  expect(abort.activeRuns()).toEqual([]);
});
