// Outcome resolution as an output producer.
//
// `resolveOutcome` used to say two things through two channels: step events on
// the `RunOutput` port, prose on the global logger. A destination that received
// only the events therefore missed half of what happened, and nothing stopped a
// site from saying the same thing twice. These tests hold the single channel:
// every line the phase produces is a `runner.message` on the injected output, and
// nothing reaches stderr behind its back.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandRegistries } from "../commands/registries.ts";
import type { AgentSession } from "../contracts/backends.ts";
import { artifact } from "../dsl/artifact.ts";
import type { StepResult } from "../exec/runners.ts";
import type { ArtifactRef, WorkItemArtifactStore } from "../model/artifact-ports.ts";
import type { PipelineStep } from "../model/definition.ts";
import type { Run, RunStep } from "../model/run.ts";
import { buildPipelineContext } from "../pipeline/context.ts";
import { createAbortScope } from "../runtime/abort.ts";
import type { RunnerEvent } from "../runtime/events.ts";
import { setLogInterceptor } from "../runtime/logging.ts";
import type { RunOutput } from "../runtime/run-output.ts";
import { makeRunStep } from "../state/run-step.ts";
import { type ResolveOutcomeInput, resolveOutcome } from "./step-outcome.ts";

afterEach(() => setLogInterceptor(undefined));

/** Recording destination plus a count of the stderr writes performed while the
 *  phase ran. The interceptor is the hook every runner write passes through, so a
 *  forgotten `log()` shows up as a non-zero count. */
function recorder(): { output: RunOutput; events: RunnerEvent[]; stderrWrites: () => number } {
  const events: RunnerEvent[] = [];
  let writes = 0;
  setLogInterceptor(() => {
    writes++;
  });
  return {
    output: { emit: (event) => events.push(event) },
    events,
    stderrWrites: () => writes,
  };
}

function failedInput(def: Partial<PipelineStep>, output: RunOutput): ResolveOutcomeInput {
  const step: RunStep = makeRunStep(
    { id: "s", name: "Check", command: "make test", runner: "bash", ...def },
    {
      status: "running",
    },
  );
  const dir = mkdtempSync(join(tmpdir(), "step-outcome-"));
  const run: Run = {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: dir,
    steps: [step],
  };
  const stepLog = join(dir, "output.log");
  writeFileSync(stepLog, "");
  return {
    run,
    step,
    command: "make test",
    baseCtx: buildPipelineContext({ cwd: process.cwd() }),
    budget: { cumulative: 0 },
    abort: createAbortScope(),
    result: { ok: false, output: "boom", failReason: "exit 3" },
    stepLog,
    deps: {
      executeStep: async () => {
        throw new Error("no attempt is expected on this path");
      },
      extractErrors: async () => ({ errors: "", hasErrors: false }),
      runFixLoop: async () => ({ failed: true }),
    },
    output,
  };
}

test("a step failing without a retry policy says it once, on the output port", async () => {
  const { output, events, stderrWrites } = recorder();

  const action = await resolveOutcome(failedInput({}, output));

  expect(action).toBe("failed");
  expect(events.map((event) => event.type)).toEqual(["step.failed", "runner.message"]);
  const message = events[1] as Extract<RunnerEvent, { type: "runner.message" }>;
  expect(message.level).toBe("info");
  expect(message.message).toContain("📄 Output:");
  expect(stderrWrites()).toBe(0);
});

test("a silent extractor on a failed step warns through the port, not through stderr", async () => {
  // The warning qualifies the diagnosis, not the run: the exit code already
  // failed the step, and the extractor simply had nothing to add.
  const { output, events, stderrWrites } = recorder();

  await resolveOutcome(failedInput({ error_extractor: "tests-json" }, output));

  const warnings = events.filter(
    (event): event is Extract<RunnerEvent, { type: "runner.message" }> =>
      event.type === "runner.message" && event.level === "warn",
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]!.message).toContain("found no actionable error");
  expect(stderrWrites()).toBe(0);
});

test("an absorbed non-blocking failure warns through the port, not through stderr", async () => {
  const { output, events, stderrWrites } = recorder();

  const action = await resolveOutcome(failedInput({ blocking: false }, output));

  expect(action).toBe("continue");
  const warnings = events.filter(
    (event): event is Extract<RunnerEvent, { type: "runner.message" }> =>
      event.type === "runner.message" && event.level === "warn",
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]!.message).toContain("non-blocking warning");
  expect(stderrWrites()).toBe(0);
});

/** `fixOnlyWhenExtracted` is decided in this phase, so the assertions live here:
 *  the extraction is computed once and handed to the on_failure handler, and the
 *  handler must not spend a repair on it when it holds nothing actionable. */
function fixPolicyInput(
  output: RunOutput,
  extraction: { hasErrors: boolean; errors: string; reportFound?: boolean },
  fixOnlyWhenExtracted?: boolean,
): { input: ResolveOutcomeInput; fixCalls: () => number } {
  const input = failedInput(
    {
      error_extractor: "phpunit",
      on_failure: {
        fix_prompt: "fix",
        max_retries: 2,
        ...(fixOnlyWhenExtracted === undefined ? {} : { fix_only_when_extracted: fixOnlyWhenExtracted }),
      },
    },
    output,
  );
  let fixCalls = 0;
  input.deps.extractErrors = async () => extraction;
  input.deps.runFixLoop = async () => {
    fixCalls++;
    return { failed: true };
  };
  return { input, fixCalls: () => fixCalls };
}

test("fixOnlyWhenExtracted fails a step whose report was never written, without a repair", async () => {
  const { output, events } = recorder();
  const { input, fixCalls } = fixPolicyInput(output, { hasErrors: false, errors: "boom", reportFound: false }, true);

  const action = await resolveOutcome(input);

  expect(action).toBe("failed");
  expect(fixCalls()).toBe(0);
  // No repair and no replay: the quota is untouched, so a resume can still fix it
  // once the infrastructure is back.
  expect(input.step.retries).toBe(0);
  expect(input.step.status).toBe("failed");
  const messages = events
    .filter((event): event is Extract<RunnerEvent, { type: "runner.message" }> => event.type === "runner.message")
    .map((event) => event.message);
  expect(messages.some((message) => message.includes("no report was produced"))).toBe(true);
  expect(messages.some((message) => message.includes("fixOnlyWhenExtracted"))).toBe(true);
});

test("fixOnlyWhenExtracted distinguishes a green report from a missing one", async () => {
  const { output, events } = recorder();
  const { input, fixCalls } = fixPolicyInput(output, { hasErrors: false, errors: "boom", reportFound: true }, true);

  const action = await resolveOutcome(input);

  expect(action).toBe("failed");
  expect(fixCalls()).toBe(0);
  const messages = events
    .filter((event): event is Extract<RunnerEvent, { type: "runner.message" }> => event.type === "runner.message")
    .map((event) => event.message);
  expect(messages.some((message) => message.includes("the report holds no actionable error"))).toBe(true);
  expect(messages.some((message) => message.includes("no report was produced"))).toBe(false);
});

test("fixOnlyWhenExtracted repairs as usual when the extractor found errors", async () => {
  const { output } = recorder();
  const { input, fixCalls } = fixPolicyInput(output, { hasErrors: true, errors: "Foo::testBar failed" }, true);

  const action = await resolveOutcome(input);

  expect(action).toBe("failed");
  expect(fixCalls()).toBe(1);
});

// The documented default: no extracted error still buys a repair from the raw
// output, because a crash after a written report is a real defect to fix.
test("without fixOnlyWhenExtracted an unextracted failure still reaches the fix loop", async () => {
  const { output } = recorder();
  const { input, fixCalls } = fixPolicyInput(output, { hasErrors: false, errors: "boom", reportFound: false });

  const action = await resolveOutcome(input);

  expect(action).toBe("failed");
  expect(fixCalls()).toBe(1);
});

/* ------------------------------------------------------------------------- *
 * Re-ask of a refused capture. The DSL keeps cross-field invariants out of the
 * schema, so a kit checks them in the artifact's parser; a pipeline cannot answer
 * the refusal itself (a step may not resume its own session), so the runner asks
 * the same session ONCE for a corrected object, as a tracked attempt of its own.
 * ------------------------------------------------------------------------- */

const CLAUDE_SESSION: AgentSession = { provider: "claude", id: "sess-triage", resumable: true };
const REFUSAL = "triage.json: a high risk requires a test policy";
const REFUSED = { risk: "high", testPolicy: "none" };
const CORRECTED = { risk: "high", testPolicy: "unit" };

/** The kit's invariant the schema cannot carry: two fields read together. */
const triage = artifact("triage.json", (value) => {
  const parsed = value as { risk?: unknown; testPolicy?: unknown };
  if (parsed.risk === "high" && parsed.testPolicy === "none") throw new Error(REFUSAL);
  return parsed;
});

interface RefusedCaptureFixture {
  input: ResolveOutcomeInput;
  values: Map<string, string>;
  /** What each re-ask spawn received: the command and the session it resumed. */
  spawns: Array<{ command: string; resumeSession: AgentSession | undefined }>;
}

function refusedCaptureInput(
  output: RunOutput,
  reasked: Partial<StepResult>,
  state: { session?: AgentSession; maxCost?: number; cumulative?: number } = { session: CLAUDE_SESSION },
): RefusedCaptureFixture {
  const values = new Map<string, string>();
  const store: WorkItemArtifactStore = {
    exists: async (ref: ArtifactRef) => values.has(ref.name),
    readText: async (ref: ArtifactRef) => values.get(ref.name),
    readJson: async <T>(ref: ArtifactRef, parse: (raw: unknown) => T) => {
      const raw = values.get(ref.name);
      return raw === undefined ? undefined : parse(JSON.parse(raw));
    },
    writeText: async (ref: ArtifactRef, next: string) => {
      values.set(ref.name, next);
    },
    remove: async (ref: ArtifactRef) => {
      values.delete(ref.name);
    },
  };
  const step: RunStep = makeRunStep(
    {
      id: "triage",
      name: "Triage",
      command: "triage the ticket",
      runner: "agent",
      backend: { id: "claude" },
      output_format: "json",
      captures: [
        {
          field: "triage",
          artifact: triage,
          schema: {
            type: "object",
            properties: { risk: { type: "string" }, testPolicy: { type: "string" } },
            required: ["risk", "testPolicy"],
            additionalProperties: false,
          },
          text: false,
        },
      ],
      outputs: [triage],
    },
    { status: "running", session: state.session },
  );
  const dir = mkdtempSync(join(tmpdir(), "step-outcome-reask-"));
  const run: Run = {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: dir,
    max_cost_usd: state.maxCost,
    steps: [step],
  };
  const stepLog = join(dir, "output.log");
  writeFileSync(stepLog, "");
  const spawns: RefusedCaptureFixture["spawns"] = [];
  const input: ResolveOutcomeInput = {
    run,
    step,
    command: "triage the ticket",
    baseCtx: buildPipelineContext({ ...commandRegistries(), cwd: ".", ticket: "PROJ-1", artifacts: store }),
    budget: { cumulative: state.cumulative ?? 0 },
    abort: createAbortScope(),
    // What `runAttempt` returns for the refused initial attempt: the command
    // succeeded, the object it returned did not pass the artifact.
    result: {
      ok: false,
      output: "",
      failReason: REFUSAL,
      structuredOutput: { success: true, reason: "done", triage: REFUSED },
      captureRefused: true,
    },
    stepLog,
    deps: {
      executeStep: async (_step, command, spawn) => {
        spawns.push({ command, resumeSession: spawn?.resumeSession });
        return { output: "", ok: true, stats: { duration_ms: 1 }, ...reasked };
      },
      extractErrors: async () => ({ errors: "", hasErrors: false }),
      runFixLoop: async () => ({ failed: true }),
    },
    output,
  };
  return { input, values, spawns };
}

function messagesOf(events: RunnerEvent[]): string[] {
  return events
    .filter((event): event is Extract<RunnerEvent, { type: "runner.message" }> => event.type === "runner.message")
    .map((event) => event.message);
}

function failedSuffixOf(events: RunnerEvent[]): string | undefined {
  return events.find((event): event is Extract<RunnerEvent, { type: "step.failed" }> => event.type === "step.failed")
    ?.suffix;
}

test("re-ask: a refused capture is asked again in the same session, and a corrected object completes the step", async () => {
  const { output, events } = recorder();
  const { input, values, spawns } = refusedCaptureInput(output, {
    structuredOutput: { success: true, reason: "done", triage: CORRECTED },
  });

  const action = await resolveOutcome(input);

  expect(action).toBe("continue");
  expect(input.step.status).toBe("done");
  // One re-ask, into the session that holds the work — not a fresh one.
  expect(spawns).toHaveLength(1);
  expect(spawns[0]!.resumeSession).toEqual(CLAUDE_SESSION);
  // Not the step command, which would redo the work: a short message that
  // carries the reason the schema could not express.
  expect(spawns[0]!.command).not.toBe("triage the ticket");
  expect(spawns[0]!.command).toContain(REFUSAL);
  // The re-ask is a tracked attempt: it has its log and its verdict on the step.
  expect(input.step.attempts).toHaveLength(1);
  expect(input.step.attempts[0]).toMatchObject({ kind: "step", status: "done" });
  // `runAttempt` persisted the corrected capture like any accepted one.
  expect(JSON.parse(values.get("triage.json")!)).toEqual(CORRECTED);
  expect(messagesOf(events).some((message) => message.includes("Re-ask (1/1)"))).toBe(true);
  expect(events.some((event) => event.type === "step.done")).toBe(true);
});

test("re-ask: the same refused object comes back — the runner does not insist", async () => {
  const { output, events } = recorder();
  const { input, values, spawns } = refusedCaptureInput(output, {
    structuredOutput: { success: true, reason: "done", triage: REFUSED },
  });

  const action = await resolveOutcome(input);

  expect(action).toBe("failed");
  expect(input.step.status).toBe("failed");
  expect(spawns).toHaveLength(1);
  expect(values.has("triage.json")).toBe(false);
  const messages = messagesOf(events);
  expect(messages.some((message) => message.includes("same refused output"))).toBe(true);
  // Neither a verdict nor a missing retry: the object was refused by its contract.
  expect(failedSuffixOf(events)).toContain("(output contract refused, no fix configured)");
  expect(failedSuffixOf(events)).toContain(REFUSAL);
});

test("re-ask: without a resumable session there is no re-ask, and the failure names the refusal", async () => {
  for (const session of [undefined, { ...CLAUDE_SESSION, resumable: false }]) {
    const { output, events } = recorder();
    const { input, spawns } = refusedCaptureInput(output, {}, { session });

    const action = await resolveOutcome(input);

    expect(action).toBe("failed");
    expect(spawns).toHaveLength(0);
    expect(input.step.attempts).toHaveLength(0);
    expect(failedSuffixOf(events)).toContain("(output contract refused, no fix configured)");
    expect(messagesOf(events).some((message) => message.includes("Re-ask"))).toBe(false);
  }
});

test("re-ask: a budget that withholds work withholds the re-ask, and records the stop", async () => {
  const { output, events } = recorder();
  const { input, spawns } = refusedCaptureInput(output, {}, { session: CLAUDE_SESSION, maxCost: 1, cumulative: 1 });

  const action = await resolveOutcome(input);

  expect(action).toBe("failed");
  expect(spawns).toHaveLength(0);
  expect(messagesOf(events).some((message) => message.includes("Budget exceeded, no re-ask"))).toBe(true);
  expect(failedSuffixOf(events)).toContain("(output contract refused, no fix configured)");
});

test("re-ask: a result that was not a refusal is never re-asked", async () => {
  const { output } = recorder();
  const { input, spawns } = refusedCaptureInput(output, {});
  input.result = { ok: false, output: "", failReason: "spec.md: missing" };

  const action = await resolveOutcome(input);

  expect(action).toBe("failed");
  expect(spawns).toHaveLength(0);
});
