import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinRegistries } from "../../../tests/builtin-registries.ts";
import { buildPipelineContext } from "./context.ts";
import { loadPipelineDefinition } from "./loader.ts";

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "loader-cwd-")));
const context = () => buildPipelineContext({ ...builtinRegistries(), cwd, runnerDir: cwd, ticket: "LOAD-0" });

function writePipeline(factory: string): string {
  const file = join(realpathSync(mkdtempSync(join(tmpdir(), "loader-"))), "pipeline.ts");
  writeFileSync(file, `export default ${factory};\n`);
  return file;
}

const BODY = `dsl
    .pipeline("ctx").desc(ctx.cwd)
    .add(dsl.bashStep({ id: "step", name: "Step", command: "true" }))
    .build()`;

test("loadPipelineDefinition: the factory receives the execution context", async () => {
  const file = writePipeline(`(dsl: any, ctx: any) => ${BODY}`);

  const pipeline = await loadPipelineDefinition(file, context());

  expect(pipeline.description).toBe(cwd);
});

test("loadPipelineDefinition: a factory with a defaulted context parameter still receives it", async () => {
  const file = writePipeline(`(dsl: any, ctx: any = undefined as never) => ${BODY}`);

  const pipeline = await loadPipelineDefinition(file, context());

  expect(pipeline.description).toBe(cwd);
});
