// Installation of DSL declarations in a KIT DIRECTORY: the shared directory,
// both project variants, and cleanup of stale generated files.
// The typed surface itself is covered by project-types.test.ts.

import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectPipeline } from "../../src/commands/create-pipeline.ts";
import {
  installKitTypes,
  installUserTypes,
  kitTsconfigPath,
  typecheckProjectPipelines,
  typecheckUserPipelines,
} from "../../src/project/dsl-types.ts";

const originalHome = process.env.PIPELINE_HOME;

// Installing and checking generated declarations starts several TypeScript
// programs and is slower under the load of the complete test suite.
setDefaultTimeout(15_000);

afterEach(() => {
  if (originalHome === undefined) delete process.env.PIPELINE_HOME;
  else process.env.PIPELINE_HOME = originalHome;
});

function dir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `kit-types-${prefix}-`));
}

const VALID_PIPELINE = `
  import type { Dsl } from "@lance-nuit/dsl";
  export default ({ pipeline, bashStep }: Dsl) => pipeline("demo")
    .add(bashStep({ id: "check", name: "Check", command: "true" }))
    .build();
`;

const BROKEN_PIPELINE = `
  import type { Dsl } from "@lance-nuit/dsl";
  export default ({ pipeline, llmStep }: Dsl) => pipeline("demo")
    .add(llmStep({ id: "review", name: "Review", backend: "claude", profile: "reviewer", options: { strict_mcp: true }, command: "review" }))
    .build();
`;

function writePipeline(kitDir: string, source: string, name = "demo.ts"): void {
  const dir = join(kitDir, "pipelines");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), source);
}

test("shared directory: a ~/.lance-nuit pipeline is typechecked", () => {
  const home = dir("home");
  process.env.PIPELINE_HOME = home;
  installUserTypes();

  // Scaffolding creates `pipelines/`: without a pipeline inside, the result is
  // green and explicit, never a “0 files” result disguised as success.
  expect(typecheckUserPipelines()).toMatchObject({ ok: true });

  writePipeline(home, VALID_PIPELINE);
  expect(typecheckUserPipelines()).toMatchObject({ ok: true });

  writePipeline(home, BROKEN_PIPELINE, "broken.ts");
  const result = typecheckUserPipelines();
  expect(result.ok).toBe(false);
  expect(result.output).toContain("strict_mcp");
});

test("a kit directory's tsconfig is independent of its location", () => {
  const kit = dir("standalone");
  installKitTypes(kit);
  const tsconfig = JSON.parse(readFileSync(kitTsconfigPath(kit), "utf8")) as {
    compilerOptions: { baseUrl: string; paths: Record<string, string[]> };
    include: string[];
  };
  expect(tsconfig.compilerOptions.baseUrl).toBe(".");
  expect(tsconfig.compilerOptions.paths["@lance-nuit/dsl"]).toEqual(["./.lance-nuit-types/project/dsl.d.ts"]);
  expect(tsconfig.include).toEqual(["pipelines/**/*.ts"]);
});

test("the kit directory gitignores its own generated files", () => {
  const kit = dir("ignore");
  installKitTypes(kit);
  const ignore = readFileSync(join(kit, ".gitignore"), "utf8");
  expect(ignore).toContain("/.lance-nuit-types/");
  expect(ignore).toContain("/tsconfig.json");
  expect(ignore).toContain("/work-items/");
  expect(ignore).toContain("/pipeline-history/");
  expect(ignore).toContain("/logs/");

  writeFileSync(join(kit, ".gitignore"), "/scratch/\n");
  installKitTypes(kit);
  const merged = readFileSync(join(kit, ".gitignore"), "utf8");
  expect(merged).toContain("/scratch/");
  expect(merged).toContain("/.lance-nuit-types/");
  installKitTypes(kit);
  expect(readFileSync(join(kit, ".gitignore"), "utf8")).toBe(merged);
});

test("--create --user writes to the shared directory", () => {
  const home = dir("home");
  process.env.PIPELINE_HOME = home;
  const root = dir("project");

  const target = createProjectPipeline({
    projectRoot: root,
    name: "deploy",
    command: "make deploy",
    shared: true,
  });
  expect(target).toBe(join(home, "pipelines", "deploy.ts"));
  expect(existsSync(join(root, ".lance-nuit"))).toBe(false);

  installUserTypes();
  expect(typecheckUserPipelines()).toMatchObject({ ok: true });
});

test("a project without pipelines returns an explicit success instead of a silent zero-file result", () => {
  process.env.PIPELINE_HOME = dir("home");
  const result = typecheckProjectPipelines(dir("project"));
  expect(result).toMatchObject({ ok: true });
  expect(result.output).toContain("no project pipelines");
});
