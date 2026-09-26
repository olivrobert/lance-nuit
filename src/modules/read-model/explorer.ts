// modules/read-model/explorer.ts
//
// The folder explorer: the tree of a work item as it stands on disk, and a
// bounded, read-only view of one file inside it.
//
// The tree is the answer to "why did this stop" that no summary can give: the
// artifact the gate is waiting on, the report a step wrote, the journal of the
// run. It is built from the EFFECTIVE work-item directory — the worktree copy
// for a worktree run — because that is the tree the run itself reads.
//
// Reading is deliberately narrow. A path arrives from a browser, so it is
// resolved under the work-item directory or the run directory and then compared
// again after `realpath`: `..` never leaves the root lexically, and a symbolic
// link pointing out of it never leaves the root physically. Size is capped so a
// stray multi-gigabyte log cannot be turned into a response; past the cap the
// reader gets the absolute path and opens the file on the disk instead.

import { type Dirent, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isValidSubjectToken, readDecisionAt } from "../../state/decisions.js";
import { isPathWithin } from "../../state/stores/path-safety.js";
import type { ReadModelOptions } from "./projects.js";
import { resolveRun } from "./runs.js";
import type { FileContentKind, FileRead, ImageRead, TreeDirectory, TreeFile, TreeNode, WorkItemTree } from "./types.js";

/** Text, including an unknown extension: a work-item directory holds documents,
 *  reports, and journals, so serving an unknown file as text is right far more
 *  often than refusing it. */
export const TEXT_LIMIT_BYTES = 1024 * 1024;

/** Images are the one binary the dashboard renders inline (a screenshot left by
 *  a browser step), so they get their own, larger cap. */
export const IMAGE_LIMIT_BYTES = 2 * 1024 * 1024;

/** Cap of an image served as raw bytes. Far above any screenshot, and still a
 *  bound: the response is built in memory. */
export const RAW_IMAGE_LIMIT_BYTES = 20 * 1024 * 1024;

/** Reading order of the work-item directory: the business outputs first, the run
 *  telemetry last. Anything else — a nested work item, `ticket.md` — follows. */
const SECTION_ORDER: readonly string[] = ["artifacts", "reports", "decisions", "runs"];

/** Depth of `runs/<pipeline>/<run>/steps/<step>/attempt-001/output.log` plus room
 *  for a nested work item; a link-free tree cannot go deeper by accident. */
const MAX_DEPTH = 10;

/** A work-item directory holds a few hundred files. The cap exists so a tree that
 *  grew unexpectedly degrades into a truncated listing instead of a hung reader. */
const MAX_ENTRIES = 5000;

const CONTENT_KIND_BY_EXTENSION: Record<string, FileContentKind> = {
  ".md": "md",
  ".markdown": "md",
  ".json": "json",
  ".log": "log",
  // Line-delimited JSON is not a JSON document; it reads like a journal.
  ".jsonl": "log",
  ".txt": "txt",
  ".png": "png",
  ".jpg": "png",
  ".jpeg": "png",
  ".gif": "png",
  ".webp": "png",
};

/** Extensions tried when a gate has no decision file yet to name its artifact. */
const GATE_EXTENSIONS: readonly string[] = [".md", ".json", ".txt"];

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** Content kind from the extension alone. The bytes are never sniffed: a work
 *  item's files are written by our own pipelines, and a guess from content would
 *  only add a way for a file to be rendered as something it is not. */
export function contentKindOf(name: string): FileContentKind {
  return CONTENT_KIND_BY_EXTENSION[extensionOf(basename(name))] ?? "other";
}

function isImage(kind: FileContentKind): boolean {
  return kind === "png";
}

function limitFor(kind: FileContentKind): number {
  return isImage(kind) ? IMAGE_LIMIT_BYTES : TEXT_LIMIT_BYTES;
}

/**
 * Reserved first segment for a run directory that does not live inside the
 * effective work-item directory.
 *
 * A worktree run reads its artifacts from the worktree copy while its snapshot
 * stays where the run was enumerated, so the two roots can be different trees.
 * The work-item layout has no top-level `run/`, so the prefix names the second
 * root without ever shadowing a real file — and it is used only when the run
 * directory is genuinely outside.
 */
const RUN_PREFIX = "run";

/** Tree paths are POSIX-style whatever the platform: they travel to a browser
 *  and come back as a query parameter. */
function treePath(root: string, absolute: string, prefix = ""): string {
  const path = relative(root, absolute).split(sep).join("/");
  return prefix ? `${prefix}/${path}` : path;
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    // A file removed between the listing and the stat has no size to report.
    return 0;
  }
}

function sectionRank(name: string): number {
  const rank = SECTION_ORDER.indexOf(name);
  return rank < 0 ? SECTION_ORDER.length : rank;
}

interface Budget {
  left: number;
}

/**
 * Children of one directory.
 *
 * Symbolic links are skipped whole: the only one the runner writes is
 * `runs/<pipeline>/latest`, whose target is already listed under its run id, and
 * following links is exactly how a tree walk leaves the directory it is meant to
 * describe. Dot entries are skipped too — `artifacts/.provenance/` is the
 * runner's own bookkeeping, not something a human reviews.
 */
function walk(root: string, dir: string, depth: number, budget: Budget, prefix = ""): TreeNode[] {
  if (depth > MAX_DEPTH || budget.left <= 0) return [];

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // An unreadable directory contributes nothing; the rest of the tree stands.
    return [];
  }

  const ordered = entries
    .filter((entry) => !entry.name.startsWith(".") && !entry.isSymbolicLink())
    .sort((a, b) => {
      if (depth === 0) {
        const rank = sectionRank(a.name) - sectionRank(b.name);
        if (rank !== 0) return rank;
      }
      const kind = Number(b.isDirectory()) - Number(a.isDirectory());
      return kind !== 0 ? kind : a.name.localeCompare(b.name);
    });

  const nodes: TreeNode[] = [];
  for (const entry of ordered) {
    if (budget.left <= 0) break;
    if (!entry.isDirectory() && !entry.isFile()) continue;
    budget.left -= 1;

    const absolute = join(dir, entry.name);
    const path = treePath(root, absolute, prefix);
    if (entry.isDirectory()) {
      const directory: TreeDirectory = {
        kind: "directory",
        name: entry.name,
        path,
        children: walk(root, absolute, depth + 1, budget, prefix),
      };
      nodes.push(directory);
    } else {
      const file: TreeFile = {
        kind: "file",
        name: entry.name,
        path,
        size: sizeOf(absolute),
        contentKind: contentKindOf(entry.name),
      };
      nodes.push(file);
    }
  }
  return nodes;
}

function findFile(nodes: readonly TreeNode[], path: string): TreeFile | undefined {
  for (const node of nodes) {
    if (node.kind === "file") {
      if (node.path === path) return node;
    } else {
      const found = findFile(node.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The file the pending gate is about.
 *
 * The subject-to-artifact binding is declared in the pipeline, which the read
 * model never loads — loading it would execute project code to render a tree. Two
 * sources answer without that: the decision file, which names the artifact it
 * locked, and otherwise the naming the kit's gates follow (`plan` → `plan.md`).
 * When neither answers, no file is flagged rather than the wrong one.
 */
function gateArtifactPath(workItemDir: string, subject: string): string | undefined {
  if (!isValidSubjectToken(subject)) return undefined;

  const decision = readDecisionAt(join(workItemDir, "decisions", `${subject}.json`));
  if (decision && isFile(join(workItemDir, decision.artifact))) return decision.artifact;

  for (const extension of GATE_EXTENSIONS) {
    const candidate = `artifacts/${subject}${extension}`;
    if (isFile(join(workItemDir, candidate))) return candidate;
  }
  return undefined;
}

/**
 * Tree of the effective work-item directory of `project/ticket`.
 *
 * `artifacts/`, `reports/`, `decisions/` and `runs/<pipeline>/<run>/` come from
 * the walk itself; so does a nested work item, whose runs appear under the
 * parent's tree exactly where they sit on disk; it gets no item of its own.
 *
 * One file is flagged `gate` — the artifact the pending approval is about — and
 * one is flagged `defaultOpen`: the gate file for a stop, the run's `state.json`
 * for a failure, which is where the reason of a technical failure is written.
 *
 * A run directory outside the effective work-item directory — the worktree case,
 * where the artifacts moved and the snapshot did not — is attached under `run/`
 * rather than dropped: a failed run whose `state.json` no reader can reach is a
 * failure nobody can diagnose.
 */
export function readTree(
  projectName: string,
  ticket: string,
  options: ReadModelOptions = {},
): WorkItemTree | undefined {
  const resolved = resolveRun(projectName, ticket, options);
  if (!resolved) return undefined;

  const root = resolved.workItemDir;
  const runDir = resolved.run.runDir;
  const budget: Budget = { left: MAX_ENTRIES };
  const children = walk(root, root, 0, budget);

  const detached = !isPathWithin(root, runDir);
  if (detached) {
    children.push({
      kind: "directory",
      name: RUN_PREFIX,
      path: RUN_PREFIX,
      children: walk(runDir, runDir, 1, budget, RUN_PREFIX),
    });
  }

  const subject = resolved.status === "STOPPED" ? resolved.run.state.outcome?.stop?.subject : undefined;
  const gateCandidate = subject ? gateArtifactPath(root, subject) : undefined;
  const gate = gateCandidate ? findFile(children, gateCandidate) : undefined;
  if (gate) gate.gate = true;

  const failed = resolved.status === "FAIL" || resolved.status === "ABORTED";
  const stateCandidate = detached ? `${RUN_PREFIX}/state.json` : `${treePath(root, runDir)}/state.json`;
  const fallback = failed ? findFile(children, stateCandidate) : undefined;

  const defaultFile = gate ?? fallback;
  if (defaultFile) defaultFile.defaultOpen = true;

  return {
    root,
    pipeline: resolved.run.pipeline,
    runId: resolved.run.state.runId ?? "",
    runDir,
    children,
    ...(gate ? { gatePath: gate.path } : {}),
    ...(defaultFile ? { defaultPath: defaultFile.path } : {}),
  };
}

/** Lexical rejection, before any filesystem call: an absolute path, a traversal
 *  segment, or a NUL byte never even becomes a candidate. Shared with the report
 *  validator, whose paths are later opened through `readFile`. */
export function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes("\0") || isAbsolute(value)) return false;
  return value
    .split(/[\\/]/)
    .every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && segment !== "");
}

/** Real path of a root, so containment survives a root reached through a link
 *  (a temporary directory on macOS, a symlinked home). */
function realRoot(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    // A root that no longer exists contains nothing.
    return undefined;
  }
}

/** Where a relative path of the tree lands on disk, once both containment
 *  checks passed — or why it does not land anywhere. */
type Located =
  | { status: "ok"; real: string; contentKind: FileContentKind; size: number }
  | { status: "not-found" }
  | { status: "denied"; reason: string };

/**
 * Resolve one path of the tree to a real file of the work item.
 *
 * The path is the one the tree gave, relative to the effective work-item
 * directory — or, under the `run/` prefix, to a run directory that sits outside
 * it. Containment is checked twice against the root it resolved under: lexically,
 * which answers `..`, then on the real path, which answers a symbolic link
 * pointing out of the tree.
 */
function locate(projectName: string, ticket: string, relativePath: string, options: ReadModelOptions): Located {
  const resolved = resolveRun(projectName, ticket, options);
  if (!resolved) return { status: "not-found" };
  if (!isSafeRelativePath(relativePath)) return { status: "denied", reason: "path escapes the work item" };

  const detached = !isPathWithin(resolved.workItemDir, resolved.run.runDir);
  const underRun = detached && relativePath.startsWith(`${RUN_PREFIX}/`);
  const root = underRun ? resolved.run.runDir : resolved.workItemDir;
  const path = underRun ? relativePath.slice(RUN_PREFIX.length + 1) : relativePath;

  const candidate = resolve(root, path);
  if (!isPathWithin(root, candidate)) return { status: "denied", reason: "path escapes the work item" };

  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    // Absent, or a broken link: nothing to read either way.
    return { status: "not-found" };
  }

  const realRootPath = realRoot(root);
  if (!realRootPath || !isPathWithin(realRootPath, real)) {
    return { status: "denied", reason: "path resolves outside the work item" };
  }
  if (!isFile(real)) return { status: "not-found" };
  return { status: "ok", real, contentKind: contentKindOf(real), size: sizeOf(real) };
}

/** Read one file of a work item, read-only and bounded. See `locate` for how the
 *  path is resolved and contained. */
export function readFile(
  projectName: string,
  ticket: string,
  relativePath: string,
  options: ReadModelOptions = {},
): FileRead {
  const located = locate(projectName, ticket, relativePath, options);
  if (located.status === "not-found") return { status: "not-found", relativePath };
  if (located.status === "denied") return { status: "denied", relativePath, reason: located.reason };

  const { real, contentKind, size } = located;
  const limit = limitFor(contentKind);
  if (size > limit) return { status: "too-large", path: real, relativePath, contentKind, size, limit };

  try {
    const buffer = readFileSync(real);
    return {
      status: "ok",
      path: real,
      relativePath,
      contentKind,
      size: buffer.byteLength,
      encoding: isImage(contentKind) ? "base64" : "text",
      content: isImage(contentKind) ? buffer.toString("base64") : buffer.toString("utf-8"),
    };
  } catch {
    // Readable a moment ago, unreadable now (permissions, removal): the reader
    // is told the file is not there rather than being handed an exception.
    return { status: "not-found", relativePath };
  }
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * The bytes of one image of a work item, for an `<img src>` rather than a JSON
 * envelope: a gallery of screenshots would otherwise travel as base64 inside
 * JSON, a third larger, and every one of them past `IMAGE_LIMIT_BYTES` would be
 * refused.
 *
 * Only images are served this way. The MIME type comes from the extension, like
 * every content kind of the explorer, so a text file renamed `.png` is at worst
 * a broken image — never a document the browser would interpret.
 */
export function readImage(
  projectName: string,
  ticket: string,
  relativePath: string,
  options: ReadModelOptions = {},
): ImageRead {
  const located = locate(projectName, ticket, relativePath, options);
  if (located.status !== "ok") return located;

  const mime = IMAGE_MIME_BY_EXTENSION[extensionOf(basename(located.real))];
  if (!mime) return { status: "denied", reason: "not an image" };
  if (located.size > RAW_IMAGE_LIMIT_BYTES) return { status: "denied", reason: "image too large" };

  try {
    return { status: "ok", mime, bytes: readFileSync(located.real) };
  } catch {
    // Same as `readFile`: a file that became unreadable is reported absent.
    return { status: "not-found" };
  }
}
