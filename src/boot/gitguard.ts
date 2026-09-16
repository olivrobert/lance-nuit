// runner/boot/gitguard.ts
//
// Clean-tree guard. It is outside BOOT[] because it depends on `resuming`, then
// on `def.name`, and therefore on `loadPipelineDefinition`: it is a run
// precondition, not a boot step. It belongs to the prelude but cannot be ordered
// with the other boot steps.

import { checkWorkingTreeAsync, shouldGuardCleanTree } from "../env/gitguard.js";
import { log } from "../runtime/logging.js";

export interface CleanTreeGuardArgs {
  resuming: boolean;
  allowDirty: boolean;
  /** Worktree mode starts from a fresh tree; only provisioning files can appear,
   * so checking for unrelated changes is unnecessary. */
  worktreeMode: boolean;
  /** Pipeline `allow_dirty`: commit / quality are inherently dirty. */
  pipelineAllowsDirty: boolean;
}

/** Reject a fresh top-level run on a dirty tree. */
export async function enforceCleanTree(args: CleanTreeGuardArgs): Promise<void> {
  if (
    !shouldGuardCleanTree({
      resuming: args.resuming,
      subRunner: false,
      allowDirty: args.allowDirty || args.worktreeMode,
      pipelineAllowsDirty: args.pipelineAllowsDirty,
    })
  )
    return;

  const tree = await checkWorkingTreeAsync(process.cwd());
  if (tree.ok) return;
  log.error(`Run refused: ${tree.reason}`);
  log(`  Commit or stash first, or rerun with --allow-dirty if this is intentional.`);
  process.exit(1);
}
