// Reading order of one explorer directory: what a human reads first, what the
// runner keeps for itself last.
//
// Pure: it only reorders the nodes the read model listed, keeping their
// relative order inside each group, so the tree paths — and therefore the file
// view — are untouched.

import type { TreeNode } from "../../api/types.js";

export interface FileGroups {
  /** Markdown files, the documents written for a reader. */
  documents: TreeNode[];
  /** Every other file and directory, in the read model's order. */
  others: TreeNode[];
  /** `*.json`, `*.sha`, `.provenance/`, `runs/` and the detached `run/` root:
   *  the runner's bookkeeping, shown folded under "Machine files". */
  machine: TreeNode[];
}

/** Directories that only hold run telemetry. `run` is the reserved root the
 *  read model gives a run directory living outside the work item. */
const MACHINE_DIRECTORIES: readonly string[] = [".provenance", "runs"];
const DETACHED_RUN_PATH = "run";
const MACHINE_EXTENSIONS: readonly string[] = [".json", ".sha"];

function isMachine(node: TreeNode): boolean {
  if (node.kind === "directory") {
    return MACHINE_DIRECTORIES.includes(node.name) || node.path === DETACHED_RUN_PATH;
  }
  // The artifact a gate waits on is what the reader came for: never fold it.
  if (node.gate) return false;
  const name = node.name.toLowerCase();
  return MACHINE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function isDocument(node: TreeNode): boolean {
  return node.kind === "file" && node.name.toLowerCase().endsWith(".md");
}

export function groupFiles(nodes: readonly TreeNode[]): FileGroups {
  const groups: FileGroups = { documents: [], others: [], machine: [] };
  for (const node of nodes) {
    if (isMachine(node)) groups.machine.push(node);
    else if (isDocument(node)) groups.documents.push(node);
    else groups.others.push(node);
  }
  // Folding everything behind one more click hides nothing and costs a click.
  if (groups.documents.length === 0 && groups.others.length === 0) {
    return { documents: [], others: groups.machine, machine: [] };
  }
  return groups;
}

/** Store key of a directory's "Machine files" fold, beside the real directory
 *  paths in `openDirs`. A NUL byte never appears in a tree path. */
export function machineFoldKey(directoryPath: string): string {
  return `${directoryPath}\u0000machine`;
}

/** The fold counts as open when the reader expanded it, or when it holds the
 *  selected file — the same rule `isOpen` applies to a directory. */
export function isMachineFoldOpen(
  directoryPath: string,
  machine: readonly TreeNode[],
  openDirs: readonly string[],
  filePath: string | null,
): boolean {
  if (openDirs.includes(machineFoldKey(directoryPath))) return true;
  if (typeof filePath !== "string") return false;
  return machine.some((node) => (node.kind === "file" ? node.path === filePath : filePath.startsWith(`${node.path}/`)));
}
