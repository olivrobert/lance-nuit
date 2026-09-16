import { expect, test } from "bun:test";
import { type Artifact, artifact, textArtifact } from "../dsl/artifact.js";
import type { Pipeline, StepCapture, StepFailure } from "../model/definition.js";
import { PipelineStructureValidator } from "./structure.js";

/** `on_failure` reaches the runner from the SDK as well as the DSL, so the
 *  structural rules are asserted on a hand-built policy: the builder would have
 *  refused these shapes before validation could see them. */
function findings(on_failure: StepFailure) {
  const pipeline = {
    name: "gate",
    steps: [{ id: "verify", name: "Verify", command: "make test", runner: "bash", on_failure }],
  } as Pipeline;

  return new PipelineStructureValidator()
    .validate({ source: "gate.ts", pipeline, profileOverrides: {} })
    .map((finding) => finding.message);
}

test("a policy accepted by the builder passes validation", () => {
  expect(findings({ max_retries: 2 })).toEqual([]);
  expect(findings({ fix_prompt: "fix", max_retries: 1 })).toEqual([]);
  expect(findings({ resume_session: "implement", fix_prompt: "fix", max_retries: 2 })).toEqual([]);
  // A plain rerun may legitimately declare no retry at all.
  expect(findings({ max_retries: 0 })).toEqual([]);
});

test("resume_session without a fix prompt has nothing to resume into", () => {
  expect(findings({ resume_session: "implement", max_retries: 2 })).toEqual([
    'step "verify": on_failure.resume_session requires fix_prompt',
  ]);
});

test("a fix policy bounded to zero attempts would never repair", () => {
  expect(findings({ fix_prompt: "fix", max_retries: 0 })).toEqual([
    'step "verify": on_failure.max_retries must be >= 1 when fix_prompt is set',
  ]);
});

/** `captures` reach the runner from a raw definition too, without the builder's
 *  checks. A capture named after a verdict field would overwrite its type in the
 *  verdict schema (`{ ...VERDICT_FIELDS, ...fields }`) and break the contract in
 *  silence, so the rule repeats the builder's refusals. */
function captureFindings(captures: StepCapture[]) {
  const pipeline = {
    name: "gate",
    steps: [{ id: "commit", name: "Commit", command: "write", runner: "agent", captures }],
  } as unknown as Pipeline;
  return new PipelineStructureValidator()
    .validate({ source: "gate.ts", pipeline, profileOverrides: {} })
    .map((finding) => finding.message);
}

const commitMessage = textArtifact("commit-message.md");
const branch = artifact("branch.json", (raw) => raw);
const text = (field: string, target: Artifact<unknown> = commitMessage): StepCapture => ({
  field,
  artifact: target,
  schema: { type: "string" },
  text: true,
});

test("captures accepted by the builder pass validation", () => {
  expect(captureFindings([text("commit"), text("branch", branch)])).toEqual([]);
});

test("a raw capture cannot take a verdict field's name", () => {
  for (const field of ["success", "reason", "blocked"]) {
    expect(captureFindings([text(field)])).toEqual([
      `step "commit": capture "${field}" is reserved by the verdict contract (success, reason, blocked)`,
    ]);
  }
});

test("a raw capture cannot repeat a field or an artifact", () => {
  expect(captureFindings([text("commit"), text("commit", branch)])).toEqual([
    'step "commit": capture "commit" is declared twice',
  ]);
  expect(captureFindings([text("commit"), text("summary")])).toEqual([
    'step "commit": capture "summary" targets artifact "commit-message.md" already captured by another field',
  ]);
  expect(captureFindings([text(" "), { field: "x", schema: { type: "string" }, text: true } as StepCapture])).toEqual([
    'step "commit": capture field names must be non-empty',
    'step "commit": capture "x" needs an artifact',
  ]);
});
