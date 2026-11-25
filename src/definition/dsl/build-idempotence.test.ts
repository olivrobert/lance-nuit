// `build()` twice gives equal values and leaves the builder as it was.
import { expect, test } from "bun:test";
import { createDefaultAgentBackendRegistry } from "../../agents/default-registry.ts";
import type { PipelineStep } from "../definition.js";
import { workItemDeliveryStep, workItemEscalateStep } from "../builtin-steps/lib/work-item-steps.js";
import { actionStep, createProjectBashStep, humanReview, llmStep, pipeline, textArtifact } from "../dsl.js";
import type { StepAssembly } from "./dsl-steps.js";

const REGISTRY = createDefaultAgentBackendRegistry();
const ASSEMBLY: StepAssembly = { pipelineName: "demo", workItemSource: { step_id: "ticket", queue: "bugTodo" } };
const result = textArtifact("result.md");
const audit = textArtifact("audit.md");
const verdict = textArtifact("verdict.md");

/** Steps composed at assembly carry closures made for that assembly: compare
 *  everything but function identity. */
function shape(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, current) => {
      if (typeof current === "function") return "[function]";
      if (current instanceof Map) return { map: [...current.entries()] };
      return current;
    }),
  );
}

function expectIdempotent(build: () => unknown): void {
  const first = build();
  const second = build();
  expect(second).not.toBe(first);
  expect(shape(second)).toEqual(shape(first));
}

test("a bash step builds twice to the same step, whose rewrite does not reach the builder", () => {
  const builder = createProjectBashStep(REGISTRY)({
    id: "checks",
    name: "Checks",
    command: "make test",
    rerunOnResume: true,
    onFail: { fix: () => "fix", retries: 2, claude: { allowedTools: ["Read"] }, escalate: { effort: "high" } },
  });
  const first = builder.build(ASSEMBLY);
  expect(builder.build(ASSEMBLY)).toEqual(first);

  // Loading rewrites these in place (`profiles.ts`): the next build must not see it.
  first.on_failure!.backend_options = { rewritten: true };
  expect(builder.build(ASSEMBLY).on_failure?.backend_options).not.toEqual({ rewritten: true });
});

test("an agent step with captures and a review builds twice to the same step", () => {
  const builder = llmStep(
    {
      id: "plan",
      name: "Plan",
      profile: "planner",
      backend: "claude",
      command: "plan",
      output: [result],
      capture: { verdict },
      review: {
        profile: "reviewer",
        backend: "claude",
        command: "review",
        capture: { field: "audit", artifact: audit, schema: { type: "string" } },
        fix: () => undefined,
      },
    },
    REGISTRY,
  );
  const first = builder.build(ASSEMBLY);
  expect(builder.build(ASSEMBLY)).toEqual(first);
  first.review!.backend = { id: "rewritten" };
  expect(builder.build(ASSEMBLY).review?.backend.id).toBe("claude");
});

test("an action step builds twice to the same step", () => {
  const builder = actionStep({ id: "act", name: "Act", run: () => "done", describe: "act", rerunOnResume: true });
  expect(builder.build(ASSEMBLY)).toEqual(builder.build(ASSEMBLY));
});

test("work-item steps compose their admission at assembly without stacking it", () => {
  const escalate = workItemEscalateStep({ artifact: verdict, note: () => ({ headline: "h", fields: [] }) });
  const deliver = workItemDeliveryStep({ mrUrl: () => "" });
  for (const builder of [escalate, deliver]) {
    expectIdempotent(() => builder.build(ASSEMBLY));
    const inputs = (step: PipelineStep) => step.inputs?.length ?? 0;
    expect(inputs(builder.build(ASSEMBLY))).toBe(inputs(builder.build(ASSEMBLY)));
  }
  expect(escalate.build(ASSEMBLY).inputs).toHaveLength(1);
});

test("a pipeline builds twice to the same definition, gates, reworks and source included", () => {
  const writer = llmStep(
    { id: "write", name: "Write", profile: "planner", backend: "claude", command: "write", output: [verdict] },
    REGISTRY,
  );
  const builder = pipeline("demo").forEachWorkItem({
    queue: "bugTodo",
    do: [
      writer,
      ...humanReview({
        id: "verdict",
        artifact: verdict,
        kind: "needs-decision",
        blocked: () => true,
        reason: () => "blocked",
        note: () => ({ headline: "h", fields: [] }),
        approval: { subject: "verdict" },
        rework: { step: "write" },
      }),
      workItemDeliveryStep({ mrUrl: () => "" }),
    ],
  });
  const first = builder.build();
  const second = builder.build();
  expect(shape(second)).toEqual(shape(first));
  expect(second.steps.find((step) => step.id === "write")?.rework_for).toEqual(["verdict"]);
  expect(second.steps.find((step) => step.id === "verdict-gate")?.inputs).toHaveLength(1);
  expect(second.reworks?.get("verdict")).toEqual({ stepId: "write", maxRounds: 3 });
  expect(second.work_item_source).toEqual({ step_id: "ticket", queue: "bugTodo" });
});
