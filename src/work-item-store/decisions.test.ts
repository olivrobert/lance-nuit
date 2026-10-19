import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textArtifact } from "../dsl/artifact.js";
import { createArtifactRef } from "../model/artifact-ports.js";
import type { PipelineContext } from "../model/context.js";
import { buildPipelineContext } from "../pipeline/context.js";
import {
  decisionMatchesArtifact,
  gateDecisionStatus,
  isValidSubjectToken,
  recordApproval,
  recordRejection,
  rejectionStatus,
  workItemLayout,
} from "./index.js";

const plan = textArtifact("plan.md");

function ticketContext(): PipelineContext {
  const cwd = mkdtempSync(join(tmpdir(), "gate-decision-"));
  const base = buildPipelineContext();
  const ctx = buildPipelineContext({ cwd, ticket: "PROJ-1", config: { ...base.config, specPath: "work-items" } });
  mkdirSync(ctx.paths.artifactsDir!, { recursive: true });
  return ctx;
}

function writePlan(ctx: PipelineContext, body: string): void {
  writeFileSync(ctx.paths.artifact("plan.md"), body);
}

/** The reader a context-free caller (the dashboard) hands the rule. */
function statusOf(ctx: PipelineContext, subject = "plan") {
  return gateDecisionStatus(ctx.paths.workItemDir!, subject, (name) =>
    ctx.artifacts.readText(createArtifactRef(ctx.ticket!, name)),
  );
}

test("workItemLayout derives every work-item directory from the work-item directory alone", () => {
  const layout = workItemLayout("/w/PROJ-1");

  expect(layout.artifactsDir).toBe("/w/PROJ-1/artifacts");
  expect(layout.decisionsDir).toBe("/w/PROJ-1/decisions");
  expect(layout.reportsDir).toBe("/w/PROJ-1/reports");
  expect(layout.provenanceDir).toBe("/w/PROJ-1/artifacts/.provenance");
  expect(layout.decisionPath("plan")).toBe("/w/PROJ-1/decisions/plan.json");
  expect(() => layout.decisionPath("../plan")).toThrow(/invalid decision subject/);
  expect(isValidSubjectToken("../plan")).toBe(false);
});

test("the pipeline context takes its work-item paths from the layout", () => {
  const ctx = ticketContext();
  const layout = workItemLayout(ctx.paths.workItemDir!);

  expect(ctx.paths.artifactsDir).toBe(layout.artifactsDir);
  expect(ctx.paths.decisionsDir).toBe(layout.decisionsDir);
  expect(ctx.paths.reportsDir).toBe(layout.reportsDir);
});

test("a recorded decision names the file the layout gives its subject", async () => {
  const ctx = ticketContext();
  writePlan(ctx, "# Plan\n");
  const decisionFile = workItemLayout(ctx.paths.workItemDir!).decisionPath("plan");

  expect((await recordApproval(ctx, "plan", plan)).path).toBe(decisionFile);
  // A kept decision names the same file: the one that already holds it.
  expect(await recordApproval(ctx, "plan", plan)).toMatchObject({ written: false, path: decisionFile });
  expect((await recordRejection(ctx, "plan", plan, "split step 2", 3)).path).toBe(decisionFile);
});

test("gateDecisionStatus: absent, fresh, then stale once the artifact changes or disappears", async () => {
  const ctx = ticketContext();
  writePlan(ctx, "# Plan\n");
  expect(await statusOf(ctx)).toEqual({ state: "absent" });

  await recordApproval(ctx, "plan", plan);
  expect((await statusOf(ctx)).state).toBe("fresh");
  expect(await decisionMatchesArtifact(ctx, "plan", plan)).toBe(true);

  writePlan(ctx, "# Plan v2\n");
  expect((await statusOf(ctx)).state).toBe("stale");
  expect(await decisionMatchesArtifact(ctx, "plan", plan)).toBe(false);

  rmSync(ctx.paths.artifact("plan.md"));
  expect((await statusOf(ctx)).state).toBe("stale");
});

test("gateDecisionStatus: a rejection waits for its rework, then the reworked artifact waits for a decision", async () => {
  const ctx = ticketContext();
  writePlan(ctx, "# Plan\n");
  await recordRejection(ctx, "plan", plan, "split step 2", 3);

  expect(await statusOf(ctx)).toMatchObject({ state: "rejected", artifact: "unchanged", decision: { round: 1 } });
  expect((await rejectionStatus(ctx, "plan"))?.artifact).toBe("unchanged");

  // The attempt erases its outputs before spawning: a rework that died midway
  // still owes the rework.
  rmSync(ctx.paths.artifact("plan.md"));
  expect(await statusOf(ctx)).toMatchObject({ state: "rejected", artifact: "absent" });
  expect((await rejectionStatus(ctx, "plan"))?.artifact).toBe("absent");

  writePlan(ctx, "# Plan v2\n");
  expect(await statusOf(ctx)).toMatchObject({ state: "reworked", decision: { reason: "split step 2", round: 1 } });
  expect((await rejectionStatus(ctx, "plan"))?.artifact).toBe("reworked");
});

test("gateDecisionStatus: a decision written for another subject decides nothing", async () => {
  const ctx = ticketContext();
  writePlan(ctx, "# Plan\n");
  await recordApproval(ctx, "other", plan);
  const layout = workItemLayout(ctx.paths.workItemDir!);
  renameSync(layout.decisionPath("other"), layout.decisionPath("plan"));

  expect(await statusOf(ctx)).toEqual({ state: "absent" });
  expect(await decisionMatchesArtifact(ctx, "plan", plan)).toBe(false);
});

test("decisionMatchesArtifact: a fresh approval of another artifact does not approve this one", async () => {
  const ctx = ticketContext();
  writePlan(ctx, "# Plan\n");
  await recordApproval(ctx, "plan", plan);
  // Same bytes under another name: only the artifact the decision names tells
  // the two apart, the hash cannot.
  writeFileSync(ctx.paths.artifact("draft.md"), "# Plan\n");

  expect(await decisionMatchesArtifact(ctx, "plan", plan)).toBe(true);
  expect(await decisionMatchesArtifact(ctx, "plan", textArtifact("draft.md"))).toBe(false);
});

test("gateDecisionStatus: an artifact the reader cannot read proves no approval", async () => {
  const ctx = ticketContext();
  writePlan(ctx, "# Plan\n");
  await recordApproval(ctx, "plan", plan);

  const status = await gateDecisionStatus(ctx.paths.workItemDir!, "plan", () => Promise.reject(new Error("EACCES")));
  expect(status.state).toBe("stale");
});

test("outside the module, a gate's decision is read through gateDecisionStatus only", async () => {
  // With `module-work-item-store-entry-only`, what the entry leaves out cannot be
  // imported elsewhere: no reader can recompose the rule from its parts again.
  const entry = Object.keys(await import("./index.js"));

  for (const part of ["approvalFreshness", "approvalStatus", "readDecisionAt", "rejectionPending", "sha256Text"]) {
    expect(entry).not.toContain(part);
  }
  expect(entry).toContain("gateDecisionStatus");
});
