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

import type { StepControl, StepUsage } from "../../contracts/backends.js";
import type { PersistedRun, PersistedStepState } from "../../model/persisted.js";
import type { ReadModelOptions } from "./projects.js";
import { resolveRun } from "./runs.js";
import { stepStatusOf } from "./steps.js";
import type { RunRecap, RunRecapStep, RunTokens } from "./types.js";

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

function recapStep(step: PersistedStepState): RunRecapStep {
  const control = step.control;
  const durationMs = durationOf(control);
  const costUsd = control?.total_cost_usd;
  const model = text(control?.model);
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
    ...(profile ? { profile } : {}),
    ...(step.retries > 0 ? { retries: step.retries } : {}),
    ...(tokens ? { tokens } : {}),
  };
}

function modelsOf(state: PersistedRun): string[] {
  const models = new Set<string>();
  for (const step of state.steps) {
    const model = text(step.control?.model);
    if (model) models.add(model);
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
  return {
    pipeline: resolved.run.pipeline,
    runId: state.runId ?? "",
    status: resolved.status,
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(activeMs !== undefined ? { activeMs } : {}),
    ...(tokens ? { tokens } : {}),
    models: modelsOf(state),
    steps: state.steps.map(recapStep),
  };
}
