import { expect, test } from "bun:test";
import type { OnFail } from "../dsl/dsl-types.js";
import { bashStep, llmStep, pipeline } from "../dsl.js";
import { PipelineValidationChain } from "./chain.js";
import { FixBackendValidator } from "./fix-backend.js";
import { createDefaultAgentBackendRegistry } from "../engine/default-registry.ts";
import { buildPipelineContext } from "../pipeline/context.js";

/** Explicit registry: the DSL no longer falls back to the built-in composition. */
const REGISTRY = createDefaultAgentBackendRegistry();
/** Rules read the registry from the context; there is no built-in fallback. */
const CONTEXT = buildPipelineContext({ agentBackendRegistry: REGISTRY });

function gatePipeline(onFail: OnFail) {
  return pipeline("validation")
    .add(
      llmStep(
        { id: "implement", name: "Implement", backend: "claude", profile: "coder", command: "implement" },
        REGISTRY,
      ),
    )
    .add(bashStep({ id: "verify", name: "Verify", command: "make test", onFail }))
    .build();
}

function validate(p: ReturnType<typeof gatePipeline>) {
  return new PipelineValidationChain([new FixBackendValidator()]).validate({
    source: "test",
    pipeline: p,
    profileOverrides: {},
    pipelineContext: CONTEXT,
  });
}

const FRESH_ON_CODEX: OnFail = { fix: () => "fix", retries: 2, fixBackend: "codex" };

test("accepts fixBackend on a fresh-session bash fix when the backend is registered", () => {
  expect(validate(gatePipeline(FRESH_ON_CODEX)).ok).toBe(true);
});

test("refuses an unregistered fixBackend", () => {
  const report = validate(gatePipeline({ ...FRESH_ON_CODEX, fixBackend: "gemini" }));

  expect(report.ok).toBe(false);
  expect(report.errors).toHaveLength(1);
  expect(report.errors[0].rule).toBe("fix-backend");
  expect(report.errors[0].message).toMatch(/"verify".*"gemini" is not a registered backend.*claude/);
});

test("refuses fixBackend with resumeSession", () => {
  const report = validate(gatePipeline({ ...FRESH_ON_CODEX, resumeSession: "implement" }));
  expect(report.ok).toBe(false);
  expect(report.errors).toHaveLength(1);
  expect(report.errors[0].message).toMatch(
    /"verify".*"codex" cannot apply with resumeSession.*Drop fixBackend or resumeSession/,
  );
});

test("refuses fixBackend on an agent step at build time", () => {
  expect(() =>
    llmStep(
      {
        id: "review",
        name: "Review",
        backend: "claude",
        profile: "reviewer",
        command: "review",
        onFail: FRESH_ON_CODEX,
      },
      REGISTRY,
    ).build(),
  ).toThrow(/"review": fixBackend applies only to a step without a backend/);
});

test("refuses an empty fixBackend", () => {
  expect(() => bashStep({ id: "x", name: "X", command: "c", onFail: { ...FRESH_ON_CODEX, fixBackend: " " } })).toThrow(
    /fixBackend must be a non-empty string/,
  );
});
