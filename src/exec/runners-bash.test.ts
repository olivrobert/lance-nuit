import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSupervisedStream } from "./process-runner.js";
import { stripStderrMarker } from "./bash-runner.js";
import { runBashAsync, runBashStreaming } from "./runners.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait for a condition instead of sleeping past it: a fixed delay either slows
 *  every run down or turns a real regression into a flake. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
}

/** A dead PID, proved by the errno rather than by a boolean: `process.kill(pid, 0)`
 *  also throws EPERM for a process that is very much alive under another user. */
function expectDead(pid: number): void {
  expect(Number.isInteger(pid)).toBe(true);
  try {
    process.kill(pid, 0);
    throw new Error(`pid ${pid} is still alive`);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
  }
}

test("runBashAsync cleans descendants after normal child exit: validates the contract", async () => {
  const pidFile = join(tmpdir(), `orphan-async-${process.pid}-${process.hrtime.bigint()}.pid`);
  const r = await runBashAsync(`sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; exit 0`, { timeoutMs: 5_000 });

  // The descendant is killed during cleanup, but a bash exit code of 0 remains a
  // business success.
  expect(r.ok).toBe(true);
  const descendant = Number(readFileSync(pidFile, "utf-8").trim());
  expect(Number.isInteger(descendant)).toBe(true);
  expect(isAlive(descendant)).toBe(false);
  rmSync(pidFile, { force: true });
}, 15_000);

test("timeout wall-clock: validates the contract", async () => {
  const r = await runBashStreaming("echo start; sleep 30; echo end", { timeoutMs: 200 });
  expect(r.ok).toBe(false);
  expect(r.timedOut).toBe(true);
  expect(r.output).toContain("start");
  expect(r.output).toContain("[runner] step killed: timeout");
}, 15_000);

test("command rapide: validates the contract", async () => {
  const r = await runBashStreaming("echo done", { timeoutMs: 5000 });
  expect(r.ok).toBe(true);
  expect(r.timedOut).toBe(false);
  expect(r.output).toContain("done");
});

test("live-feed filesystem failures do not fail Bash steps: validates the contract", async () => {
  const previousLiveFeed = process.env.RUNNER_LIVE_FEED;
  const previousEventsFile = process.env.RUNNER_EVENTS_FILE;
  process.env.RUNNER_LIVE_FEED = join(
    tmpdir(),
    `missing-live-feed-${process.pid}-${process.hrtime.bigint()}`,
    "feed.jsonl",
  );
  delete process.env.RUNNER_EVENTS_FILE;

  try {
    const r = await runBashStreaming("printf ok", { timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("ok");
  } finally {
    if (previousLiveFeed === undefined) delete process.env.RUNNER_LIVE_FEED;
    else process.env.RUNNER_LIVE_FEED = previousLiveFeed;
    if (previousEventsFile === undefined) delete process.env.RUNNER_EVENTS_FILE;
    else process.env.RUNNER_EVENTS_FILE = previousEventsFile;
  }
});

test("timeout: validates the contract", async () => {
  // The nested `bash -c` is a child of the runner; without detached group cleanup,
  // Only direct bash receives SIGTERM: the grandchild survives, keeps stdout/stderr
  // pipes open, and holds test ports / databases for the next step.
  const pidFile = join(tmpdir(), `killtree-${process.pid}-${process.hrtime.bigint()}.pid`);
  const r = await runBashStreaming(`bash -c 'echo $$ > ${pidFile}; sleep 30' & wait $!`, { timeoutMs: 500 });

  expect(r.timedOut).toBe(true);
  const grandchild = Number(readFileSync(pidFile, "utf-8").trim());
  expect(Number.isInteger(grandchild)).toBe(true);

  // Let the group SIGTERM be delivered and the process reaped.
  await new Promise((res) => setTimeout(res, 500));
  expect(isAlive(grandchild)).toBe(false);

  rmSync(pidFile, { force: true });
}, 15_000);

test("normal child output is preserved: validates the contract", async () => {
  const pidFile = join(tmpdir(), `orphan-after-exit-${process.pid}-${process.hrtime.bigint()}.pid`);
  const r = await runBashStreaming(`trap '' TERM; sleep 30 & echo $! > '${pidFile}'; exit 0`, { timeoutMs: 5_000 });

  expect(r.ok).toBe(true);
  const descendant = Number(readFileSync(pidFile, "utf-8").trim());
  expect(Number.isInteger(descendant)).toBe(true);
  await new Promise((res) => setTimeout(res, 500));
  expect(isAlive(descendant)).toBe(false);
  rmSync(pidFile, { force: true });
}, 15_000);

test("failures without timeout remain failures: validates the contract", async () => {
  const r = await runBashStreaming("exit 3", { timeoutMs: 5000 });
  expect(r.ok).toBe(false);
  expect(r.timedOut).toBe(false);
});

// U+00E9 (e acute) is C3 A9. Emit the two bytes in separate writes so they land
// in separate chunks: a per-chunk toString() would yield two U+FFFD instead of
// the single character. The expected value is spelled as an escape so this file
// stays free of non-ASCII text.
const E_ACUTE = "\u00e9";
const SPLIT_UTF8 = "printf '\\xc3'; sleep 0.15; printf '\\xa9\\n'";

test("runBashStreaming reassembles a UTF-8 sequence split across chunks", async () => {
  const r = await runBashStreaming(SPLIT_UTF8, { timeoutMs: 5000 });
  expect(r.ok).toBe(true);
  expect(r.output).toContain(E_ACUTE);
  expect(r.output).not.toContain("\uFFFD");
}, 15_000);

test("runSupervisedStream reassembles a UTF-8 sequence split across chunks", async () => {
  const chunks: string[] = [];
  const r = await runSupervisedStream(
    "bash",
    ["-c", SPLIT_UTF8],
    { stdio: ["ignore", "pipe", "pipe"], timeoutMs: 5000 },
    () => ({
      onStdout: (text) => chunks.push(text),
    }),
  );
  expect(r.code).toBe(0);
  expect(r.output).toBe(`${E_ACUTE}\n`);
  expect(chunks.join("")).toBe(`${E_ACUTE}\n`);
  expect(r.output).not.toContain("\uFFFD");
}, 15_000);

test("runSupervisedStream cleans descendants and rejects when onFinalize throws", async () => {
  const pidFile = join(tmpdir(), `orphan-finalize-${process.pid}-${process.hrtime.bigint()}.pid`);
  const run = runSupervisedStream(
    "bash",
    ["-c", `sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; exit 0`],
    { stdio: ["ignore", "pipe", "pipe"], detached: true, timeoutMs: 5_000 },
    () => ({
      onFinalize: () => {
        throw new Error("finalize boom");
      },
    }),
  );
  await expect(run).rejects.toThrow("finalize boom");
  const orphan = Number(readFileSync(pidFile, "utf-8").trim());
  rmSync(pidFile, { force: true });
  expect(isAlive(orphan)).toBe(false);
}, 15_000);

test("runSupervisedStream: a timeout kills the spawned CLI and its grandchild", async () => {
  // `runSupervisedStream` is the spawn path of the three agent backends. The
  // supervisor knows the direct child only, so a kill that is not group-wide
  // leaves the grandchild holding the working tree, the test ports, and — for a
  // real agent — the budget, while the runner reports the step as over.
  const stamp = `${process.pid}-${process.hrtime.bigint()}`;
  const parentPidFile = join(tmpdir(), `agent-timeout-parent-${stamp}.pid`);
  const childPidFile = join(tmpdir(), `agent-timeout-child-${stamp}.pid`);
  const script = [
    `echo $$ > '${parentPidFile}'`,
    "sleep 30 >/dev/null 2>&1 &",
    `echo $! > '${childPidFile}'`,
    "wait",
  ].join("\n");

  const result = await runSupervisedStream(
    "bash",
    ["-c", script],
    { stdio: ["ignore", "pipe", "pipe"], detached: true, timeoutMs: 300 },
    () => ({}),
  );

  expect(result.killed).toBe(true);
  expect(result.killReason).toStartWith("timeout");
  const cliPid = Number(readFileSync(parentPidFile, "utf-8").trim());
  const grandchildPid = Number(readFileSync(childPidFile, "utf-8").trim());
  await waitFor(() => !isAlive(cliPid) && !isAlive(grandchildPid));
  expectDead(cliPid);
  expectDead(grandchildPid);
  rmSync(parentPidFile, { force: true });
  rmSync(childPidFile, { force: true });
}, 20_000);

test("a non-zero exit carries the tail of stderr in its failure reason", async () => {
  const r = await runBashStreaming("echo out; echo 'fatal: not a git repository' >&2; exit 128", { timeoutMs: 5000 });
  expect(r.ok).toBe(false);
  expect(r.failReason).toBe("exit code 128\nfatal: not a git repository");
  // stdout is not a cause: a failure that says nothing on stderr keeps the bare code.
  const quiet = await runBashStreaming("echo out; exit 2", { timeoutMs: 5000 });
  expect(quiet.failReason).toBe("exit code 2");
});

test("runBashAsync: the failure reason names the stderr cause behind the exit code", async () => {
  const r = await runBashAsync("echo 'fatal: A branch named x already exists.' >&2; exit 128", { timeoutMs: 5000 });
  expect(r.ok).toBe(false);
  expect(r.failReason).toBe("exit code 128\nfatal: A branch named x already exists.");
  expect(stripStderrMarker(r.output)).toBe("fatal: A branch named x already exists.\n");
});
