// The identity and verdict of the item, at the top of the sticky header.
//
// Three lines, the same for every group: where the run is (project, ticket,
// pipeline, run, with the way out to the tracker and to the terminal), what it
// is about (the ticket's title), and how it ended. A delivered run says
// "Delivered" and when it finished; any other keeps its status pill and its
// headline, because there the status is the news.
//
// Times are wall clocks in the reader's zone (`fmtClock`), and "took" is the
// span of the run's snapshot: first write to last, pauses included, which is
// how long the reader waited for it.

import type { JSX } from "react";
import type { Item, RunRecap } from "../../api/types.js";
import { headlineOf, isDelivered } from "../../lib/derive.js";
import { fmtClock, fmtCost, fmtDuration, shortRunId } from "../../lib/format.js";
import { linkableUrl } from "../../lib/url.js";
import { ProjectBadge } from "../ProjectBadge.js";
import { StatusTag } from "../StatusTag.js";
import styles from "./Sheet.module.css";
import { TerminalLink } from "./TerminalLink.js";

/** Milliseconds between the first and the last write of the run, or
 *  `undefined` when either is missing or they do not parse. */
function spanMs(recap: RunRecap | null): number | undefined {
  const start = Date.parse(recap?.startedAt ?? "");
  const end = Date.parse(recap?.endedAt ?? "");
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
}

function Breadcrumb({ item }: { item: Item }): JSX.Element {
  const ticketHref = linkableUrl(item.project.ticketUrl);
  return (
    <div className={styles.breadcrumb}>
      <ProjectBadge name={item.project.name} />
      <code>{item.ticket}</code>
      <span>{item.pipeline}</span>
      <span title={item.runId}>{`run ${shortRunId(item.runId)}`}</span>
      <span className="grow" />
      {ticketHref ? (
        <a href={ticketHref} target="_blank" rel="noreferrer">
          Ticket ↗
        </a>
      ) : null}
      <TerminalLink item={item} className={styles.crumbButton} />
    </div>
  );
}

function Verdict({ item, recap }: { item: Item; recap: RunRecap | null }): JSX.Element {
  const delivered = isDelivered(item);
  const running = item.group === "running";
  const took = running ? undefined : spanMs(recap);
  const at = fmtClock(running ? item.updatedAt : (recap?.endedAt ?? item.updatedAt));
  return (
    <div className={styles.verdict}>
      {delivered ? <span className={styles.delivered}>Delivered</span> : <StatusTag item={item} />}
      {delivered ? null : <span className={styles.headline}>{headlineOf(item)}</span>}
      <span>
        {item.group === "done" ? "Finished " : "Updated "}
        <b>{at}</b>
      </span>
      {took === undefined ? null : (
        <span>
          took <b>{fmtDuration(took)}</b>
        </span>
      )}
      <b>{fmtCost(item.cost)}</b>
    </div>
  );
}

export function SheetHeader({ item, recap }: { item: Item; recap: RunRecap | null }): JSX.Element {
  return (
    <>
      <Breadcrumb item={item} />
      <h2 className={styles.title}>{item.title ?? item.ticket}</h2>
      <Verdict item={item} recap={recap} />
    </>
  );
}
