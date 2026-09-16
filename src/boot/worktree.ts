// runner/boot/worktree.ts
//
// Worktree boot step: setup and chdir before pipeline resolution, locking, and
// guards. The rest of the runner follows cwd, so the lock must be acquired after
// this step.
//
// RUNNER_IN_WORKTREE lets child runners inherit cwd without repeating setup.
// process.argv[1] remains the runner source.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadPipelineConfig } from "../env/config.js";
import { resolveTicketDir } from "../env/tickets.js";
import { gitToplevelAsync, isLinkedWorktreeAsync, setupWorktreeAsync, worktreeSpecFor } from "../env/worktree.js";
import { errorMessage } from "../lib/errors.js";
import { log } from "../runtime/logging.js";
import type { BootState, BootStep } from "./boot-state.js";

export interface WorktreeBootstrapArgs {
  worktree: boolean;
  scan: boolean;
  ticket?: string;
  baseBranch?: string;
  pipelinePath?: string;
}

/** Set up the worktree if needed and chdir into it. Returns the effective mode
 * and a pipeline path resolved before chdir when necessary. */
export async function bootstrapWorktree(
  args: WorktreeBootstrapArgs,
): Promise<{ worktreeMode: boolean; pipelinePath?: string }> {
  const { worktree, scan, ticket, baseBranch } = args;
  let pipelinePath = args.pipelinePath;

  const worktreeMode = worktree || process.env.RUNNER_IN_WORKTREE === "1";
  if (worktree && process.env.RUNNER_IN_WORKTREE !== "1") {
    if (scan) {
      log("--worktree is not supported with --scan (scan tickets are isolated in separate worktrees).");
      process.exit(1);
    }
    if (!ticket) {
      log("--worktree requires a ticket.");
      process.exit(1);
    }
    const mainRepo = await gitToplevelAsync(process.cwd());
    if (!mainRepo) {
      log("--worktree requires a Git repository.");
      process.exit(1);
    }
    if (await isLinkedWorktreeAsync(process.cwd())) {
      log("--worktree from a worktree is not allowed. Re-run from the main clone.");
      process.exit(1);
    }
    const spec = worktreeSpecFor(ticket, mainRepo);
    const mainCfg = loadPipelineConfig(process.cwd());
    const wtBase = baseBranch ?? mainCfg.baseBranch;
    // Resolve a relative --pipeline path before chdir.
    if (pipelinePath && existsSync(pipelinePath)) pipelinePath = resolve(pipelinePath);
    try {
      const setup = await setupWorktreeAsync(spec, {
        baseBranch: wtBase,
        ticketDir: resolveTicketDir(ticket, mainCfg.specPath, mainRepo),
        specPath: mainCfg.specPath,
        mode: mainCfg.worktreeMode,
      });
      log(
        setup.reused
          ? `↻ Reusing worktree: ${spec.path}`
          : `✓ Created worktree: ${spec.path} (branch ${spec.branch}, base ${wtBase}, mode ${mainCfg.worktreeMode})`,
      );
      for (const w of setup.warnings) log.warn(`  ${w}`);
    } catch (e) {
      log.error(`Worktree setup failed: ${errorMessage(e)}`);
      process.exit(1);
    }
    process.chdir(spec.path);
    process.env.RUNNER_IN_WORKTREE = "1";
    log(`  Running in worktree — main clone is free. Clean up after the MR: skill worktree-delete ${spec.dir}`);
  }

  return { worktreeMode, pipelinePath };
}

export const worktreeStep: BootStep = {
  id: "worktree",
  desc: "Prepare the ticket worktree and change into it before anything that depends on cwd.",
  // Always applicable: RUNNER_IN_WORKTREE also sets worktreeMode when a child
  // inherits an already prepared cwd.
  applies: () => true,
  async run(s: BootState): Promise<Partial<BootState>> {
    const { worktreeMode, pipelinePath } = await bootstrapWorktree({
      worktree: s.args.worktree,
      scan: s.args.scan,
      ticket: s.args.ticket,
      baseBranch: s.args.baseBranch,
      pipelinePath: s.pipelinePath,
    });
    return { worktreeMode, pipelinePath, cwd: process.cwd() };
  },
};
