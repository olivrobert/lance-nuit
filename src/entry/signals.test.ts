import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadOrCreateRun } from "../boot/resume.ts";
import { commandRegistries } from "../commands/registries.ts";
import { buildPipelineContext } from "../pipeline/context.ts";
import { NULL_RUN_OUTPUT } from "../runtime/run-output.ts";
import { readRunEvents } from "../state/run-journal.ts";
import { resumeDecision } from "../state/run-predicates.ts";
import { readRunSnapshot } from "../state/run-snapshot.ts";
import { executeRunSteps } from "../step/step-loop.ts";

// An interruption is the one code path that cannot be exercised in-process: the
// handler installed by `installChildKillHandlers` must receive a real signal,
// persist the run synchronously, and exit. Everything after it — that a resume
// replays no completed step — is asserted on the bytes that child left on disk.
//
// The child runs under `process.execPath`, so this also pins that the runtime
// executing the runner delivers SIGINT/SIGTERM to a JavaScript handler and lets
// it finish its synchronous writes before the process goes away.

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");

/** Three-step pipeline: one step completed before the interruption, one in
 *  flight when it arrives, one never started. */
function pipelineFile(root: string): string {
  const path = join(root, "p.ts");
  writeFileSync(
    path,
    `export default ({ pipeline, actionStep }) => pipeline("p")
  .add(actionStep({ id: "a", name: "a", run: () => {}, describe: "a" }))
  .add(actionStep({ id: "b", name: "b", run: () => {}, describe: "b" }))
  .add(actionStep({ id: "c", name: "c", run: () => {}, describe: "c" }))
  .build();`,
  );
  return path;
}

/** Source of the interrupted runner. It reaches the exact state a signal is
 *  worst in: step `a` done, step `b` running with an open attempt, then nothing
 *  left to do but wait. */
function childSource(root: string, runDir: string, pipelinePath: string): string {
  const module = (path: string) => JSON.stringify(join(REPO_ROOT, path));
  return [
    `import { loadOrCreateRun } from ${module("src/boot/resume.ts")};`,
    `import { commandRegistries } from ${module("src/commands/registries.ts")};`,
    `import { buildPipelineContext } from ${module("src/pipeline/context.ts")};`,
    `import { appendRunEvent } from ${module("src/state/run-journal.ts")};`,
    `import { saveRun } from ${module("src/state/run-repository.ts")};`,
    `import { nextAttemptLogPath } from ${module("src/state/run-timeline.ts")};`,
    `import { updateStep } from ${module("src/state/run-transitions.ts")};`,
    `import { installChildKillHandlers } from ${module("src/entry/signals.ts")};`,
    `import { createAbortScope } from ${module("src/runtime/abort.ts")};`,
    `const ctx = buildPipelineContext({ ...commandRegistries(), cwd: ${JSON.stringify(root)}, ticket: "T-9" });`,
    `const run = await loadOrCreateRun(${JSON.stringify(pipelinePath)}, "T-9", undefined, undefined, ${JSON.stringify(
      runDir,
    )}, false, undefined, ctx);`,
    'updateStep(run, run.steps[0], "done");',
    'updateStep(run, run.steps[1], "running");',
    'const logPath = nextAttemptLogPath(run, run.steps[1], "step");',
    'appendRunEvent(run, "step.attempt.started", { stepId: "b", attempt: 1, kind: "step", logPath });',
    "saveRun(run);",
    "installChildKillHandlers(createAbortScope(), () => run);",
    // The handshake: the parent signals only once the run is in flight, so the
    // test never races the setup.
    'process.stdout.write("ready\\n");',
    "setInterval(() => {}, 1000);",
  ].join("\n");
}

interface Interrupted {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  root: string;
  runDir: string;
  pipelinePath: string;
  stderr: string;
}

/** Start a runner, wait until it holds a running step, signal it, and wait for
 *  it to be gone. No fixed delay anywhere: both waits are on events. */
async function interruptRunner(signal: "SIGINT" | "SIGTERM"): Promise<Interrupted> {
  const root = mkdtempSync(join(tmpdir(), `signals-${signal.toLowerCase()}-`));
  const runDir = join(root, "run");
  const pipelinePath = pipelineFile(root);
  const { RUNNER_EVENTS_FILE: _ignored, ...env } = process.env;
  const child = spawn(process.execPath, ["-e", childSource(root, runDir, pipelinePath)], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (text: string) => {
    stderr += text;
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("exit", (code, exitSignal) => resolveExit({ code, signal: exitSignal }));
  });
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    let seen = "";
    child.stdout.on("data", (text: string) => {
      seen += text;
      if (seen.includes("ready")) resolveReady();
    });
    child.once("exit", () => rejectReady(new Error(`runner exited before it was ready: ${stderr}`)));
  });

  await ready;
  child.kill(signal);
  const outcome = await exited;
  return { exitCode: outcome.code, signal: outcome.signal, root, runDir, pipelinePath, stderr };
}

test("a real SIGTERM during a step persists the abort and leaves a resumable run", async () => {
  const { exitCode, signal, root, runDir, pipelinePath, stderr } = await interruptRunner("SIGTERM");

  // 128 + 15: the handler ran to completion and chose the exit code. A bare
  // `signal: "SIGTERM"` would mean the default disposition killed the process
  // before it could write anything.
  expect(stderr).not.toContain("Unable to persist abort");
  expect(signal).toBeNull();
  expect(exitCode).toBe(143);

  const raw = readFileSync(join(runDir, "state.json"), "utf8");
  // A snapshot written by a dying process must be complete, not half a file.
  expect(() => JSON.parse(raw)).not.toThrow();
  const snapshot = readRunSnapshot(join(runDir, "state.json"))!;
  expect(snapshot.status).toBe("ABORTED");
  expect(snapshot.steps.map((step) => step.status)).toEqual(["done", "aborted", "pending"]);
  expect(snapshot.outcome).toMatchObject({ phase: "b", resumable: true });
  expect(String(snapshot.outcome?.reason)).toContain("SIGTERM");

  // The interrupted attempt is closed, not left open: a resume that found it
  // `running` would either replay a step it cannot account for, or settle it a
  // second time.
  const events = readRunEvents(runDir);
  const started = events.filter((event) => event.type === "step.attempt.started");
  const finished = events.filter((event) => event.type === "step.attempt.finished");
  expect(started).toHaveLength(1);
  expect(finished).toHaveLength(1);
  expect(finished[0]).toMatchObject({ stepId: "b", attempt: 1, status: "aborted" });
  expect(events.filter((event) => event.type === "run.aborted")).toHaveLength(1);

  // Only the interrupted step and the untouched one are left to do.
  expect(resumeDecision(snapshot)).toEqual({ resume: true });
  expect(snapshot.steps.filter((step) => step.status === "done").map((step) => step.id)).toEqual(["a"]);

  // The relaunch: the same directory, loaded by the same boot path, executed by
  // the real loop. The completed step must not be spawned again.
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "T-9" });
  const resumed = await loadOrCreateRun(pipelinePath, "T-9", undefined, undefined, runDir, false, undefined, ctx);
  expect(resumed.steps.map((step) => step.status)).toEqual(["done", "aborted", "pending"]);
  const spawned: string[] = [];
  const outcome = await executeRunSteps(
    resumed,
    "T-9",
    undefined,
    { resuming: true },
    {
      executeStep: async (step) => {
        spawned.push(step.id);
        return { ok: true, output: "", stats: { duration_ms: 1 } };
      },
      extractErrors: async () => ({ hasErrors: false, errors: "" }),
      runFixLoop: async () => ({ failed: false }),
      output: NULL_RUN_OUTPUT,
    },
    ctx,
  );

  expect(outcome.failed).toBe(false);
  expect(spawned).toEqual(["b", "c"]);
}, 30_000);

test("a real SIGINT is the same durable stop, with the Ctrl+C exit code", async () => {
  const { exitCode, signal, runDir } = await interruptRunner("SIGINT");

  expect(signal).toBeNull();
  expect(exitCode).toBe(130);
  const snapshot = readRunSnapshot(join(runDir, "state.json"))!;
  expect(snapshot.status).toBe("ABORTED");
  expect(String(snapshot.outcome?.reason)).toContain("SIGINT");
  expect(snapshot.steps.map((step) => step.status)).toEqual(["done", "aborted", "pending"]);
  expect(resumeDecision(snapshot)).toEqual({ resume: true });
}, 30_000);
