// modules/read-model/runs.ts
//
// Which run a work item is currently about.
//
// The morning box, the folder explorer, and the step list must all describe the
// SAME run, or the dashboard would flag a gate on one run while rendering the
// tree of another. That choice — the most recently updated `latest` across every
// pipeline the ticket ran on — lives here once, and every entry point of the read
// model resolves through it.

import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { PersistedRun } from "../../model/persisted.js";
import { type RunRead, readRun, type RunsLocation } from "../../run-record/index.js";
import { type ProjectEntry, type ReadModelOptions, readProjects, workItemsRoot } from "./projects.js";
import type { ItemStatus } from "./types.js";

/** Directory entries that are real directories; anything unreadable is empty. */
export function directoryNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    // Enumeration is opportunistic: a project without work items has none.
    return [];
  }
}

/**
 * Work-item directories that carry runs, top level only.
 *
 * A nested work item (`PROJ-28/US-01`) keeps its runs under its own directory,
 * so it is skipped here by construction: it shows inside its parent's explorer
 * rather than as an item of its own.
 */
export function ticketDirectories(project: ProjectEntry): string[] {
  const root = workItemsRoot(project);
  return directoryNames(root).filter((name) => directoryNames(join(root, name, "runs")).length > 0);
}

function latestRunDir(pipelineDir: string): string | null {
  try {
    return realpathSync(join(pipelineDir, "latest"));
  } catch {
    // No `latest` link, or a broken one: this pipeline has no current run.
    return null;
  }
}

function updatedMs(state: PersistedRun): number {
  const stamp = state.updatedAt ?? state.createdAt;
  const parsed = stamp ? Date.parse(stamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A run as the run record reads it, with the pipeline it ran. */
export interface SelectedRun extends RunRead {
  pipeline: string;
}

/** Where `project` keeps its runs: what the run record needs to tell who holds
 *  a run, a composed child included. */
export function runsLocationOfProject(project: ProjectEntry): RunsLocation {
  return { cwd: project.cwd, specPath: project.specPath };
}

/**
 * Latest run of each pipeline, most recently updated first.
 *
 * Each is read through the run record (`readRun`), so its status is the one the
 * runner would judge — a snapshot without a verdict that no live process holds
 * is an interrupted `ABORTED` run — and its steps are the ones a resume would
 * start from. The dashboard and a later `lancenuit run` agree on what is live.
 */
export function latestRuns(project: ProjectEntry, ticket: string): SelectedRun[] {
  const runsDir = join(workItemsRoot(project), ticket, "runs");
  const location = runsLocationOfProject(project);
  const runs: SelectedRun[] = [];
  for (const pipeline of directoryNames(runsDir)) {
    const runDir = latestRunDir(join(runsDir, pipeline));
    if (!runDir) continue;
    const run = readRun(runDir, location);
    if (run) runs.push({ pipeline, ...run });
  }
  return runs.sort((a, b) => updatedMs(b.state) - updatedMs(a.state));
}

/**
 * Directory the run's code and git operations ran in.
 *
 * A worktree run records its effective `cwd`; a run written before that field
 * existed falls back to the main clone, which is where it ran. It never locates
 * the work item: see `workItemDirOf`.
 */
export function effectiveCwd(project: ProjectEntry, state: PersistedRun): string {
  const cwd = state.cwd?.trim();
  return cwd && cwd.length > 0 ? cwd : project.cwd;
}

/**
 * The work item of `ticket`, always in the main clone.
 *
 * A worktree links its work item to the main clone's (`env/worktree.ts`), so the
 * main clone holds the only copy — and the only one left once the worktree is
 * removed.
 */
export function workItemDirOf(project: ProjectEntry, ticket: string): string {
  return join(workItemsRoot(project), ticket);
}

/** The run a ticket is about, with the directories every reader needs. */
export interface ResolvedRun {
  project: ProjectEntry;
  ticket: string;
  run: SelectedRun;
  status: ItemStatus;
  /** The snapshot says RUNNING but its runner is gone; `status` is then ABORTED. */
  interrupted: boolean;
  /** Effective working directory of the run, after any worktree `chdir`: where
   *  its code and git state live, not its work item. */
  cwd: string;
  /** Work-item directory, in the main clone whatever `cwd` is:
   *  `<project.cwd>/<specPath>/<ticket>`. */
  workItemDir: string;
}

/** Resolve `project/ticket` to its current run, or `undefined` when the project
 *  is not listed, its path is gone, or the work item has no run. */
export function resolveRun(
  projectName: string,
  ticket: string,
  options: ReadModelOptions = {},
): ResolvedRun | undefined {
  const project = readProjects(options).find((entry) => entry.name === projectName && entry.found);
  if (!project || !ticketDirectories(project).includes(ticket)) return undefined;

  const [run] = latestRuns(project, ticket);
  if (!run) return undefined;

  return {
    project,
    ticket,
    run,
    status: run.status,
    interrupted: run.interrupted,
    cwd: effectiveCwd(project, run.state),
    workItemDir: workItemDirOf(project, ticket),
  };
}
