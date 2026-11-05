import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPipelineName, pipelineSearchPaths, resolveBuiltinPipeline } from "./builtin-pipeline.ts";

const originalHome = process.env.PIPELINE_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.PIPELINE_HOME;
  else process.env.PIPELINE_HOME = originalHome;
});

function dir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `builtin-pipeline-${prefix}-`));
}

function writePipeline(root: string, relativePath: string): string {
  const target = join(root, relativePath);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, "export default () => ({});\n");
  return target;
}

test("a pipeline from ~/.lance-nuit is executable from any project", () => {
  const home = dir("home");
  process.env.PIPELINE_HOME = home;
  const shared = writePipeline(home, "pipelines/deploy.ts");
  expect(resolveBuiltinPipeline("deploy", dir("project"))).toBe(shared);
});

test("the project homonym shadows the shared pipeline", () => {
  const home = dir("home");
  const project = dir("project");
  process.env.PIPELINE_HOME = home;
  writePipeline(home, "pipelines/deploy.ts");
  const local = writePipeline(project, ".lance-nuit/pipelines/deploy.ts");
  expect(resolveBuiltinPipeline("deploy", project)).toBe(local);
});

test("returns null when no root provides the name", () => {
  process.env.PIPELINE_HOME = dir("home");
  expect(resolveBuiltinPipeline("pipeline-qui-nexiste-pas", dir("project"))).toBeNull();
});

test("isPipelineName: distinguishes a name from a path", () => {
  for (const name of ["deploy", "deploy-staging", "a", "x9"]) {
    expect(isPipelineName(name)).toBe(true);
  }
  for (const path of [
    "",
    "Deploy",
    "deploy.ts",
    "./deploy",
    "a/b",
    "-deploy",
    "9deploy",
    "deploy_x",
    "deploy staging",
  ]) {
    expect(isPipelineName(path)).toBe(false);
  }
});

test("pipelineSearchPaths: chain order, builtin last", () => {
  const home = dir("home");
  process.env.PIPELINE_HOME = home;
  const project = dir("project");
  const paths = pipelineSearchPaths("deploy", project);
  expect(paths).toEqual([
    join(project, ".lance-nuit", "pipelines", "deploy.ts"),
    join(home, "pipelines", "deploy.ts"),
    join(import.meta.dir, "..", "builtins", "deploy.ts"),
  ]);
});

test("the package does not treat old opinionated presets as builtins", () => {
  process.env.PIPELINE_HOME = dir("home");
  expect(resolveBuiltinPipeline("default", dir("project"))).toEndWith(join("builtins", "default.ts"));
  expect(resolveBuiltinPipeline("quality", dir("project"))).toBeNull();
});
