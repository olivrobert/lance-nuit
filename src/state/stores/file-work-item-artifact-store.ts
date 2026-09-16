import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { PipelineConfig } from "../../env/config.js";
import { resolveTicketDir } from "../../env/tickets.js";
import { isErrno } from "../../lib/errors.js";
import { type ArtifactRef, createArtifactRef, type WorkItemArtifactStore } from "../../model/artifact-ports.js";
import { isDescendantPath } from "./path-safety.js";
import { DEFAULT_SPEC_PATH } from "./run-storage.js";

export interface FileWorkItemArtifactStoreOptions {
  cwd?: string;
  config?: Pick<PipelineConfig, "specPath">;
  /** Current logical ticket, for example `PROJ-42-01`. */
  ticket?: string;
  /** Resolved current ticket directory, for example `PROJ-42/US-01`. */
  ticketDir?: string;
}

function isNotFound(error: unknown): boolean {
  return isErrno(error, "ENOENT");
}

/** Filesystem adapter scoped to the current work-item artifacts. */
export class FileWorkItemArtifactStore implements WorkItemArtifactStore {
  private readonly ticket?: string;

  private readonly artifactsDir?: string;

  constructor(options: FileWorkItemArtifactStoreOptions = {}) {
    const cwd = options.cwd ?? process.cwd();
    const specPath = options.config?.specPath ?? DEFAULT_SPEC_PATH;

    if (options.ticketDir !== undefined && options.ticket === undefined) {
      throw new Error("FileWorkItemArtifactStore requires a ticket when ticketDir is provided");
    }
    if (options.ticket === undefined) return;

    // Apply the same logical validation used for ArtifactRef to context-derived
    // scope values.
    this.ticket = createArtifactRef(options.ticket, "__scope__").ticket;
    const ticketDir = options.ticketDir ?? resolveTicketDir(this.ticket, specPath, cwd);
    createArtifactRef(ticketDir, "__scope__");

    const workItemsRoot = resolve(cwd, specPath);
    const workItemDir = resolve(workItemsRoot, ticketDir);
    if (!isDescendantPath(workItemsRoot, workItemDir)) {
      throw new Error(`ticket directory for "${this.ticket}" is outside the work-item root`);
    }
    this.artifactsDir = resolve(workItemDir, "artifacts");
  }

  async exists(ref: ArtifactRef): Promise<boolean> {
    try {
      await access(await this.pathFor(ref));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async readText(ref: ArtifactRef): Promise<string | undefined> {
    try {
      return await readFile(await this.pathFor(ref), "utf-8");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async readJson<T>(ref: ArtifactRef, parse: (value: unknown) => T): Promise<T | undefined> {
    const text = await this.readText(ref);
    if (text === undefined) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      // A crash mid-write (pre-atomic-write artifacts) leaves truncated JSON.
      // Treat it like a missing artifact so the pipeline can regenerate it,
      // instead of failing every subsequent run with a raw SyntaxError.
      console.error(`[pipeline] WARNING: artifact "${ref.name}" contains invalid JSON; treating it as absent.`);
      return undefined;
    }
    return parse(value);
  }

  async writeText(ref: ArtifactRef, value: string): Promise<void> {
    const path = await this.pathFor(ref);
    await mkdir(resolve(path, ".."), { recursive: true });
    await this.rejectSymlinkComponents(path);
    // Atomic publish: a crash mid-write must not leave a truncated artifact.
    const temporaryPath = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await writeFile(temporaryPath, value, "utf-8");
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async remove(ref: ArtifactRef): Promise<void> {
    await rm(await this.pathFor(ref), { force: true });
  }

  private async pathFor(ref: ArtifactRef): Promise<string> {
    const validated = createArtifactRef(ref);
    if (!this.ticket || !this.artifactsDir) {
      throw new Error(`artifact "${validated.name}" requested without a current ticket`);
    }
    if (validated.ticket !== this.ticket) {
      throw new Error(`artifact ticket "${validated.ticket}" is outside the current work item "${this.ticket}"`);
    }

    const path = resolve(this.artifactsDir, validated.name);
    if (!isDescendantPath(this.artifactsDir, path)) {
      throw new Error(`artifact name "${validated.name}" is outside the artifacts directory`);
    }
    await this.rejectSymlinkComponents(path);
    return path;
  }

  /** An artifacts directory can contain user-created links. Never let artifact
   * I/O follow one outside the artifacts directory, even when the lexical path
   * remains inside it.
   *
   * Only the components BELOW the artifacts directory are inspected. The path
   * leading to it may legitimately cross a link: under `--worktree` the run
   * writes through `work-items/<ticket>/artifacts`, a symlink to the main clone
   * (`env/worktree.ts`), so walking from the work-item root would reject every
   * artifact of such a run. That link is lance-nuit's own, placed to share a
   * work item between clones; the ones a user could drop under `artifacts/` are
   * the actual scope escape, and they stay refused. */
  private async rejectSymlinkComponents(path: string): Promise<void> {
    if (!this.artifactsDir) return;

    let current: string;
    try {
      // Walk the real directory: an lstat on a path still holding the shared
      // link would traverse it again and compare something other than disk.
      current = await realpath(this.artifactsDir);
    } catch (error) {
      // An artifacts directory not created yet holds no link below it either.
      if (isNotFound(error)) return;
      throw error;
    }
    for (const component of relative(this.artifactsDir, path).split(sep).filter(Boolean)) {
      current = join(current, component);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error(`artifact path "${path}" traverses a symbolic link`);
        }
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
    }
  }
}
