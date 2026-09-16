import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPipelineContext } from "../pipeline/context.js";
import { loadPipelineDefinition } from "../pipeline/loader.js";
import { installProjectTypes, typecheckProjectPipelines } from "../project/dsl-types.js";
import { createProjectPipeline } from "./create-pipeline.js";
import { commandRegistries } from "./registries.js";

// Rendering itself — templates, command serialization, name validation — is
// covered by pipeline-templates.test.ts. This file covers what creation adds:
// where the file lands, and what happens when it cannot be written.
function project(): string {
  return mkdtempSync(join(tmpdir(), "pipeline-create-test-"));
}

// Installing declarations and typechecking runs a TypeScript program; on a
// loaded machine or a CI runner that exceeds the 5-second default, which is
// not a code slowness worth failing on. Both typechecking tests get 30s.
test("creation: missing directories, typecheck, and loading", async () => {
  const root = project();
  const target = createProjectPipeline({ projectRoot: root, name: "demo-pipeline", command: "make test" });

  expect(target).toBe(join(root, ".lance-nuit", "pipelines", "demo-pipeline.ts"));
  expect(existsSync(target)).toBe(true);

  installProjectTypes(root);
  expect(typecheckProjectPipelines(root)).toMatchObject({ ok: true });
  const definition = await loadPipelineDefinition(target, buildPipelineContext({ ...commandRegistries(), cwd: root }));
  expect(definition.name).toBe("demo-pipeline");
  expect(definition.steps.map((step) => step.id)).toEqual(["check"]);
  expect(definition.steps[0]?.command).toBe("make test");
}, 30_000);

test("creation: invalid names and traversal rejected before writing", () => {
  for (const name of ["", "Demo", "-demo", "demo name", "../demo", "demo/other"]) {
    const root = project();
    expect(() => createProjectPipeline({ projectRoot: root, name, command: "make test" })).toThrow(
      /Invalid pipeline name/,
    );
    expect(existsSync(join(root, ".lance-nuit"))).toBe(false);
  }
});

test("creation: existing file remains unchanged", () => {
  const root = project();
  const dir = join(root, ".lance-nuit", "pipelines");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "demo.ts");
  writeFileSync(target, "original\n");

  expect(() => createProjectPipeline({ projectRoot: root, name: "demo", command: "make test" })).toThrow(
    /refusing to overwrite/,
  );
  expect(readFileSync(target, "utf8")).toBe("original\n");
});

test("creation: a template is rendered and typechecked like the default", () => {
  const root = project();
  const target = createProjectPipeline({ projectRoot: root, name: "agent-pipeline", template: "agent" });

  expect(readFileSync(target, "utf8")).toContain('backend: "claude"');
  installProjectTypes(root);
  expect(typecheckProjectPipelines(root)).toMatchObject({ ok: true });
}, 30_000);

test("creation: an unknown template writes nothing", () => {
  const root = project();
  expect(() => createProjectPipeline({ projectRoot: root, name: "demo", template: "nope" })).toThrow(
    /Unknown template/,
  );
  expect(existsSync(join(root, ".lance-nuit"))).toBe(false);
});
