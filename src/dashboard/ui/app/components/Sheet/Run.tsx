// The Run tab: where the time and the money of a run went.
//
// A quiet summary (`RunSummary.tsx`), the run's invocations and the waits
// between them as one thin strip, then the timeline of every attempt
// (`RunTimeline.tsx`). The attempts and pauses come from the journal on their
// own query, mounted only while this tab is shown; the totals come from the
// recap and the item, which translate the runner's ledger, so the cost on screen
// is the one the budget was enforced against. The layout is `buildTimeline`, a
// pure function; these files only draw it.

import { useQuery } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { runJourneyQuery } from "../../api/queries.js";
import type { Item, RunRecap, RunStepsView, WorkItemTree } from "../../api/types.js";
import { fmtClock, fmtDuration } from "../../lib/format.js";
import { failedBeforeRun } from "../../lib/items.js";
import { buildTimeline, type RunEpisode, type RunTimeline } from "../../lib/run-timeline.js";
import { Callout, LaunchFailureCallout } from "./Callout.js";
import { showsDecision } from "./Decision.js";
import styles from "./Run.module.css";
import { RunSummary } from "./RunSummary.js";
import { type EpisodeHighlight, RunTimelineCard } from "./RunTimeline.js";
import { Screenshots } from "./Screenshots.js";
import { Steps } from "./Steps.js";

const OUTCOME: Record<Item["status"], string> = {
  PASS: "passed",
  FAIL: "failed",
  ABORTED: "aborted",
  STOPPED: "stopped",
  RUNNING: "running",
};

function iso(timeline: RunTimeline, at: number): string {
  return new Date(timeline.startMs + at).toISOString();
}

function episodeTitle(episode: RunEpisode): string {
  const length = fmtDuration(episode.to - episode.from);
  if (episode.kind === "pause") return `Wait · ${length}`;
  return `${episode.index === 0 ? "Initial run" : `Resume ${episode.index}`} · ${length}`;
}

interface EpisodeStoryProps {
  item: Item;
  timeline: RunTimeline;
  episode: RunEpisode;
  previous: RunEpisode | undefined;
  next: RunEpisode | undefined;
}

/** How a stretch began and ended: the decision that resumed it, and the stop
 *  or the outcome that closed it. */
function EpisodeStory({ item, timeline, episode, previous, next }: EpisodeStoryProps): JSX.Element {
  if (episode.kind === "pause") return <span>{episode.pause.reason ?? "runner exited"}</span>;
  const decision = previous?.kind === "pause" ? previous.pause.decision : undefined;
  let opened: JSX.Element | null = null;
  if (episode.index > 0 && decision) {
    opened = <span className={decision === "approved" ? styles.ok : styles.warn}>{`${decision}, `}</span>;
  } else if (episode.index > 0) {
    opened = <span className={styles.warn}>resumed without a decision, </span>;
  }
  const waiting = episode.last ? timeline.waiting : undefined;
  let closed: JSX.Element;
  if (next?.kind === "pause") closed = <span>{`stopped: ${next.pause.reason ?? "runner exited"}`}</span>;
  else if (waiting) closed = <span>{`stopped: ${waiting.reason ?? "waiting"}`}</span>;
  else closed = <span className={item.status === "PASS" ? styles.ok : ""}>{OUTCOME[item.status]}</span>;
  return (
    <span>
      {opened}
      {closed}
    </span>
  );
}

interface JourneyProps {
  item: Item;
  timeline: RunTimeline;
  onHighlight: (highlight: EpisodeHighlight | null) => void;
}

/** The run's invocations and the waits between them, each as wide as the time
 *  it took. A run that ran in one go has nothing to show here. */
function Journey({ item, timeline, onHighlight }: JourneyProps): JSX.Element | null {
  const { episodes, waiting } = timeline;
  if (episodes.length < 2 && !waiting) return null;
  return (
    <ol className={styles.journey} aria-label="Run episodes">
      {episodes.map((episode, index) => {
        const open = episode.kind === "run" && episode.last && (timeline.live || waiting !== undefined);
        const span = `${fmtClock(iso(timeline, episode.from))} → ${open ? "…" : fmtClock(iso(timeline, episode.to))}`;
        return (
          <li
            key={`${episode.kind}-${episode.from}`}
            className={episode.kind === "pause" ? `${styles.episode} ${styles.pause}` : styles.episode}
            style={{ flexGrow: Math.max(episode.to - episode.from, 1) }}
            onPointerEnter={() => onHighlight({ kind: episode.kind, from: episode.from, to: episode.to })}
            onPointerLeave={() => onHighlight(null)}
          >
            <span className={styles.segment} />
            <b>{episodeTitle(episode)}</b>
            <span>{span}</span>
            <EpisodeStory
              item={item}
              timeline={timeline}
              episode={episode}
              previous={episodes[index - 1]}
              next={episodes[index + 1]}
            />
          </li>
        );
      })}
      {waiting ? (
        <li className={`${styles.episode} ${styles.pause} ${styles.waiting}`}>
          <span className={styles.segment} />
          <b>Waiting</b>
          <span>{`since ${fmtClock(waiting.stoppedAt)}`}</span>
          <span>{waiting.reason ?? ""}</span>
        </li>
      ) : null}
    </ol>
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
  const { data: journey, dataUpdatedAt } = useQuery(runJourneyQuery(item));
  // Hover state of this tab alone: nothing else reads it, and a poll that
  // repaints the tab keeps it.
  const [highlight, setHighlight] = useState<EpisodeHighlight | null>(null);
  // A live run ends at the last poll, not at the render: the tab redraws on
  // each poll, and a clock read during render would make it impure.
  const timeline = journey ? buildTimeline(journey, recap, dataUpdatedAt) : null;
  const ran = timeline !== null && timeline.attempts > 0;
  // A launch that died before its run has no step to list: its box says it all.
  const stepless = !ran && failedBeforeRun(item);
  return (
    <div className={styles.run}>
      <LaunchFailureCallout item={item} />
      {showsDecision(item) ? null : <Callout item={item} includeActions={false} />}
      {journey && timeline && ran ? (
        <>
          <RunSummary item={item} recap={recap} journey={journey} timeline={timeline} />
          <Journey item={item} timeline={timeline} onHighlight={setHighlight} />
          <RunTimelineCard item={item} recap={recap} timeline={timeline} highlight={highlight} />
        </>
      ) : stepless ? null : (
        <Steps steps={steps} />
      )}
      <Screenshots item={item} tree={tree} />
    </div>
  );
}
