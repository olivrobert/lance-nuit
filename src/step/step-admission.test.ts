import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textArtifact } from "../dsl/artifact.js";
import { skipIf, skipUnlessCommand } from "../dsl/input.js";
import type { ArtifactRef, WorkItemArtifactStore } from "../model/artifact-ports.js";
import type { PipelineContext } from "../model/context.js";
import type { PipelineStep } from "../model/definition.js";
import type { Run, RunStep } from "../model/run.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { NULL_RUN_OUTPUT } from "../runtime/run-output.js";
import { pendingRejection, recordRejection } from "../state/decisions.js";
import { readRunEvents } from "../state/run-journal.js";
import { makeRunStep } from "../state/run-step.js";
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

test("rework: without a pending rejection a done step stays done", async () => {
  const { values, ctx } = reworkContext({ "plan.md": "v1" });
  await recordRejection(ctx, "plan", planArtifact, "split step 2", 3);
  values.set("plan.md", "v2");
  const step = reworkStep();

  const { admission, events } = await admitRework(step, ctx);
  expect(admission.kind).toBe("skip");
  expect(step.status).toBe("done");
  expect(events.find((event) => event.type === "step.skipped")).toMatchObject({
    stepId: "plan",
    reason: "no pending rejection",
  });
});

test("rework: without a pending rejection a step declaring input still answers to its freshness", async () => {
  const { values, ctx } = reworkContext({ "plan.md": "v1", "spec.md": "s" });
  await recordRejection(ctx, "plan", planArtifact, "split step 2", 3);
  values.set("plan.md", "v2");
  const step = reworkStep({ sources: [textArtifact("spec.md")] });
  // The first admission adopts the outputs against the current spec.
  const adopted = await admitRework(step, ctx);
  expect(adopted.admission.kind).toBe("skip");
  expect(adopted.events.find((event) => event.type === "step.skipped")).toMatchObject({
    reason: "outputs up to date with declared inputs",
  });

  values.set("spec.md", "s2");
  step.status = "done";
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
}

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

test("interrupted: the --start-at target of this invocation is ready without authorization, a step later in the requeue is not", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "admission-interrupted-"));
  const target = interruptedStep("check", { replay: true });
  // Requeued by the same --start-at, so it carries `replay` too, but the operator
  // never named it.
  const later = interruptedStep("later", { replay: true });
  const run = { name: "p", pipeline: "p", pipeline_path: "p.ts", run_dir: runDir, steps: [target, later] } as Run;
  const admit = (step: RunStep) =>
    admitStep({
      run,
      step,
      baseCtx: buildPipelineContext({ cwd: runDir }),
      budget: { cumulative: 0 },
      output: NULL_RUN_OUTPUT,
      startAt: "check",
    });

  expect((await admit(target)).kind).toBe("ready");
  const refused = await admit(later);
  expect(refused.kind).toBe("stopped");
  expect(refused.kind === "stopped" && refused.reason).toMatch(/LATER.*--replay-interrupted.*replayInterrupted: true/s);
  expect(run.outcome).toMatchObject({ phase: "later", resumable: true, stop: { kind: "needs-decision" } });
});
