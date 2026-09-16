import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineContext } from "../src/model/context.js";
import type { Pipeline } from "../src/model/definition.js";
import type { Run } from "../src/model/run.js";
import { commandRegistries } from "../src/commands/registries.js";
import { buildPipelineContext } from "../src/pipeline/context.js";
import { createProjectDsl } from "../src/pipeline/loader.js";
import { finalizeRun } from "../src/state/run-transitions.js";
import { makeRunStep } from "../src/state/run-step.js";
import { NULL_RUN_OUTPUT } from "../src/runtime/run-output.js";
import { executeRunSteps, stepLoopDeps } from "../src/step/step-loop.js";
import genericShell from "./generic-shell/pipeline.js";
import gitlabGlab from "./gitlab-glab/pipeline.js";
import jiraAcli from "./jira-acli/pipeline.js";

const originalPath = process.env.PATH;
const originalGlabLog = process.env.FAKE_GLAB_LOG;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalGlabLog === undefined) delete process.env.FAKE_GLAB_LOG;
  else process.env.FAKE_GLAB_LOG = originalGlabLog;
});

async function execute(def: Pipeline, context: PipelineContext, ticket: string): Promise<Run> {
  const runDir = mkdtempSync(join(tmpdir(), "pipeline-example-run-"));
  const run: Run = {
    schemaVersion: 1,
    runId: `example-${def.name}`,
    name: def.name,
    pipeline: def.name,
    pipeline_path: join(context.cwd, `${def.name}.ts`),
    run_dir: runDir,
    ticket,
    status: "RUNNING",
    steps: def.steps.map((step) => makeRunStep(step)),
  };
  const outcome = await executeRunSteps(
    run,
    ticket,
    undefined,
    { resuming: false },
    stepLoopDeps(NULL_RUN_OUTPUT),
    context,
  );
  finalizeRun(run, outcome);
  return run;
}

test("generic shell example has no optional integration command", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pipeline-example-generic-"));
  const context = buildPipelineContext({ ...commandRegistries(), cwd, ticket: "build-42" });
  const def = genericShell(createProjectDsl(context, cwd));
  expect(def.steps).toHaveLength(1);
  expect(String(def.steps[0]?.command)).not.toMatch(/acli|glab|docker/i);
});

test("Jira example runs against a fake acli without network", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pipeline-example-jira-"));
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const acli = join(bin, "acli");
  writeFileSync(
    acli,
    '#!/bin/sh\nprintf \'%s\\n\' \'{"fields":{"summary":"Fake issue","description":"Offline body","status":{"name":"To Do","statusCategory":{"key":"new"}},"comment":{"comments":[]}}}\'\n',
  );
  chmodSync(acli, 0o755);
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  const context = buildPipelineContext({ ...commandRegistries(), cwd, ticket: "DEMO-123" });
  const def = jiraAcli(createProjectDsl(context, join(import.meta.dir, "jira-acli")));
  const run = await execute(def, context, "DEMO-123");
  expect(run.status).toBe("PASS");
  expect(readFileSync(join(context.paths.artifactsDir!, "ticket.md"), "utf8")).toContain("Fake issue");
});

test("GitLab example runs against a fake glab without network", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pipeline-example-gitlab-"));
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const log = join(cwd, "glab.log");
  const glab = join(bin, "glab");
  writeFileSync(glab, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FAKE_GLAB_LOG"\n');
  chmodSync(glab, 0o755);
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  process.env.FAKE_GLAB_LOG = log;
  const context = buildPipelineContext({ ...commandRegistries(), cwd, ticket: "delivery-42" });
  const def = gitlabGlab(createProjectDsl(context, join(import.meta.dir, "gitlab-glab")));
  const run = await execute(def, context, "delivery-42");
  expect(run.status).toBe("PASS");
  expect(readFileSync(log, "utf8")).toContain("api user");
});
