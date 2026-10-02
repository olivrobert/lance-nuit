import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runnerLockPath } from "../env/runlock.js";
import type { RunnerArgs } from "../model/cli-options.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { approvalCommand, rejectionCommand } from "./approval.js";

/** `lancenuit approve` goes through --approve-only, not through a run: the guard
 *  must hold on this path too. */
async function approveOnly(verdict: "decision" | "split"): Promise<{ code: number; decision: string }> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "approve-only-")));
  const file = join(cwd, "pipeline.ts");
  writeFileSync(
    file,
    `
    export default ({ pipeline, artifact, humanReview }) => {
      const triage = artifact("triage.json", (value) => value);
      return pipeline("triaged")
        .add(humanReview({
          id: "triage",
          artifact: triage,
          kind: "needs-decision",
          blocked: () => true,
          approval: {
            subjects: ["triage-decision"],
            subjectFor: (value) => (value.verdict === "split" ? undefined : "triage-decision"),
          },
          reason: () => "triage blocks",
        }))
        .build();
    };
  `,
  );
  const context = buildPipelineContext({ cwd, ticket: "PROJ-9" });
  mkdirSync(context.paths.artifactsDir!, { recursive: true });
  writeFileSync(context.paths.artifact("triage.json"), JSON.stringify({ verdict }));

  const previous = process.cwd();
  process.chdir(cwd);
  try {
    const code = await approvalCommand.run({
      ticket: "PROJ-9",
      approve: "triage-decision",
      approveOnly: true,
      pipelinePath: file,
    } as RunnerArgs);
    return { code, decision: join(context.paths.decisionsDir!, "triage-decision.json") };
  } finally {
    process.chdir(previous);
  }
}

test("approve-only refuses a subject the current verdict does not offer", async () => {
  const { code, decision } = await approveOnly("split");
  expect(code).toBe(1);
  expect(existsSync(decision)).toBe(false);
});

test("approve-only records the subject the current verdict offers", async () => {
  const { code, decision } = await approveOnly("decision");
  expect(code).toBe(0);
  expect(existsSync(decision)).toBe(true);
});

/** A pipeline whose plan gate declares its writer as rework step, or none. */
function rejectablePipeline(rework: boolean): { cwd: string; file: string; decision: string } {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "reject-only-")));
  const file = join(cwd, "pipeline.ts");
  writeFileSync(
    file,
    `
    export default ({ pipeline, textArtifact, bashStep, humanReview }) => {
      const plan = textArtifact("plan.md");
      return pipeline("planned")
        .add(
          bashStep({ id: "write", name: "Write", command: "true" }).output(plan),
          humanReview({
            id: "plan",
            artifact: plan,
            kind: "needs-decision",
            blocked: () => true,
            approval: { subject: "plan" },
            ${rework ? 'rework: { step: "write" },' : ""}
            reason: () => "plan to review",
          }),
        )
        .build();
    };
  `,
  );
  const context = buildPipelineContext({ cwd, ticket: "PROJ-9" });
  mkdirSync(context.paths.artifactsDir!, { recursive: true });
  writeFileSync(context.paths.artifact("plan.md"), "plan v1\n");
  return { cwd, file, decision: join(context.paths.decisionsDir!, "plan.json") };
}

async function rejectOnly(cwd: string, args: Partial<RunnerArgs>): Promise<number> {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await rejectionCommand.run({ ticket: "PROJ-9", rejectOnly: true, ...args } as RunnerArgs);
  } finally {
    process.chdir(previous);
  }
}

test("reject-only records the rejection with its reason", async () => {
  const { cwd, file, decision } = rejectablePipeline(true);
  expect(await rejectOnly(cwd, { pipelinePath: file, reject: "plan", reason: "split step 2" })).toBe(0);
  expect(JSON.parse(readFileSync(decision, "utf-8"))).toMatchObject({
    decision: "rejected",
    reason: "split step 2",
    round: 1,
  });
});

test("reject-only refuses a gate without rework, an undeclared subject, and missing arguments", async () => {
  const plain = rejectablePipeline(false);
  expect(await rejectOnly(plain.cwd, { pipelinePath: plain.file, reject: "plan", reason: "no" })).toBe(1);
  expect(existsSync(plain.decision)).toBe(false);

  const { cwd, file, decision } = rejectablePipeline(true);
  expect(await rejectOnly(cwd, { pipelinePath: file, reject: "other", reason: "no" })).toBe(1);
  expect(await rejectOnly(cwd, { pipelinePath: file, reason: "no" })).toBe(1);
  expect(await rejectOnly(cwd, { pipelinePath: file, reject: "plan" })).toBe(1);
  expect(await rejectOnly(cwd, { reject: "plan", reason: "no" })).toBe(1);
  expect(await rejectOnly(cwd, { ticket: undefined, pipelinePath: file, reject: "plan", reason: "no" })).toBe(1);
  expect(existsSync(decision)).toBe(false);
});

test("reject-only records while another runner holds the project lock, and does not take it", async () => {
  const { cwd, file, decision } = rejectablePipeline(true);
  const lock = runnerLockPath(cwd);
  mkdirSync(dirname(lock), { recursive: true });
  const holder = JSON.stringify({ pid: process.ppid, ticket: "OTHER-1" });
  writeFileSync(lock, holder);

  expect(await rejectOnly(cwd, { pipelinePath: file, reject: "plan", reason: "split step 2" })).toBe(0);
  expect(existsSync(decision)).toBe(true);
  expect(readFileSync(lock, "utf-8")).toBe(holder);
});
