import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isErrno } from "../../lib/errors.js";
import type { PipelineContext } from "../../model/context.js";
import { createLogRef, type LogRef, type RunLogStore, type RunRef } from "../../model/storage-ports.js";
import { isDescendantPath, isPathWithin } from "./path-safety.js";
import { pipelineRunsDir } from "./run-storage.js";

export interface FileRunLogStoreOptions {
  runDir?: string;
  runDirs?: Map<string, string>;
  context?: PipelineContext;
  ticket?: string;
}

export class FileRunLogStore implements RunLogStore {
  private readonly runDir?: string;

  private readonly runDirs?: Map<string, string>;

  private readonly context?: PipelineContext;

  private readonly ticket?: string;

  constructor({ runDir, runDirs, context, ticket }: FileRunLogStoreOptions = {}) {
    this.runDir = runDir;
    this.runDirs = runDirs;
    this.context = context;
    this.ticket = ticket;
  }

  allocate(run: RunRef, stepId: string, attempt: number): LogRef {
    return this.allocateAt(this.requiredRunDir(run), run, stepId, attempt);
  }

  append(log: LogRef, text: string): void {
    const path = this.pathForRef(log);
    mkdirSync(dirname(path), { recursive: true });
    this.assertNoSymlinkComponents(this.requiredRunDir(log.run), path);
    appendFileSync(path, text, { encoding: "utf-8" });
  }

  read(log: LogRef): string | null {
    const path = this.pathForRef(log);
    try {
      return readFileSync(path, "utf-8");
    } catch {
      // Log reads are diagnostic; an absent or unreadable file is represented as null.
      return null;
    }
  }

  allocateAt(runDir: string, run: RunRef, stepId: string, attempt: number): LogRef {
    const ref = createLogRef(run, stepId, attempt);
    const localPath = this.pathFor(runDir, ref.stepId, ref.attempt);
    mkdirSync(dirname(localPath), { recursive: true });
    this.assertNoSymlinkComponents(runDir, localPath);
    return createLogRef(ref.run, ref.stepId, ref.attempt, localPath);
  }

  /** Resolve the latest existing log without creating an attempt directory. */
  findLatest(run: RunRef, stepId: string): LogRef | null {
    return this.findLatestAt(this.requiredRunDir(run), run, stepId);
  }

  findLatestAt(runDir: string, run: RunRef, stepId: string): LogRef | null {
    const validated = createLogRef(run, stepId, 1);
    const stepDir = dirname(dirname(this.pathFor(runDir, validated.stepId, 1)));
    if (!existsSync(stepDir)) return null;

    let attempts: Array<{ attempt: number; path: string }>;
    try {
      attempts = readdirSync(stepDir)
        .map((entry) => ({ entry, match: /^attempt-(\d+)$/.exec(entry) }))
        .filter((item): item is { entry: string; match: RegExpExecArray } => item.match !== null)
        .map(({ entry, match }) => ({
          attempt: Number.parseInt(match[1]!, 10),
          path: resolve(stepDir, entry, "output.log"),
        }))
        .filter(({ attempt, path }) => attempt > 0 && existsSync(path))
        .sort((left, right) => right.attempt - left.attempt);
    } catch {
      // A concurrently removed or unreadable step directory has no latest log.
      return null;
    }

    const latest = attempts[0];
    return latest ? createLogRef(validated.run, validated.stepId, latest.attempt, latest.path) : null;
  }

  private pathForRef(log: LogRef): string {
    const validated = createLogRef(log);
    const expected = this.pathFor(this.requiredRunDir(validated.run), validated.stepId, validated.attempt);
    if (validated.localPath && resolve(validated.localPath) !== expected) {
      throw new Error("Local log path does not match its persisted reference");
    }
    return expected;
  }

  private pathFor(runDir: string, stepId: string, attempt: number): string {
    const root = resolve(runDir);
    const safeStep = stepId.replace(/[^A-Za-z0-9._-]/g, "_");
    const path = resolve(root, "steps", safeStep, `attempt-${String(attempt).padStart(3, "0")}`, "output.log");
    if (!isDescendantPath(root, path)) {
      throw new Error("Log path is outside the run directory");
    }
    this.assertNoSymlinkComponents(root, path);
    return path;
  }

  /** A run directory can contain user-created links. Never let log I/O follow
   * one outside the run, even when the lexical path remains inside it.
   *
   * Only the components BELOW the run directory are inspected. The path leading
   * to it may legitimately cross a link: a `--worktree` run writes through
   * `work-items/<ticket>/runs`, a symlink to the main clone (`env/worktree.ts`),
   * and walking from `/` would reject every log of such a run. */
  private assertNoSymlinkComponents(root: string, path: string): void {
    const resolvedRoot = resolve(root);
    const resolvedPath = resolve(path);
    if (!isPathWithin(resolvedRoot, resolvedPath)) {
      throw new Error("Log path is outside the run directory");
    }
    let current: string;
    try {
      current = realpathSync(resolvedRoot);
    } catch (error) {
      // A run directory not created yet has no link below it either.
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
    const components = relative(resolvedRoot, resolvedPath).split(sep).filter(Boolean);
    for (const component of components) {
      current = join(current, component);
      try {
        if (lstatSync(current).isSymbolicLink()) {
          throw new Error(`Log path "${path}" traverses a symbolic link`);
        }
      } catch (error) {
        if (isErrno(error, "ENOENT")) return;
        throw error;
      }
    }
  }

  private requiredRunDir(run: RunRef | string): string {
    const runId = typeof run === "string" ? run : run.runId;
    const runDir =
      this.runDirs?.get(runId) ??
      this.runDir ??
      (typeof run !== "string"
        ? join(pipelineRunsDir(run.pipeline, run.ticket ?? this.ticket, this.context), run.runId)
        : undefined);
    if (!runDir) throw new Error(`No local directory configured for run "${runId}"`);
    return runDir;
  }
}
