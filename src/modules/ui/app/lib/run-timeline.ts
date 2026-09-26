// Where the time and the money of a run went, laid out for the Run tab.

import type { RunRecap, RunRecapStep, RunStepsView } from "../api/types.js";

/** Under this, a step is plumbing — a gate, a guard, a copy — and giving it a
 *  lane of its own would bury the steps that actually took the time. */
export const NOTABLE_MS = 1000;

export function isNotable(step: RunRecapStep): boolean {
  if (step.status === "failed" || step.status === "aborted") return true;
  if (typeof step.costUsd === "number" && step.costUsd > 0) return true;
  return (step.durationMs ?? 0) >= NOTABLE_MS;
}

/** Narrowest bar drawn, in % of the run span: a 30-second step of a 9-hour run
 *  still has to be seen. */
const MIN_BAR_PCT = 0.4;

/** A horizontal position over the run span, in %. */
export interface RunTimelineBar {
  left: number;
  width: number;
}

export interface RunTimelineLane {
  step: RunRecapStep;
  /** Wall-clock extent of the step. Absent without a start, an end (a step
   *  still running ends at the span's end), or a span to place it on. */
  bar?: RunTimelineBar;
  wallMs?: number;
  /** The step ran an agent — its own model, a composed split, or a price. */
  agent: boolean;
}

/** Where the time of a run went, laid out for the Run tab. Every position is
 *  a percentage of the run span, so nothing here knows about pixels. */
export interface RunTimeline {
  /** Run span start, epoch ms; absent when the run has no usable span. */
  startMs?: number;
  /** 0 when the run has no usable span: nothing is placed, nothing divides. */
  spanMs: number;
  /** One lane per notable step, plus any step still running, in run order. */
  lanes: RunTimelineLane[];
  /** The other steps that ran, drawn as ticks on a single lane. */
  short: { count: number; ticks: number[] };
  skipped: string[];
  totals: { wallMs?: number };
}

function epoch(iso: string | undefined): number | undefined {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function ranAgent(step: RunRecapStep): boolean {
  return Boolean(step.model) || (step.models?.length ?? 0) > 0 || (step.costUsd ?? 0) > 0;
}

/**
 * The Run tab's timeline, from the recap (steps, cost) and the step view
 * (when each step started and finished).
 *
 * The span is the recap's first-to-last write; when the snapshot does not carry
 * it, the earliest start and latest finish of the steps stand in. A step's bar
 * is its wall time.
 */
export function timelineLanes(steps: RunStepsView | null, recap: RunRecap): RunTimeline {
  const times = new Map((steps?.steps ?? []).map((step) => [step.id, step]));
  const starts = [...times.values()].map((step) => epoch(step.startedAt)).filter((t) => t !== undefined);
  const ends = [...times.values()].map((step) => epoch(step.finishedAt)).filter((t) => t !== undefined);
  const start = epoch(recap.startedAt) ?? (starts.length ? Math.min(...starts) : undefined);
  const end = epoch(recap.endedAt) ?? (ends.length ? Math.max(...ends) : undefined);
  const spanMs = start !== undefined && end !== undefined && end > start ? end - start : 0;
  const pct = (at: number): number => (start !== undefined && spanMs > 0 ? clampPct(((at - start) / spanMs) * 100) : 0);

  const lanes: RunTimelineLane[] = [];
  const ticks: number[] = [];
  const skipped: string[] = [];
  let shortCount = 0;

  for (const step of recap.steps) {
    if (step.status === "skipped") {
      skipped.push(step.id);
      continue;
    }
    const view = times.get(step.id);
    const from = epoch(view?.startedAt);
    const to = epoch(view?.finishedAt) ?? (step.status === "running" && spanMs > 0 ? end : undefined);

    if (!isNotable(step) && step.status !== "running") {
      shortCount += 1;
      if (from !== undefined && spanMs > 0) ticks.push(pct(from));
      continue;
    }

    const lane: RunTimelineLane = { step, agent: ranAgent(step) };
    if (from !== undefined && to !== undefined && to >= from) lane.wallMs = to - from;
    if (from !== undefined && to !== undefined && to >= from && spanMs > 0) {
      const width = Math.max(pct(to) - pct(from), MIN_BAR_PCT);
      lane.bar = { left: Math.min(pct(from), 100 - width), width };
    }
    lanes.push(lane);
  }

  return {
    ...(start !== undefined && spanMs > 0 ? { startMs: start } : {}),
    spanMs,
    lanes,
    short: { count: shortCount, ticks },
    skipped,
    totals: spanMs > 0 ? { wallMs: spanMs } : {},
  };
}

/** Label of spend no step recorded a model for. */
const UNKNOWN_MODEL = "unknown";

/**
 * What each model cost over the run, costliest first: a step's own model, and
 * the split the read model computed for a node composing pipelines. A model
 * that no step priced keeps an absent `costUsd` rather than a claimed zero.
 */
export function costByModel(recap: RunRecap): { model: string; costUsd?: number }[] {
  const costs = new Map<string, number | undefined>();
  const add = (model: string, cost: number | undefined): void => {
    const previous = costs.get(model);
    costs.set(model, typeof cost === "number" ? (previous ?? 0) + cost : previous);
  };
  for (const step of recap.steps) {
    if (step.models?.length) for (const split of step.models) add(split.model, split.costUsd);
    else if (step.model) add(step.model, step.costUsd);
    else if ((step.costUsd ?? 0) > 0) add(UNKNOWN_MODEL, step.costUsd);
  }
  return [...costs]
    .map(([model, costUsd]) => ({ model, ...(costUsd !== undefined ? { costUsd } : {}) }))
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
}
