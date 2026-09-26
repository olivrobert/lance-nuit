// The ticket table of the stats screen: one row per ticket, its root runs
// unfolded beneath it on demand.
//
// Sorting is the parent's state — the header only reports which column was
// clicked — so the order survives a refresh of the data.

import type { JSX } from "react";
import { Fragment, useState } from "react";
import type { StatsRun, StatsTicket } from "../../api/types.js";
import { cx } from "../../lib/cx.js";
import { fmtCost, fmtDate, fmtDuration, shortRunId } from "../../lib/format.js";
import { nextSort, type StatsColumn, type StatsSort, spanMs } from "../../lib/stats.js";
import { useActions, useUiSelector } from "../../store/store.js";
import { navigate } from "../../store/useRoute.js";
import styles from "./Stats.module.css";

const COLUMNS: ReadonlyArray<{ column: StatsColumn; label: string; numeric?: true; title?: string }> = [
  { column: "project", label: "Project" },
  { column: "ticket", label: "Ticket" },
  { column: "kind", label: "Kind" },
  { column: "cost", label: "Cost", numeric: true },
  { column: "active", label: "Active", numeric: true, title: "Time spent executing steps" },
  { column: "span", label: "Span", numeric: true, title: "First run created to last run updated, pauses included" },
  { column: "runs", label: "Runs", numeric: true },
  {
    column: "outcome",
    label: "Outcome",
    title: "Passed once a run reached the handover; else its most recent delivery run",
  },
  { column: "lastAt", label: "Last run", numeric: true },
];

function Header({ sort, onSort }: { sort: StatsSort; onSort: (sort: StatsSort) => void }): JSX.Element {
  return (
    <thead>
      <tr>
        {COLUMNS.map(({ column, label, numeric, title }) => {
          const active = sort.column === column;
          return (
            <th
              key={column}
              className={cx(numeric && styles.num)}
              aria-sort={active ? (sort.descending ? "descending" : "ascending") : "none"}
            >
              <button
                type="button"
                className={styles.sort}
                title={title}
                onClick={() => onSort(nextSort(sort, column))}
              >
                {label}
                <span className={styles.arrow} aria-hidden="true">
                  {active ? (sort.descending ? "↓" : "↑") : ""}
                </span>
              </button>
            </th>
          );
        })}
      </tr>
    </thead>
  );
}

/** The ticket id: opens the inbox on it when the inbox has it, else the
 *  tracker when the project declares one, else plain text. */
function TicketCell({ ticket }: { ticket: StatsTicket }): JSX.Element {
  const inInbox = useUiSelector((state) => state.items.some((item) => item.key === ticket.key));
  const actions = useActions();
  if (inInbox) {
    return (
      <button
        type="button"
        className={styles.link}
        onClick={() => {
          actions.select(ticket.key);
          navigate({ view: "inbox" });
        }}
      >
        {ticket.ticket}
      </button>
    );
  }
  if (ticket.ticketUrl) {
    return (
      <a href={ticket.ticketUrl} target="_blank" rel="noreferrer">
        {ticket.ticket}
      </a>
    );
  }
  return <span>{ticket.ticket}</span>;
}

function RunRows({ runs }: { runs: StatsRun[] }): JSX.Element {
  return (
    <>
      {runs.map((run) => (
        <tr key={`${run.source}-${run.runId}`} className={cx(styles.run, !run.delivery && styles.aside)}>
          <td />
          <td colSpan={2} className="small">
            <span className="mute">{run.pipeline || "—"}</span> <code>{shortRunId(run.runId)}</code>
            {run.source === "archive" ? <span className="small mute"> · archive</span> : null}
          </td>
          <td className={styles.num}>
            {fmtCost({
              ...(run.costUsd !== undefined ? { usd: run.costUsd } : {}),
              estimated: run.costEstimated === true,
              unknown: run.costUnknown === true,
            })}
          </td>
          <td className={styles.num}>{fmtDuration(run.activeMs)}</td>
          <td />
          <td />
          <td>
            <span className={`tag ${run.status}`}>{run.status}</span>
            {run.handover ? (
              <span className="small mute">{run.handover === "shipped" ? " · shipped" : " · handover failed"}</span>
            ) : null}
          </td>
          <td className={cx(styles.num, "small")}>{fmtDate(run.updatedAt ?? run.createdAt)}</td>
        </tr>
      ))}
    </>
  );
}

export function StatsTable({
  tickets,
  sort,
  onSort,
}: {
  tickets: StatsTicket[];
  sort: StatsSort;
  onSort: (sort: StatsSort) => void;
}): JSX.Element {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  if (tickets.length === 0) return <p className="mute">No ticket matches these filters.</p>;

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <Header sort={sort} onSort={onSort} />
        <tbody>
          {tickets.map((ticket) => {
            const expanded = open.has(ticket.key);
            return (
              <Fragment key={ticket.key}>
                <tr className={cx(styles.row, expanded && styles.expanded)}>
                  <td>
                    <span className="proj">{ticket.project}</span>
                  </td>
                  <td>
                    <TicketCell ticket={ticket} />
                  </td>
                  <td>
                    <span className={cx(styles.kind, styles[ticket.kind])}>{ticket.kind}</span>
                  </td>
                  <td className={styles.num}>
                    {fmtCost({
                      ...(ticket.costUsd !== undefined ? { usd: ticket.costUsd } : {}),
                      estimated: ticket.costEstimated,
                      unknown: ticket.costUnknown,
                    })}
                  </td>
                  <td className={styles.num}>{fmtDuration(ticket.activeMs)}</td>
                  <td className={styles.num}>{fmtDuration(spanMs(ticket))}</td>
                  <td className={styles.num}>
                    <button
                      type="button"
                      className={styles.link}
                      aria-expanded={expanded}
                      title={ticket.pipelines.join(", ")}
                      onClick={() => toggle(ticket.key)}
                    >
                      {ticket.runs.length} {expanded ? "▾" : "▸"}
                    </button>
                  </td>
                  <td>
                    {ticket.outcome ? (
                      <span className={`tag ${ticket.outcome}`}>
                        {ticket.outcome === "UNSHIPPED" ? "not shipped" : ticket.outcome}
                      </span>
                    ) : (
                      <span className="small mute">no delivery</span>
                    )}
                  </td>
                  <td className={cx(styles.num, "small")}>{fmtDate(ticket.lastAt)}</td>
                </tr>
                {expanded ? <RunRows runs={ticket.runs} /> : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
