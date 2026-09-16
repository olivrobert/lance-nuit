import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifact } from "../../dsl/artifact.js";
import { pipeline, createInternalWorkItemSourceStep as sourceStep } from "../../dsl.js";
import type { ArtifactRef, WorkItemArtifactStore } from "../../model/artifact-ports.js";
import type { PipelineContext } from "../../model/context.js";
import { createFakeWorkItemGateway, type FakeWorkItemGateway } from "../../modules/work-item/fake.js";
import { buildPipelineContext } from "../../pipeline/context.js";
import { loadPipelineDefinition } from "../../pipeline/loader.js";
import { checkInputs } from "../../step/step-admission.js";
import { workItemDeliveryStep, workItemEscalateStep } from "./work-item-steps.js";
import { commandRegistries } from "../../commands/registries.js";

const TICKET = "PROJ-42";
type Triage = { verdict: "escalate" | "proceed"; reason: string };

function fixture(
  value: unknown,
  present = true,
): {
  ctx: PipelineContext;
  gateway: FakeWorkItemGateway;
  reads: () => number;
} {
  let reads = 0;
  const store: WorkItemArtifactStore = {
    exists: async () => present,
    readText: async () => (present ? JSON.stringify(value) : undefined),
    readJson: async <T>(_ref: ArtifactRef, parse: (raw: unknown) => T) => {
      reads += 1;
      return present ? parse(value) : undefined;
    },
    writeText: async () => undefined,
    remove: async () => undefined,
  };
  const gateway = createFakeWorkItemGateway({
    items: [{ ref: TICKET, queues: ["featureTodo"], state: "todo" }],
  });
  return {
    ctx: buildPipelineContext({ ...commandRegistries(), ticket: TICKET, artifacts: store, workItem: gateway }),
    gateway,
    reads: () => reads,
  };
}

const triageArtifact = artifact<Triage>("triage.json", (value) => {
  if (!value || typeof value !== "object") throw new Error("invalid triage");
  const triage = value as Partial<Triage>;
  if (triage.verdict !== "escalate" && triage.verdict !== "proceed") throw new Error("invalid verdict");
  if (typeof triage.reason !== "string") throw new Error("invalid reason");
  return triage as Triage;
});

function definition(options: Parameters<typeof workItemEscalateStep<Triage>>[0]) {
  return pipeline("project")
    .add(sourceStep({ dir: () => "/tmp/project-work-items", queue: "featureTodo" }))
    .add(workItemEscalateStep(options))
    .build();
}

test("public source: queue is carried independently of scan mode", () => {
  const source = pipeline("project")
    .add(
      sourceStep({
        dir: () => "/tmp/project-work-items",
        queue: "featureTodo",
        scan: { limit: 2 },
      }),
    )
    .build();

  expect(source.work_item_source).toEqual({
    step_id: "ticket",
    queue: "featureTodo",
    scan: { limit: 2 },
  });
});

test("loader: work-item helpers are injected into a project factory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "project-dsl-work-item-"));
  const file = join(dir, "pipeline.ts");
  writeFileSync(
    file,
    `
    export default ({ pipeline, artifact, workItemEscalateStep }) => {
      const triage = artifact("triage.json", (value) => value);
      return pipeline("project")
        .forEachWorkItem({
          queue: "featureTodo",
          do: [workItemEscalateStep({
            id: "escalate-project",
            artifact: triage,
            escalation: () => ({ cause: "cause", state: "state", action: "action" }),
          })],
        })
        .build();
    };
  `,
  );

  const definition = await loadPipelineDefinition(file, buildPipelineContext({ ...commandRegistries(), cwd: dir }));
  expect(definition.work_item_source).toEqual({ step_id: "ticket", queue: "featureTodo" });
  expect(definition.steps.find((step) => step.id === "escalate-project")?.blocking).toBe(false);
});

test("loader: unified humanReview is injected and binds renamed pipeline names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "project-dsl-human-review-"));
  const file = join(dir, "pipeline.ts");
  writeFileSync(
    file,
    `
    export default ({ pipeline, artifact, humanReview }) => {
      const verdict = artifact("verdict.json", (value) => value);
      return pipeline("renamed-feature")
        .forEachWorkItem({
          queue: "featureTodo",
          do: [humanReview({
            id: "review",
            artifact: verdict,
            kind: "needs-decision",
            blocked: () => true,
            approval: { subject: "verdict" },
            note: () => ({ headline: "review", fields: [] }),
            reason: () => "needs review",
          })],
        })
        .build();
    };
  `,
  );

  const definition = await loadPipelineDefinition(file, buildPipelineContext({ ...commandRegistries(), cwd: dir }));
  expect(definition.approvals?.get("verdict")?.name).toBe("verdict.json");
  expect(definition.name).toBe("renamed-feature");
});

test("loader: directly exported Pipeline object is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "project-dsl-direct-pipeline-"));
  const file = join(dir, "pipeline.ts");
  writeFileSync(file, `export default { name: "direct", steps: [] };`);

  await expect(
    loadPipelineDefinition(file, buildPipelineContext({ ...commandRegistries(), cwd: dir })),
  ).rejects.toThrow(/must be a factory/);
});

test("loader: named pipeline export does not replace default factory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "project-dsl-named-pipeline-"));
  const file = join(dir, "pipeline.ts");
  writeFileSync(file, `export const pipeline = { name: "named", steps: [] };`);

  await expect(
    loadPipelineDefinition(file, buildPipelineContext({ ...commandRegistries(), cwd: dir })),
  ).rejects.toThrow(/missing default export/);
});

test("loader: module without default export is explicitly rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "project-dsl-no-default-"));
  const file = join(dir, "pipeline.ts");
  writeFileSync(file, `export const meaning = 42;`);

  await expect(
    loadPipelineDefinition(file, buildPipelineContext({ ...commandRegistries(), cwd: dir })),
  ).rejects.toThrow(/missing default export/);
});

test("public escalation: from is inferred and simple note is transformed", async () => {
  const { ctx, gateway, reads } = fixture({ verdict: "escalate", reason: "surface too large" });
  const definition = pipeline("project")
    .add(sourceStep({ dir: () => "/tmp/project-work-items", queue: "featureTodo" }))
    .add(
      workItemEscalateStep({
        id: "escalate-triage",
        artifact: triageArtifact,
        onlyIf: (triage) => triage.verdict === "escalate",
        escalation: (triage) => ({
          cause: "ticket is not eligible for auto-dev",
          details: { Reason: triage.reason },
          state: "no code written",
          action: "complete the ticket spec",
        }),
      }),
    )
    .build();
  const step = definition.steps.find((candidate) => candidate.id === "escalate-triage")!;

  expect(step.command).toBeTypeOf("function");
  const rendered = typeof step.command === "function" ? step.command(ctx) : step.command;
  expect(rendered).toContain("featureTodo");
  expect(await checkInputs({ def: step } as never, ctx)).toEqual({ action: "pass" });
  await step.action!(ctx);

  expect(reads()).toBe(1);
  expect(gateway.bodiesOf(TICKET)[0]).toContain("Reason : surface too large");
  expect(gateway.bodiesOf(TICKET)[0]).toContain("State : no code written");
  expect(gateway.bodiesOf(TICKET)[0]).toContain("Action : complete the ticket spec");
  expect(gateway.queuesOf(TICKET)).toEqual(["escalate"]);
});

test("public escalation: artifact is read once and the same value reaches callbacks", async () => {
  const { ctx, gateway, reads } = fixture({ verdict: "escalate", reason: "stable reason" });
  const seen: Triage[] = [];
  const contexts: PipelineContext[] = [];
  const step = definition({
    artifact: triageArtifact,
    onlyIf: (value, context) => {
      seen.push(value);
      contexts.push(context);
      return true;
    },
    note: (value, context) => {
      seen.push(value);
      contexts.push(context);
      return { headline: "Advanced note", fields: [{ label: "Reason", value: value.reason }] };
    },
  }).steps[1]!;

  expect(await checkInputs({ def: step } as never, ctx)).toEqual({ action: "pass" });
  await step.action!(ctx);
  await step.action!(ctx);

  expect(reads()).toBe(1);
  expect(seen).toHaveLength(3);
  expect(seen[0]).toBe(seen[1]);
  expect(seen[1]).toBe(seen[2]);
  expect(contexts).toHaveLength(3);
  expect(contexts.every((context) => context === ctx)).toBe(true);
  expect(gateway.bodiesOf(TICKET)).toHaveLength(1);
});

test("public escalation: missing or invalid artifact skips without tracker effect", async () => {
  const absent = fixture(undefined, false);
  const absentStep = definition({
    artifact: triageArtifact,
    escalation: () => ({ cause: "cause", state: "state", action: "action" }),
  }).steps[1]!;
  const absentAdmission = await checkInputs({ def: absentStep } as never, absent.ctx);
  expect(absentAdmission.action).toBe("skip");
  expect(absent.gateway.calls).toHaveLength(0);

  const invalid = fixture({ verdict: "bogus", reason: "x" });
  const invalidStep = definition({
    artifact: triageArtifact,
    escalation: () => ({ cause: "cause", state: "state", action: "action" }),
  }).steps[1]!;
  const invalidAdmission = await checkInputs({ def: invalidStep } as never, invalid.ctx);
  expect(invalidAdmission.action).toBe("skip");
  expect(invalid.gateway.calls).toHaveLength(0);
});

test("public escalation: false onlyIf produces a skip", async () => {
  const { ctx, gateway, reads } = fixture({ verdict: "proceed", reason: "voie standard" });
  const step = definition({
    artifact: triageArtifact,
    onlyIf: (value) => value.verdict === "escalate",
    escalation: () => ({ cause: "cause", state: "state", action: "action" }),
  }).steps[1]!;

  const admission = await checkInputs({ def: step } as never, ctx);
  expect(admission.action).toBe("skip");
  expect(reads()).toBe(1);
  expect(gateway.calls).toHaveLength(0);
});

test("public escalation: source without identifiable queue is rejected", () => {
  expect(() =>
    pipeline("project")
      .add(sourceStep({ dir: () => "/tmp/project-work-items", queue: undefined as never }))
      .add(
        workItemEscalateStep({
          artifact: triageArtifact,
          escalation: () => ({ cause: "cause", state: "state", action: "action" }),
        }),
      )
      .build(),
  ).toThrow(/queue must be bugTodo or featureTodo/);
});

test("public escalation: tracker outage still attempts every effect", async () => {
  const { ctx, gateway } = fixture({ verdict: "escalate", reason: "review" });
  gateway.armFailure({ op: "comment", ref: TICKET, kind: "error", message: "tracker unavailable" });
  const step = definition({
    id: "review-triage",
    artifact: triageArtifact,
    escalation: () => ({ cause: "cause", state: "state", action: "action" }),
  }).steps[1]!;

  await expect(step.action!(ctx)).rejects.toThrow(/note published|tracker unavailable/);
  expect(gateway.calls.map((call) => call.op)).toEqual(["comment", "moveTo"]);
});

test("public escalation: invalid dynamic note = error before any tracker effect", async () => {
  const { ctx, gateway } = fixture({ verdict: "escalate", reason: "review" });
  const step = definition({
    id: "review-triage",
    artifact: triageArtifact,
    note: () => ({ headline: "incomplete", fields: "no" as never }),
  }).steps[1]!;

  await expect(step.action!(ctx)).rejects.toThrow(/note\.fields/);
  expect(gateway.calls).toHaveLength(0);
});

test("public delivery: source queue inferred without exposing from", async () => {
  const { ctx, gateway } = fixture({ verdict: "proceed", reason: "ok" });
  const definition = pipeline("project")
    .add(sourceStep({ dir: () => "/tmp/project-work-items", queue: "featureTodo" }))
    .add(workItemDeliveryStep({ mrUrl: () => "https://forge/mr/42" }))
    .build();
  const step = definition.steps[1]!;

  await step.action!(ctx);
  expect(gateway.bodiesOf(TICKET)[0]).toContain("https://forge/mr/42");
  expect(gateway.queuesOf(TICKET)).toEqual(["done"]);
  expect(gateway.stateOf(TICKET)).toBe("inReview");
});

test("public delivery: without mrUrl, no note is published — move only", async () => {
  const { ctx, gateway } = fixture({ verdict: "proceed", reason: "ok" });
  const definition = pipeline("project")
    .add(sourceStep({ dir: () => "/tmp/project-work-items", queue: "featureTodo" }))
    .add(workItemDeliveryStep({}))
    .build();
  const step = definition.steps[1]!;

  await step.action!(ctx);
  expect(gateway.calls.map((call) => call.op)).toEqual(["moveTo"]);
  expect(gateway.queuesOf(TICKET)).toEqual(["done"]);
  expect(gateway.stateOf(TICKET)).toBe("inReview");
});

test("public escalation: runtime validation of XOR and artifact", () => {
  expect(() =>
    pipeline("invalid")
      .add(sourceStep({ dir: () => "/tmp/project-work-items", queue: "featureTodo" }))
      .add(
        workItemEscalateStep({
          artifact: triageArtifact,
          escalation: () => ({ cause: "cause", state: "state", action: "action" }),
          note: () => ({ headline: "note", fields: [] }),
        } as never),
      )
      .build(),
  ).toThrow(/exactly one/);

  expect(() =>
    pipeline("invalid-artifact")
      .add(sourceStep({ dir: () => "/tmp/project-work-items", queue: "featureTodo" }))
      .add(
        workItemEscalateStep({
          artifact: {} as never,
          escalation: () => ({ cause: "cause", state: "state", action: "action" }),
        } as never),
      )
      .build(),
  ).toThrow(/invalid artifact descriptor/);
});
