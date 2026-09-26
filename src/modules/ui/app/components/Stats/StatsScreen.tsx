// The stats screen (`#/stats`): what every ticket cost, across every project.
//
// It owns its data rather than going through the store. The figures are read
// once when the screen opens and again on a manual refresh — never by the poll,
// because the server opens every run snapshot of every project to answer — and
// nothing else on the page needs them.
//
// The recap cards, the filter bar and the table all read the same filtered
// list, so the cards always describe exactly the rows on screen.

import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchStats } from "../../api/client.js";
import type { StatsRead, TicketKind } from "../../api/types.js";
import { cx } from "../../lib/cx.js";
import { fmtCost, fmtDate, fmtDuration } from "../../lib/format.js";
import {
  DEFAULT_FILTER,
  DEFAULT_SORT,
  daysAgo,
  filterTickets,
  KINDS,
  type ScopeFilter,
  type SourceFilter,
  type StatsFilter,
  type StatsGroupTotals,
  type StatsSort,
  type StatsTotals,
  sortTickets,
  totalsOf,
} from "../../lib/stats.js";
import styles from "./Stats.module.css";
import { StatsTable } from "./StatsTable.js";

type Load = { status: "loading" } | { status: "error"; error: string } | { status: "ok"; data: StatsRead };

function useStats(): [Load, () => void] {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const refresh = useCallback(() => {
    setLoad((current) => (current.status === "ok" ? current : { status: "loading" }));
    fetchStats()
      .then((result) => {
        if (result.ok && Array.isArray(result.body.tickets) && result.body.archive) {
          setLoad({ status: "ok", data: { tickets: result.body.tickets, archive: result.body.archive } });
        } else {
          setLoad({ status: "error", error: result.body.error ?? `HTTP ${result.status}` });
        }
      })
      .catch((error: unknown) => setLoad({ status: "error", error: String(error) }));
  }, []);
  useEffect(refresh, [refresh]);
  return [load, refresh];
}

interface ChipProps<T> {
  label: string;
  value: T;
  current: T;
  onPick: (value: T) => void;
}

function Chip<T>({ label, value, current, onPick }: ChipProps<T>): JSX.Element {
  return (
    <button type="button" className={cx(styles.chip, value === current && styles.on)} onClick={() => onPick(value)}>
      {label}
    </button>
  );
}

/** Quick ranges, each ending today: the last 7, 30 and 90 days. */
const PERIODS: readonly number[] = [7, 30, 90];

/** The quick range the filter holds, null when open, -1 for a custom range. */
function currentPeriod(filter: StatsFilter): number | null {
  if (filter.from === null && filter.to === null) return null;
  if (filter.to !== null) return -1;
  return PERIODS.find((days) => daysAgo(days - 1) === filter.from) ?? -1;
}

function Period({ filter, onChange }: { filter: StatsFilter; onChange: (filter: StatsFilter) => void }): JSX.Element {
  const pickDays = (days: number | null) =>
    onChange({ ...filter, from: days === null ? null : daysAgo(days - 1), to: null });
  const current = currentPeriod(filter);
  return (
    <div className={styles.chips} title="Tickets whose last run falls in the range">
      <span className="small mute">Period</span>
      <Chip<number | null> label="All" value={null} current={current} onPick={pickDays} />
      {PERIODS.map((days) => (
        <Chip<number | null> key={days} label={`${days} d`} value={days} current={current} onPick={pickDays} />
      ))}
      <input
        type="date"
        className={styles.date}
        aria-label="From"
        value={filter.from ?? ""}
        max={filter.to ?? undefined}
        onChange={(event) => onChange({ ...filter, from: event.target.value || null })}
      />
      <span className="small mute">→</span>
      <input
        type="date"
        className={styles.date}
        aria-label="To"
        value={filter.to ?? ""}
        min={filter.from ?? undefined}
        onChange={(event) => onChange({ ...filter, to: event.target.value || null })}
      />
    </div>
  );
}

function Filters({
  projects,
  filter,
  onChange,
}: {
  projects: string[];
  filter: StatsFilter;
  onChange: (filter: StatsFilter) => void;
}): JSX.Element {
  const pick =
    <K extends keyof StatsFilter>(key: K) =>
    (value: StatsFilter[K]) =>
      onChange({ ...filter, [key]: value });
  return (
    <div className={styles.filters}>
      <Period filter={filter} onChange={onChange} />
      <div className={styles.chips} title="Delivery leaves out tickets no delivery pipeline ran on">
        <span className="small mute">Scope</span>
        {(["delivery", "all"] as const).map((scope) => (
          <Chip<ScopeFilter> key={scope} label={scope} value={scope} current={filter.scope} onPick={pick("scope")} />
        ))}
      </div>
      <div className={styles.chips}>
        <span className="small mute">Project</span>
        <Chip<string | null> label="All" value={null} current={filter.project} onPick={pick("project")} />
        {projects.map((name) => (
          <Chip<string | null> key={name} label={name} value={name} current={filter.project} onPick={pick("project")} />
        ))}
      </div>
      <div className={styles.chips}>
        <span className="small mute">Kind</span>
        <Chip<TicketKind | null> label="All" value={null} current={filter.kind} onPick={pick("kind")} />
        {KINDS.map((kind) => (
          <Chip<TicketKind | null> key={kind} label={kind} value={kind} current={filter.kind} onPick={pick("kind")} />
        ))}
      </div>
      <div className={styles.chips}>
        <span className="small mute">Source</span>
        {(["all", "live", "archive"] as const).map((source) => (
          <Chip<SourceFilter>
            key={source}
            label={source}
            value={source}
            current={filter.source}
            onPick={pick("source")}
          />
        ))}
      </div>
    </div>
  );
}

function money(usd: number | undefined, group: StatsGroupTotals): string {
  return fmtCost(usd === undefined ? undefined : { usd, estimated: group.estimated, unknown: group.unknown });
}

function share(group: StatsGroupTotals, of: number): string {
  return of > 0 ? `${Math.round((group.tickets / of) * 100)} %` : "—";
}

function Card({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: string | undefined;
}): JSX.Element {
  return (
    <div className={cx(styles.card, tone)}>
      <dt>{label}</dt>
      <dd>
        <span className={styles.value}>{value}</span>
        <span className={cx("small", "mute")}>{detail}</span>
      </dd>
    </div>
  );
}

/** What a finished ticket costs, then how the tickets ended. */
function Recap({ totals }: { totals: StatsTotals }): JSX.Element {
  const { all, passed, failed, unfinished } = totals;
  return (
    <dl className={styles.cards}>
      <Card
        label="Mean cost · passed"
        value={money(passed.meanUsd, passed)}
        detail={`median ${money(passed.medianUsd, passed)} · all tickets ${money(all.meanUsd, all)}`}
      />
      <Card
        label="Passed"
        value={String(passed.tickets)}
        detail={`${share(passed, all.tickets)} · ${money(passed.costUsd, passed)}`}
        tone={styles.pass}
      />
      <Card
        label="Failed"
        value={String(failed.tickets)}
        detail={`${share(failed, all.tickets)} · ${money(failed.costUsd, failed)}`}
        tone={styles.fail}
      />
      <Card
        label="Unfinished"
        value={String(unfinished.tickets)}
        detail={`stopped, aborted, running or not shipped · ${money(unfinished.costUsd, unfinished)}`}
      />
      <Card
        label="Total"
        value={money(all.costUsd, all)}
        detail={`${all.tickets} tickets · ${fmtDuration(all.activeMs)} active`}
      />
    </dl>
  );
}

function ArchiveNote({ archive }: { archive: StatsRead["archive"] }): JSX.Element {
  if (archive.status === "ok") {
    return (
      <span className="small mute">{`Archive: ${archive.runs} runs${archive.generatedAt ? `, exported ${fmtDate(archive.generatedAt)}` : ""}`}</span>
    );
  }
  if (archive.status === "invalid") {
    return <span className={cx("small", styles.warn)}>{`Archive ignored: ${archive.error}`}</span>;
  }
  return <span className="small mute">No archive</span>;
}

export function StatsScreen(): JSX.Element {
  const [load, refresh] = useStats();
  const [filter, setFilter] = useState<StatsFilter>(DEFAULT_FILTER);
  const [sort, setSort] = useState<StatsSort>(DEFAULT_SORT);

  const tickets = load.status === "ok" ? load.data.tickets : [];
  const projects = useMemo(() => [...new Set(tickets.map((ticket) => ticket.project))].sort(), [tickets]);
  const shown = useMemo(() => filterTickets(tickets, filter), [tickets, filter]);
  const sorted = useMemo(() => sortTickets(shown, sort), [shown, sort]);
  const totals = useMemo(() => totalsOf(shown), [shown]);

  return (
    <main className={styles.screen}>
      <div className={styles.head}>
        <h1>Ticket costs</h1>
        {load.status === "ok" ? <ArchiveNote archive={load.data.archive} /> : null}
        <button type="button" className={styles.refresh} onClick={refresh}>
          Refresh
        </button>
      </div>
      {load.status === "loading" ? <p className="mute">Reading every run…</p> : null}
      {load.status === "error" ? <p className={styles.warn}>{`Could not read the stats: ${load.error}`}</p> : null}
      {load.status === "ok" ? (
        <>
          <Recap totals={totals} />
          <Filters projects={projects} filter={filter} onChange={setFilter} />
          <StatsTable tickets={sorted} sort={sort} onSort={setSort} />
        </>
      ) : null}
    </main>
  );
}
