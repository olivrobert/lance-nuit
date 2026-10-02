import { expect, test } from "bun:test";
import type { WorktreeSpec } from "../env/worktree.ts";
import { runSupervisedCommand } from "../exec/process-runner.ts";
import type { ProcessScope } from "../exec/process-supervision.ts";
import { createStackStop, NO_STACK_STOP, type StackStopDeps, stopsStack } from "./stack-stop.ts";

const SPEC = { path: "/tmp/wt", mainRepo: "/tmp/repo" } as WorktreeSpec;

/** Fakes that record the order in which the stop calls them. */
function recording(runHook: StackStopDeps["runHook"] = async () => {}) {
  const calls: string[] = [];
  const deps: StackStopDeps = {
    shutdown: async () => {
      calls.push("shutdown");
    },
    runHook: async (spec, scope) => {
      calls.push("hook");
      await runHook(spec, scope);
    },
  };
  return { calls, deps };
}

/** Capture what the stop wrote to stderr. */
async function stderrOf(action: () => Promise<void>): Promise<string> {
  const previous = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await action();
  } finally {
    process.stderr.write = previous;
  }
  return out;
}

test("no entered worktree: neither shutdown nor hook runs", async () => {
  const { calls, deps } = recording();
  const stop = createStackStop(undefined, deps);

  await stop.run();

  expect(stop).toBe(NO_STACK_STOP);
  expect(calls).toEqual([]);
});

test("the hook runs after children are shut down", async () => {
  const { calls, deps } = recording();

  await createStackStop(SPEC, deps).run();

  expect(calls).toEqual(["shutdown", "hook"]);
});

test("concurrent run() calls run the hook once", async () => {
  const { calls, deps } = recording();
  const stop = createStackStop(SPEC, deps);

  await Promise.all([stop.run(), stop.run()]);
  await stop.run();

  expect(calls).toEqual(["shutdown", "hook"]);
});

test("inProgress is true only while the hook runs", async () => {
  let release = () => {};
  const { deps } = recording(() => new Promise<void>((resolve) => (release = resolve)));
  const stop = createStackStop(SPEC, deps);
  expect(stop.inProgress()).toBe(false);

  const pending = stop.run();
  expect(stop.inProgress()).toBe(true);
  await Bun.sleep(0);
  release();
  await pending;

  expect(stop.inProgress()).toBe(false);
});

test("skip force-kills the hook and run() resolves", async () => {
  let killed = false;
  const { deps } = recording(async (_spec: WorktreeSpec, scope: ProcessScope) => {
    const r = await runSupervisedCommand("sleep", ["30"], { scope });
    killed = r.status !== 0;
  });
  const stop = createStackStop(SPEC, deps);

  const pending = stop.run();
  await Bun.sleep(50);
  stop.skip();
  await pending;

  expect(killed).toBe(true);
  expect(stop.inProgress()).toBe(false);
});

test("a failing hook resolves and warns", async () => {
  const { deps } = recording(async () => {
    throw new Error("project hook worktree-stop failed (stop.sh)");
  });

  const out = await stderrOf(() => createStackStop(SPEC, deps).run());

  expect(out).toContain("worktree-stop failed (stop.sh)");
  expect(out).toContain("outcome is unchanged");
});

test("stopsStack: PASS keeps the stack, FAIL/STOPPED/ABORTED/UNKNOWN stop it", () => {
  expect(stopsStack("PASS")).toBe(false);
  for (const status of ["FAIL", "STOPPED", "ABORTED", "UNKNOWN"] as const) expect(stopsStack(status)).toBe(true);
});
