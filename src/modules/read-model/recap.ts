// modules/read-model/recap.ts
//
// What a run cost, once it is over: time, money, and tokens, run-wide and step
// by step.
//
// Every figure already sits in `state.json`: the runner accounts each step's
// duration, spend, and usage in its `control` and `usage` blocks, and folds them
// into `total_control` / `total_usage`. The recap only translates them — it adds
// nothing up itself, because a sum recomputed here would disagree with the
// ledger the budget was enforced against the first time a fix pass or a composed
// child was accounted differently.
//
// One figure is not in the parent's ledger: which models a composed node's
// spend went to. A node composing pipelines ran no agent of its own, so the
// recap reads its child runs' snapshots and groups their step costs by model.
// That split explains the node's cost; it never replaces it.

import { dirname, join } from "node:path";
import type { StepControl, StepUsage } from "../../contracts/backends.js";
import { resolveTicketDir } from "../../env/tickets.js";
import { isLogicalSegment } from "../../model/artifact-ports.js";
import type { PersistedPipelineChildRef, PersistedRun, PersistedStepState } from "../../model/persisted.js";
import { RUNS_DIRECTORY } from "../../state/stores/run-storage.js";
import { FileRunStateStore } from "../../state/stores/file-run-state-store.js";
import { type ProjectEntry, type ReadModelOptions, workItemsRoot } from "./projects.js";
import { resolveRun } from "./runs.js";
import { stepStatusOf } from "./steps.js";
import { isTicketToken } from "./tickets.js";
import type { RunModelCost, RunRecap, RunRecapStep, RunTokens } from "./types.js";

/** Composition depth the recap follows. Pipelines nest a level or two; the cap
 *  only guards against a snapshot that points back at an ancestor. */
const MAX_CHILD_DEPTH = 8;

/** Label of an agent step that spent money without recording its model. */
const UNKNOWN_MODEL = "unknown";

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Tokens of a usage block, or `undefined` when the block reports none — a
 *  command step has no usage, and four zeros would claim it was measured. */
function tokensOf(usage: StepUsage | undefined): RunTokens | undefined {
  if (!usage) return undefined;
  const tokens: RunTokens = {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_tokens),
    cacheWrite: count(usage.cache_creation_tokens),
  };
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite > 0 ? tokens : undefined;
}

function durationOf(control: StepControl | undefined): number | undefined {
  const duration = control?.duration_ms;
  return typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function text(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

/** Where the snapshots of a run live, so its children can be found. */
interface RunLocation {
  project: ProjectEntry;
  runDir: string;
  state: PersistedRun;
}

/**
 * Directory of one child run, or `undefined` when the reference cannot name
 * one safely.
 *
 * A child on the parent's own work item sits beside it, under the same `runs/`;
 * a child on another work item — a sub-US — sits under that item's directory,
 * resolved the way the runner resolved it.
 */
function childRunDir(parent: RunLocation, ref: PersistedPipelineChildRef): string | undefined {
  if (!isLogicalSegment(ref.pipeline) || !isLogicalSegment(ref.runId)) return undefined;
  if (!ref.ticket || ref.ticket === parent.state.ticket) {
    return join(dirname(dirname(parent.runDir)), ref.pipeline, ref.runId);
  }
  if (!isTicketToken(ref.ticket)) return undefined;
  const { project } = parent;
  const ticketDir = resolveTicketDir(ref.ticket, project.specPath, project.cwd);
  return join(workItemsRoot(project), ticketDir, RUNS_DIRECTORY, ref.pipeline, ref.runId);
}

/** Add every agent step of `location`'s run — and of the runs it composed — to
 *  `costs`, keyed by model. */
function collectModelCosts(
  location: RunLocation,
  store: FileRunStateStore,
  costs: Map<string, number | undefined>,
  depth: number,
): void {
  for (const step of location.state.steps) {
    if (step.orchestration) {
      if (depth < MAX_CHILD_DEPTH) collectChildCosts(location, step, store, costs, depth + 1);
      continue;
    }
    const cost = step.control?.total_cost_usd;
    const model = text(step.control?.model) ?? (typeof cost === "number" && cost > 0 ? UNKNOWN_MODEL : undefined);
    if (!model) continue;
    const previous = costs.get(model);
    costs.set(model, typeof cost === "number" ? (previous ?? 0) + cost : previous);
  }
}

function collectChildCosts(
  parent: RunLocation,
  step: PersistedStepState,
  store: FileRunStateStore,
  costs: Map<string, number | undefined>,
  depth: number,
): void {
  for (const ref of step.orchestration?.children ?? []) {
    const runDir = childRunDir(parent, ref);
    const state = runDir ? store.readAt(runDir) : null;
    // A child never started, or whose snapshot is gone, leaves no split to show.
    if (runDir && state) collectModelCosts({ project: parent.project, runDir, state }, store, costs, depth);
  }
}

/** Models a composed node's children ran, costliest first. */
function childModels(parent: RunLocation, step: PersistedStepState, store: FileRunStateStore): RunModelCost[] {
  const costs = new Map<string, number | undefined>();
  collectChildCosts(parent, step, store, costs, 1);
  return [...costs]
    .map(([model, costUsd]) => ({ model, ...(costUsd !== undefined ? { costUsd } : {}) }))
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
}

function recapStep(step: PersistedStepState, childSplit: RunModelCost[] | undefined): RunRecapStep {
  const control = step.control;
  const durationMs = durationOf(control);
  const costUsd = control?.total_cost_usd;
  // A composed node's `control.model` is not its own: snapshots written before
  // the runner stopped copying it hold the child's last model there.
  const model = childSplit ? undefined : text(control?.model);
  const profile = text(step.profile);
  const tokens = tokensOf(step.usage);
  return {
    id: step.id,
    status: stepStatusOf(step),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(typeof costUsd === "number" ? { costUsd } : {}),
    ...(control?.cost_estimated === true ? { costEstimated: true as const } : {}),
    ...(control?.cost_unknown === true ? { costUnknown: true as const } : {}),
    ...(model ? { model } : {}),
    ...(childSplit && childSplit.length > 0 ? { models: childSplit } : {}),
    ...(profile ? { profile } : {}),
    ...(step.retries > 0 ? { retries: step.retries } : {}),
    ...(tokens ? { tokens } : {}),
  };
}

/** Models the run's steps used, in order of first use, a composed node standing
 *  for the models of its children. */
function modelsOf(steps: RunRecapStep[]): string[] {
  const models = new Set<string>();
  for (const step of steps) {
    if (step.model) models.add(step.model);
    for (const split of step.models ?? []) if (split.model !== UNKNOWN_MODEL) models.add(split.model);
  }
  return [...models];
}

/**
 * Recap of the run `project/ticket` is currently about.
 *
 * Returns `undefined` for the same reasons as `readSteps`: an unlisted project, a
 * path that disappeared, or a work item with no run at all. A run still in
 * flight gets a recap too — the figures are simply the ones accounted so far.
 */
export function readRecap(projectName: string, ticket: string, options: ReadModelOptions = {}): RunRecap | undefined {
  const resolved = resolveRun(projectName, ticket, options);
  if (!resolved) return undefined;

  const state = resolved.run.state;
  const activeMs = durationOf(state.total_control);
  const tokens = tokensOf(state.total_usage);
  const startedAt = text(state.createdAt);
  const endedAt = text(state.updatedAt);
  const location: RunLocation = { project: resolved.project, runDir: resolved.run.runDir, state };
  const store = new FileRunStateStore();
  const steps = state.steps.map((step) =>
    recapStep(step, step.orchestration ? childModels(location, step, store) : undefined),
  );
  return {
    pipeline: resolved.run.pipeline,
    runId: state.runId ?? "",
    status: resolved.status,
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(activeMs !== undefined ? { activeMs } : {}),
    ...(tokens ? { tokens } : {}),
    models: modelsOf(steps),
    steps,
  };
}
