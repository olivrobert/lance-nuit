// The Run tab's timeline: one lane per step that took time, money or a
// refusal, every attempt a bar on a shared axis, the waits between invocations
// as cream columns.
//
// The waits usually dwarf the work, so by default the axis compresses them to
// a narrow column; the reader can switch to wall-clock time. A bar opens its
// attempt in the lane's panel (`StepPanel.tsx`); the step's name opens its last
// attempt and is the keyboard path to the same panel.

import { type CSSProperties, type JSX, type PointerEvent, useRef, useState } from "react";
import type { Item, RunRecap, RunRecapStep } from "../../api/types.js";
import { fmtClock, fmtCost, fmtDuration, fmtModel } from "../../lib/format.js";
import {
  type AttemptTone,
  MIN_BAR_PCT,
  placeSpan,
  type RunEpisode,
  type RunTimeline,
  type TimelineAttempt,
  type TimelineStep,
  type TimeScale,
  timeScale,
} from "../../lib/run-timeline.js";
import { type OpenStep, openStepOf, setOpenStep, useUi } from "../../store/ui-store.js";
import styles from "./RunTimeline.module.css";
import { StepPanel } from "./StepPanel.js";

/** A stretch of the run the reader points at in the strip, found again on the
 *  timeline. */
export interface EpisodeHighlight {
  kind: RunEpisode["kind"];
  from: number;
  to: number;
}

const TONE_LABEL: Record<Exclude<AttemptTone, "agent">, string> = {
  "other-model": "other model",
  command: "command",
  replay: "replay of a passed step",
  fail: "refused",
  running: "running",
};

const GRID_LINES = [25, 50, 75];

/** Gap between the pointer and the tooltip, and the tooltip's widest. */
const TIP_OFFSET = 14;
const TIP_WIDTH = 300;

function iso(timeline: RunTimeline, at: number): string {
  return new Date(timeline.startMs + at).toISOString();
}

/** A span of the track as the custom properties its transform reads. */
function spanStyle(scale: TimeScale, from: number, to: number, minPct = 0, index = 0): CSSProperties {
  const { left, width } = placeSpan(scale, from, to, minPct);
  return { "--l": left, "--s": width / 100, "--i": index } as CSSProperties;
}

function stepCost(step: TimelineStep, ledger: RunRecapStep | undefined): string {
  if (step.costUsd === 0 && !ledger?.costUnknown) return "—";
  return fmtCost({
    usd: step.costUsd,
    estimated: ledger?.costEstimated === true,
    ...(ledger?.costUnknown ? { unknown: true } : {}),
  });
}

function failedStep(item: Item, timeline: RunTimeline): OpenStep | null {
  if (item.group !== "failure") return null;
  const failed = timeline.steps.filter((step) => step.attempts.at(-1)?.tone === "fail");
  const step = failed.find((entry) => entry.id === item.failure?.phase) ?? failed.at(-1);
  return step ? { stepId: step.id } : null;
}

interface Tip {
  stepId: string;
  entry: TimelineAttempt;
}

function TipBody({ timeline, tip }: { timeline: RunTimeline; tip: Tip }): JSX.Element {
  const { attempt, from, to, tone } = tip.entry;
  const cost = typeof attempt.costUsd === "number" ? fmtCost({ usd: attempt.costUsd, estimated: false }) : "";
  const figures = [fmtDuration(to - from), cost, attempt.model ? fmtModel(attempt.model) : ""].filter(Boolean);
  const kind = attempt.kind === "fix" ? ", fix pass" : "";
  return (
    <>
      <b>{`${tip.stepId} · attempt ${attempt.attempt}${kind}`}</b>
      <br />
      {`${fmtClock(iso(timeline, from))} → ${tone === "running" ? "now" : fmtClock(iso(timeline, to))}`}
      <br />
      {figures.join(" · ")}
      {attempt.reason ? (
        <>
          <br />
          <span className={styles.tipReason}>{attempt.reason}</span>
        </>
      ) : null}
    </>
  );
}

interface AxisProps {
  timeline: RunTimeline;
  scale: TimeScale;
}

function Axis({ timeline, scale }: AxisProps): JSX.Element {
  return (
    <div className={`${styles.cell} ${styles.axis}`}>
      {scale.pauses.map(({ pause, x0, x1 }) => (
        <span key={`pause-${pause.from}`} className={styles.pauseLabel} style={{ left: `${(x0 + x1) / 2}%` }}>
          {`⏸ ${fmtDuration(pause.to - pause.from)}`}
        </span>
      ))}
      {scale.labels.map((label) => {
        let edge = "";
        if (label.x < 1) edge = styles.start ?? "";
        else if (label.x > 99) edge = styles.end ?? "";
        const text = timeline.live && label.at === timeline.endMs ? "now" : fmtClock(iso(timeline, label.at));
        return (
          <span key={label.at} className={`${styles.label} ${edge}`} style={{ left: `${label.x}%` }}>
            {text}
          </span>
        );
      })}
    </div>
  );
}

interface TrackProps {
  timeline: RunTimeline;
  scale: TimeScale;
  highlight: EpisodeHighlight | null;
  children: JSX.Element[];
}

/** What every lane draws behind its bars: the grid, the waits, the stretch the
 *  reader points at in the episode strip, and now. */
function Track({ timeline, scale, highlight, children }: TrackProps): JSX.Element {
  const band = highlight?.kind === "run" ? spanStyle(scale, highlight.from, highlight.to) : null;
  return (
    <div className={styles.track}>
      {GRID_LINES.map((x) => (
        <span key={x} className={styles.grid} style={{ left: `${x}%` }} />
      ))}
      {scale.pauses.map(({ pause, x0, x1 }) => {
        const lit = highlight?.kind === "pause" && highlight.from === pause.from;
        return (
          <span
            key={`pause-${pause.from}`}
            className={`${styles.span} ${styles.pauseColumn} ${lit ? styles.lit : ""}`}
            style={{ "--l": x0, "--s": (x1 - x0) / 100 } as CSSProperties}
          />
        );
      })}
      {band ? <span className={`${styles.span} ${styles.band}`} style={band} /> : null}
      {children}
      {timeline.live ? <span className={styles.now} /> : null}
    </div>
  );
}

interface LaneProps {
  item: Item;
  timeline: RunTimeline;
  scale: TimeScale;
  step: TimelineStep;
  ledger: RunRecapStep | undefined;
  open: OpenStep | null;
  highlight: EpisodeHighlight | null;
  firstBar: number;
  onTip: (tip: Tip | null) => void;
}

function Lane({ item, timeline, scale, step, ledger, open, highlight, firstBar, onTip }: LaneProps): JSX.Element {
  const opened = open?.stepId === step.id;
  const meta = [step.model ? fmtModel(step.model) : "command"];
  if (step.attempts.length > 1) meta.push(`${step.passes} ${step.passes === 1 ? "pass" : "passes"}`);
  return (
    <div className={`${styles.row} ${styles.lane} ${opened ? styles.opened : ""}`}>
      <div className={styles.cell}>
        <button
          type="button"
          className={styles.name}
          aria-expanded={opened}
          onClick={() => setOpenStep(item.key, opened ? null : { stepId: step.id })}
        >
          <code>{step.id}</code>
          <small>
            {meta.join(" · ")}
            {step.fails > 0 ? <span className={styles.bad}>{` · ${step.fails} refused`}</span> : null}
          </small>
        </button>
      </div>
      <div className={`${styles.cell} ${styles.trackCell}`}>
        <Track timeline={timeline} scale={scale} highlight={highlight}>
          {step.attempts.map((entry, index) => (
            // Pointer only: the step's name is the keyboard path to its attempts.
            // biome-ignore lint/a11y/noStaticElementInteractions: a mouse shortcut to the panel the name button opens
            // biome-ignore lint/a11y/useKeyWithClickEvents: same
            <span
              key={entry.attempt.attempt}
              className={`${styles.span} ${styles.bar} ${styles[entry.tone] ?? ""}`}
              style={spanStyle(scale, entry.from, entry.to, MIN_BAR_PCT, firstBar + index)}
              onPointerEnter={() => onTip({ stepId: step.id, entry })}
              onPointerLeave={() => onTip(null)}
              onClick={() => setOpenStep(item.key, { stepId: step.id, attempt: entry.attempt.attempt })}
            />
          ))}
        </Track>
      </div>
      <div className={`${styles.cell} ${styles.num}`}>{`${fmtDuration(step.workMs)}${step.running ? "…" : ""}`}</div>
      <div className={`${styles.cell} ${styles.num}`}>{stepCost(step, ledger)}</div>
      {opened && open ? (
        <div className={styles.detail}>
          <StepPanel item={item} stepId={step.id} {...(open.attempt !== undefined ? { attempt: open.attempt } : {})} />
        </div>
      ) : null}
    </div>
  );
}

interface MinorRowProps {
  item: Item;
  timeline: RunTimeline;
  scale: TimeScale;
  open: OpenStep | null;
  highlight: EpisodeHighlight | null;
  onTip: (tip: Tip | null) => void;
}

/** The steps under a second, as dots on one shared row: there, but out of the
 *  way of the steps that took the time. */
function MinorRow({ item, timeline, scale, open, highlight, onTip }: MinorRowProps): JSX.Element {
  const { minor } = timeline;
  const opened = minor.find((step) => step.id === open?.stepId);
  const dots = minor.flatMap((step) => step.attempts.map((entry) => ({ step, entry })));
  return (
    <div className={`${styles.row} ${styles.minor}`}>
      <div className={styles.cell}>
        <span className={styles.name}>
          <code>{`${minor.length} short ${minor.length === 1 ? "step" : "steps"}`}</code>
          <small>under a second each</small>
        </span>
      </div>
      <div className={`${styles.cell} ${styles.trackCell}`}>
        <Track timeline={timeline} scale={scale} highlight={highlight}>
          {dots.map(({ step, entry }) => (
            // biome-ignore lint/a11y/noStaticElementInteractions: a mouse shortcut, see `Lane`
            // biome-ignore lint/a11y/useKeyWithClickEvents: same
            <span
              key={`${step.id}-${entry.attempt.attempt}`}
              className={`${styles.span} ${styles.dot}`}
              style={{ "--l": scale.pct(entry.from) } as CSSProperties}
              onPointerEnter={() => onTip({ stepId: step.id, entry })}
              onPointerLeave={() => onTip(null)}
              onClick={() => setOpenStep(item.key, { stepId: step.id, attempt: entry.attempt.attempt })}
            />
          ))}
        </Track>
      </div>
      <div className={`${styles.cell} ${styles.num}`} />
      <div className={`${styles.cell} ${styles.num}`} />
      {opened && open ? (
        <div className={styles.detail}>
          <StepPanel
            item={item}
            stepId={opened.id}
            {...(open.attempt !== undefined ? { attempt: open.attempt } : {})}
          />
        </div>
      ) : null}
    </div>
  );
}

function Legend({ timeline }: { timeline: RunTimeline }): JSX.Element {
  const tones = new Set(timeline.steps.flatMap((step) => step.attempts.map((entry) => entry.tone)));
  const shown = (["agent", "other-model", "command", "replay", "fail", "running"] as const).filter((tone) =>
    tones.has(tone),
  );
  return (
    <div className={styles.legend}>
      {shown.map((tone) => (
        <span key={tone}>
          <i className={styles[tone]} />
          {tone === "agent" ? fmtModel(timeline.mainModel ?? "agent") : TONE_LABEL[tone]}
        </span>
      ))}
      {timeline.pauses.length > 0 ? (
        <span>
          <i className={styles.pauseSwatch} />
          waiting on a human
        </span>
      ) : null}
    </div>
  );
}

export interface RunTimelineCardProps {
  item: Item;
  recap: RunRecap | null;
  timeline: RunTimeline;
  highlight: EpisodeHighlight | null;
}

export function RunTimelineCard({ item, recap, timeline, highlight }: RunTimelineCardProps): JSX.Element {
  // Screen state of this card alone: the axis mode and the hovered attempt.
  const [compressed, setCompressed] = useState(true);
  const [tip, setTip] = useState<Tip | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const chosen = useUi((state) => openStepOf(state, item.key));
  // A failed run opens on the step that failed, until the reader picks another.
  const open = chosen === undefined ? failedStep(item, timeline) : chosen;
  const scale = timeScale(timeline, compressed && timeline.pauses.length > 0);
  const ledger = new Map((recap?.steps ?? []).map((step) => [step.id, step]));

  // The tooltip follows the pointer through its style, not through state: a
  // render per pixel of movement would repaint every lane.
  const follow = (event: PointerEvent<HTMLDivElement>): void => {
    const node = tipRef.current;
    if (!node) return;
    const flip = event.clientX + TIP_OFFSET + TIP_WIDTH > window.innerWidth;
    node.style.left = `${flip ? event.clientX - TIP_OFFSET - TIP_WIDTH : event.clientX + TIP_OFFSET}px`;
    node.style.top = `${event.clientY + TIP_OFFSET}px`;
  };

  // Where each lane's bars start in the run's count, for the staggered intro.
  const firstBars = timeline.steps.map((_, index) =>
    timeline.steps.slice(0, index).reduce((sum, step) => sum + step.attempts.length, 0),
  );
  const lanes = timeline.steps.map((step, index) => (
    <Lane
      key={step.id}
      item={item}
      timeline={timeline}
      scale={scale}
      step={step}
      ledger={ledger.get(step.id)}
      open={open}
      highlight={highlight}
      firstBar={firstBars[index] ?? 0}
      onTip={setTip}
    />
  ));

  return (
    <section className={styles.card} aria-label="Steps timeline">
      <header className={styles.toolbar}>
        <h2>Steps</h2>
        {timeline.pauses.length > 0 ? (
          <fieldset className={styles.segmented} aria-label="Time axis">
            <button type="button" aria-pressed={compressed} onClick={() => setCompressed(true)}>
              Waits compressed
            </button>
            <button type="button" aria-pressed={!compressed} onClick={() => setCompressed(false)}>
              Real time
            </button>
          </fieldset>
        ) : null}
      </header>
      <div className={styles.scroll} onPointerMove={follow}>
        <div className={styles.table}>
          <div className={`${styles.row} ${styles.head}`}>
            <div className={styles.cell}>Step</div>
            <Axis timeline={timeline} scale={scale} />
            <div className={`${styles.cell} ${styles.num}`}>Duration</div>
            <div className={`${styles.cell} ${styles.num}`}>Cost</div>
          </div>
          {lanes}
          {timeline.minor.length > 0 ? (
            <MinorRow item={item} timeline={timeline} scale={scale} open={open} highlight={highlight} onTip={setTip} />
          ) : null}
        </div>
      </div>
      <footer className={styles.foot}>
        <Legend timeline={timeline} />
        {timeline.skipped.length > 0 ? (
          <span>{`${timeline.skipped.length} skipped: ${timeline.skipped.join(", ")}`}</span>
        ) : null}
      </footer>
      <div ref={tipRef} className={styles.tip} role="tooltip" hidden={tip === null}>
        {tip ? <TipBody timeline={timeline} tip={tip} /> : null}
      </div>
    </section>
  );
}
