import { expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSupervisedCommand, spawnSupervisedProcess } from "./process-runner.ts";
import { isProcessAlive, ProcessScope, whenProcessSettled } from "./process-supervision.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(20);
}

test("process-supervision: validates the integration contract", async () => {
  const pidFile = join(tmpdir(), `runner-supervision-${process.pid}-${process.hrtime.bigint()}.pid`);
  const child = spawn("bash", ["-c", `trap '' TERM; sleep 30 & echo $! > '${pidFile}'; exit 0`], {
    detached: true,
    stdio: "ignore",
  });
  const scope = new ProcessScope();
  scope.track(child, { group: true });
  const childExit = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  await waitFor(() => existsSync(pidFile));
  await childExit;
  const descendant = Number(readFileSync(pidFile, "utf8").trim());
  expect(isProcessAlive(descendant)).toBe(true);
  expect(isProcessAlive(child.pid!, true)).toBe(true);

  await scope.shutdown({ graceMs: 80, forceWaitMs: 800 });
  await waitFor(() => !isProcessAlive(descendant));
  expect(isProcessAlive(descendant)).toBe(false);
  expect(isProcessAlive(child.pid!, true)).toBe(false);
  rmSync(pidFile, { force: true });
}, 5_000);

test("process-supervision: validates the integration contract", async () => {
  const child = spawn("bash", ["-c", "trap '' TERM; sleep 30"], {
    detached: true,
    stdio: "ignore",
  });
  const scope = new ProcessScope();
  scope.track(child, { group: true });
  const started = Date.now();
  const shutdown = scope.shutdown({ graceMs: 2_000, forceWaitMs: 800 });
  await delay(60);
  scope.forceKillAll();
  await shutdown;

  expect(Date.now() - started).toBeLessThan(1_500);
  expect(isProcessAlive(child.pid!, true)).toBe(false);
}, 5_000);

test("process-supervision: validates the integration contract", async () => {
  const child = spawn("true", [], { detached: true, stdio: "ignore" });
  const scope = new ProcessScope();
  scope.track(child, { group: true });
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  await expect(scope.shutdown({ graceMs: 50, forceWaitMs: 50 })).resolves.toBeUndefined();
});

test("process-supervision: validates the integration contract", async () => {
  const supervised = spawnSupervisedProcess("true", [], { stdio: "ignore", timeoutMs: null });
  await new Promise<void>((resolve) => supervised.child.once("close", () => resolve()));
  expect(supervised.killed).toBe(false);
  supervised.clear();
});

test("process-supervision: validates the integration contract", async () => {
  const pidFile = join(tmpdir(), `runner-command-${process.pid}-${process.hrtime.bigint()}.pid`);
  const result = await runSupervisedCommand(
    "bash",
    ["-c", `sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; exit 0`],
    { timeoutMs: 5_000 },
  );

  expect(result.status).toBe(0);
  expect(result.killedForCleanup).toBe(true);
  const descendant = Number(readFileSync(pidFile, "utf8").trim());
  await waitFor(() => !isProcessAlive(descendant));
  expect(isProcessAlive(descendant)).toBe(false);
  rmSync(pidFile, { force: true });
}, 15_000);

test("whenProcessSettled exposes async finalizer failures", async () => {
  const child = new EventEmitter();
  const failure = new Error("finalizer failed");
  const settled = whenProcessSettled(
    child as unknown as ChildProcess,
    async () => {
      throw failure;
    },
    { drainMs: 1 },
  );

  child.emit("exit", 0);

  await expect(settled).rejects.toBe(failure);
});

test("whenProcessSettled keeps an async error observer from blocking completion", async () => {
  const child = new EventEmitter();
  const settled = whenProcessSettled(child as unknown as ChildProcess, () => {}, {
    onError: async () => {
      throw new Error("observer failed");
    },
  });

  child.emit("error", new Error("spawn failed"));

  await expect(settled).resolves.toBeUndefined();
});
