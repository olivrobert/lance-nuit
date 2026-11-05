// runner/step/tree-snapshot.ts
//
// What a git tree holds beyond its last commit, to tell afterwards what changed in
// between. Status lines alone cannot say: a pipeline often reaches this point with
// uncommitted work, and editing a file that is already modified leaves its line as
// it was. So each dirty path also carries a hash of its content.

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { runSupervisedCommand } from "../../shared/process/process-runner.js";

const GIT_TIMEOUT_MS = 30_000;

export interface TreeSnapshot {
  root: string;
  /** Repository-relative path -> status and content of that path. */
  entries: ReadonlyMap<string, string>;
}

async function contentHash(path: string): Promise<string> {
  try {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch {
    // Deleted, or a directory for a submodule: the status line already tells it apart.
    return "unreadable";
  }
}

/** The tree as it stands, or `undefined` where git cannot say: outside a repository
 *  there is no tree to protect. */
export async function snapshotTree(cwd: string): Promise<TreeSnapshot | undefined> {
  const top = await runSupervisedCommand("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  if (top.status !== 0) return undefined;
  const root = top.stdout.trim();
  // Porcelain paths are relative to the root whatever the cwd, and cover the whole
  // tree. `-z` leaves them unquoted, `--no-renames` leaves one path per entry, and
  // listing each untracked file sees a new file in a directory already untracked.
  const status = await runSupervisedCommand(
    "git",
    ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"],
    { cwd, timeoutMs: GIT_TIMEOUT_MS },
  );
  if (status.status !== 0) return undefined;
  const entries = new Map<string, string>();
  for (const entry of status.stdout.split("\0").filter(Boolean)) {
    const path = entry.slice(3);
    entries.set(path, `${entry.slice(0, 2)} ${await contentHash(join(root, path))}`);
  }
  return { root, entries };
}

function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Paths whose state differs between two snapshots, sorted, leaving out what lies in
 *  `allowed` (files or directories, absolute). */
export function treeChanges(before: TreeSnapshot, after: TreeSnapshot, allowed: readonly string[]): string[] {
  const allowedPaths = allowed.map(resolved);
  const isAllowed = (path: string): boolean => {
    const absolute = join(after.root, path);
    return allowedPaths.some((candidate) => absolute === candidate || absolute.startsWith(candidate + sep));
  };
  return [...new Set([...before.entries.keys(), ...after.entries.keys()])]
    .filter((path) => before.entries.get(path) !== after.entries.get(path) && !isAllowed(path))
    .sort();
}
