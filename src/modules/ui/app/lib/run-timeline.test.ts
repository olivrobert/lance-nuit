import { describe, expect, test } from "bun:test";
import type { RunJourney, RunJourneyAttempt, RunRecap, RunRecapStep } from "../api/types.js";
import { buildTimeline, placeSpan, takeaways, timeScale } from "./run-timeline.js";

const T0 = "2026-09-25T14:00:00.000Z";
const MIN = 60_000;
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * MIN).toISOString();

function attempt(stepId: string, from: number, to: number, extra: Partial<RunJourneyAttempt> = {}): RunJourneyAttempt {
  return { stepId, attempt: 1, kind: "step", status: "done", startedAt: at(from), finishedAt: at(to), ...extra };
}

function journeyOf(attempts: RunJourneyAttempt[], overrides: Partial<RunJourney> = {}): RunJourney {
  return {
    pipeline: "feature",
    runId: "run-1",
    status: "PASS",
    startedAt: T0,
    attempts,
    pauses: [],
    ...overrides,
  };
}

function recapOf(steps: RunRecapStep[]): RunRecap {
  return { pipeline: "feature", runId: "run-1", status: "PASS", models: [], steps };
}

/** Ten minutes of work, a two-hour wait for approval, then ten more minutes in
 *  which `static` is replayed although it had passed. */
function gatedRun(): RunJourney {
  return journeyOf(
    [
      attempt("implement", 0, 8, { model: "opus", costUsd: 3 }),
      attempt("static", 8, 10),
      attempt("static", 130, 132, { attempt: 2 }),
      attempt("review", 132, 140, { model: "haiku", costUsd: 0.2 }),
    ],
    { pauses: [{ stoppedAt: at(10), resumedAt: at(130), decision: "approved" }] },
  );
}

describe("buildTimeline", () => {
  test("steps keep the pipeline's order and their own attempts, waits excluded from work", () => {
    const recap = recapOf([
      { id: "implement", status: "done", costUsd: 3.5 },
      { id: "static", status: "done" },
      { id: "review", status: "done" },
      { id: "plan", status: "skipped" },
    ]);
    const timeline = buildTimeline(gatedRun(), recap, Date.parse(at(500)));

    expect(timeline.steps.map((step) => step.id)).toEqual(["implement", "static", "review"]);
    expect(timeline.endMs).toBe(140 * MIN);
    expect(timeline.waitMs).toBe(120 * MIN);
    expect(timeline.workMs).toBe(20 * MIN);
    expect(timeline.attempts).toBe(4);
    expect(timeline.skipped).toEqual(["plan"]);
    // The ledger's figure wins over the attempts' sum.
    expect(timeline.steps[0]?.costUsd).toBe(3.5);
  });

  test("a step run again after it passed is a replay; the costliest model sets the main tone", () => {
    const timeline = buildTimeline(gatedRun(), null, 0);
    const tones = timeline.steps.map((step) => step.attempts.map((entry) => entry.tone));

    expect(timeline.mainModel).toBe("opus");
    expect(tones).toEqual([["agent"], ["command", "replay"], ["other-model"]]);
  });

  test("a refused attempt followed by a fix pass is a refusal, not a replay", () => {
    const journey = journeyOf([
      attempt("tests", 0, 2, { status: "failed", reason: "1 fail" }),
      attempt("tests", 2, 5, { attempt: 2, kind: "fix", model: "opus", costUsd: 1 }),
    ]);
    const [step] = buildTimeline(journey, null, 0).steps;

    expect(step?.attempts.map((entry) => entry.tone)).toEqual(["fail", "agent"]);
    expect(step).toMatchObject({ fails: 1, passes: 1 });
  });

  test("a live run ends now, its open attempt running up to it", () => {
    const journey = journeyOf([attempt("tests", 0, 0, { status: "running", finishedAt: undefined })], {
      status: "RUNNING",
    });
    const timeline = buildTimeline(journey, null, Date.parse(at(7)));

    expect(timeline.endMs).toBe(7 * MIN);
    expect(timeline.steps[0]?.attempts[0]).toMatchObject({ tone: "running", to: 7 * MIN });
  });

  test("an attempt left open by a dead runner is drawn as a refusal of its known length", () => {
    const journey = journeyOf([
      attempt("tests", 0, 0, { status: "running", finishedAt: undefined, durationMs: 3 * MIN }),
    ]);
    const [step] = buildTimeline(journey, null, Date.parse(at(60))).steps;

    expect(step?.attempts[0]).toMatchObject({ tone: "fail", to: 3 * MIN });
  });

  test("steps under a second share one row; a wait still going is not a pause span", () => {
    const journey = journeyOf([attempt("gate", 0, 0), attempt("build", 0, 4)], {
      status: "STOPPED",
      pauses: [{ stoppedAt: at(4), reason: "awaiting approval" }],
    });
    const timeline = buildTimeline(journey, null, Date.parse(at(90)));

    expect(timeline.steps.map((step) => step.id)).toEqual(["build"]);
    expect(timeline.minor.map((step) => step.id)).toEqual(["gate"]);
    expect(timeline.pauses).toEqual([]);
    expect(timeline.waiting?.reason).toBe("awaiting approval");
    expect(timeline.endMs).toBe(4 * MIN);
  });

  test("the run splits into its invocations and the waits between them", () => {
    const timeline = buildTimeline(gatedRun(), null, 0);

    expect(timeline.episodes.map((episode) => [episode.kind, episode.from / MIN, episode.to / MIN])).toEqual([
      ["run", 0, 10],
      ["pause", 10, 130],
      ["run", 130, 140],
    ]);
  });
});

describe("timeScale", () => {
  test("real time places a moment by its share of the span", () => {
    const scale = timeScale(buildTimeline(gatedRun(), null, 0), false);

    expect(scale.pct(70 * MIN)).toBeCloseTo(50);
    expect(scale.pauses[0]?.x0).toBeCloseTo((10 / 140) * 100);
  });

  test("compressed, a pause shrinks to a small share of the work and the work spreads", () => {
    const scale = timeScale(buildTimeline(gatedRun(), null, 0), true);
    const pause = scale.pauses[0];
    const width = (pause?.x1 ?? 0) - (pause?.x0 ?? 0);

    // 20 min of work, the pause takes 9 % of it: 1.8 out of 21.8.
    expect(width).toBeCloseTo((1.8 / 21.8) * 100);
    expect(scale.pct(140 * MIN)).toBe(100);
    expect(placeSpan(scale, 0, 0, 0.6)).toEqual({ left: 0, width: 0.6 });
  });

  test("axis labels never crowd each other and keep both ends", () => {
    const { labels } = timeScale(buildTimeline(gatedRun(), null, 0), true);

    expect(labels[0]?.at).toBe(0);
    expect(labels.at(-1)?.at).toBe(140 * MIN);
    for (let i = 1; i < labels.length; i++) expect((labels[i]?.x ?? 0) - (labels[i - 1]?.x ?? 0)).toBeGreaterThan(9);
  });
});

describe("takeaways", () => {
  test("names the longest and the costliest step, the replayed time and the refusals", () => {
    const journey = gatedRun();
    journey.attempts.push(attempt("tests", 140, 141, { status: "failed" }), attempt("tests", 141, 142, { attempt: 2 }));
    const found = takeaways(buildTimeline(journey, null, 0), 4);

    expect(found).toEqual([
      { kind: "longest", stepId: "implement", workMs: 8 * MIN, share: 8 / 22, passes: 1 },
      { kind: "priciest", stepId: "implement", costUsd: 3, share: 0.75, model: "opus" },
      { kind: "replayed", workMs: 2 * MIN, stepIds: ["static"] },
      { kind: "refused", count: 1, stepIds: ["tests"] },
    ]);
  });
});
