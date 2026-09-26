// modules/dashboard-home/project-list.ts
//
// `projects.json`: the flat list of project paths the dashboard reads. The read
// model describes each project from the project itself; this file only owns the
// list.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { DashboardPaths } from "./paths.js";
import { readJson, writeJsonAtomic } from "./json-file.js";

export type ProjectWrite = { status: "ok"; paths: string[] } | { status: "error"; reason: string };

const NO_HOME: ProjectWrite = { status: "error", reason: "no home directory to store the dashboard files" };

export class FileProjectList {
  constructor(private readonly paths: DashboardPaths | null) {}

  /** Create the file, empty but valid, when it is missing; never rewrite one. */
  ensure(): void {
    if (!this.paths) return;
    mkdirSync(this.paths.dir, { recursive: true });
    if (readJson(this.paths.projects) === undefined) writeJsonAtomic(this.paths.projects, { projects: [] });
  }

  /** Absolute project paths, in file order, deduplicated. A missing or invalid
   *  file lists nothing: the dashboard shows no project rather than failing. */
  list(): string[] {
    if (!this.paths) return [];
    const parsed = readJson(this.paths.projects);
    const entries = parsed && typeof parsed === "object" ? (parsed as { projects?: unknown }).projects : undefined;
    if (!Array.isArray(entries)) return [];

    const listed: string[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const path = (entry as { path?: unknown }).path;
      if (typeof path !== "string" || path.trim().length === 0) continue;
      const absolute = resolve(path.trim());
      if (!listed.includes(absolute)) listed.push(absolute);
    }
    return listed;
  }

  /**
   * Add a project path, stored absolute and deduplicated.
   *
   * Whether it still exists is NOT checked here: the read model reports a
   * vanished path as not found, and the caller decides whether to refuse a path
   * that is not a directory today.
   */
  add(path: string): ProjectWrite {
    if (!this.paths) return NO_HOME;
    const absolute = resolve(path.trim());
    const listed = this.list();
    if (listed.includes(absolute)) return { status: "ok", paths: listed };
    const next = [...listed, absolute];
    this.write(next);
    return { status: "ok", paths: next };
  }

  /** Remove a project path. Removing one that is not listed is a no-op, so the
   *  same click twice does not become an error. */
  remove(path: string): ProjectWrite {
    if (!this.paths) return NO_HOME;
    const absolute = resolve(path.trim());
    const listed = this.list();
    const kept = listed.filter((entry) => entry !== absolute);
    if (kept.length !== listed.length) this.write(kept);
    return { status: "ok", paths: kept };
  }

  private write(paths: string[]): void {
    if (!this.paths) return;
    mkdirSync(this.paths.dir, { recursive: true });
    writeJsonAtomic(this.paths.projects, { projects: paths.map((entry) => ({ path: entry })) });
  }
}
