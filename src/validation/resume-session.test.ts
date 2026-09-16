import { expect, test } from "bun:test";
import type { OnFail } from "../dsl/dsl-types.js";
import { bashStep, llmStep, pipeline } from "../dsl.js";
import { validatePipeline } from "../pipeline/loader.js";
import { PipelineValidationChain } from "./chain.js";
import { ResumeSessionValidator } from "./resume-session.js";
import { createDefaultAgentBackendRegistry } from "../engine/default-registry.ts";
import { buildPipelineContext } from "../pipeline/context.js";

/** Explicit registry: the DSL no longer falls back to the built-in composition. */
const REGISTRY = createDefaultAgentBackendRegistry();
/** Rules read the registry from the context; there is no built-in fallback. */
const CONTEXT = buildPipelineContext({ agentBackendRegistry: REGISTRY });

function implement(id = "implement") {
  return llmStep({ id, name: "Implement", backend: "claude", profile: "coder", command: "implement" }, REGISTRY);
}

function gatePipeline(onFail: OnFail) {
  return pipeline("validation")
    .add(implement())
    .add(bashStep({ id: "verify", name: "Verify", command: "make test", onFail }))
    .build();
}

function validate(p: ReturnType<typeof gatePipeline>) {
  return new PipelineValidationChain([new ResumeSessionValidator()]).validate({
    source: "test",
    pipeline: p,
    profileOverrides: {},
  });
}

function resume(target: string): OnFail {
  return { fix: () => "fix", resumeSession: target, retries: 2 };
}

function onlyError(p: ReturnType<typeof gatePipeline>): string {
  const report = validate(p);
  expect(report.ok).toBe(false);
  expect(report.errors).toHaveLength(1);
  expect(report.errors[0].rule).toBe("resume-session");
  return report.errors[0].message;
}

test("accepts resumeSession naming an earlier agent step", () => {
  expect(validate(gatePipeline(resume("implement"))).ok).toBe(true);
});

test("a fresh-session fix names no step and needs none", () => {
  expect(validate(gatePipeline({ fix: () => "fix", retries: 2 })).ok).toBe(true);
});

test("refuses resumeSession naming an unknown step", () => {
  expect(onlyError(gatePipeline(resume("build")))).toBe('step "verify": resumeSession "build": no step with this id');
});

test("refuses a step resuming its own session", () => {
  expect(onlyError(gatePipeline(resume("verify")))).toBe(
    'step "verify": resumeSession "verify": cannot resume its own session',
  );
});

test("refuses resumeSession naming a bash step, which records no session", () => {
  const p = pipeline("validation")
    .add(bashStep({ id: "prepare", name: "Prepare", command: "make prepare" }))
    .add(bashStep({ id: "verify", name: "Verify", command: "make test", onFail: resume("prepare") }))
    .build();
  expect(onlyError(p)).toBe(
    'step "verify": resumeSession "prepare": step "prepare" is not an agent step, it has no session',
  );
});

test("refuses resumeSession naming a step declared later", () => {
  const p = pipeline("validation")
    .add(bashStep({ id: "verify", name: "Verify", command: "make test", onFail: resume("implement") }))
    .add(implement())
    .build();
  expect(onlyError(p)).toBe(
    'step "verify": resumeSession "implement": step "implement" runs after "verify": its session does not exist yet',
  );
});

test("the loader runs the rule on a pipeline built by the DSL", () => {
  expect(() => validatePipeline(gatePipeline(resume("build")), "validation.ts", { context: CONTEXT })).toThrow(
    /no step with this id/,
  );
  expect(() =>
    validatePipeline(gatePipeline(resume("implement")), "validation.ts", { context: CONTEXT }),
  ).not.toThrow();
});
