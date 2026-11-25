import { expect, test } from "bun:test";
import { type Artifact, artifact, source, textArtifact } from "../dsl/artifact.js";
import type { Pipeline, StepCapture, StepFailure } from "../definition.js";
import { PipelineStructureValidator } from "./structure.js";

/** `on_failure` reaches the runner from the SDK as well as the DSL, so the
 *  structural rules are asserted on a hand-built policy: the builder would have
 *  refused these shapes before validation could see them. */
function findings(on_failure: StepFailure) {
  const pipeline = {
    name: "gate",
    steps: [{ id: "verify", name: "Verify", command: "make test", runner: "bash", rerun_on_resume: true, on_failure }],
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
    'step "verify": onFail.resumeSession requires fix',
  ]);
});

test("stop_if_unchanged without a fix prompt has no repair to measure", () => {
  expect(findings({ stop_if_unchanged: true, fix_prompt: "fix", max_retries: 2 })).toEqual([]);
  expect(findings({ stop_if_unchanged: true, max_retries: 2 })).toEqual([
    'step "verify": onFail.stopIfUnchanged requires fix',
  ]);
});

test("a fix policy bounded to zero attempts would never repair", () => {
  expect(findings({ fix_prompt: "fix", max_retries: 0 })).toEqual([
    'step "verify": onFail.retries must be >= 1 when fix is set',
  ]);
});

test("a raw definition meets the rules the builder used to hold alone", () => {
  expect(findings({ fix_prompt: "fix", max_retries: 1, fix_only_when_extracted: true })).toEqual([
    'step "verify": fixOnlyWhenExtracted requires errorExtractor',
  ]);
  expect(findings({ fix_prompt: "fix", max_retries: 2, replay_after_fix: false })).toEqual([
    'step "verify": replayAfterFix: false requires blocking: false',
    'step "verify": replayAfterFix: false requires retries: 1',
  ]);
  expect(
    findings({ max_retries: 1, escalate_model: " ", escalate_effort: "huge" as never, escalate_after: -1 }),
  ).toEqual([
    'step "verify": escalate.model must be a non-empty string',
    'step "verify": escalate.effort is invalid (received: huge)',
    'step "verify": escalate.after must be a non-negative integer (received: -1)',
  ]);
});

test("a raw definition writing a source, or declaring one twice, is refused like the builder does", () => {
  const tree = source("tree", { command: "git rev-parse HEAD" });
  const result = textArtifact("result.md");
  const validate = (sources: unknown[], outputs: unknown[]) =>
    new PipelineStructureValidator()
      .validate({
        source: "gate.ts",
        pipeline: {
          name: "gate",
          steps: [{ id: "derive", name: "Derive", command: "true", runner: "bash", sources, outputs }],
        } as unknown as Pipeline,
        profileOverrides: {},
      })
      .map((finding) => finding.message);

  expect(validate([tree], [result])).toEqual([]);
  expect(validate([tree], [result, tree])).toEqual([
    'step "derive": source "tree" cannot be an output: a source is read, never written',
  ]);
  expect(validate([tree, tree], [result])).toEqual(['step "derive": source "tree" is declared twice in input']);
});

/** `captures` reach the runner from a raw definition too. A capture named after a
 *  verdict field would overwrite its type in the verdict schema
 *  (`{ ...VERDICT_FIELDS, ...fields }`) and break the contract in silence, so the
 *  builder and this rule share one refusal. */
function captureFindings(captures: StepCapture[]) {
  const pipeline = {
    name: "gate",
    steps: [{ id: "commit", name: "Commit", command: "write", runner: "agent", rerun_on_resume: true, captures }],
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

test("a raw capture schema is held to strict mode", () => {
  const open = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
  expect(captureFindings([{ field: "branch", artifact: branch, schema: open, text: false }])).toEqual([
    'step "commit": capture "branch".schema: schema must set additionalProperties: false on every object',
  ]);
  expect(captureFindings([{ field: "branch", artifact: branch, text: false } as unknown as StepCapture])).toEqual([
    'step "commit": capture "branch".schema must be a schema object',
  ]);
});

test("a raw rework names a declared step that writes the approved artifact", () => {
  const plan = textArtifact("plan.md");
  const validate = (outputs: Artifact<unknown>[], stepId: string) =>
    new PipelineStructureValidator()
      .validate({
        source: "gate.ts",
        pipeline: {
          name: "gate",
          steps: [{ id: "write-plan", name: "Plan", command: "plan", runner: "bash", outputs }],
          approvals: new Map([["plan", plan]]),
          reworks: new Map([["plan", { stepId, maxRounds: 3 }]]),
        } as unknown as Pipeline,
        profileOverrides: {},
      })
      .map((finding) => finding.message);

  expect(validate([plan], "write-plan")).toEqual([]);
  expect(validate([plan], "missing")).toEqual(['rework step "missing" of subject "plan" is not declared']);
  expect(validate([textArtifact("other.md")], "write-plan")).toEqual([
    'rework step "write-plan" of subject "plan" does not declare plan.md as an output',
  ]);
});

test("an entry that is not a step object is reported, not dereferenced", () => {
  const pipeline = { name: "gate", steps: [null] } as unknown as Pipeline;
  const messages = new PipelineStructureValidator()
    .validate({ source: "gate.ts", pipeline, profileOverrides: {} })
    .map((finding) => finding.message);
  expect(messages).toEqual(["steps[0] must be a step object"]);
});
