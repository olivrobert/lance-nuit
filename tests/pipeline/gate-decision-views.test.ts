// The dashboard and `lancenuit inspect` read a stopped gate's decision through
// the same rule (`gateDecisionStatus`), so each case reaches the reader under
// the same word, whichever surface they look at.

import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { inspectTicket } from "../../src/commands/diagnostics-readers.js";
import { textArtifact } from "../../src/dsl/artifact.js";
import type { ApprovalState } from "../../src/modules/read-model/index.js";
import { listItems } from "../../src/modules/read-model/index.js";
import {
  cleanupTempDirs,
  makeProject,
  makeTempDir,
  SPEC_PATH,
  writeArtifact,
  writeProjectsFile,
  writeRun,
} from "../../src/modules/read-model/test-harness.js";
import { buildPipelineContext } from "../../src/pipeline/context.js";
import { recordApproval, recordRejection } from "../../src/work-item-store/index.js";

const originalHome = process.env.PIPELINE_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.PIPELINE_HOME;
  else process.env.PIPELINE_HOME = originalHome;
  cleanupTempDirs();
});

const plan = textArtifact("plan.md");

function stoppedOnPlan() {
  const home = makeTempDir("gate-views-home-");
  process.env.PIPELINE_HOME = home;
  const project = makeProject("demo-app");
  writeProjectsFile(home, [project]);
  writeRun(project, "DEMO-1", "feature", {
    runId: "r-1",
    status: "STOPPED",
    updatedAt: "2026-09-05T09:00:00.000Z",
    outcome: {
      phase: "plan-gate",
      reason: "escalated: plan",
      logPath: null,
      resumable: true,
      stop: { subject: "plan", kind: "needs-decision", detail: "plan", reworkable: true },
    },
  });
  writeArtifact(project, "DEMO-1", "plan.md", "# plan\n");
  const base = buildPipelineContext();
  const ctx = buildPipelineContext({ cwd: project, ticket: "DEMO-1", config: { ...base.config, specPath: SPEC_PATH } });
  return { ctx, rewritePlan: (body: string) => writeFileSync(ctx.paths.artifact("plan.md"), body) };
}

/** The decision as each surface shows it: the item's state, and the word
 *  `--inspect` prints right after the subject. */
async function bothViews(ctx: ReturnType<typeof stoppedOnPlan>["ctx"]): Promise<[ApprovalState, string]> {
  const [item] = await listItems();
  const inspected = await inspectTicket(ctx, "DEMO-1");
  const word = /^approval: plan — (\w+)/m.exec(inspected)?.[1] ?? "";
  return [item!.approval!.state, word];
}

test("a reworked artifact is called reworked by the dashboard and by --inspect", async () => {
  const { ctx, rewritePlan } = stoppedOnPlan();
  await recordRejection(ctx, "plan", plan, "split step 2", 3);
  expect(await bothViews(ctx)).toEqual(["rejected", "rejected"]);

  rewritePlan("# plan, reworked\n");
  expect(await bothViews(ctx)).toEqual(["reworked", "reworked"]);
});

test("a stale approval is called stale by the dashboard and by --inspect", async () => {
  const { ctx, rewritePlan } = stoppedOnPlan();
  await recordApproval(ctx, "plan", plan);
  rewritePlan("# plan, rewritten\n");

  expect(await bothViews(ctx)).toEqual(["stale", "stale"]);
});
