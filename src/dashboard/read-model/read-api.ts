//
// The read API's projection: every root run of every listed project, in the
// shapes of `read-api.schema.ts`.
//
// It decides nothing about a run on its own. The status is the run record's
// (`readRun`), the spend its ledger's (`runSpend`), how the run ended comes from
// `run-facts.ts`, and the run a ticket is about from `latestRuns`: the readings
// the morning box makes, so the dashboard and a reader of the API never
// disagree on a run. What this module adds is the enumeration — every root run,
// each read once by its real path, as the statistics read them — and the
// filters.
//
// Nothing is cached across calls: an answer is the disk as it is now.

import { realpathSync } from "node:fs";
import { basename } from "node:path";
import type { HistoryEntry, PersistedRun, RunRead, Spend } from "../../run/index.js";
import { awaitsHuman, listWorkItemRuns, readHistory, readRun, runSpend } from "../../run/index.js";
import { readTicketTitle } from "./items.js";
import { type ProjectEntry, type ReadModelOptions, readProjects, ticketUrl } from "./projects.js";
import {
  type ApiCost,
  type ApiRun,
  type ApiRunDetail,
  type ApiRunList,
  type ApiRunStatus,
  type ApiStep,
  type ApiStop,
  READ_API_VERSION,
} from "./read-api.schema.js";
import { recapStepsOf } from "./recap.js";
import { readReport } from "./report.js";
import {
  approvalOf,
  budgetExceededOf,
  closureOf,
  costUnaccountedOf,
  failureOf,
  type RunStop,
  stopOf,
} from "./run-facts.js";
import { latestRuns, runsLocationOfProject, ticketDirectories, workItemDirOf } from "./runs.js";
import type { ItemCost, RunRecapStep } from "./types.js";

/** What a reader asked for. Every field narrows; none widens. */
export interface ApiRunFilters {
  project?: string;
  ticket?: string;
  /** Keep the runs in one of these statuses; empty or absent keeps them all. */
  statuses?: readonly ApiRunStatus[];
  /** Keep the runs updated at or after this instant (epoch ms). A run with no
   *  stamp is left out rather than counted as recent. */
  sinceMs?: number;
  /** Keep only the run each ticket is currently about. */
  currentOnly?: boolean;
  limit: number;
}

/** A root run found on disk, before it is rendered. */
interface FoundRun {
  project: ProjectEntry;
  ticket: string;
  pipeline: string;
  run: RunRead;
  /** Real path of the run directory: the identity a link cannot fake. */
  realDir: string;
  current: boolean;
}

function realPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    // A run directory that vanished mid-scan has nothing left to show.
    return undefined;
  }
}

function text(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function updatedMs(state: PersistedRun): number | undefined {
  const stamp = text(state.updatedAt) ?? text(state.createdAt);
  const parsed = stamp ? Date.parse(stamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The run id the snapshot recorded, or the directory it sits in: the layout
 *  names a run directory after its run. */
function runIdOf(found: Pick<FoundRun, "run" | "realDir">): string {
  return text(found.run.state.runId) ?? basename(found.realDir);
}

/** A composed child: its spend is already in its parent's ledger. */
function isChild(state: PersistedRun): boolean {
  return typeof state.parentRunId === "string" && state.parentRunId.length > 0;
}

/**
 * Every root run of one ticket, each read once.
 *
 * `ticket` must be one of `ticketDirectories(project)`: it reaches a path.
 */
function rootRunsOf(project: ProjectEntry, ticket: string): FoundRun[] {
  const location = runsLocationOfProject(project);
  const [selected] = latestRuns(project, ticket);
  const currentDir = selected ? realPath(selected.runDir) : undefined;
  const seen = new Set<string>();
  const found: FoundRun[] = [];
  for (const { pipeline, runDirs } of listWorkItemRuns(workItemDirOf(project, ticket))) {
    for (const listed of runDirs) {
      const realDir = realPath(listed);
      if (!realDir || seen.has(realDir)) continue;
      seen.add(realDir);
      const run = readRun(realDir, location);
      if (!run || isChild(run.state)) continue;
      found.push({ project, ticket, pipeline, run, realDir, current: realDir === currentDir });
    }
  }
  return found;
}

function matches(found: FoundRun, filters: ApiRunFilters): boolean {
  if (filters.currentOnly && !found.current) return false;
  if (filters.statuses && filters.statuses.length > 0 && !filters.statuses.includes(found.run.status)) return false;
  if (filters.sinceMs !== undefined) {
    const updated = updatedMs(found.run.state);
    if (updated === undefined || updated < filters.sinceMs) return false;
  }
  return true;
}

function apiCostOf(spend: Pick<Spend, "usd" | "estimated" | "lowerBound">): ApiCost {
  return {
    ...(spend.usd !== undefined ? { usd: spend.usd } : {}),
    estimated: spend.estimated,
    lowerBound: spend.lowerBound,
  };
}

function apiStepCostOf(cost: ItemCost): ApiCost {
  return {
    ...(cost.usd !== undefined ? { usd: cost.usd } : {}),
    estimated: cost.estimated,
    lowerBound: cost.unknown === true,
  };
}

function apiStopOf(stop: RunStop): ApiStop {
  return {
    ...(stop.subject ? { subject: stop.subject } : {}),
    ...(stop.kind ? { kind: stop.kind } : {}),
    detail: stop.detail,
    ...(stop.reworkable ? { reworkable: true } : {}),
  };
}

function apiStepOf(step: RunRecapStep): ApiStep {
  return {
    id: step.id,
    status: step.status,
    ...(step.profile ? { profile: step.profile } : {}),
    ...(step.model ? { model: step.model } : {}),
    ...(step.models ? { models: step.models.map((split) => ({ ...split })) } : {}),
    ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
    ...(step.cost ? { cost: apiStepCostOf(step.cost) } : {}),
    ...(step.retries !== undefined ? { retries: step.retries } : {}),
    ...(step.tokens ? { tokens: { ...step.tokens } } : {}),
  };
}

/** What every run of a project shares: read once per call, not once per run. */
interface ProjectReads {
  history: HistoryEntry[];
  titles: Map<string, string | undefined>;
}

function titleOf(found: FoundRun, reads: ProjectReads): string | undefined {
  if (!reads.titles.has(found.ticket)) {
    reads.titles.set(found.ticket, readTicketTitle(workItemDirOf(found.project, found.ticket), found.ticket));
  }
  return reads.titles.get(found.ticket);
}

/** Branch of the run, as the central history recorded it when the run finished. */
function branchOf(runId: string, reads: ProjectReads): string | undefined {
  const branch = reads.history.find((entry) => entry.runId === runId)?.branch;
  return typeof branch === "string" && branch.length > 0 ? branch : undefined;
}

async function apiRunOf(found: FoundRun, reads: ProjectReads): Promise<ApiRun> {
  const { project, ticket, run, current } = found;
  const { state, status, interrupted } = run;
  const runId = runIdOf(found);
  const stop = stopOf(state, status);
  const failure = failureOf(state, status, interrupted);
  // The decision is read as the work item stands today: it says nothing about
  // a run the ticket has moved past.
  const approval = current && stop?.subject ? await approvalOf(project, ticket, stop.subject) : undefined;
  const closed = closureOf(run.runDir, state, status);
  const spend = runSpend(state);
  const activeMs = spend.durationMs !== undefined && spend.durationMs >= 0 ? spend.durationMs : undefined;
  const title = titleOf(found, reads);
  const url = ticketUrl(project, ticket);
  const createdAt = text(state.createdAt);
  const updatedAt = text(state.updatedAt) ?? createdAt;
  const branch = branchOf(runId, reads);
  return {
    project: project.name,
    ticket,
    pipeline: found.pipeline,
    runId,
    current,
    ...(title ? { title } : {}),
    ...(url ? { ticketUrl: url } : {}),
    status,
    ...(interrupted ? { interrupted: true } : {}),
    awaitsHuman: awaitsHuman(status),
    ...(stop ? { stop: apiStopOf(stop) } : {}),
    ...(failure ? { failure } : {}),
    ...(approval ? { approval } : {}),
    ...(budgetExceededOf(state) ? { budgetExceeded: true } : {}),
    ...(costUnaccountedOf(state) ? { costUnaccounted: true } : {}),
    cost: apiCostOf(spend),
    ...(activeMs !== undefined ? { activeMs } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(branch ? { branch } : {}),
    worktree: state.worktree === true,
    ...(closed ? { closed } : {}),
  };
}

function newestFirst(a: FoundRun, b: FoundRun): number {
  const age = (updatedMs(b.run.state) ?? 0) - (updatedMs(a.run.state) ?? 0);
  if (age !== 0) return age;
  const keyA = `${a.project.name}/${a.ticket}/${runIdOf(a)}`;
  const keyB = `${b.project.name}/${b.ticket}/${runIdOf(b)}`;
  return keyA.localeCompare(keyB);
}

function projectReads(project: ProjectEntry, cache: Map<string, ProjectReads>): ProjectReads {
  let reads = cache.get(project.cwd);
  if (!reads) {
    reads = { history: readHistory(project.cwd), titles: new Map() };
    cache.set(project.cwd, reads);
  }
  return reads;
}

/**
 * The root runs of every listed project that pass `filters`, newest first.
 *
 * Every run is read before the list is cut to `limit`, because the newest ones
 * can only be known once all are read. A project whose path disappeared, or
 * that the filters leave out, is not read at all.
 */
export async function listApiRuns(filters: ApiRunFilters, options: ReadModelOptions = {}): Promise<ApiRunList> {
  const found: FoundRun[] = [];
  for (const project of readProjects(options)) {
    if (!project.found || (filters.project !== undefined && project.name !== filters.project)) continue;
    for (const ticket of ticketDirectories(project)) {
      if (filters.ticket !== undefined && ticket !== filters.ticket) continue;
      found.push(...rootRunsOf(project, ticket).filter((run) => matches(run, filters)));
    }
  }
  const kept = found.sort(newestFirst).slice(0, filters.limit);
  const cache = new Map<string, ProjectReads>();
  const runs: ApiRun[] = [];
  for (const run of kept) runs.push(await apiRunOf(run, projectReads(run.project, cache)));
  return { schemaVersion: READ_API_VERSION, generatedAt: new Date().toISOString(), runs };
}

/**
 * One root run with its steps, and the delivery report when it is the run the
 * ticket is about. `undefined` when the project is not listed, its path is
 * gone, the work item has no such run, or the run is a composed child.
 */
export async function readApiRun(
  projectName: string,
  ticket: string,
  runId: string,
  options: ReadModelOptions = {},
): Promise<ApiRunDetail | undefined> {
  const project = readProjects(options).find((entry) => entry.name === projectName && entry.found);
  if (!project || !ticketDirectories(project).includes(ticket)) return undefined;
  const found = rootRunsOf(project, ticket).find((candidate) => runIdOf(candidate) === runId);
  if (!found) return undefined;

  const run = await apiRunOf(found, projectReads(project, new Map()));
  const steps = recapStepsOf(project, found.run.runDir, found.run.state, found.run.interrupted).map(apiStepOf);
  // `report.json` belongs to the work item, and is valid only for the run it names.
  const report = found.current ? readReport(project.name, ticket, options) : undefined;
  return {
    schemaVersion: READ_API_VERSION,
    generatedAt: new Date().toISOString(),
    run,
    steps,
    ...(report?.report ? { report: report.report } : {}),
    ...(report?.reportError ? { reportError: report.reportError } : {}),
  };
}
