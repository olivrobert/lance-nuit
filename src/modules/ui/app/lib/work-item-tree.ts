// Reads of a work item's folder tree: file counts, the assumptions file, image
// types, and the screenshots a run left under `reports/`.

import type { Assumptions, TreeFile, TreeNode, WorkItemTree } from "../api/types.js";

export function countFiles(node: TreeNode): number {
  return node.kind === "file" ? 1 : node.children.reduce((total, child) => total + countFiles(child), 0);
}

/** The first `assumptions.json` anywhere in the tree. Depth-first, and the first
 *  hit wins: a run writes one, and a second would be a copy. */
export function findAssumptions(nodes: readonly TreeNode[]): TreeFile | undefined {
  for (const node of nodes) {
    if (node.kind === "file" && node.name === "assumptions.json") return node;
    if (node.kind === "directory") {
      const found = findAssumptions(node.children);
      if (found) return found;
    }
  }
  return undefined;
}

/** True when `assumptions.json` holds anything worth a section. */
export function hasAssumptionContent(data: Assumptions | null): boolean {
  if (!data) return false;
  return [data.blocking, data.requiredInputs, data.resolved].some(
    (entries) => Array.isArray(entries) && entries.length > 0,
  );
}

/** MIME type of an image the explorer shows inline. The read model already
 *  refused anything that is not an image, so PNG is a safe default. */
export function mimeOf(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

/** The images of one directory of `reports/`, with the summary a browser step
 *  left beside them, when it left one. */
export interface ScreenshotGroup {
  dir: string;
  images: TreeFile[];
  summary?: TreeFile;
}

/** Names a browser step gives the table that explains its screenshots. A
 *  convention of the pipelines, not a contract: a directory without one simply
 *  shows its images. */
const SUMMARY_NAMES: readonly string[] = ["summary.md", "report.md"];

function collectScreenshots(node: TreeNode, groups: ScreenshotGroup[]): void {
  if (node.kind === "file") return;
  const images = node.children.filter(
    (child): child is TreeFile => child.kind === "file" && child.contentKind === "png",
  );
  if (images.length > 0) {
    const summary = node.children.find(
      (child): child is TreeFile => child.kind === "file" && SUMMARY_NAMES.includes(child.name.toLowerCase()),
    );
    groups.push({ dir: node.path, images, ...(summary ? { summary } : {}) });
  }
  for (const child of node.children) collectScreenshots(child, groups);
}

/**
 * Screenshots of a run, grouped by the directory that holds them, in tree order.
 *
 * Only `reports/` is searched: it is where the pipelines put what a step
 * produced as evidence, whereas an image under `artifacts/` is an input — a
 * mock-up attached to the ticket — and would pass for a result of the run.
 */
export function screenshotGroups(tree: WorkItemTree | null): ScreenshotGroup[] {
  const reports = tree?.children.find((node) => node.kind === "directory" && node.name === "reports");
  const groups: ScreenshotGroup[] = [];
  if (reports) collectScreenshots(reports, groups);
  return groups;
}
