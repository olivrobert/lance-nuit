import { expect, test } from "bun:test";
import { nodeProcessRunner } from "./runner.ts";

test("missing binaries return exit code 127 and include the command name", async () => {
  const result = await nodeProcessRunner("runner-binary-that-does-not-exist", []);
  expect(result.code).toBe(127);
  expect(result.stderr).toContain("runner-binary-that-does-not-exist");
});

test("timed-out commands return exit code 124 and set timedOut", async () => {
  const result = await nodeProcessRunner("bash", ["-c", "sleep 30"], { timeoutMs: 60 });
  expect(result.code).toBe(124);
  expect(result.timedOut).toBe(true);
});

test("aborted commands terminate the process group without lingering", async () => {
  const controller = new AbortController();
  const running = nodeProcessRunner("bash", ["-c", "sleep 30"], { signal: controller.signal });
  setTimeout(() => controller.abort(), 60);

  const result = await running;
  expect(result.code).not.toBe(0);
});
