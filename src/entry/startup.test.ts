import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifact } from "../dsl/artifact.js";
import { bashStep, humanReview, pipeline } from "../dsl.js";
import type { RunnerArgs } from "../model/cli-options.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { pipelineRunsDir } from "../state/stores/run-storage.js";
import { textArtifact } from "../dsl/artifact.js";
import { readDecision } from "../state/decisions.js";
import { applyApproval, applyRejection } from "./startup.js";

const budgetArtifact = artifact("budget.json", (value) => value as { amountUsd: number });
const def = pipeline("budgeted")
  .approval("budget", budgetArtifact)
  .add(bashStep({ id: "noop", name: "Noop", command: "true" }))
  .build();

function approvedContext() {
  const cwd = mkdtempSync(join(tmpdir(), "startup-approval-"));
  const base = buildPipelineContext();
  const context = buildPipelineContext({
    cwd,
    ticket: "PROJ-9",
    config: { ...base.config, specPath: ".lance-nuit/work-items" },
  });
  mkdirSync(context.paths.artifactsDir!, { recursive: true });
  writeFileSync(context.paths.artifact("budget.json"), JSON.stringify({ amountUsd: 12 }));
  return context;
}

function approveArgs(overrides: Partial<RunnerArgs> = {}): RunnerArgs {
  return { ticket: "PROJ-9", approve: "budget", approveOnly: false, fresh: false, ...overrides } as RunnerArgs;
}

/** A stopped run under `latest`, its lock held by a live process that is not us. */
function heldLatestRun(context: ReturnType<typeof approvedContext>): void {
  const runsDir = pipelineRunsDir("budgeted", "PROJ-9", context);
  const runDir = join(runsDir, "run-1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: "run-1",
      name: "budgeted",
      pipeline: "budgeted",
      ticket: "PROJ-9",
      status: "STOPPED",
      steps: [{ id: "noop", status: "pending" }],
    }),
  );
  symlinkSync("run-1", join(runsDir, "latest"));
  writeFileSync(join(runDir, "runner.lock"), JSON.stringify({ pid: process.ppid }));
}

test("--approve journals only the decision it wrote", async () => {
  const context = approvedContext();

  const first = await applyApproval(approveArgs(), def, context);
  expect(first).toMatchObject({ kind: "ok", decision: { subject: "budget", decision: "approved" } });
  // The same gate lifted a second time: the decision is kept, so this run did not
  // record it and must not claim it did.
  expect(await applyApproval(approveArgs(), def, context)).toEqual({ kind: "ok" });
});

test("--approve on a run another runner is already resuming starts no second run", async () => {
  const context = approvedContext();
  heldLatestRun(context);

  expect(await applyApproval(approveArgs(), def, context)).toEqual({ kind: "done" });
  // --fresh asks for a new run on purpose: the held one is not a duplicate of it.
  expect(await applyApproval(approveArgs({ fresh: true }), def, context)).toEqual({ kind: "ok" });
});

test("--approve refuses a subject the current verdict does not offer", async () => {
  const context = approvedContext();
  const triage = artifact("triage.json", (value) => value as { verdict: "decision" | "split" });
  const triaged = pipeline("triaged")
    .add(
      humanReview({
        id: "triage",
        artifact: triage,
        kind: "needs-decision",
        blocked: () => true,
        approval: {
          subjects: ["triage-decision"],
          subjectFor: (value) => (value.verdict === "split" ? undefined : "triage-decision"),
        },
        reason: () => "triage blocks",
      }),
    )
    .build();
  writeFileSync(context.paths.artifact("triage.json"), JSON.stringify({ verdict: "split" }));

  const outcome = await applyApproval(approveArgs({ approve: "triage-decision" }), triaged, context);
  expect(outcome.kind).toBe("error");
  expect(existsSync(join(context.paths.decisionsDir!, "triage-decision.json"))).toBe(false);
});

const planArtifact = textArtifact("plan.md");
const planned = (rework: boolean) =>
  pipeline("budgeted")
    .add(
      bashStep({ id: "write", name: "Write", command: "true" }).output(planArtifact),
      humanReview({
        id: "plan",
        artifact: planArtifact,
        kind: "needs-decision",
        blocked: () => true,
        approval: { subject: "plan" },
        ...(rework ? { rework: { step: "write", maxRounds: 2 } } : {}),
        reason: () => "plan to review",
      }),
    )
    .build();

function rejectArgs(overrides: Partial<RunnerArgs> = {}): RunnerArgs {
  return {
    ticket: "PROJ-9",
    reject: "plan",
    reason: "split step 2",
    rejectOnly: false,
    fresh: false,
    ...overrides,
  } as RunnerArgs;
}

function plannedContext() {
  const context = approvedContext();
  writeFileSync(context.paths.artifact("plan.md"), "plan v1\n");
  return context;
}

test("--reject records the rejection and hands the decision it wrote to the run", async () => {
  const context = plannedContext();

  const outcome = await applyRejection(rejectArgs(), planned(true), context);
  expect(outcome).toMatchObject({
    kind: "ok",
    decision: { subject: "plan", decision: "rejected", reason: "split step 2", round: 1 },
  });
  // The same rejection repeated is kept, so this run did not record it.
  expect(await applyRejection(rejectArgs(), planned(true), context)).toEqual({ kind: "ok" });
  expect(await applyRejection({ ticket: "PROJ-9" } as RunnerArgs, planned(true), context)).toEqual({ kind: "ok" });
});

test("--reject refuses a gate without rework and an undeclared subject, writing nothing", async () => {
  const context = plannedContext();

  const plain = await applyRejection(rejectArgs(), planned(false), context);
  expect(plain.kind).toBe("error");
  expect((await applyRejection(rejectArgs({ reject: "other" }), planned(true), context)).kind).toBe("error");
  expect(readDecision(context, "plan")).toBeUndefined();
});

test("--reject on a run another runner is already resuming starts no second run", async () => {
  const context = plannedContext();
  heldLatestRun(context);

  expect(await applyRejection(rejectArgs(), planned(true), context)).toEqual({ kind: "done" });
  expect(readDecision(context, "plan")?.decision).toBe("rejected");
});
