import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBackendRegistry } from "../../../contracts/backends.js";
import { executeStep, runWithAgent } from "../../../exec/runners.js";
import type { Run } from "../../../model/run.js";
import { buildPipelineContext } from "../../../pipeline/context.js";
import { performFixAttempt } from "../../../step/fix-loop-pass.js";
import { prepareFixRun } from "../../../step/fix-loop-runtime.js";
import { makeRunStep } from "../../../state/run-step.js";
import { createOpencodeBackendFactory } from "./backend.js";
import type { OpencodeBackendHost, OpencodeExecutionOptions, RawOpencodeExecutionResult } from "./types.js";
import { OPENCODE_MODEL } from "./types.js";
import { createAbortScope } from "../../../runtime/abort.js";
import { NULL_RUN_OUTPUT } from "../../../runtime/run-output.js";

/** A fork answers under a new session id; that is what makes the parent survive. */
const FORKED = JSON.stringify({
  type: "text",
  sessionID: "ses_fork",
  part: { id: "prt_1", text: "fixed" },
});

function recordingRegistry(): { registry: AgentBackendRegistry; seen: () => OpencodeExecutionOptions } {
  let captured: OpencodeExecutionOptions | undefined;
  const host: OpencodeBackendHost = {
    execute(options): Promise<RawOpencodeExecutionResult> {
      captured = options;
      return Promise.resolve({ output: FORKED, logs: "", code: 0, killed: false, durationMs: 9 });
    },
  };
  return {
    registry: new AgentBackendRegistry().register(createOpencodeBackendFactory(host)),
    seen: () => {
      if (!captured) throw new Error("no opencode spawn recorded");
      return captured;
    },
  };
}

/** The agent step whose session a later gate resumes. */
function implementStep(session?: { id: string }) {
  return makeRunStep(
    { id: "implement", name: "Implement", command: "implement", runner: "agent", backend: { id: "opencode" } },
    session
      ? { status: "done", session: { provider: "opencode", id: session.id, resumable: true } }
      : { status: "done" },
  );
}

test("fix loop: a repair resumes the session of the named step and forks it", async () => {
  const { registry, seen } = recordingRegistry();
  const implement = implementStep({ id: "ses_coder" });
  const step = makeRunStep(
    {
      id: "verify",
      name: "Verify",
      command: "make test",
      runner: "agent",
      backend: { id: "opencode", options: { model: OPENCODE_MODEL.NEMOTRON_3_ULTRA } },
      on_failure: { resume_session: "implement", fix_prompt: "corrige", max_retries: 1 },
    },
    { status: "running" },
  );
  const run: Run = {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: mkdtempSync(join(tmpdir(), "opencode-fixloop-")),
    steps: [implement, step],
  };
  const fx = prepareFixRun(
    run,
    step,
    "make test",
    buildPipelineContext({ cwd: ".", runnerBin: "", runnerDir: "" }),
    { cumulative: 0 },
    {
      resumeSession: "implement",
      deps: { executeStep, runWithAgent, extractErrors: async () => ({ hasErrors: true, errors: "boom" }), registry },
      output: NULL_RUN_OUTPUT,
      abort: createAbortScope(),
    },
  );

  const pass = await performFixAttempt(fx, { output: "KO", label: "1/1", banner: "fix 1/1", agentOptions: undefined });

  const args = seen().args;
  expect(args[args.indexOf("--session") + 1]).toBe("ses_coder");
  expect(args).toContain("--fork");
  expect(pass?.fix.ok).toBe(true);
  // The fork holds the repairs: it is written back to the resumed step so a
  // following pass resumes it, not the pristine parent.
  expect(implement.session).toEqual({ provider: "opencode", id: "ses_fork", resumable: true });
});

test("fix loop: a fresh repair when the named step recorded no session neither resumes nor forks", async () => {
  const { registry, seen } = recordingRegistry();
  const implement = implementStep();
  const step = makeRunStep(
    {
      id: "verify",
      name: "Verify",
      command: "make test",
      runner: "agent",
      backend: { id: "opencode" },
      on_failure: { resume_session: "implement", fix_prompt: "corrige", max_retries: 1 },
    },
    { status: "running" },
  );
  const run: Run = {
    name: "p",
    pipeline: "p",
    pipeline_path: "p.ts",
    run_dir: mkdtempSync(join(tmpdir(), "opencode-fixloop-")),
    steps: [implement, step],
  };
  const fx = prepareFixRun(
    run,
    step,
    "make test",
    buildPipelineContext({ cwd: ".", runnerBin: "", runnerDir: "" }),
    { cumulative: 0 },
    {
      resumeSession: "implement",
      deps: { executeStep, runWithAgent, extractErrors: async () => ({ hasErrors: true, errors: "boom" }), registry },
      output: NULL_RUN_OUTPUT,
      abort: createAbortScope(),
    },
  );

  await performFixAttempt(fx, { output: "KO", label: "1/1", banner: "fix 1/1", agentOptions: undefined });

  expect(seen().args).not.toContain("--session");
  expect(seen().args).not.toContain("--fork");
  expect(implement.session).toBeUndefined();
});
