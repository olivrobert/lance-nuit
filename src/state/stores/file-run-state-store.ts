import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { PipelineContext } from "../../model/context.js";
import type { PersistedRun } from "../../model/persisted.js";
import { createRunRef, type RunStateSnapshot, type RunStateStore } from "../../model/storage-ports.js";
import { readRunSnapshot } from "../run-snapshot.js";
import { FileRunSnapshotCatalog } from "./file-run-snapshot-catalog.js";
import {
  DEFAULT_SPEC_PATH,
  latestRunFile,
  pipelineRunsDir,
  resolveRunDir as resolveStoredRunDir,
  resolveRunDirSelection,
  type RunDirResolution,
  STATE_FILE,
} from "./run-storage.js";

export interface FileRunStateStoreOptions {
  cwd?: string;
  context?: PipelineContext;
  ticket?: string;
  pipeline?: string;
}

export class FileRunStateStore implements RunStateStore {
  private readonly context?: PipelineContext;

  private readonly ticket?: string;

  private readonly pipeline?: string;

  private readonly snapshotCatalog: FileRunSnapshotCatalog;

  constructor(options: FileRunStateStoreOptions = {}) {
    this.context = this.resolveContext(options.cwd, options.context);
    this.ticket = options.ticket ?? options.context?.ticket;
    this.pipeline = options.pipeline;
    this.snapshotCatalog = new FileRunSnapshotCatalog(this.context);
  }

  resolveRunDir(
    pipeline: string,
    ticket?: string,
    explicitRunDir?: string,
    fresh?: boolean,
    context?: PipelineContext,
  ): string {
    return resolveStoredRunDir(pipeline, ticket ?? this.ticket, explicitRunDir, fresh, context ?? this.context);
  }

  /** Boot uses this richer form to distinguish a new directory from a selected
   * existing snapshot during its final, race-safe read. */
  resolveRunDirSelection(
    pipeline: string,
    ticket?: string,
    explicitRunDir?: string,
    fresh?: boolean,
    context?: PipelineContext,
  ): RunDirResolution {
    return resolveRunDirSelection(pipeline, ticket ?? this.ticket, explicitRunDir, fresh, context ?? this.context);
  }

  load(runId: string): PersistedRun | null {
    if (!this.pipeline) throw new Error("FileRunStateStore.load requires a configured pipeline");
    const ref = createRunRef({ runId, pipeline: this.pipeline, ticket: this.ticket });
    const runDir = join(pipelineRunsDir(ref.pipeline, ref.ticket, this.context), ref.runId);
    return readRunSnapshot(this.pathFor(runDir));
  }

  loadLatest(pipeline: string, ticket?: string): PersistedRun | null {
    const path = latestRunFile(pipeline, ticket ?? this.ticket, this.context);
    return path ? readRunSnapshot(path) : null;
  }

  listSnapshots(ticket?: string, context?: PipelineContext): RunStateSnapshot[] {
    return this.snapshotCatalog.list(ticket, context);
  }

  readAt(runDir: string): PersistedRun | null {
    return readRunSnapshot(this.pathFor(runDir));
  }

  save(run: PersistedRun): void {
    if (!run.runId) throw new Error("FileRunStateStore.save requires run.runId");
    const ticket = run.ticket ?? this.ticket;
    const ref = createRunRef({ runId: run.runId, pipeline: run.pipeline, ticket });
    const runDir = join(pipelineRunsDir(ref.pipeline, ref.ticket, this.context), ref.runId);
    this.saveAt(run, runDir);
  }

  saveAt(run: PersistedRun, runDir: string): void {
    const snapshot: PersistedRun = {
      ...run,
      schemaVersion: 1,
      runId: run.runId ?? basename(runDir),
      updatedAt: new Date().toISOString(),
    };

    if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true });
    const path = this.pathFor(runDir);
    // Per-writer temp name: a shared `.tmp` would let two concurrent writers
    // publish each other's half-written bytes via rename.
    const temporaryPath = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(snapshot, null, 2));
      renameSync(temporaryPath, path);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Temporary snapshot cleanup is best effort; preserve the original write error.
      }
      throw error;
    }
  }

  pathFor(runDir: string): string {
    return join(runDir, STATE_FILE);
  }

  private resolveContext(cwd?: string, context?: PipelineContext): PipelineContext | undefined {
    // A caller holding a context and wanting another `cwd` derives it itself
    // (`deriveContext`): the store reads a context, it does not build one.
    if (context) return context;
    if (!cwd) return undefined;

    // run-storage primitives consult only cwd and config.specPath.
    return { cwd, config: { specPath: DEFAULT_SPEC_PATH } } as PipelineContext;
  }
}
