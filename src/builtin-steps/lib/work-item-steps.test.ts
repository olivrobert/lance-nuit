// Deterministic tracker-control steps, run against the port fake.
//
// Everything goes through `WorkItemGateway`: these tests observe only queues,
// logical transitions, and note bodies — never a provider-specific marker or status.

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markerFor } from "../../contracts/work-items.js";
import { artifact } from "../../dsl/artifact.js";
import { pipeline, createInternalWorkItemSourceStep as sourceStep } from "../../dsl.js";
import type { ArtifactRef, WorkItemArtifactStore } from "../../model/artifact-ports.js";
import type { PipelineContext } from "../../model/context.js";
import { createFakeWorkItemGateway, type FakeWorkItemGateway } from "../../modules/work-item/fake.js";
import { buildPipelineContext } from "../../pipeline/context.js";
import { checkInputs } from "../../step/step-admission.js";
import type { ProjectEscalationNoteOptions } from "./public-work-item.js";
import { workItemDeliveryStep, workItemEscalateStep } from "./work-item-steps.js";

const TICKET = "PROJ-24";

const testArtifact = artifact<Record<string, never>>("test.json", (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid test.json");
  return value as Record<string, never>;
});

function setup(queues: Array<"bugTodo" | "featureTodo"> = ["bugTodo"]): {
  gateway: FakeWorkItemGateway;
  ctx: PipelineContext;
} {
  const gateway = createFakeWorkItemGateway({ items: [{ ref: TICKET, queues, state: "todo" }] });
  const artifacts: WorkItemArtifactStore = {
    exists: async () => true,
    readText: async () => "{}",
    readJson: async <T>(_ref: ArtifactRef, parse: (value: unknown) => T) => parse({}),
    writeText: async () => undefined,
    remove: async () => undefined,
  };
  return { gateway, ctx: buildPipelineContext({ ticket: TICKET, workItem: gateway, artifacts }) };
}

const escalate = (overrides: Partial<ProjectEscalationNoteOptions<Record<string, never>>> = {}) => {
  const definition = pipeline("test")
    .add(sourceStep({ dir: () => "/tmp/work-items", queue: "bugTodo" }))
    .add(
      workItemEscalateStep({
        artifact: testArtifact,
        note: () => ({ headline: "Test escalation.", fields: [{ label: "Reason", value: "large surface" }] }),
        ...overrides,
      }),
    )
    .build();
  return definition.steps[1]!;
};

const delivery = (queue: "bugTodo" | "featureTodo", mrUrl: (ctx: PipelineContext) => string | Promise<string>) => {
  const definition = pipeline("test")
    .add(sourceStep({ dir: () => "/tmp/work-items", queue }))
    .add(workItemDeliveryStep({ mrUrl }))
    .build();
  return definition.steps[1]!;
};

/** Read context: gateway with one open or terminal ticket, and a disposable
 *  directory where the step writes `ticket.md`. */
function fetchSetup(closed: boolean): { gateway: FakeWorkItemGateway; ctx: PipelineContext; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "work-item-fetch-"));
  const gateway = createFakeWorkItemGateway({
    items: [{ ref: TICKET, title: "Export CSV", description: "Export suppliers.", closed }],
  });
  return { gateway, ctx: buildPipelineContext({ ticket: TICKET, workItem: gateway }), dir };
}

const fetchStep = (dir: string, refuseClosed?: boolean) =>
  sourceStep({ dir: () => dir, queue: "bugTodo", ...(refuseClosed === undefined ? {} : { refuseClosed }) }).build();

test("source: scan configuration contributes to pipeline metadata", () => {
  const definition = pipeline("feature")
    .add(
      sourceStep({
        dir: () => "/tmp/spec",
        queue: "featureTodo",
        scan: { limit: 3 },
      }),
    )
    .build();

  expect(definition.work_item_source).toEqual({
    step_id: "ticket",
    queue: "featureTodo",
    scan: { limit: 3 },
  });
  expect(definition.steps[0]).not.toHaveProperty("work_item_source");
});

test("source: without scan, pipeline declares reading but remains unscannable", () => {
  const definition = pipeline("manual")
    .add(sourceStep({ id: "read-ticket", dir: () => "/tmp/spec", queue: "bugTodo" }))
    .build();

  expect(definition.work_item_source).toEqual({ step_id: "read-ticket", queue: "bugTodo" });
});

test("source: two declarations in one pipeline are rejected", () => {
  expect(() =>
    pipeline("invalid")
      .add(sourceStep({ id: "first", dir: () => "/tmp/first", queue: "bugTodo" }))
      .add(sourceStep({ id: "second", dir: () => "/tmp/second", queue: "bugTodo" })),
  ).toThrow(/multiple work-item sources.*first.*second/);
});

test("read: open ticket → ticket.md written despite active guard", async () => {
  const { ctx, dir } = fetchSetup(false);

  const summary = await fetchStep(dir, true).action!(ctx);

  expect(existsSync(join(dir, "ticket.md"))).toBe(true);
  expect(summary).toContain("Export CSV");
});

test("read: closed ticket + guard → explicit failure, no ticket.md", async () => {
  const { ctx, dir } = fetchSetup(true);

  await expect(fetchStep(dir, true).action!(ctx)).rejects.toThrow(/already closed/);
  // The artifact is the step's skip condition: leaving one would pass the
  // guard on the next relaunch, which would restart a full pipeline.
  expect(existsSync(join(dir, "ticket.md"))).toBe(false);
});

test("read: refusal names the ticket and provider", async () => {
  const { ctx, dir } = fetchSetup(true);
  let thrown = "";
  try {
    await fetchStep(dir, true).action!(ctx);
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  expect(thrown).toContain(TICKET);
  expect(thrown).toContain("fake");
});

test("read: refusal = blocking step FAILURE, neither skip nor clean stop", () => {
  const step = fetchStep("/tmp/x", true);
  // NO admission: the ticket is read on every run (idempotence covers written
  // content, not file existence), and the business guard remains a blocking failure.
  expect(step.inputs ?? []).toHaveLength(0);
  expect(step.blocking).toBeUndefined();
});

test("read: inactive guard → closed ticket still read (bugfix compatibility)", async () => {
  const { gateway, ctx, dir } = fetchSetup(true);

  await fetchStep(dir).action!(ctx);

  expect(existsSync(join(dir, "ticket.md"))).toBe(true);
  expect(gateway.calls.map((call) => call.op)).toEqual(["fetch"]);
});

test("read: explicitly disabled guard → no check", async () => {
  const { ctx, dir } = fetchSetup(true);
  await fetchStep(dir, false).action!(ctx);
  expect(existsSync(join(dir, "ticket.md"))).toBe(true);
});

test("escalation: note published, escalate queue set, work queue left", async () => {
  const { gateway, ctx } = setup();
  const step = escalate();

  const summary = await step.action!(ctx);

  expect(gateway.bodiesOf(TICKET)).toHaveLength(1);
  expect(gateway.bodiesOf(TICKET)[0]).toContain("Test escalation.");
  expect(gateway.queuesOf(TICKET)).toEqual(["escalate"]);
  // Escalation does not touch state: original prompts only set a queue marker; the
  // ticket stays where the human left it.
  expect(gateway.stateOf(TICKET)).toBe("todo");
  expect(summary).toContain(TICKET);
  expect(summary).toContain("note published");
});

test("escalation: ExecutionKey = { ticket, stepId } — step ID carries the marker", async () => {
  const { gateway, ctx } = setup();
  await escalate({ id: "escalate-reuse" }).action!(ctx);
  expect(gateway.bodiesOf(TICKET)[0]).toContain(markerFor({ ticket: TICKET, stepId: "escalate-reuse" }));
});

test("escalation: replaying same step → no duplicate note, same final state", async () => {
  const { gateway, ctx } = setup();
  const step = escalate();

  await step.action!(ctx);
  await step.action!(ctx);

  expect(gateway.bodiesOf(TICKET)).toHaveLength(1);
  expect(gateway.queuesOf(TICKET)).toEqual(["escalate"]);
});

test("escalation: two distinct escalation steps → two distinct notes", async () => {
  const { gateway, ctx } = setup();
  await escalate({ id: "escalate" }).action!(ctx);
  await escalate({ id: "escalate-sensitive" }).action!(ctx);
  expect(gateway.bodiesOf(TICKET)).toHaveLength(2);
});

test("escalation: false precondition → skip (step never runs)", async () => {
  const { gateway, ctx } = setup();
  const step = escalate({ onlyIf: () => false });

  const result = await checkInputs({ def: step } as never, ctx);
  expect(result).toMatchObject({ action: "skip", reason: "onlyIf=false" });
  expect(gateway.calls).toHaveLength(0);
});

test("escalation: true precondition → step executable", async () => {
  const { ctx } = setup();
  const step = escalate({ onlyIf: () => true });
  expect(await checkInputs({ def: step } as never, ctx)).toEqual({ action: "pass" });
});

test("escalation: description remains traceable in last_command", () => {
  const step = escalate();
  const rendered = typeof step.command === "function" ? step.command(setup().ctx) : step.command;
  expect(rendered).toContain(TICKET);
  expect(rendered).toContain("escalation note");
  expect(rendered).toContain("bugTodo");
});

test("escalation: async note resolves before publication", async () => {
  const { gateway, ctx } = setup();
  const step = escalate({
    note: async () => ({ headline: "Async note.", fields: [] }),
  });

  await step.action!(ctx);

  expect(gateway.bodiesOf(TICKET)[0]).toContain("Async note.");
});

test("delivery: note with MR URL, done queue, inReview state", async () => {
  const { gateway, ctx } = setup(["featureTodo"]);
  const step = delivery("featureTodo", () => "https://forge/mr/42");

  await step.action!(ctx);

  expect(gateway.bodiesOf(TICKET)[0]).toContain("https://forge/mr/42");
  expect(gateway.queuesOf(TICKET)).toEqual(["done"]);
  expect(gateway.stateOf(TICKET)).toBe("inReview");
});

test("delivery: empty MR URL → manual creation note, step succeeds", async () => {
  const { gateway, ctx } = setup();
  const step = delivery("bugTodo", () => "");

  const summary = await step.action!(ctx);

  expect(gateway.bodiesOf(TICKET)[0]).toContain("MR must be created manually");
  expect(gateway.queuesOf(TICKET)).toEqual(["done"]);
  expect(summary).toContain("note published");
});

test("delivery: async URL resolution accepted", async () => {
  const { gateway, ctx } = setup();
  const step = delivery("bugTodo", async () => "https://forge/mr/7");
  await step.action!(ctx);
  expect(gateway.bodiesOf(TICKET)[0]).toContain("https://forge/mr/7");
});

test("delivery: URL resolution throws → note and movement still happen, failure reported", async () => {
  const { gateway, ctx } = setup();
  const step = delivery("bugTodo", () => {
    throw new Error("glab unreachable");
  });

  await expect(step.action!(ctx)).rejects.toThrow(/merge-request URL: glab unreachable/);
  expect(gateway.bodiesOf(TICKET)[0]).toContain("MR must be created manually");
  expect(gateway.queuesOf(TICKET)).toEqual(["done"]);
  expect(gateway.stateOf(TICKET)).toBe("inReview");
});

test("delivery: replaying same step → no duplicate note", async () => {
  const { gateway, ctx } = setup();
  const step = delivery("bugTodo", () => "https://forge/mr/42");

  await step.action!(ctx);
  await step.action!(ctx);

  expect(gateway.bodiesOf(TICKET)).toHaveLength(1);
  expect(gateway.queuesOf(TICKET)).toEqual(["done"]);
});

test("both steps are non-blocking: failure is a persisted warning", () => {
  expect(escalate().blocking).toBe(false);
  expect(delivery("bugTodo", () => "").blocking).toBe(false);
  // No on_failure policy: this puts the step in the warning branch
  // "non-blocking warning" from step-loop (status done + step.errors).
  expect(escalate().on_failure).toBeUndefined();
});

test("note failure: movement is attempted anyway and failure reaches the message", async () => {
  const { gateway, ctx } = setup();
  gateway.armFailure({ op: "comment", ref: TICKET, kind: "error", message: "tracker unreachable" });

  await expect(escalate().action!(ctx)).rejects.toThrow(/tracker unreachable/);
  // "continue without crashing": the queue moved despite the note failure.
  expect(gateway.queuesOf(TICKET)).toEqual(["escalate"]);
  expect(gateway.bodiesOf(TICKET)).toHaveLength(0);
});

test("movement failure: note remains published and message reports what passed", async () => {
  const { gateway, ctx } = setup();
  gateway.armFailure({ op: "moveTo", ref: TICKET, kind: "error", message: "transition refused" });

  let thrown = "";
  try {
    await escalate().action!(ctx);
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }

  expect(thrown).toContain("transition refused");
  expect(thrown).toContain("applied: note published");
  expect(gateway.bodiesOf(TICKET)).toHaveLength(1);
});

test("both operations fail: message counts failures", async () => {
  const { gateway, ctx } = setup();
  gateway.armFailure({ op: "comment", ref: TICKET, kind: "error" });
  gateway.armFailure({ op: "moveTo", ref: TICKET, kind: "error" });

  await expect(escalate().action!(ctx)).rejects.toThrow(/2 operation\(s\) failed/);
});

test("transient failure: replaying step repairs state", async () => {
  const { gateway, ctx } = setup();
  gateway.armFailure({ op: "comment", ref: TICKET, kind: "timeout" });
  const step = escalate();

  await expect(step.action!(ctx)).rejects.toThrow();
  await step.action!(ctx);

  expect(gateway.bodiesOf(TICKET)).toHaveLength(1);
  expect(gateway.queuesOf(TICKET)).toEqual(["escalate"]);
});

test("ticket absent from context → explicit failure before any tracker call", async () => {
  const gateway = createFakeWorkItemGateway();
  const ctx = buildPipelineContext({ workItem: gateway });
  await expect(escalate().action!(ctx)).resolves.toContain("escalation skipped");
  expect(gateway.calls).toHaveLength(0);
});
