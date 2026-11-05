// The stats screen's arithmetic: which tickets are shown, in what order, and
// what they add up to.
//
// Kept apart from the components so it can be tested without a DOM, and so the
// table and the recap cards can never disagree about the filtered set: both
// read the output of `filterTickets`.
//
// The default scope is the tickets something delivered — those with an
// `outcome`. A ticket only ever triaged costs a few cents and would drag every
// mean towards zero; the `all` scope brings it back.
//
// The date range picks tickets by their last activity (`lastAt`), so each
// ticket falls in exactly one period and the periods add up. Its bounds are
// local calendar days, both inclusive, as a date input reads them; a ticket
// with no timestamp is left out once a bound is set.
//
// A value the server did not send — a ticket that never reported a cost, a run
// without a timestamp — always sorts last, whichever way the column is sorted.
// Flipping the order is a question about the figures; the blanks are not part
// of the answer.

import type { StatsTicket, TicketKind } from "../api/types.js";

export type StatsColumn = "project" | "ticket" | "kind" | "cost" | "active" | "span" | "runs" | "outcome" | "lastAt";

export interface StatsSort {
  column: StatsColumn;
  descending: boolean;
}

/** The default order answers the first question a reader has: what cost most. */
export const DEFAULT_SORT: StatsSort = { column: "cost", descending: true };

export type SourceFilter = "all" | "live" | "archive";

export type ScopeFilter = "delivery" | "all";

export interface StatsFilter {
  project: string | null;
  kind: TicketKind | null;
  source: SourceFilter;
  scope: ScopeFilter;
  /** First and last local day, `YYYY-MM-DD`, both inclusive; null is open. */
  from: string | null;
  to: string | null;
}

export const DEFAULT_FILTER: StatsFilter = {
  project: null,
  kind: null,
  source: "all",
  scope: "delivery",
  from: null,
  to: null,
};

/** The local day `days` before `now`, as a date input writes it. */
export function daysAgo(days: number, now: Date = new Date()): string {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/** Local midnight opening `day`, or the last millisecond closing it. */
function dayBound(day: string | null, end: boolean): number | undefined {
  return day ? stampMs(`${day}T${end ? "23:59:59.999" : "00:00:00"}`) : undefined;
}

function inRange(ticket: StatsTicket, filter: StatsFilter): boolean {
  const from = dayBound(filter.from, false);
  const to = dayBound(filter.to, true);
  if (from === undefined && to === undefined) return true;
  const last = stampMs(ticket.lastAt);
  return last !== undefined && (from === undefined || last >= from) && (to === undefined || last <= to);
}

export const KINDS: readonly TicketKind[] = ["bug", "feature", "other"];

function stampMs(iso: string | undefined): number | undefined {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Wall-clock span of a ticket, first run created to last run updated. */
export function spanMs(ticket: StatsTicket): number | undefined {
  const first = stampMs(ticket.firstAt);
  const last = stampMs(ticket.lastAt);
  return first !== undefined && last !== undefined && last >= first ? last - first : undefined;
}

function sortValue(ticket: StatsTicket, column: StatsColumn): string | number | undefined {
  switch (column) {
    case "project":
      return ticket.project;
    case "ticket":
      return ticket.ticket;
    case "kind":
      return ticket.kind;
    case "cost":
      return ticket.costUsd;
    case "active":
      return ticket.activeMs;
    case "span":
      return spanMs(ticket);
    case "runs":
      return ticket.runs.length;
    case "outcome":
      return ticket.outcome;
    case "lastAt":
      return stampMs(ticket.lastAt);
  }
}

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/** A sorted copy; ties fall back to the ticket key so the order is stable
 *  between two reads of the same data. */
export function sortTickets(tickets: readonly StatsTicket[], sort: StatsSort): StatsTicket[] {
  const sign = sort.descending ? -1 : 1;
  return [...tickets].sort((a, b) => {
    const left = sortValue(a, sort.column);
    const right = sortValue(b, sort.column);
    if (left === undefined || right === undefined) {
      if (left !== right) return left === undefined ? 1 : -1;
    } else {
      const order = compareValues(left, right);
      if (order !== 0) return sign * order;
    }
    return a.key.localeCompare(b.key, undefined, { numeric: true });
  });
}

/** Clicking the sorted column flips it; clicking another sorts it, text
 *  columns A→Z first and figures largest first. */
export function nextSort(current: StatsSort, column: StatsColumn): StatsSort {
  if (current.column === column) return { column, descending: !current.descending };
  const textual = column === "project" || column === "ticket" || column === "kind" || column === "outcome";
  return { column, descending: !textual };
}

export function filterTickets(tickets: readonly StatsTicket[], filter: StatsFilter): StatsTicket[] {
  return tickets.filter(
    (ticket) =>
      (filter.project === null || ticket.project === filter.project) &&
      (filter.kind === null || ticket.kind === filter.kind) &&
      (filter.scope === "all" || ticket.outcome !== undefined) &&
      inRange(ticket, filter) &&
      // A mixed ticket answers both: it has runs of each source.
      (filter.source === "all" || ticket.source === filter.source || ticket.source === "mixed"),
  );
}

/** A set of tickets and what it cost. */
export interface StatsGroupTotals {
  tickets: number;
  /** Absent when no ticket of the group reported a cost. */
  costUsd?: number;
  /** Mean and median over the tickets of the group that reported a cost. */
  meanUsd?: number;
  medianUsd?: number;
  /** A ticket of the group carries an estimated figure. */
  estimated: boolean;
  /** A ticket of the group carries a lower bound: the sum is one too. */
  unknown: boolean;
}

/**
 * The recap cards. `passed` answers what a shipped ticket costs; `failed` what
 * was spent for nothing; `unfinished` holds the rest — stopped at a gate,
 * aborted, still running, passed without shipping, or never delivered in the
 * `all` scope — so the three always add up to `all.tickets`.
 */
export interface StatsTotals {
  all: StatsGroupTotals & { activeMs?: number };
  passed: StatsGroupTotals;
  failed: StatsGroupTotals;
  unfinished: StatsGroupTotals;
}

function sum(values: readonly number[]): number | undefined {
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined;
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function groupTotals(tickets: readonly StatsTicket[]): StatsGroupTotals {
  const priced = tickets.map((ticket) => ticket.costUsd).filter((cost): cost is number => cost !== undefined);
  const total = sum(priced);
  const medianUsd = median(priced);
  return {
    tickets: tickets.length,
    ...(total !== undefined ? { costUsd: total, meanUsd: total / priced.length } : {}),
    ...(medianUsd !== undefined ? { medianUsd } : {}),
    estimated: tickets.some((ticket) => ticket.costEstimated),
    unknown: tickets.some((ticket) => ticket.costUnknown),
  };
}

export function totalsOf(tickets: readonly StatsTicket[]): StatsTotals {
  const activeMs = sum(tickets.map((ticket) => ticket.activeMs).filter((ms): ms is number => ms !== undefined));
  return {
    all: { ...groupTotals(tickets), ...(activeMs !== undefined ? { activeMs } : {}) },
    passed: groupTotals(tickets.filter((ticket) => ticket.outcome === "PASS")),
    failed: groupTotals(tickets.filter((ticket) => ticket.outcome === "FAIL")),
    unfinished: groupTotals(tickets.filter((ticket) => ticket.outcome !== "PASS" && ticket.outcome !== "FAIL")),
  };
}
