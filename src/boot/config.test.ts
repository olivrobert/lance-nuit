import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRunnerArgs } from "../cli/parse.js";
import { composeRunnerRegistries } from "../entry/registries.js";
import { configStep } from "./config.js";

const boot = (worktreeMode: boolean) =>
  configStep.run({
    cwd: mkdtempSync(join(tmpdir(), "boot-config-")),
    args: parseRunnerArgs([]),
    worktreeMode,
    composeRegistries: composeRunnerRegistries,
  });

test("the run context says whether the run executes in its worktree", async () => {
  expect((await boot(true)).context?.worktree).toBe(true);
  expect((await boot(false)).context?.worktree).toBe(false);
});
