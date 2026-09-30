// runner/boot/worktree-ready.ts
//
// Project hook that finishes preparing a worktree once its services are up.
//
// Position in BOOT[]: after the stack preflight, the first point where the
// hook can rely on running services, and after the lock, so two runners never
// install into the same worktree at once. Like the preflight, it runs before
// `loadOrCreateRun`, outside any step budget.

import { runReadyHookAsync } from "../env/worktree.js";
import { errorMessage } from "../lib/errors.js";
import { log } from "../runtime/logging.js";
import type { BootState, BootStep } from "./boot-state.js";

export const worktreeReadyStep: BootStep = {
  id: "worktree-ready",
  desc: "Run the project's worktree-ready hook once the Docker stack is ready.",
  applies: (s: BootState) => !!s.enteredWorktree,
  async run(s: BootState): Promise<Partial<BootState>> {
    try {
      await runReadyHookAsync(s.enteredWorktree!);
    } catch (e) {
      log.error(errorMessage(e));
      process.exit(1);
    }
    return {};
  },
};
