import { expect, test } from "bun:test";
import { RUNNER_STATE_ENV } from "../env/runner-env.js";
import {
  describeKill,
  KILLED_BY_POLICY_STATUS,
  killedByPolicy,
  killedByTimeout,
  runSupervisedCommand,
  spawnSupervisedProcess,
} from "./process-runner.js";

const STATE = {
  [RUNNER_STATE_ENV.lockHeld]: "1",
  [RUNNER_STATE_ENV.inWorktree]: "1",
  [RUNNER_STATE_ENV.liveFeed]: "/tmp/parent-feed.jsonl",
};

test("a spawned process never sees the runner state unless it asks to inherit it", async () => {
  const env = { ...process.env, ...STATE, KEPT: "yes" };
  const plain = await runSupervisedCommand("env", [], { env, timeoutMs: 5_000 });
  for (const name of Object.keys(STATE)) expect(plain.stdout).not.toContain(`${name}=`);
  expect(plain.stdout).toContain("KEPT=yes");

  const relaunch = spawnSupervisedProcess("env", [], {
    env,
    stdio: ["ignore", "pipe", "ignore"],
    timeoutMs: 5_000,
    inheritRunnerState: true,
  });
  let stdout = "";
  relaunch.child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  await relaunch.settle();
  for (const [name, value] of Object.entries(STATE)) expect(stdout).toContain(`${name}=${value}`);
});

test("a zero timeout means the default deadline, not an immediate kill", async () => {
  const result = await runSupervisedCommand("bash", ["-c", "sleep 0.2; echo done"], { timeoutMs: 0 });
  expect(result.status).toBe(0);
  expect(result.kill).toBeUndefined();
  expect(result.stdout).toBe("done\n");
});

test("a deadline kill is typed, reported with the policy status, and described from its type", async () => {
  const result = await runSupervisedCommand("bash", ["-c", "sleep 30"], { timeoutMs: 100 });
  expect(result.kill).toEqual({ cause: "timeout", afterMs: 100 });
  expect(result.status).toBe(KILLED_BY_POLICY_STATUS);
  expect(describeKill(result.kill!)).toBe("timeout (0s)");
}, 15_000);

test("an aborted signal kills with the signal cause", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const result = await runSupervisedCommand("bash", ["-c", "sleep 30"], { signal: controller.signal });
  expect(result.kill).toEqual({ cause: "signal" });
  expect(result.status).toBe(KILLED_BY_POLICY_STATUS);
}, 15_000);

test("both deadlines count as timeouts; cleanup is no policy kill", () => {
  expect(killedByTimeout({ cause: "timeout", afterMs: 1 })).toBe(true);
  expect(killedByTimeout({ cause: "no-first-event", afterMs: 1 })).toBe(true);
  expect(killedByTimeout({ cause: "budget", detail: "x" })).toBe(false);
  expect(killedByPolicy({ cause: "cleanup" })).toBe(false);
  expect(killedByPolicy({ cause: "signal" })).toBe(true);
  expect(killedByPolicy(undefined)).toBe(false);
});

test("each kill cause has its own text", () => {
  expect(describeKill({ cause: "no-first-event", afterMs: 90_000 })).toBe("no first event within 90000ms");
  expect(describeKill({ cause: "budget", detail: "$1.20 estimated > $1.00 remaining" })).toBe(
    "budget exceeded ($1.20 estimated > $1.00 remaining)",
  );
  expect(describeKill({ cause: "cost-unaccounted", detail: "m: no pricing entry" })).toContain("--allow-unmetered");
  expect(describeKill({ cause: "signal" })).toBe("aborted");
  expect(describeKill({ cause: "cleanup" })).toBe("child exited with descendants still alive");
});
