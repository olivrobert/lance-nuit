// The top of the Run tab: how the run ended, three facts, and what a reader
// should take away from it.
//
// The facts are the ledger's (the item's cost, the recap's tokens) and the
// journey's (time, attempts); the takeaways are `takeaways`, a pure function.
// Nothing here is a card: the timeline below is the one block that needs a
// frame.

import type { JSX } from "react";
import type { Item, RunJourney, RunRecap } from "../../api/types.js";
import { fmtClock, fmtCost, fmtDuration, fmtModel } from "../../lib/format.js";
import { type RunTimeline, type Takeaway, takeaways } from "../../lib/run-timeline.js";
import styles from "./RunSummary.module.css";

const HEADLINE: Record<Item["status"], string> = {
  PASS: "Passed",
  FAIL: "Failed",
  ABORTED: "Aborted",
  STOPPED: "Stopped",
  RUNNING: "Running",
};

function percent(share: number): string {
  return `${Math.round(share * 100)} %`;
}

function Headline({ item, timeline }: { item: Item; timeline: RunTimeline }): JSX.Element {
  const started = new Date(timeline.startMs).toISOString();
  const ended = new Date(timeline.startMs + timeline.endMs).toISOString();
  const running = timeline.steps.find((step) => step.running);
  const when = timeline.live
    ? `started ${fmtClock(started)}`
    : `ended ${fmtClock(ended)}, started ${fmtClock(started)}`;
  return (
    <p className={styles.headline}>
      <span className={`${styles.state} ${styles[item.status]}`}>
        <i />
        {running ? `Running ${running.id}` : HEADLINE[item.status]}
      </span>
      <span>{when}</span>
    </p>
  );
}

function CostFact({ item, recap, journey }: { item: Item; recap: RunRecap | null; journey: RunJourney }): JSX.Element {
  const budget = journey.maxCostUsd;
  const spent = item.cost?.usd;
  const tokens = recap?.tokens;
  const tokensIn = tokens ? tokens.input + tokens.cacheRead + tokens.cacheWrite : 0;
  const notes = [
    budget && typeof spent === "number" ? `${percent(spent / budget)} of the budget` : "",
    item.cost?.unknown ? "a floor: some spend could not be priced" : "",
    item.cost?.estimated ? "estimated from rate tables" : "",
    tokens && tokensIn > 0 ? `${percent(tokens.cacheRead / tokensIn)} of input from cache` : "",
  ].filter(Boolean);
  return (
    <div>
      <dt>Cost</dt>
      <dd>
        {fmtCost(item.cost)}
        {budget ? <small>{` / ${budget} $`}</small> : null}
      </dd>
      {budget && typeof spent === "number" ? (
        <div className={styles.meter}>
          <span style={{ transform: `scaleX(${Math.min(spent / budget, 1)})` }} />
        </div>
      ) : null}
      {notes.length > 0 ? <p>{notes.join(", ")}</p> : null}
    </div>
  );
}

function modelCounts(timeline: RunTimeline): string {
  const counts = new Map<string, number>();
  for (const step of [...timeline.steps, ...timeline.minor]) {
    for (const { attempt } of step.attempts) {
      if (attempt.model) counts.set(attempt.model, (counts.get(attempt.model) ?? 0) + 1);
    }
  }
  return [...counts].map(([model, count]) => `${fmtModel(model)} ×${count}`).join(", ");
}

interface FactsProps {
  item: Item;
  recap: RunRecap | null;
  journey: RunJourney;
  timeline: RunTimeline;
}

function Facts({ item, recap, journey, timeline }: FactsProps): JSX.Element {
  const stepCount = timeline.steps.length + timeline.minor.length;
  const models = modelCounts(timeline);
  return (
    <dl className={styles.facts}>
      <div>
        <dt>Duration</dt>
        <dd>{`${fmtDuration(timeline.endMs)}${timeline.live ? "…" : ""}`}</dd>
        <p>{timeline.waitMs > 0 ? `incl. ${fmtDuration(timeline.waitMs)} waiting on a human` : "no human wait"}</p>
      </div>
      <CostFact item={item} recap={recap} journey={journey} />
      <div>
        <dt>Attempts</dt>
        <dd>
          {timeline.attempts}
          <small>{` over ${stepCount} ${stepCount === 1 ? "step" : "steps"}`}</small>
        </dd>
        {models ? <p>{models}</p> : null}
      </div>
    </dl>
  );
}

function listed(ids: string[], limit = 3): string {
  return ids.length > limit ? `${ids.slice(0, limit).join(", ")}…` : ids.join(", ");
}

function TakeawayLine({ takeaway }: { takeaway: Takeaway }): JSX.Element {
  switch (takeaway.kind) {
    case "longest":
      return (
        <li>
          <span aria-hidden="true">⏱</span>
          <span>
            <b>{takeaway.stepId}</b>
            {` took ${percent(takeaway.share)} of the work: ${fmtDuration(takeaway.workMs)}${takeaway.passes > 1 ? ` over ${takeaway.passes} passes` : ""}`}
          </span>
        </li>
      );
    case "priciest":
      return (
        <li>
          <span aria-hidden="true">$</span>
          <span>
            <b>{takeaway.stepId}</b>
            {` took ${percent(takeaway.share)} of the cost: ${fmtCost({ usd: takeaway.costUsd, estimated: false })}${takeaway.model ? ` on ${fmtModel(takeaway.model)}` : ""}`}
          </span>
        </li>
      );
    case "replayed":
      return (
        <li>
          <span aria-hidden="true">↻</span>
          <span>
            <b>{fmtDuration(takeaway.workMs)}</b>
            {` replaying ${takeaway.stepIds.length === 1 ? "a step" : `${takeaway.stepIds.length} steps`} that had passed (${listed(takeaway.stepIds)})`}
          </span>
        </li>
      );
    case "refused":
      return (
        <li className={styles.bad}>
          <span aria-hidden="true">✕</span>
          <span>
            <b>{`${takeaway.count} ${takeaway.count === 1 ? "refusal" : "refusals"}`}</b>
            {` on ${listed(takeaway.stepIds)}`}
          </span>
        </li>
      );
  }
}

export interface RunSummaryProps {
  item: Item;
  recap: RunRecap | null;
  journey: RunJourney;
  timeline: RunTimeline;
}

export function RunSummary({ item, recap, journey, timeline }: RunSummaryProps): JSX.Element {
  const found = takeaways(timeline, item.cost?.usd);
  return (
    <section className={styles.summary} aria-label="Run summary">
      <Headline item={item} timeline={timeline} />
      <div className={styles.overview}>
        <Facts item={item} recap={recap} journey={journey} timeline={timeline} />
        {found.length > 0 ? (
          <div>
            <h3 className={styles.notesTitle}>Takeaways</h3>
            <ul className={styles.notes}>
              {found.map((takeaway) => (
                <TakeawayLine key={takeaway.kind} takeaway={takeaway} />
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
