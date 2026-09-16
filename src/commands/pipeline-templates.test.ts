import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPipelineContext } from "../pipeline/context.js";
import { loadPipelineDefinition } from "../pipeline/loader.js";
import { installProjectTypes, typecheckProjectPipelines } from "../project/dsl-types.js";
import { PIPELINE_TEMPLATES, pipelineTemplate, renderPipelineTemplate, templateIds } from "./pipeline-templates.js";
import { commandRegistries } from "./registries.js";

// Installing declarations and typechecking every template runs several
// TypeScript programs; the 5-second default is not a meaningful budget here.
setDefaultTimeout(60_000);

const COMMAND = "npm test";

function project(): string {
  return mkdtempSync(join(tmpdir(), "pipeline-templates-"));
}

test("templates: every one typechecks against the installed declarations", () => {
  const root = project();
  installProjectTypes(root);
  const dir = join(root, ".lance-nuit", "pipelines");
  mkdirSync(dir, { recursive: true });

  for (const template of PIPELINE_TEMPLATES) {
    writeFileSync(join(dir, `${template.id}.ts`), renderPipelineTemplate(template.id, COMMAND, template.id));
  }

  expect(typecheckProjectPipelines(root)).toMatchObject({ ok: true });

  // The check above is only meaningful if this harness really compiles the
  // rendered files: prove it rejects a broken one.
  writeFileSync(
    join(dir, "broken.ts"),
    'import type { Dsl } from "@lance-nuit/dsl";\nexport default (d: Dsl) => d.nope();\n',
  );
  expect(typecheckProjectPipelines(root).ok).toBe(false);
});

test("templates: every one loads into a pipeline with steps", async () => {
  const root = project();
  const dir = join(root, ".lance-nuit", "pipelines");
  mkdirSync(dir, { recursive: true });

  for (const template of PIPELINE_TEMPLATES) {
    const target = join(dir, `${template.id}.ts`);
    writeFileSync(target, renderPipelineTemplate(template.id, COMMAND, template.id));
    const definition = await loadPipelineDefinition(
      target,
      buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "PROJ-42" }),
    );
    expect(definition.name).toBe(template.id);
    expect(definition.steps.length).toBeGreaterThan(0);
  }
});

test("templates: a command is required by, and only by, the templates that run one", () => {
  for (const template of PIPELINE_TEMPLATES) {
    if (template.usesCommand) {
      expect(() => renderPipelineTemplate("demo", undefined, template.id)).toThrow(/requires a non-empty --command/);
      expect(() => renderPipelineTemplate("demo", "  ", template.id)).toThrow(/requires a non-empty --command/);
      expect(renderPipelineTemplate("demo", COMMAND, template.id)).toContain(JSON.stringify(COMMAND));
    } else {
      expect(renderPipelineTemplate("demo", undefined, template.id)).toContain('pipeline("demo")');
    }
  }
});

test("templates: the command is serialized, never interpolated into the source", () => {
  const command = `printf "quoted" && echo \`backtick\` && echo $(touch should-not-run)`;
  for (const template of PIPELINE_TEMPLATES.filter((candidate) => candidate.usesCommand)) {
    const source = renderPipelineTemplate("demo", command, template.id);
    expect(source).toContain(`command: ${JSON.stringify(command)}`);
    expect(source).not.toContain("$(touch should-not-run)`");
  }
});

test("templates: the default is the single shell step, and an unknown id lists the choices", () => {
  expect(pipelineTemplate().id).toBe("bash");
  expect(renderPipelineTemplate("demo", COMMAND)).toBe(renderPipelineTemplate("demo", COMMAND, "bash"));
  expect(() => pipelineTemplate("nope")).toThrow(/Unknown template: "nope"/);
  expect(() => pipelineTemplate("nope")).toThrow(new RegExp(templateIds().join(", ")));
});

test("templates: an invalid name is rejected before rendering", () => {
  for (const name of ["", "Demo", "-demo", "demo name", "../demo"]) {
    expect(() => renderPipelineTemplate(name, COMMAND)).toThrow(/Invalid pipeline name/);
  }
});
