import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workItemDeliveryStep } from "../../src/builtin-steps/lib/work-item-steps.js";
import type { OnFail } from "../../src/dsl/dsl-types.js";
import { createProjectBashStep } from "../../src/dsl/dsl-steps.js";
import {
  createInternalWorkItemSourceStep,
  forEachPipeline,
  llmStep,
  mechanicalFix,
  pipeline,
  runPipeline,
} from "../../src/dsl.js";
import { createFakeWorkItemGateway } from "../../src/modules/work-item/fake.js";
import { createDefaultWorkItemGatewayRegistry } from "../../src/modules/work-item/registry.js";
import { buildPipelineContext } from "../../src/pipeline/context.js";
import { createDefaultAgentBackendRegistry } from "../../src/engine/default-registry.js";

/** Explicit registry: the DSL no longer falls back to the built-in composition. */
const REGISTRY = createDefaultAgentBackendRegistry();

/** Steps are declared through the loaded DSL: the factories are bound to the
 *  run registry, which a fix carrying Claude options needs. */
const bashStep = createProjectBashStep(REGISTRY);

function step(id: string) {
  return bashStep({ id, name: id, command: "true" });
}

test("add flattens exactly one level and preserves order", () => {
  const definition = pipeline("composition")
    .add(step("one"), [step("two"), step("three")], step("four"))
    .build();

  expect(definition.steps.map((current) => current.id)).toEqual(["one", "two", "three", "four"]);
});

test("forEachWorkItem places the internal source before the body", () => {
  const definition = pipeline("loop")
    .forEachWorkItem({
      queue: "featureTodo",
      scan: { limit: 3, query: "project = PROJ AND assignee = currentUser()" },
      do: [step("one"), [step("two")], []],
    })
    .build();

  expect(definition.work_item_source).toEqual({
    step_id: "ticket",
    queue: "featureTodo",
    scan: { limit: 3, query: "project = PROJ AND assignee = currentUser()" },
  });
  expect(definition.steps.map((current) => current.id)).toEqual(["ticket", "one", "two"]);
});

test("forEachWorkItem preserves prerequisites before the source and configures loading", async () => {
  const definition = pipeline("loop-with-load-policy")
    .forEachWorkItem({
      queue: "featureTodo",
      before: [step("preflight")],
      load: { retries: 1 },
      do: [step("body")],
    })
    .build();

  expect(definition.steps.map((current) => current.id)).toEqual(["preflight", "ticket", "body"]);
  expect(definition.steps[1]!.on_failure).toEqual({ max_retries: 1 });

  const cwd = mkdtempSync(join(tmpdir(), "work-item-closed-"));
  const gateway = createFakeWorkItemGateway({
    items: [{ ref: "PROJ-1", title: "Title", description: "Description", closed: true }],
  });
  const context = buildPipelineContext({ cwd, ticket: "PROJ-1", workItem: gateway });
  await expect(definition.steps[1]!.action!(context)).rejects.toThrow(/already closed/);

  const allowedCwd = mkdtempSync(join(tmpdir(), "work-item-closed-allowed-"));
  const allowed = pipeline("loop-allow-closed")
    .forEachWorkItem({ queue: "featureTodo", load: { allowClosed: true }, do: [] })
    .build();
  const allowedContext = buildPipelineContext({ cwd: allowedCwd, ticket: "PROJ-1", workItem: gateway });
  await allowed.steps[0]!.action!(allowedContext);
  expect(existsSync(join(allowedContext.paths.artifactsDir!, "ticket.md"))).toBe(true);
});

test("forEachWorkItem links work-item steps to its source", () => {
  const definition = pipeline("delivery-loop")
    .forEachWorkItem({
      queue: "featureTodo",
      dir: "/tmp/work-item-loop",
      do: [workItemDeliveryStep({ mrUrl: () => "" })],
    })
    .build();

  expect(definition.steps.map((current) => current.id)).toEqual(["ticket", "work-item-update"]);
});

test("late work-item binding: delivery may precede the explicit source", () => {
  const source = createInternalWorkItemSourceStep({
    queue: "bugTodo",
    dir: () => "/tmp/work-item-late-source",
  });
  const definition = pipeline("late-source")
    .add(workItemDeliveryStep({ mrUrl: () => "" }), source)
    .build();

  expect(definition.work_item_source).toEqual({ step_id: "ticket", queue: "bugTodo" });
  expect(definition.steps.map((current) => current.id)).toEqual(["work-item-update", "ticket"]);
});

test("the failure policies retain their shape", () => {
  const prompt = () => "corrige";
  const definition = pipeline("failure-policies")
    .add(
      step("rerun").onFail({ retries: 2 }),
      step("fix-retry").onFail({ fix: prompt, retries: 3, backendOptions: { trace: true } }),
      step("fix-default-retries").onFail({ fix: prompt }),
      step("resume-fix").onFail({ fix: prompt, resumeSession: "implement", retries: 4, resumeSizeThresholdKb: 128 }),
    )
    .build();

  expect(definition.steps.map((current) => current.on_failure)).toEqual([
    { max_retries: 2 },
    { fix_prompt: prompt, max_retries: 3, backend_options: { trace: true } },
    { fix_prompt: prompt, max_retries: 1 },
    { fix_prompt: prompt, resume_session: "implement", max_retries: 4, resume_size_threshold_kb: 128 },
  ]);
});

test("the builder refuses a policy whose options could never apply", () => {
  const prompt = () => "corrige";
  // `resumeSession` without `fix` is a type error (tests/dsl/dsl-options.test.ts
  // asserts it with @ts-expect-error); an untyped JavaScript caller still reaches here.
  expect(() =>
    step("resume-without-fix").onFail({ retries: 2, resumeSession: "implement" } as unknown as OnFail),
  ).toThrow(/onFail: resumeSession requires fix/);
  // The target is an id, never a bare flag.
  expect(() => step("resume-blank").onFail({ fix: prompt, resumeSession: " " })).toThrow(
    /resumeSession must be a non-empty string/,
  );
  // A fix loop bounded to zero attempts would fail the step without repairing it.
  expect(() => step("fix-without-retry").onFail({ fix: prompt, retries: 0 })).toThrow(
    /onFail: retries must be >= 1 when fix is set/,
  );
});

test("mechanicalFix repairs in a fresh session", () => {
  const prompt = () => "corrige";
  const definition = step("checks").onFail(mechanicalFix(prompt)).build();

  expect(definition.on_failure).toMatchObject({
    fix_prompt: prompt,
    max_retries: 2,
    fix_profile: "coder",
    escalate_effort: "high",
  });
});

test("fix claude options apply only when the fix backend is Claude", () => {
  const fix = mechanicalFix(() => "corrige");
  const definition = pipeline("fix-backends")
    .add(
      llmStep(
        { id: "on-claude", name: "on-claude", profile: "coder", backend: "claude", command: "go", onFail: fix },
        REGISTRY,
      ),
      llmStep(
        { id: "on-codex", name: "on-codex", profile: "coder", backend: "codex", command: "go", onFail: fix },
        REGISTRY,
      ),
      step("on-bash").onFail(fix),
    )
    .build();

  const [onClaude, onCodex, onBash] = definition.steps;
  expect(onClaude!.on_failure!.backend_options).toBeDefined();
  expect(onCodex!.on_failure!.backend_options).toBeUndefined();
  // A bash step's fix runs on the default backend (claude): options apply.
  expect(onBash!.on_failure!.backend_options).toBeDefined();
});

test("work-item directory: explicit dir wins, otherwise artifactsDir", async () => {
  const explicit = mkdtempSync(join(tmpdir(), "work-item-explicit-"));
  const gateway = createFakeWorkItemGateway({
    items: [{ ref: "PROJ-1", title: "Title", description: "Description", closed: false }],
  });
  const explicitDefinition = pipeline("explicit-dir")
    .forEachWorkItem({ queue: "featureTodo", dir: explicit, do: [] })
    .build();
  const explicitContext = buildPipelineContext({ cwd: explicit, ticket: "PROJ-1", workItem: gateway });
  await explicitDefinition.steps[0]!.action!(explicitContext);
  expect(existsSync(join(explicit, "ticket.md"))).toBe(true);

  const defaultCwd = mkdtempSync(join(tmpdir(), "work-item-default-"));
  const defaultDefinition = pipeline("default-dir").forEachWorkItem({ queue: "featureTodo", do: [] }).build();
  const defaultContext = buildPipelineContext({ cwd: defaultCwd, ticket: "PROJ-1", workItem: gateway });
  await defaultDefinition.steps[0]!.action!(defaultContext);
  expect(existsSync(join(defaultContext.paths.artifactsDir!, "ticket.md"))).toBe(true);
});

test("work-item directory: missing ticket and dir produce a clear error", () => {
  const definition = pipeline("missing-dir").forEachWorkItem({ queue: "featureTodo", do: [] }).build();
  const context = buildPipelineContext({ workItemRegistry: createDefaultWorkItemGatewayRegistry() });
  expect(() => definition.steps[0]!.command instanceof Function && definition.steps[0]!.command(context)).toThrow(
    /ticket context or explicit dir/,
  );
});

test("empty pipeline is rejected after an empty array", () => {
  expect(() => pipeline("empty").add([]).build()).toThrow(/Pipeline "empty".*no steps/);
});

test("invalid entries and mixed topologies are guarded at runtime", () => {
  expect(() => (pipeline("invalid") as any).add([step("ok"), { id: "bad" }])).toThrow(
    /Pipeline "invalid".*index 0\[1\]/,
  );
  expect(() => (pipeline("bad-before") as any).forEachWorkItem({ queue: "featureTodo", before: "no", do: [] })).toThrow(
    /before must be an array/,
  );
  expect(() =>
    (pipeline("bad-load") as any).forEachWorkItem({ queue: "featureTodo", load: { retries: -1 }, do: [] }),
  ).toThrow(/retries.*non-negative integer/);
  expect(() =>
    (pipeline("bad-closed") as any).forEachWorkItem({ queue: "featureTodo", load: { allowClosed: "yes" }, do: [] }),
  ).toThrow(/allowClosed must be a boolean/);

  const mixed = pipeline("mixed");
  (mixed as any).add(step("one"));
  expect(() => (mixed as any).forEachWorkItem({ queue: "featureTodo", do: [] })).toThrow(/mixed.*incompatible/);

  const loop = pipeline("second-loop");
  (loop as any).forEachWorkItem({ queue: "featureTodo", do: [] });
  expect(() => (loop as any).forEachWorkItem({ queue: "featureTodo", do: [] })).toThrow(/only one.*loop/i);
  expect(() => (loop as any).add(step("outside"))).toThrow(/incompatible/);
});

test("composition: runPipeline and forEachPipeline become dedicated nodes", () => {
  const definition = pipeline("composition-pipelines")
    .add(
      runPipeline({ id: "once", name: "Une fois", pipeline: "./child.ts" }),
      forEachPipeline({
        id: "loop",
        name: "Boucle",
        items: (ctx) => [ctx.ticket ?? "P-01"],
        pipeline: "default",
        afterEach: { pipeline: "commit", when: () => true, ticket: (ctx) => ctx.ticket },
        afterAll: { pipeline: "finalize", ticket: (ctx) => ctx.ticket },
      }),
    )
    .build();

  expect(definition.steps.map((current) => current.runner)).toEqual(["pipeline", "pipeline"]);
  expect(definition.steps[0]!.command).toBe("");
  expect(definition.steps[0]!.orchestration).toMatchObject({ kind: "runPipeline", pipeline: "./child.ts" });
  expect(definition.steps[1]!.orchestration).toMatchObject({
    kind: "forEachPipeline",
    pipeline: "default",
    afterEach: { pipeline: "commit" },
    afterAll: { pipeline: "finalize" },
  });
});

test("composition: bare and explicit when use the same admission", () => {
  const predicate = () => true;
  const builders = [
    runPipeline({ id: "run-bare", name: "Run bare", pipeline: "child", when: predicate }),
    runPipeline({ id: "run-object", name: "Run object", pipeline: "child", when: { if: predicate } }),
    forEachPipeline({ id: "each-bare", name: "Each bare", items: [], pipeline: "child", when: predicate }),
    forEachPipeline({ id: "each-object", name: "Each object", items: [], pipeline: "child", when: { if: predicate } }),
  ];

  for (const builder of builders) {
    const definition = builder.build();
    expect(definition.inputs).toHaveLength(1);
    expect(definition.inputs?.[0]?.kind).toBe("function");
    expect(definition.orchestration).not.toHaveProperty("when");
  }
});

test("DSL budget: work-item cap is separate and .maxCost() is forbidden", () => {
  const definition = pipeline("work-item-budget")
    .forEachWorkItem({ queue: "featureTodo", maxCostPerWorkItemUsd: 3, do: [step("body")] })
    .build();
  expect(definition.max_cost_usd).toBeUndefined();
  expect(definition.max_cost_per_work_item_usd).toBe(3);

  const mixed = pipeline("mixed-budget").maxCost(5) as any;
  expect(() => mixed.forEachWorkItem({ queue: "featureTodo", do: [] })).toThrow(/maxCost\(\).*incompatible/);
  expect(() =>
    (pipeline("bad-work-item-budget") as any).forEachWorkItem({
      queue: "featureTodo",
      maxCostPerWorkItemUsd: 0,
      do: [],
    }),
  ).toThrow(/positive number/);
});

test("forEachWorkItem rejects a blank scan query", () => {
  expect(() =>
    pipeline("blank-query")
      .forEachWorkItem({ queue: "bugTodo", scan: { query: "   " }, do: [step("one")] })
      .build(),
  ).toThrow(/scan\.query must be a non-empty string/);
});
