// runner/commands/worktree-clean.ts
//
// Removing a ticket worktree is a human decision taken after the MR, never a side
// effect of a PASS. Like the other commands it takes neither the project lock nor
// the clean-tree guard: it acts on the worktree, whose own lock it holds instead.

import { gitToplevelAsync, isLinkedWorktreeAsync, removeWorktreeAsync, worktreeSpecFor } from "../env/worktree.js";
import type { RunnerArgs } from "../model/cli-options.js";
import { log } from "../runtime/logging.js";
import type { RunnerCommand } from "./runner-command.js";
import { errorMessage, isValidTicket } from "./shared.js";

/** The single option `--worktree-clean` reads. */
type WorktreeCleanArgs = Pick<RunnerArgs, "ticket">;

export const worktreeCleanCommand: RunnerCommand = {
  id: "worktree-clean",
  flag: "--worktree-clean",
  label: "lancenuit worktree clean",
  key: "worktreeClean",
  desc: "Run the optional teardown hook, then remove the ticket worktree and its scaffold branch.",
  async run(args: WorktreeCleanArgs): Promise<number> {
    if (!isValidTicket(args.ticket)) {
      log("lancenuit worktree clean requires a valid ticket.");
      return 1;
    }
    const mainRepo = await gitToplevelAsync(process.cwd());
    if (!mainRepo || (await isLinkedWorktreeAsync(process.cwd()))) {
      log("lancenuit worktree clean must run from the main clone.");
      return 1;
    }
    const spec = worktreeSpecFor(args.ticket, mainRepo);
    try {
      const { warnings } = await removeWorktreeAsync(spec);
      log(`✓ Removed worktree: ${spec.path}`);
      for (const w of warnings) log.warn(`  ${w}`);
      return 0;
    } catch (error) {
      log.error(`Worktree not removed: ${errorMessage(error)}`);
      return 1;
    }
  },
};
