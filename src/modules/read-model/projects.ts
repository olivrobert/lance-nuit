// modules/read-model/projects.ts
//
// The dashboard's projects: the paths listed in `~/.lance-nuit/ui/projects.json`
// (owned by `dashboard-home/`), each described from the project itself, so the
// list never drifts from the repositories it points at.
//
// A path that disappeared stays listed and is reported as not found: the UI
// greys the chip instead of failing the whole morning box over one stale entry.

import { statSync } from "node:fs";
import { basename, join } from "node:path";
import { loadPipelineConfig } from "../../env/config.js";
import { DEFAULT_SPEC_PATH } from "../../env/tickets.js";
import { openDashboardHome } from "../dashboard-home/index.js";

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
  return openDashboardHome(options.env ?? process.env)
    .projects.list()
    .map(describe);
}

/** Work-item root of a project. */
export function workItemsRoot(project: ProjectEntry): string {
  return join(project.cwd, project.specPath);
}

/** Tracker URL of one ticket, when the project declares a base URL. */
export function ticketUrl(project: ProjectEntry, ticket: string): string | undefined {
  return project.ticketBaseUrl ? `${project.ticketBaseUrl}/${ticket}` : undefined;
}
