// modules/read-model/projects.ts
//
// The dashboard's own list of projects: `~/.lance-nuit/ui/projects.json`, a flat
// list of paths. Everything else about a project is read from the project
// itself, so the file never drifts from the repositories it points at.
//
// A path that disappeared stays listed and is reported as not found: the UI
// greys the chip instead of failing the whole morning box over one stale entry.

import { readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadPipelineConfig } from "../../env/config.js";
import { userKitDir } from "../../env/kit-paths.js";
import { DEFAULT_SPEC_PATH } from "../../env/tickets.js";

/** Options shared by every read-model entry point. `env` exists so a caller —
 *  and a test — can point `PIPELINE_HOME` at a disposable kit directory. */
export interface ReadModelOptions {
  env?: NodeJS.ProcessEnv;
}

export interface ProjectEntry {
  /** Last segment of the project path. */
  name: string;
  /** Absolute path of the main clone, as listed in `projects.json`. */
  cwd: string;
  /** Work-item provider, or `"unknown"` when the project cannot be read. */
  provider: string;
  /** Tracker project key declared by the project, when it declares one. */
  key?: string;
  /** Tracker base URL; a ticket URL is this joined to the ticket id. */
  ticketBaseUrl?: string;
  /** Work-item root, relative to `cwd`. */
  specPath: string;
  /** False when the path no longer exists on disk. */
  found: boolean;
}

/** Directory holding the three files the dashboard owns. `null` when no home
 *  directory is resolvable, which is the one case with nothing to read. */
export function uiDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const kit = userKitDir(env);
  return kit ? join(kit, "ui") : null;
}

export function projectsFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = uiDir(env);
  return dir ? join(dir, "projects.json") : null;
}

function listedPaths(env: NodeJS.ProcessEnv): string[] {
  const file = projectsFile(env);
  if (!file) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    // No file yet, or a hand-edited file left invalid: the dashboard shows no
    // project rather than refusing to start.
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const projects = (parsed as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) return [];

  const paths: string[] = [];
  for (const entry of projects) {
    if (!entry || typeof entry !== "object") continue;
    const path = (entry as { path?: unknown }).path;
    if (typeof path !== "string" || path.trim().length === 0) continue;
    const absolute = resolve(path.trim());
    if (!paths.includes(absolute)) paths.push(absolute);
  }
  return paths;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    // A path that vanished, or one the server cannot stat, is simply not found.
    return false;
  }
}

function describe(path: string): ProjectEntry {
  const name = basename(path);
  if (!isDirectory(path)) {
    return { name, cwd: path, provider: "unknown", specPath: DEFAULT_SPEC_PATH, found: false };
  }

  try {
    const config = loadPipelineConfig(path);
    const key = config.workItem.project;
    const baseUrl = config.workItem.baseUrl?.replace(/\/+$/, "");
    return {
      name,
      cwd: path,
      provider: config.workItem.provider,
      ...(key ? { key } : {}),
      ...(baseUrl ? { ticketBaseUrl: baseUrl } : {}),
      specPath: config.specPath,
      found: true,
    };
  } catch {
    // A malformed `config.json` costs the project its metadata, not its items:
    // the work-item layout is the same with or without a readable configuration.
    return { name, cwd: path, provider: "unknown", specPath: DEFAULT_SPEC_PATH, found: true };
  }
}

/** Projects listed for the dashboard, in file order, deduplicated by path. */
export function readProjects(options: ReadModelOptions = {}): ProjectEntry[] {
  return listedPaths(options.env ?? process.env).map(describe);
}

/** Work-item root of a project. */
export function workItemsRoot(project: ProjectEntry): string {
  return join(project.cwd, project.specPath);
}

/** Tracker URL of one ticket, when the project declares a base URL. */
export function ticketUrl(project: ProjectEntry, ticket: string): string | undefined {
  return project.ticketBaseUrl ? `${project.ticketBaseUrl}/${ticket}` : undefined;
}
