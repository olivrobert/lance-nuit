import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { source, textArtifact } from "../../definition/dsl/artifact.js";
import { skipIf, skipUnlessCommand } from "../../definition/dsl/input.js";
import type { ArtifactRef, WorkItemArtifactStore } from "../../shared/language/artifact-ports.js";
import type { PipelineContext } from "../../shared/language/context.js";
import type { PipelineStep } from "../../definition/definition.js";
import type { Run, RunStep } from "../../run/record/run.js";
import { buildPipelineContext } from "../../definition/pipeline/context.js";
import { NULL_RUN_OUTPUT } from "../run-output.js";
import { pendingRejection, recordRejection } from "../../work-items/store/decisions.js";
import { commitPass, readInputs } from "../../work-items/store/step-lock.js";
import { readRunEvents } from "../../run/record/run-journal.js";
import { makeRunStep } from "../../run/record/run-step.js";
import { admitStep, checkInputs } from "./step-admission.js";

const step = { def: { id: "guard", name: "Guard" } } as unknown as RunStep;
const ctx = {} as PipelineContext;

test("checkInputs: a guard refusing on stderr yields its text as the reason, without the stream marker", async () => {
  const decision = await checkInputs(step, ctx, [
    skipUnlessCommand("echo '3 commit(s) already on the branch — refused' >&2; exit 1"),
  ]);
  expect(decision).toEqual({ action: "skip", reason: "3 commit(s) already on the branch — refused" });
});

test("checkInputs: a silent refusal falls back to the command itself", async () => {
  const decision = await checkInputs(step, ctx, [skipUnlessCommand("false")]);
  expect(decision).toEqual({ action: "skip", reason: "false" });
});

// ── Rework of a rejected artifact ────────────────────────────────────────────

const planArtifact = textArtifact("plan.md");

/** Ticket context over an in-memory artifact store, decisions on disk. */
function reworkContext(initial: Record<string, string>): { values: Map<string, string>; ctx: PipelineContext } {
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
  const cwd = mkdtempSync(join(tmpdir(), "rework-"));
  return { values, ctx: buildPipelineContext({ cwd, ticket: "PROJ-1", artifacts: store }) };
}

function reworkStep(
  def: Partial<PipelineStep> = {},
  state: Parameters<typeof makeRunStep>[1] = { status: "done", control: { duration_ms: 1 } },
): RunStep {
  return makeRunStep(
    {
      id: "plan",
      name: "Plan",
      command: "write plan",
      runner: "bash",
      outputs: [planArtifact],
      rework_for: ["plan"],
      ...def,
    },
    state,
  );
}

/** Stamp `def` as a pass settled `done` now would: its inputs and outputs as
 *  they read at this moment. */
async function stampAsIs(ctx: PipelineContext, def: PipelineStep): Promise<void> {
  const inputs = (await readInputs(ctx, def.sources ?? [])).fingerprints;
  const outputs = (await readInputs(ctx, def.outputs ?? [])).fingerprints as Record<string, string>;
  commitPass(ctx, def.id, { pipeline: "p", runId: "r", stampedAt: "2026-01-01T00:00:00.000Z", inputs, outputs }, []);
}

async function admitRework(step: RunStep, ctx: PipelineContext) {
  const run = { name: "p", pipeline: "p", pipeline_path: "p.ts", run_dir: ctx.cwd, steps: [step] } as Run;
  const admission = await admitStep({ run, step, baseCtx: ctx, budget: { cumulative: 0 }, output: NULL_RUN_OUTPUT });
  return { admission, events: readRunEvents(run.run_dir) };
}

test("rework: a done step whose subject has a pending rejection is ready again, its prompt reads the reason", async () => {
  const { ctx } = reworkContext({ "plan.md": "v1" });
  await recordRejection(ctx, "plan", planArtifact, "split step 2", 3);
  const step = reworkStep({
    command: async (c) => `rework: ${(await pendingRejection(c, "plan"))?.reason}`,
  });

  const { admission } = await admitRework(step, ctx);
  expect(admission).toMatchObject({ kind: "ready", command: "rework: split step 2" });
});

test("rework: a rework interrupted after its outputs were erased is ready again, not done", async () => {
  const { values, ctx } = reworkContext({ "plan.md": "v1" });
  await recordRejection(ctx, "plan", planArtifact, "split step 2", 3);
  values.delete("plan.md");

  const { admission } = await admitRework(reworkStep(), ctx);
  expect(admission.kind).toBe("ready");
});

test("rework: a pending rejection runs the step although its stamp holds", async () => {
  const { ctx } = reworkContext({ "plan.md": "v1" });
  const step = reworkStep();
  await stampAsIs(ctx, step.def);
  await recordRejection(ctx, "plan", planArtifact, "split step 2", 3);

  expect((await admitRework(step, ctx)).admission.kind).toBe("ready");
});

test("rework: without a pending rejection a done step answers to its stamp", async () => {
  const { values, ctx } = reworkContext({ "plan.md": "v1", "spec.md": "s" });
  await recordRejection(ctx, "plan", planArtifact, "split step 2", 3);
  values.set("plan.md", "v2");
  const step = reworkStep({ sources: [textArtifact("spec.md")] });
  await stampAsIs(ctx, step.def);
  const skipped = await admitRework(step, ctx);
  expect(skipped.admission.kind).toBe("skip");
  expect(step.status).toBe("done");
  expect(skipped.events.find((event) => event.type === "step.skipped")).toMatchObject({ reason: "up to date" });

  values.set("spec.md", "s2");
  expect((await admitRework(step, ctx)).admission.kind).toBe("ready");
});

test("rework: an author when still decides first", async () => {
  const { ctx } = reworkContext({ "plan.md": "v1" });
  await recordRejection(ctx, "plan", planArtifact, "split step 2", 3);
  const step = reworkStep({ inputs: [skipIf(() => true, "deliverable exists")] });

  const { admission, events } = await admitRework(step, ctx);
  expect(admission.kind).toBe("skip");
  expect(events.find((event) => event.type === "step.skipped")).toMatchObject({ reason: "deliverable exists" });
});

// ── Resume of a step whose last pass did not complete ────────────────────────

/** A pass that closed an attempt but never completed: its spend is recorded,
 *  so `control` is set, yet nothing it produced can be trusted. */
const UNFINISHED_PASSES = [
  {
    status: "failed",
    control: { duration_ms: 5, total_cost_usd: 0.3 },
    errors: "agent exited 1",
    fail_kind: "technical",
  },
  { status: "aborted", control: { duration_ms: 5, total_cost_usd: 0.3 } },
] as const;

for (const state of UNFINISHED_PASSES) {
  test(`resume: a rework step left ${state.status}, with no pending rejection, runs again`, async () => {
    const { ctx } = reworkContext({});
    const step = reworkStep({}, { ...state });

    const { admission } = await admitRework(step, ctx);
    expect(admission.kind).toBe("ready");
  });

  test(`resume: a step left ${state.status} that declares input does not adopt the outputs its pass left`, async () => {
    const { ctx } = reworkContext({ "plan.md": "partial", "spec.md": "s" });
    const step = reworkStep({ rework_for: undefined, sources: [textArtifact("spec.md")] }, { ...state });

    const { admission, events } = await admitRework(step, ctx);
    expect(admission.kind).toBe("ready");
    expect(events.some((event) => event.type === "step.skipped")).toBe(false);
  });

  test(`resume: a step left ${state.status} that its when now skips ends skipped, not already completed`, async () => {
    const { ctx } = reworkContext({});
    const step = reworkStep(
      { rework_for: undefined, inputs: [skipIf(() => true, "deliverable exists")] },
      { ...state },
    );

    const { admission, events } = await admitRework(step, ctx);
    expect(admission.kind).toBe("skip");
    expect(step.status).toBe("skipped");
    expect(events.filter((event) => event.type === "step.status.changed").at(-1)).toMatchObject({
      status: "skipped",
    });
  });
}

test("resume: a done step that its when now skips stays done", async () => {
  const { ctx } = reworkContext({});
  const step = reworkStep(
    { rework_for: undefined, inputs: [skipIf(() => true, "deliverable exists")] },
    { status: "done", control: { duration_ms: 1 } },
  );

  const { admission } = await admitRework(step, ctx);
  expect(admission.kind).toBe("skip");
  expect(step.status).toBe("done");
});

// ── Interrupted attempt ──────────────────────────────────────────────────────

/** A step the runner died in, as crash settlement leaves it. */
function interruptedStep(id: string, state: Parameters<typeof makeRunStep>[1] = {}): RunStep {
  return makeRunStep(
    { id, name: id.toUpperCase(), command: "push", runner: "bash" },
    {
      status: "running",
      attempts: [
        {
          attempt: 1,
          kind: "step",
          status: "failed",
          started_at: "2026-08-01T10:00:00.000Z",
          log_path: `steps/${id}/attempt-001/output.log`,
          interrupted: true,
        },
      ],
      ...state,
    },
  );
}

// ── The freshness lock decides a stamped step ───────────────────────────────

/** A step producing `plan.md` from nothing it declares, like a branch creation. */
function deliverableStep(state: Parameters<typeof makeRunStep>[1], def: Partial<PipelineStep> = {}): RunStep {
  return reworkStep({ rework_for: undefined, ...def }, state);
}

async function admitStamped(step: RunStep, ctx: PipelineContext, fork: { startAt?: string } = {}) {
  const run = { name: "p", pipeline: "p", pipeline_path: "p.ts", run_dir: ctx.cwd, steps: [step], ...fork } as Run;
  const admission = await admitStep({
    run,
    step,
    baseCtx: ctx,
    budget: { cumulative: 0 },
    output: NULL_RUN_OUTPUT,
  });
  return { admission, events: readRunEvents(run.run_dir) };
}

test("lock: a done step whose stamp holds is skipped up to date, stays done, and costs no attempt (L8)", async () => {
  const { ctx } = reworkContext({ "plan.md": "v1" });
  const step = deliverableStep({ status: "done", control: { duration_ms: 1, total_cost_usd: 0.4 } });
  await stampAsIs(ctx, step.def);

  const { admission, events } = await admitStamped(step, ctx);

  expect(admission.kind).toBe("skip");
  expect(step.status).toBe("done");
  expect(step.attempts ?? []).toEqual([]);
  expect(step.control?.total_cost_usd).toBe(0.4);
  expect(events.find((event) => event.type === "step.skipped")).toMatchObject({
    stepId: "plan",
    reason: "up to date",
    freshness: "fresh",
  });
});

test("lock: a pending step of a new run whose stamp holds is skipped, not run", async () => {
  const { ctx } = reworkContext({ "plan.md": "v1" });
  const step = deliverableStep({ status: "pending" });
  await stampAsIs(ctx, step.def);

  const { admission } = await admitStamped(step, ctx);

  expect(admission.kind).toBe("skip");
  expect(step.status).toBe("skipped");
});

test("lock: outputs present without a stamp run, and the reading travels with the admission", async () => {
  const { ctx } = reworkContext({ "plan.md": "v1", "ticket.md": "t" });
  const step = deliverableStep({ status: "done" }, { sources: [textArtifact("ticket.md")] });

  const { admission } = await admitStamped(step, ctx);

  expect(admission.kind).toBe("ready");
  expect(admission.kind === "ready" && admission.freshness).toMatchObject({
    value: "none",
    inputs: { "artifacts/ticket.md": expect.stringMatching(/^[a-f0-9]{64}$/) },
  });
});

test("lock: the start step of a pending fork runs although its stamp holds (F5)", async () => {
  const { ctx } = reworkContext({ "plan.md": "v1" });
  const step = deliverableStep({ status: "pending" });
  await stampAsIs(ctx, step.def);

  expect((await admitStamped(step, ctx, { startAt: "plan" })).admission.kind).toBe("ready");
});

test("lock: once the start step of a fork left pending, its stamp decides again (F7)", async () => {
  const { ctx } = reworkContext({ "plan.md": "v1" });
  const failed = deliverableStep({ status: "failed" });
  await stampAsIs(ctx, failed.def);
  expect((await admitStamped(failed, ctx, { startAt: "plan" })).admission.kind).toBe("skip");

  const skippedByWhen = deliverableStep({ status: "skipped" });
  expect((await admitStamped(skippedByWhen, ctx, { startAt: "plan" })).admission.kind).toBe("skip");
});

test("lock: when decides before the stamp", async () => {
  const { ctx } = reworkContext({});
  const step = deliverableStep(
    { status: "done", control: { duration_ms: 1 } },
    { inputs: [skipIf(() => true, "not this time")] },
  );

  const { admission, events } = await admitStamped(step, ctx);
  expect(admission.kind).toBe("skip");
  expect(events.find((event) => event.type === "step.skipped")).toMatchObject({ reason: "not this time" });
});

test("lock: a rerunOnResume step runs and carries no reading", async () => {
  const { ctx } = reworkContext({ "plan.md": "v1" });
  const step = deliverableStep({ status: "done", control: { duration_ms: 1 } }, { rerun_on_resume: true });
  await stampAsIs(ctx, step.def);

  const { admission } = await admitStamped(step, ctx);
  expect(admission.kind).toBe("ready");
  expect(admission.kind === "ready" && admission.freshness).toBeUndefined();
});

test("lock: a step with input and no output is skipped while fresh, and runs once an input changed (L9)", async () => {
  const { values, ctx } = reworkContext({ "summary.md": "s1" });
  const step = deliverableStep({ status: "done" }, { outputs: undefined, sources: [textArtifact("summary.md")] });
  await stampAsIs(ctx, step.def);

  expect((await admitStamped(step, ctx)).admission.kind).toBe("skip");
  values.set("summary.md", "s2");
  expect((await admitStamped(step, ctx)).admission.kind).toBe("ready");
});

for (const state of UNFINISHED_PASSES) {
  test(`lock: a step left ${state.status} without a stamp runs whatever its outputs`, async () => {
    const { ctx } = reworkContext({ "plan.md": "partial" });
    const step = deliverableStep({ ...state });

    const { admission, events } = await admitStamped(step, ctx);
    expect(admission.kind).toBe("ready");
    expect(events.some((event) => event.type === "step.skipped")).toBe(false);
  });
}

test("lock: a step the runner died in has no stamp, so the interruption guard asks first", async () => {
  const { ctx } = reworkContext({ "plan.md": "partial" });
  const died = interruptedStep("plan");
  const step = makeRunStep({ ...died.def, outputs: [planArtifact] }, { ...died });

  const { admission, events } = await admitStamped(step, ctx);

  expect(admission.kind).toBe("stopped");
  expect(events.some((event) => event.type === "step.skipped")).toBe(false);
});

test("lock: an orchestration node declaring an output is not stamped, its children decide", async () => {
  const { ctx } = reworkContext({ "plan.md": "v1" });
  const node = makeRunStep(
    {
      id: "children",
      name: "Children",
      command: "",
      runner: "pipeline",
      orchestration: { kind: "runPipeline", pipeline: "child" },
      outputs: [planArtifact],
    },
    { status: "pending" },
  );
  await stampAsIs(ctx, node.def);

  const { admission, events } = await admitStamped(node, ctx);

  expect(admission.kind).toBe("ready");
  expect(events.some((event) => event.type === "step.skipped")).toBe(false);
});

test("lock: an unreadable lock.json fails the admission closed, naming its path, before any spawn (L14)", async () => {
  const { ctx } = reworkContext({ "plan.md": "v1" });
  const lockPath = join(ctx.paths.workItemDir!, "artifacts", "lock.json");
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, "{ not json");
  const step = deliverableStep({ status: "done" });

  const { admission } = await admitStamped(step, ctx);

  expect(admission.kind).toBe("failed");
  expect(admission.kind === "failed" && admission.reason).toContain(lockPath);
  expect(step.status).toBe("failed");
  expect(step.attempts ?? []).toEqual([]);
});

test("lock: blocking: false does not absorb an unreadable lock.json, the step fails (L14)", async () => {
  const { ctx } = reworkContext({ "plan.md": "v1" });
  const lockPath = join(ctx.paths.workItemDir!, "artifacts", "lock.json");
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ schemaVersion: 2, steps: {} }));
  const step = deliverableStep({ status: "done" }, { blocking: false });

  const { admission } = await admitStamped(step, ctx);

  expect(admission.kind).toBe("failed");
  expect(admission.kind === "failed" && admission.reason).toContain(lockPath);
  expect(step.status).toBe("failed");
  expect(step.attempts ?? []).toEqual([]);
});

// ── External sources ─────────────────────────────────────────────────────────

test("source: a source that cannot be read makes the step stale, and the journal says which source and why", async () => {
  const { ctx } = reworkContext({ "plan.md": "v1" });
  const tree = source("tree", { command: "echo 'fatal: not a git repository' >&2; exit 128" });
  const step = reworkStep({ rework_for: undefined, sources: [tree] });
  await stampAsIs(ctx, step.def);

  const { admission, events } = await admitRework(step, ctx);

  expect(admission.kind).toBe("ready");
  expect(events.some((event) => event.type === "step.skipped")).toBe(false);
  const unavailable = events.filter((event) => event.type === "step.source.unavailable");
  expect(unavailable).toHaveLength(1);
  expect(unavailable[0]).toMatchObject({ stepId: "plan", source: "tree" });
  expect(String((unavailable[0] as { reason?: unknown }).reason)).toContain("fatal: not a git repository");
});

test("source: a done step whose source reads the bytes it was stamped with is skipped as up to date", async () => {
  const { ctx } = reworkContext({ "plan.md": "v1" });
  const tree = source("tree", { command: "echo stable" });
  const step = reworkStep({ rework_for: undefined, sources: [tree] });
  await stampAsIs(ctx, step.def);

  const { admission, events } = await admitRework(step, ctx);

  expect(admission.kind).toBe("skip");
  expect(events.some((event) => event.type === "step.source.unavailable")).toBe(false);
  expect(events.find((event) => event.type === "step.skipped")).toMatchObject({ stepId: "plan", reason: "up to date" });
});
