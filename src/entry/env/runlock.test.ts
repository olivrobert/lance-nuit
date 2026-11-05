import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunnerLock, releaseRunnerLock, runnerLockPath, shouldSkipRunnerLock } from "./runlock.ts";

const cwd = () => mkdtempSync(join(tmpdir(), "runlock-"));
const info = (pid: number) => ({ pid, ticket: "PROJ-28", pipeline: "default", startedAt: "T" });

test("runnerLockPath: <cwd>/.lance-nuit/run/runner.lock", () => {
  expect(runnerLockPath("/proj")).toBe("/proj/.lance-nuit/run/runner.lock");
});

test("acquires a free lock (creates .lance-nuit/run/ when needed)", () => {
  const dir = cwd();
  const r = acquireRunnerLock(dir, info(123), () => true);
  expect(r.ok).toBe(true);
  expect(existsSync(runnerLockPath(dir))).toBe(true);
  expect(JSON.parse(readFileSync(runnerLockPath(dir), "utf-8")).pid).toBe(123);
});

test("refuses when the holder is alive and exposes the holder", () => {
  const dir = cwd();
  acquireRunnerLock(dir, info(123), () => true);
  const r = acquireRunnerLock(dir, info(456), () => true);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.holder?.pid).toBe(123);
    expect(r.holder?.ticket).toBe("PROJ-28");
  }
});

test("resumes a stale lock (dead holder)", () => {
  const dir = cwd();
  acquireRunnerLock(dir, info(123), () => false);
  expect(acquireRunnerLock(dir, info(456), () => false).ok).toBe(true);
});

test("release frees the lock", () => {
  const dir = cwd();
  acquireRunnerLock(dir, info(123), () => true);
  releaseRunnerLock(dir, 123);
  expect(acquireRunnerLock(dir, info(456), () => true).ok).toBe(true);
});

// Registered on `process.on("exit")`: a lock path that turned unusable mid-run
// must not turn a successful run into a stack trace and a failing exit code.
test("releaseRunnerLock: an unusable lock path warns instead of throwing", () => {
  const dir = cwd();
  mkdirSync(runnerLockPath(dir), { recursive: true });

  expect(() => releaseRunnerLock(dir)).not.toThrow();
});

test("shouldSkipRunnerLock: a feed env does not disable the lock", () => {
  expect(shouldSkipRunnerLock({ RUNNER_LIVE_FEED: "/x/run/live.jsonl" })).toBe(false);
});

test("shouldSkipRunnerLock: lock already held by parent (RUNNER_LOCK_HELD) → skip", () => {
  expect(shouldSkipRunnerLock({ RUNNER_LOCK_HELD: "1" })).toBe(true);
});

test("shouldSkipRunnerLock: top-level launch → no skip", () => {
  expect(shouldSkipRunnerLock({})).toBe(false);
});
