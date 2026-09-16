#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runnerRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runnerBin = process.env.SMOKE_RUNNER_BIN ?? join(runnerRoot, "bin", "lancenuit");
const tempRoot = mkdtempSync(join(tmpdir(), "lance-nuit-smoke-"));
const repo = join(tempRoot, "repo");
const fakeBin = join(tempRoot, "fake-bin");
const invocationLog = join(tempRoot, "forbidden-invocations.log");
const counterFile = join(tempRoot, "step-counter.log");
const allowSecond = join(tempRoot, "allow-second");
const ticket = "SMOKE-STANDALONE";
const pipelineName = "smoke-standalone";
const pipelineFile = join(repo, ".lance-nuit", "pipelines", `${pipelineName}.ts`);

const forbiddenCommands = ["acli", "gh", "glab", "docker", "docker-compose", "jira", "claude", "codex", "opencode"];

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  // The managed execution environment can report EPERM from spawnSync even
  // after the child completed successfully (status/stdout remain authoritative).
  if (result.error && result.status == null) throw result.error;
  return result;
}

function checked(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    fail(
      [`${command} ${args.join(" ")} exited with ${result.status}`, result.stdout?.trim(), result.stderr?.trim()]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result;
}

let captureId = 0;

function runCaptured(command, args, options = {}) {
  const id = captureId++;
  const stdoutPath = join(tempRoot, `runner-${id}.stdout`);
  const stderrPath = join(tempRoot, `runner-${id}.stderr`);
  const stdoutFd = openSync(stdoutPath, "w");
  const stderrFd = openSync(stderrPath, "w");
  let result;
  try {
    result = spawnSync(command, args, {
      encoding: "utf8",
      ...options,
      // Piped child output is suppressed by the managed sandbox for nested
      // Node processes. File descriptors preserve the real CLI diagnostics.
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  result.stdout = readFileSync(stdoutPath, "utf8");
  result.stderr = readFileSync(stderrPath, "utf8");
  return result;
}

function makeForbiddenExecutables() {
  mkdirSync(fakeBin, { recursive: true });
  const script = [
    "#!/usr/bin/env bash",
    "set -eu",
    `printf '%s\\n' "$0 $*" >> ${JSON.stringify(invocationLog)}`,
    'printf \'forbidden executable invoked: %s\\n\' "$(basename "$0")" >&2',
    "exit 97",
    "",
  ].join("\n");
  for (const command of forbiddenCommands) {
    const path = join(fakeBin, command);
    writeFileSync(path, script, { mode: 0o755 });
    chmodSync(path, 0o755);
  }
}

function initializeRepository() {
  mkdirSync(repo, { recursive: true });
  checked("git", ["init", "--quiet", "-b", "main"], { cwd: repo });
  checked("git", ["config", "user.email", "smoke@example.invalid"], { cwd: repo });
  checked("git", ["config", "user.name", "Standalone smoke"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# standalone smoke\n");
  checked("git", ["add", "README.md"], { cwd: repo });
  checked("git", ["commit", "--quiet", "-m", "smoke baseline"], { cwd: repo });
}

function writePipeline() {
  mkdirSync(join(repo, ".lance-nuit", "pipelines"), { recursive: true });
  writeFileSync(join(repo, ".lance-nuit", ".gitignore"), "run/\nwork-items/\npipeline-history/\n");
  writeFileSync(
    pipelineFile,
    [
      'export default ({ pipeline, bashStep }) => pipeline("smoke-standalone")',
      '  .desc("Technology-neutral standalone smoke pipeline")',
      `  .add(bashStep({ id: "first", name: "First shell step", command: "printf 'first-step\\\\n' >> \\"$SMOKE_COUNTER\\"" }))`,
      `  .add(bashStep({ id: "second", name: "Second shell step", command: "if [[ ! -f \\"$SMOKE_ALLOW_SECOND\\" ]]; then printf 'second-step blocked\\\\n'; exit 23; fi; printf 'second-step\\\\n' >> \\"$SMOKE_COUNTER\\"" }))`,
      "  .build();",
      "",
    ].join("\n"),
  );
}

function statePath(result) {
  const runRoot = join(repo, ".lance-nuit", "work-items", ticket, "runs", pipelineName);
  const latest = join(runRoot, "latest");
  assert(
    existsSync(latest),
    [`latest is missing: ${latest}`, result?.stdout?.trim(), result?.stderr?.trim()].filter(Boolean).join("\n"),
  );
  const runId = readlinkSync(latest);
  return join(runRoot, runId, "state.json");
}

/**
 * The wrapper is the only entry point exercised here, and it runs the runner on
 * Bun. There is no second mode to fall back to: a missing or broken Bun is the
 * failure this script is meant to surface, not a condition to work around.
 */
function selectRunner() {
  const bun = run("bun", ["--version"], { cwd: tempRoot });
  if (bun.status !== 0) {
    fail(`bun is not usable on PATH (status ${bun.status}); the standalone runner needs Bun 1.3 or newer`);
  }
  const probe = runCaptured(runnerBin, ["--help"], { cwd: tempRoot, env: process.env });
  if (probe.status !== 0) {
    fail(`standalone bin probe failed (${probe.status})\n${probe.stdout}\n${probe.stderr}`);
  }
  return bun.stdout.trim();
}

function invokeRunner(env) {
  return runCaptured(runnerBin, ["run", ticket, "--pipeline", pipelineFile], {
    cwd: repo,
    env,
  });
}

function assertState(path, expectedStatus, expectedSteps) {
  assert(existsSync(path), `snapshot is missing: ${path}`);
  const state = JSON.parse(readFileSync(path, "utf8"));
  assert(state.schemaVersion === 1, `expected schemaVersion 1, got ${state.schemaVersion}`);
  assert(state.status === expectedStatus, `expected run status ${expectedStatus}, got ${state.status}`);
  const statuses = Object.fromEntries(state.steps.map((step) => [step.id, step.status]));
  for (const [id, status] of Object.entries(expectedSteps)) {
    assert(statuses[id] === status, `expected ${id}=${status}, got ${statuses[id]}`);
  }
  return state;
}

function main() {
  const bunVersion = selectRunner();
  makeForbiddenExecutables();
  initializeRepository();
  writePipeline();
  checked("git", ["add", ".lance-nuit/pipelines/smoke-standalone.ts", ".lance-nuit/.gitignore"], { cwd: repo });
  checked("git", ["commit", "--quiet", "-m", "add smoke pipeline"], { cwd: repo });

  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    SMOKE_COUNTER: counterFile,
    SMOKE_ALLOW_SECOND: allowSecond,
    PIPELINE_HOME: join(tempRoot, "empty-pipeline-home"),
  };

  const first = invokeRunner(env);
  assert(first.status !== 0, "the first run should fail at the second shell step");
  const firstStatePath = statePath(first);
  const firstState = assertState(firstStatePath, "FAIL", { first: "done", second: "failed" });
  const firstRunDir = join(firstStatePath, "..");
  const failedOutput = readFileSync(join(firstRunDir, "steps", "second", "attempt-001", "output.log"), "utf8");
  assert(
    failedOutput.includes("second-step blocked"),
    "the failed step log does not contain the deterministic failure",
  );
  const firstCounter = readFileSync(counterFile, "utf8");
  assert(firstCounter === "first-step\n", `unexpected first-run counter: ${JSON.stringify(firstCounter)}`);

  writeFileSync(allowSecond, "ok\n");
  const second = invokeRunner(env);
  assert(second.status === 0, `resume should pass (status ${second.status})\n${second.stdout}\n${second.stderr}`);
  const secondState = assertState(firstStatePath, "PASS", { first: "done", second: "done" });
  const finalCounter = readFileSync(counterFile, "utf8");
  assert(
    finalCounter === "first-step\nsecond-step\n",
    `first step was replayed or second did not run once: ${JSON.stringify(finalCounter)}`,
  );
  assert(
    !existsSync(invocationLog) || readFileSync(invocationLog, "utf8").trim() === "",
    "an optional external executable was invoked",
  );
  assert(firstState.runId === secondState.runId, "resume created a different run instead of resuming latest");

  console.log(
    [
      "smoke:standalone PASS",
      `entrypoint=${runnerBin}`,
      `runtime=bun ${bunVersion}`,
      `repo=${repo}`,
      `run=${firstState.runId}`,
      "first=FAIL(first done, second failed)",
      "resume=PASS(first not replayed, second done)",
      "optional-integrations=0 invocations",
    ].join("\n"),
  );
}

try {
  main();
} catch (error) {
  console.error(`smoke:standalone FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
