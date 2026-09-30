import { expect, test } from "bun:test";
import type { RunnerArgs } from "../model/cli-options.ts";
import { createDefaultRunnerRegistries } from "../entry/registries.js";
import type { BootState } from "./boot-state.ts";
import { BOOT } from "./step.ts";
import { worktreeReadyStep } from "./worktree-ready.ts";

function state(extra: Partial<BootState>): BootState {
  return {
    args: {} as RunnerArgs,
    cwd: "/wt",
    worktreeMode: true,
    baseRegistries: createDefaultRunnerRegistries(),
    ...extra,
  };
}

test("applies: only in the process that entered the worktree", () => {
  expect(worktreeReadyStep.applies(state({}))).toBe(false);
  const spec = { path: "/wt", dir: "proj-1", branch: "wt/proj-1", mainRepo: "/repo" };
  expect(worktreeReadyStep.applies(state({ enteredWorktree: spec }))).toBe(true);
});

test("BOOT: the ready hook runs right after the stack preflight", () => {
  const ids = BOOT.map((step) => step.id);
  expect(ids.indexOf("worktree-ready")).toBe(ids.indexOf("stack") + 1);
});
