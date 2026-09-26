// The Run tab: where the time and the money of a run went.
//
// Three figures, a timeline of the steps over the run span, and the cost split
// by model. Every figure is read from `RunRecap`, which translates the runner's
// own ledger: nothing here adds a step's cost to another, so the total on
// screen is the one the budget was enforced against. The layout of the
// timeline is `timelineLanes`, a pure function; this file only draws it.

import type { JSX } from "react";
import type { Item, RunRecap, RunRecapStep, RunStepsView, WorkItemTree } from "../../api/types.js";
import { NOTABLE_MS, type RunTimeline, type RunTimelineLane, costByModel, timelineLanes } from "../../lib/derive.js";
import { fmtCost, fmtDuration, fmtTokens } from "../../lib/format.js";
import styles from "./Run.module.css";
import { Screenshots } from "./Screenshots.js";
import { Steps } from "./Steps.js";

/** Local wall-clock time, `HH:MM`: the reader compares it with their morning,
 *  not with the runner's UTC journal. */
function clock(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function percent(part: number, whole: number): string {
  return `${Math.round((part / whole) * 100)} %`;
}

function stepCost(step: RunRecapStep): string {
  if (typeof step.costUsd !== "number" && !step.costUnknown) return "—";
  return fmtCost({
    ...(typeof step.costUsd === "number" ? { usd: step.costUsd } : {}),
    estimated: step.costEstimated === true,
    ...(step.costUnknown ? { unknown: true } : {}),
  });
}

function costNote(item: Item): string {
  if (item.cost?.unknown) return "a floor: some spend could not be priced";
  if (item.cost?.estimated) return "estimated from rate tables";
  return typeof item.cost?.usd === "number" ? "as the providers reported it" : "";
}

function Figures({ item, recap, timeline }: { item: Item; recap: RunRecap; timeline: RunTimeline }): JSX.Element {
  const { wallMs } = timeline.totals;
  const tokens = recap.tokens;
  const tokensIn = tokens ? tokens.input + tokens.cacheRead + tokens.cacheWrite : 0;
  const end = timeline.startMs !== undefined ? timeline.startMs + timeline.spanMs : undefined;
  return (
    <dl className={styles.figures}>
      <div title="From the first to the last write of the run, pauses included">
        <dt>Elapsed</dt>
        <dd>
          {fmtDuration(wallMs)}
          {wallMs !== undefined ? <small>{`${clock(timeline.startMs)} → ${clock(end)}`}</small> : null}
        </dd>
      </div>
      <div>
        <dt>Cost</dt>
        <dd>
          {fmtCost(item.cost)}
          <small>{costNote(item)}</small>
        </dd>
      </div>
      <div
        title={tokens ? `cache read ${fmtTokens(tokens.cacheRead)} · cache write ${fmtTokens(tokens.cacheWrite)}` : ""}
      >
        <dt>Tokens in / out</dt>
        <dd>
          {tokens ? `${fmtTokens(tokensIn)} / ${fmtTokens(tokens.output)}` : "—"}
          {tokens && tokensIn > 0 ? <small>{`${percent(tokens.cacheRead, tokensIn)} read from cache`}</small> : null}
        </dd>
      </div>
    </dl>
  );
}

function Track({ lane }: { lane: RunTimelineLane }): JSX.Element {
  const { bar } = lane;
  const kind = lane.agent ? styles.agent : styles.command;
  const broken = lane.step.status === "failed" || lane.step.status === "aborted" ? styles.broken : "";
  return (
    <div className={styles.track}>
      <span className={styles.axis} />
      {bar ? (
        <span className={`${styles.wall} ${kind} ${broken}`} style={{ left: `${bar.left}%`, width: `${bar.width}%` }} />
      ) : null}
    </div>
  );
}

function AxisLabels({ timeline }: { timeline: RunTimeline }): JSX.Element {
  const start = timeline.startMs;
  return (
    <div className={styles.axisLabels}>
      {start !== undefined
        ? [0, 25, 50, 75, 100].map((at) => (
            <span key={at} style={{ left: `${at}%` }}>
              {clock(start + (timeline.spanMs * at) / 100)}
            </span>
          ))
        : null}
    </div>
  );
}

function TimelineGrid({ item, timeline }: { item: Item; timeline: RunTimeline }): JSX.Element {
  const { short } = timeline;
  return (
    <div className={styles.timelineWrap}>
      <div className={styles.timeline}>
        <div className={styles.hd}>Step</div>
        <div className={styles.hd}>
          <AxisLabels timeline={timeline} />
        </div>
        <div className={`${styles.hd} ${styles.num}`}>Duration</div>
        <div className={`${styles.hd} ${styles.num}`}>Cost</div>
        {timeline.lanes.map((lane) => (
          <Lane key={lane.step.id} lane={lane} />
        ))}
        {short.count > 0 ? (
          <>
            <div className="mute">{`${short.count} short steps`}</div>
            <div>
              <div className={styles.track}>
                <span className={styles.axis} />
                {short.ticks.map((left, index) => (
                  // Ticks carry no identity beyond their position and order.
                  // biome-ignore lint/suspicious/noArrayIndexKey: positions may repeat
                  <span key={index} className={styles.tick} style={{ left: `${left}%` }} />
                ))}
              </div>
            </div>
            <div className={`${styles.num} mute`}>{`< ${fmtDuration(NOTABLE_MS)}`}</div>
            <div className={`${styles.num} mute`}>—</div>
          </>
        ) : null}
        <div>
          <b>Total</b>
        </div>
        <div />
        <div className={styles.num}>
          <b>{fmtDuration(timeline.totals.wallMs)}</b>
        </div>
        <div className={styles.num}>
          <b>{fmtCost(item.cost)}</b>
        </div>
      </div>
    </div>
  );
}

function Lane({ lane }: { lane: RunTimelineLane }): JSX.Element {
  const { step } = lane;
  const broken = step.status === "failed" || step.status === "aborted";
  return (
    <>
      <div className={styles.name} title={step.retries ? `${step.id} · ${step.retries} retries` : step.id}>
        <code className={broken ? styles.brokenText : ""}>{step.id}</code>
        {step.status === "running" ? <span className="small mute">running</span> : null}
      </div>
      <div>
        <Track lane={lane} />
      </div>
      <div className={styles.num}>{fmtDuration(lane.wallMs)}</div>
      <div className={styles.num}>{stepCost(step)}</div>
    </>
  );
}

function Legend({ timeline }: { timeline: RunTimeline }): JSX.Element {
  return (
    <div className={styles.legend}>
      <span>
        <i className={`${styles.agent} ${styles.swatch}`} />
        agent step
      </span>
      <span>
        <i className={`${styles.command} ${styles.swatch}`} />
        command
      </span>
      {timeline.skipped.length > 0 ? (
        <span>
          {`${timeline.skipped.length} skipped: `}
          {timeline.skipped.map((id, index) => (
            <span key={id}>
              {index > 0 ? ", " : ""}
              <code>{id}</code>
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}

function CostByModel({ recap }: { recap: RunRecap }): JSX.Element | null {
  const models = costByModel(recap);
  if (models.length === 0) return null;
  const max = Math.max(...models.map((entry) => entry.costUsd ?? 0), 0);
  return (
    <section>
      <h3 className={styles.heading}>Cost by model</h3>
      <div className={styles.models}>
        {models.map((entry) => (
          <div key={entry.model} className={styles.modelRow}>
            <code>{entry.model}</code>
            <span className={styles.modelBar}>
              {max > 0 && (entry.costUsd ?? 0) > 0 ? (
                <span style={{ width: `${((entry.costUsd ?? 0) / max) * 100}%` }} />
              ) : null}
            </span>
            <span className={styles.num}>
              {typeof entry.costUsd === "number" ? fmtCost({ usd: entry.costUsd, estimated: false }) : "—"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

export interface RunProps {
  item: Item;
  recap: RunRecap | null;
  steps: RunStepsView | null;
  /** Where the screenshot gallery is read from; `null` draws none. */
  tree: WorkItemTree | null;
}

export function Run({ item, recap, steps, tree }: RunProps): JSX.Element {
  const timeline = recap ? timelineLanes(steps, recap) : null;
  return (
    <div className={styles.run}>
      {item.status === "RUNNING" || !recap ? <Steps steps={steps} /> : null}
      {recap && timeline ? (
        <>
          <Figures item={item} recap={recap} timeline={timeline} />
          {timeline.lanes.length > 0 || timeline.short.count > 0 ? (
            <div className={styles.timelineBlock}>
              <TimelineGrid item={item} timeline={timeline} />
              <Legend timeline={timeline} />
            </div>
          ) : (
            <p className="mute small">No step has run yet.</p>
          )}
          <CostByModel recap={recap} />
        </>
      ) : null}
      <Screenshots item={item} tree={tree} />
    </div>
  );
}
