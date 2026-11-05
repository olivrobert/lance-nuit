// Where the time and the money of a run went, laid out for the Run tab.
//
// Everything here is a pure function of the run's journey (every attempt and
// pause, from the journal) and its recap (step order and the ledger's costs).
// Times are milliseconds from the run's start, positions percentages of the
// track: nothing here knows about pixels or clocks.

import type { RunJourney, RunJourneyAttempt, RunPause, RunRecap } from "../api/types.js";

/** Under this, a step is plumbing — a gate, a guard, a copy — and giving it a
 *  lane of its own would bury the steps that actually took the time. */
export const NOTABLE_MS = 1000;

/** Width a compressed pause takes, as a share of the run's working time: wide
 *  enough to read as a pause and carry its label, narrow enough that a night of
 *  waiting does not squeeze the work into a corner. */
const PAUSE_SHARE = 0.09;

/** Narrowest bar drawn, in % of the track: a 2-second command of a 3-hour run
 *  is still a mark. */
export const MIN_BAR_PCT = 0.6;

/** Closest two axis labels may sit, in % of the track. */
const LABEL_GAP_PCT = 9;

/** Clock steps an axis tick may take, in minutes. */
const TICK_MINUTES = [1, 2, 5, 10, 15, 30, 60, 120, 240, 480];

/** How an attempt is drawn: the run's main model, another model, a command, a
 *  replay of a step that had already passed, a refusal, or still running. */
export type AttemptTone = "agent" | "other-model" | "command" | "replay" | "fail" | "running";

export interface TimelineAttempt {
  attempt: RunJourneyAttempt;
  from: number;
  to: number;
  tone: AttemptTone;
}

export interface TimelineStep {
  id: string;
  attempts: TimelineAttempt[];
  /** Time spent in its attempts, waits excluded. */
  workMs: number;
  /** The ledger's figure when the recap has one, the attempts' sum otherwise. */
  costUsd: number;
  model?: string;
  /** Attempts that passed, and that were refused. */
  passes: number;
  fails: number;
  running: boolean;
}

export interface TimelinePause {
  pause: RunPause;
  from: number;
  to: number;
}

/** A stretch of the run: one invocation of the runner, or the wait between two. */
export type RunEpisode =
  | { kind: "run"; from: number; to: number; index: number; last: boolean }
  | { kind: "pause"; from: number; to: number; pause: RunPause };

export interface RunTimeline {
  /** Epoch of the run's start, for clocks. */
  startMs: number;
  /** Run span: up to now while the run is live, its last line otherwise. */
  endMs: number;
  live: boolean;
  /** The run's costliest model; the others are drawn in a second tone. */
  mainModel?: string;
  /** Steps that took time, money or a refusal, in pipeline order. */
  steps: TimelineStep[];
  /** The other steps that ran, drawn as dots on one shared row. */
  minor: TimelineStep[];
  skipped: string[];
  /** Closed pauses only: a wait still going is the run's end, not a span. */
  pauses: TimelinePause[];
  /** The wait the run sits in now, when stopped and not resumed. */
  waiting?: RunPause;
  episodes: RunEpisode[];
  attempts: number;
  workMs: number;
  waitMs: number;
}

function epoch(iso: string | undefined): number | undefined {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

function isAgent(attempt: RunJourneyAttempt): boolean {
  return Boolean(attempt.model) || (attempt.costUsd ?? 0) > 0;
}

/** The model that cost the most over the run's attempts. */
function mainModelOf(attempts: RunJourneyAttempt[]): string | undefined {
  const costs = new Map<string, number>();
  for (const attempt of attempts) {
    if (attempt.model) costs.set(attempt.model, (costs.get(attempt.model) ?? 0) + (attempt.costUsd ?? 0));
  }
  return [...costs].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function toneOf(
  attempt: RunJourneyAttempt,
  previous: RunJourneyAttempt | undefined,
  live: boolean,
  main: string | undefined,
): AttemptTone {
  if (attempt.status === "running") return live ? "running" : "fail";
  if (attempt.status === "failed" || attempt.status === "aborted") return "fail";
  // Running a step again after it passed is a resume replaying it, not a fix.
  if (previous?.status === "done") return "replay";
  if (!isAgent(attempt)) return "command";
  return attempt.model && main && attempt.model !== main ? "other-model" : "agent";
}

function episodesOf(pauses: TimelinePause[], endMs: number): RunEpisode[] {
  const episodes: RunEpisode[] = [];
  let from = 0;
  let index = 0;
  for (const entry of pauses) {
    episodes.push({ kind: "run", from, to: entry.from, index, last: false });
    episodes.push({ kind: "pause", from: entry.from, to: entry.to, pause: entry.pause });
    from = entry.to;
    index += 1;
  }
  episodes.push({ kind: "run", from, to: Math.max(endMs, from), index, last: true });
  return episodes;
}

function stepOf(id: string, attempts: TimelineAttempt[], ledgerCost: number | undefined): TimelineStep {
  const model = attempts.find((entry) => entry.attempt.model)?.attempt.model;
  return {
    id,
    attempts,
    workMs: attempts.reduce((sum, entry) => sum + (entry.to - entry.from), 0),
    costUsd: ledgerCost ?? attempts.reduce((sum, entry) => sum + (entry.attempt.costUsd ?? 0), 0),
    ...(model ? { model } : {}),
    passes: attempts.filter((entry) => entry.attempt.status === "done").length,
    fails: attempts.filter((entry) => entry.tone === "fail").length,
    running: attempts.some((entry) => entry.tone === "running"),
  };
}

function isNotable(step: TimelineStep): boolean {
  return step.workMs >= NOTABLE_MS || step.costUsd > 0 || step.fails > 0 || step.running;
}

/**
 * The Run tab's timeline.
 *
 * The run starts at its snapshot's creation, or its first attempt; it ends
 * `now` while live, at its last attempt or pause otherwise. An attempt with no
 * end is still running in a live run; in a run that is not, its runner died, and
 * it is drawn as a refusal of its known length.
 */
export function buildTimeline(journey: RunJourney, recap: RunRecap | null, now: number): RunTimeline {
  const live = journey.status === "RUNNING";
  const firstStart = journey.attempts.map((entry) => epoch(entry.startedAt)).find((t) => t !== undefined);
  const startMs = epoch(journey.startedAt) ?? firstStart ?? now;
  const at = (iso: string | undefined): number | undefined => {
    const value = epoch(iso);
    return value === undefined ? undefined : Math.max(value - startMs, 0);
  };
  const main = mainModelOf(journey.attempts);

  const byStep = new Map<string, TimelineAttempt[]>();
  let lastEnd = 0;
  for (const attempt of journey.attempts) {
    const from = at(attempt.startedAt);
    if (from === undefined) continue;
    const list = byStep.get(attempt.stepId) ?? [];
    const tone = toneOf(attempt, list.at(-1)?.attempt, live, main);
    const end = at(attempt.finishedAt) ?? (tone === "running" ? now - startMs : from + (attempt.durationMs ?? 0));
    const to = Math.max(end, from);
    list.push({ attempt, from, to, tone });
    byStep.set(attempt.stepId, list);
    lastEnd = Math.max(lastEnd, to);
  }

  const pauses: TimelinePause[] = [];
  let waiting: RunPause | undefined;
  for (const pause of journey.pauses) {
    const from = at(pause.stoppedAt);
    if (from === undefined) continue;
    const to = at(pause.resumedAt);
    if (to === undefined) waiting = pause;
    else if (to > from) pauses.push({ pause, from, to });
    lastEnd = Math.max(lastEnd, to ?? from);
  }
  const endMs = live ? Math.max(now - startMs, lastEnd) : lastEnd;

  const ledger = new Map((recap?.steps ?? []).map((step) => [step.id, step.costUsd]));
  const order = new Set([...(recap?.steps ?? []).map((step) => step.id), ...byStep.keys()]);
  const steps: TimelineStep[] = [];
  const minor: TimelineStep[] = [];
  for (const id of order) {
    const attempts = byStep.get(id);
    if (!attempts) continue;
    const step = stepOf(id, attempts, ledger.get(id));
    (isNotable(step) ? steps : minor).push(step);
  }
  const all = [...steps, ...minor];

  return {
    startMs,
    endMs,
    live,
    ...(main ? { mainModel: main } : {}),
    steps,
    minor,
    skipped: (recap?.steps ?? []).filter((step) => step.status === "skipped").map((step) => step.id),
    pauses,
    ...(waiting ? { waiting } : {}),
    episodes: episodesOf(pauses, endMs),
    attempts: all.reduce((sum, step) => sum + step.attempts.length, 0),
    workMs: all.reduce((sum, step) => sum + step.workMs, 0),
    waitMs: pauses.reduce((sum, entry) => sum + (entry.to - entry.from), 0),
  };
}

/** One stretch of the track: a span of run time drawn over `[x0, x1]` %. */
interface ScaleSegment {
  from: number;
  to: number;
  x0: number;
  x1: number;
  pause?: TimelinePause;
}

export interface AxisLabel {
  /** Position on the track, in %. */
  x: number;
  /** Run time it marks, in ms from the start. */
  at: number;
}

export interface TimeScale {
  /** Position of run time `at` on the track, in %. */
  pct(at: number): number;
  /** Where each pause lands, for its column and its label. */
  pauses: { pause: TimelinePause; x0: number; x1: number }[];
  labels: AxisLabel[];
}

/** A clock step giving at most eight ticks over `spanMs`. */
function tickStep(spanMs: number): number {
  const minutes = TICK_MINUTES.find((step) => spanMs / (step * 60_000) <= 8) ?? 480;
  return minutes * 60_000;
}

function segmentsOf(timeline: RunTimeline, compressed: boolean): ScaleSegment[] {
  const { endMs, pauses } = timeline;
  const pauseWidth = Math.max((endMs - timeline.waitMs) * PAUSE_SHARE, 1);
  const raw: Omit<ScaleSegment, "x0" | "x1">[] = [];
  let cursor = 0;
  for (const entry of pauses) {
    raw.push({ from: cursor, to: entry.from });
    raw.push({ from: entry.from, to: entry.to, pause: entry });
    cursor = entry.to;
  }
  if (endMs > cursor) raw.push({ from: cursor, to: endMs });
  const widthOf = (segment: Omit<ScaleSegment, "x0" | "x1">): number =>
    segment.pause && compressed ? pauseWidth : segment.to - segment.from;
  const total = raw.reduce((sum, segment) => sum + widthOf(segment), 0) || 1;
  let acc = 0;
  return raw.map((segment) => {
    const x0 = (acc / total) * 100;
    acc += widthOf(segment);
    return { ...segment, x0, x1: (acc / total) * 100 };
  });
}

/**
 * The track's scale. Compressed, every pause takes the same small width and the
 * work spreads over the rest; otherwise the track is plain wall-clock time.
 */
export function timeScale(timeline: RunTimeline, compressed: boolean): TimeScale {
  const segments = segmentsOf(timeline, compressed);
  const pct = (at: number): number => {
    if (at <= 0) return 0;
    for (const segment of segments) {
      if (at <= segment.to) {
        const length = segment.to - segment.from || 1;
        return segment.x0 + ((at - segment.from) / length) * (segment.x1 - segment.x0);
      }
    }
    return 100;
  };

  // Ends and pause starts come first, so a regular tick gives way to them.
  const { endMs, startMs } = timeline;
  const step = tickStep(compressed ? endMs - timeline.waitMs : endMs);
  const candidates = [0, endMs, ...timeline.pauses.map((entry) => entry.from)];
  for (let tick = Math.ceil(startMs / step) * step - startMs; tick < endMs; tick += step) {
    const inPause = segments.some((segment) => segment.pause && tick > segment.from && tick < segment.to);
    if (tick > 0 && !inPause) candidates.push(tick);
  }
  const labels: AxisLabel[] = [];
  for (const at of candidates) {
    const x = pct(at);
    if (labels.every((label) => Math.abs(label.x - x) > LABEL_GAP_PCT)) labels.push({ x, at });
  }

  return {
    pct,
    pauses: segments.flatMap((segment) =>
      segment.pause ? [{ pause: segment.pause, x0: segment.x0, x1: segment.x1 }] : [],
    ),
    labels: labels.sort((a, b) => a.x - b.x),
  };
}

/** Where a span `[from, to]` sits on the track: its start and its width, in %. */
export function placeSpan(scale: TimeScale, from: number, to: number, minPct = 0): { left: number; width: number } {
  const left = scale.pct(from);
  return { left, width: Math.max(scale.pct(to) - left, minPct) };
}

/** What a reader should take away from the run, at most one of each kind. */
export type Takeaway =
  | { kind: "longest"; stepId: string; workMs: number; share: number; passes: number }
  | { kind: "priciest"; stepId: string; costUsd: number; share: number; model?: string }
  | { kind: "replayed"; workMs: number; stepIds: string[] }
  | { kind: "refused"; count: number; stepIds: string[] };

function replayedMs(step: TimelineStep): number {
  return step.attempts.filter((entry) => entry.tone === "replay").reduce((sum, e) => sum + e.to - e.from, 0);
}

/**
 * The run's notable facts: the step that took the most work time, the one that
 * cost the most, the time spent replaying steps that had passed, and the
 * refusals. `totalCostUsd` is the ledger's total, which the cost share divides.
 */
export function takeaways(timeline: RunTimeline, totalCostUsd: number | undefined): Takeaway[] {
  const all = [...timeline.steps, ...timeline.minor];
  const found: Takeaway[] = [];

  const longest = [...all].sort((a, b) => b.workMs - a.workMs)[0];
  if (longest && longest.workMs >= NOTABLE_MS) {
    const { id: stepId, workMs, passes } = longest;
    found.push({ kind: "longest", stepId, workMs, share: workMs / timeline.workMs, passes });
  }

  const priciest = [...all].sort((a, b) => b.costUsd - a.costUsd)[0];
  const costTotal = totalCostUsd ?? all.reduce((sum, step) => sum + step.costUsd, 0);
  if (priciest && priciest.costUsd > 0 && costTotal > 0) {
    const { id: stepId, costUsd, model } = priciest;
    found.push({ kind: "priciest", stepId, costUsd, share: costUsd / costTotal, ...(model ? { model } : {}) });
  }

  const replayed = all
    .map((step) => ({ id: step.id, ms: replayedMs(step) }))
    .filter((entry) => entry.ms > 0)
    .sort((a, b) => b.ms - a.ms);
  if (replayed.length > 0) {
    const workMs = replayed.reduce((sum, entry) => sum + entry.ms, 0);
    found.push({ kind: "replayed", workMs, stepIds: replayed.map((entry) => entry.id) });
  }

  const refused = all.filter((step) => step.fails > 0);
  if (refused.length > 0) {
    const count = refused.reduce((sum, step) => sum + step.fails, 0);
    found.push({ kind: "refused", count, stepIds: refused.map((step) => step.id) });
  }
  return found;
}
