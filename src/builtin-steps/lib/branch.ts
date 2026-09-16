// Abandon the work branch of an escalated work item.
//
// Without returning to base, a `--scan` would process the next ticket FROM the
// escalated ticket's branch. Work-item artifacts (ticket, triage, spec, assumptions,
// red-test) are untracked: they survive checkout and discard, so the human can review them.
//
// One implementation serves bugfix and feature. Read the branch with
// `git branch --show-current` instead of rebuilding it from `triage.json`: the real
// name wins, and unreadable triage no longer prevents abandonment.

import { runSupervisedCommand } from "../../exec/process-runner.js";
import type { PipelineContext } from "../../model/context.js";

async function currentBranchAsync(cwd: string): Promise<string> {
  const result = await runSupervisedCommand("git", ["branch", "--show-current"], { cwd, timeoutMs: 120_000 });
  return result.status === 0 ? result.stdout.trim() : "";
}

/**
 * Return to base, then delete the work branch.
 *
 * @param base pipeline base branch (`ctx.baseBranch ?? ctx.config.baseBranch`)
 */
export async function abandonWorkItemBranch(ctx: PipelineContext, base: string): Promise<string> {
  const git = (args: string[]) => runSupervisedCommand("git", args, { cwd: ctx.cwd, timeoutMs: 120_000 });
  // Read BEFORE checkout: afterward `git branch --show-current` would return base.
  const branch = await currentBranchAsync(ctx.cwd);
  // --detach fallback: in --worktree mode, base is checked out in the main clone;
  // detached HEAD on origin/<base> is enough (disposable worktree).
  const checkedOut = await git(["checkout", base]);
  if (checkedOut.status !== 0) {
    const detached = await git(["checkout", "--detach", `origin/${base}`]);
    if (detached.status !== 0) {
      throw new Error(detached.stderr.trim() || checkedOut.stderr.trim() || "cannot return to base");
    }
  }
  // Guard: never delete the branch just checked out (an unchanged base checkout
  // means create-branch was already skipped; deleting it would destroy base).
  if (branch && branch !== base) await git(["branch", "-D", branch]);
  await git(["checkout", "--", "."]);
  return branch ? `abandoned branch ${branch}` : "returned to base (no branch to delete)";
}
