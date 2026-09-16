import { expect, test } from "bun:test";
import type { OnFail } from "../dsl/dsl-types.js";
import { bashStep, llmStep, pipeline } from "../dsl.js";
import { PipelineValidationChain } from "./chain.js";
import { ResumedFixEscalationValidator } from "./resumed-fix-escalation.js";
import { createDefaultAgentBackendRegistry } from "../engine/default-registry.ts";
import { buildPipelineContext } from "../pipeline/context.js";

/** Explicit registry: the DSL no longer falls back to the built-in composition. */
const REGISTRY = createDefaultAgentBackendRegistry();
/** Rules read the registry from the context; there is no built-in fallback. */
const CONTEXT = buildPipelineContext({ agentBackendRegistry: REGISTRY });

function gatePipeline(coderBackend: "claude" | "codex", onFail: OnFail) {
  return pipeline("validation")
    .add(
      llmStep(
        {
          id: "implement",
          name: "Implement",
          backend: coderBackend as never,
          profile: "coder",
          command: "implement",
        },
        REGISTRY,
      ),
    )
    .add(bashStep({ id: "verify", name: "Verify", command: "make test", onFail }))
    .build();
}

function validate(p: ReturnType<typeof gatePipeline>) {
  return new PipelineValidationChain([new ResumedFixEscalationValidator()]).validate({
    source: "test",
    pipeline: p,
    profileOverrides: {},
    pipelineContext: CONTEXT,
  });
}

const RESUME_WITH_MODEL: OnFail = {
  fix: () => "fix",
  resumeSession: "implement",
  retries: 3,
  escalate: { model: "opus[1m]" },
};

test("refuses escalate.model on a resumed bash fix when the resumed step runs on another backend", () => {
  const report = validate(gatePipeline("codex", RESUME_WITH_MODEL));

  expect(report.ok).toBe(false);
  expect(report.errors).toHaveLength(1);
  expect(report.errors[0].rule).toBe("resumed-fix-escalation");
  expect(report.errors[0].message).toMatch(
    /"verify".*opus\[1m\].*resumes the session of "implement" on codex.*Drop escalate.model or resumeSession/,
  );
});

test("accepts escalate.model on a resumed bash fix when the resumed step runs on the default backend", () => {
  expect(validate(gatePipeline("claude", RESUME_WITH_MODEL)).ok).toBe(true);
});

test("accepts escalate.effort on a resumed bash fix whatever the coder backend", () => {
  const onFail: OnFail = { ...RESUME_WITH_MODEL, escalate: { effort: "high" } };
  expect(validate(gatePipeline("codex", onFail)).ok).toBe(true);
});

test("accepts escalate.model on a fresh-session bash fix whatever the coder backend", () => {
  const onFail: OnFail = { ...RESUME_WITH_MODEL, resumeSession: undefined };
  expect(validate(gatePipeline("codex", onFail)).ok).toBe(true);
});
