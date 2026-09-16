// runner/env/gitguard.ts
// Git-state guard at the start of a FRESH top-level run: a dirty tree would carry
// unrelated changes into sub-US commits (the runner uses bypassPermissions and
// commits without rereading). Bypass: --allow-dirty, pipeline.allow_dirty (commit,
// quality — dirty by nature), run resume (the active implementation legitimately
// leaves the tree dirty), or child runner.
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { runSupervisedCommand } from "../exec/process-runner.js";

const MAX_LISTED_FILES = 10;

type WorkingTreeCheck = { ok: boolean; reason?: string };

/**
 * An untracked entry that Git itself could never commit (character device, FIFO,
 * socket) does not make the tree dirty for our purpose: it cannot leak into a
 * sub-US commit, and the "commit or stash" hint would be impossible to follow.
 * Sandboxes that bind-mount /dev/null over dotfiles produce exactly such entries.
 * Quoted paths and unreadable entries stay listed: a false positive is cheaper
 * than a missed real file.
 */
function isUncommittableUntracked(line: string, cwd: string): boolean {
  if (!line.startsWith("?? ") || line.startsWith('?? "')) return false;
  try {
    const stat = lstatSync(join(cwd, line.slice(3)));
    return !stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Apply the shared porcelain-status interpretation used by sync and async probes. */
function summarizeWorkingTree(stdout: string, cwd: string): WorkingTreeCheck {
  const lines = stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => !isUncommittableUntracked(line, cwd));
  if (lines.length === 0) return { ok: true };

  const listed = lines.slice(0, MAX_LISTED_FILES).join("\n");
  const more = lines.length > MAX_LISTED_FILES ? `\n… and ${lines.length - MAX_LISTED_FILES} more` : "";
  return { ok: false, reason: `dirty Git tree (${lines.length} file(s)):\n${listed}${more}` };
}

export interface GuardDecision {
  resuming: boolean;
  subRunner: boolean;
  allowDirty: boolean;
  pipelineAllowsDirty: boolean;
}

export function shouldGuardCleanTree(d: GuardDecision): boolean {
  return !d.resuming && !d.subRunner && !d.allowDirty && !d.pipelineAllowsDirty;
}

/** ok=true for a clean tree OR outside a Git repository (guard not applicable, e.g. tests). */
export function checkWorkingTree(cwd: string): WorkingTreeCheck {
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf-8" });
  if (inside.status !== 0) return { ok: true };

  const status = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf-8" });
  // Git present but status failed (corrupt repository?): do not block on a false
  // signal; the run will fail on subsequent git commands anyway.
  if (status.status !== 0) return { ok: true };

  return summarizeWorkingTree(status.stdout ?? "", cwd);
}

/** Production variant: Git probes do not block the runner loop. */
export async function checkWorkingTreeAsync(cwd: string): Promise<WorkingTreeCheck> {
  const inside = await runSupervisedCommand("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    timeoutMs: 30_000,
  });
  if (inside.status !== 0) return { ok: true };

  const status = await runSupervisedCommand("git", ["status", "--porcelain"], {
    cwd,
    timeoutMs: 30_000,
  });
  if (status.status !== 0) return { ok: true };

  return summarizeWorkingTree(status.stdout, cwd);
}
