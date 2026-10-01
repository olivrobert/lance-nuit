// The stats screen's filters and sort, as search params of `#/stats`.
//
// Kept in the address so a filtered view can be reloaded, bookmarked and
// pasted to a colleague. Only what differs from the defaults is written: the
// bare `#/stats` is the default view, and a link carries no noise.

import type { TicketKind } from "../api/types.js";
import {
  DEFAULT_FILTER,
  DEFAULT_SORT,
  KINDS,
  type ScopeFilter,
  type SourceFilter,
  type StatsColumn,
  type StatsFilter,
  type StatsSort,
} from "./stats.js";

export interface StatsSearch {
  project?: string;
  kind?: TicketKind;
  source?: SourceFilter;
  scope?: ScopeFilter;
  from?: string;
  to?: string;
  sort?: StatsColumn;
  desc?: boolean;
}

const SOURCES: readonly SourceFilter[] = ["all", "live", "archive"];
const SCOPES: readonly ScopeFilter[] = ["delivery", "all"];
const COLUMNS: readonly StatsColumn[] = [
  "project",
  "ticket",
  "kind",
  "cost",
  "active",
  "span",
  "runs",
  "outcome",
  "lastAt",
];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function oneOf<T>(allowed: readonly T[], value: unknown): T | undefined {
  return allowed.find((entry) => entry === value);
}

function day(value: unknown): string | undefined {
  return typeof value === "string" && DAY.test(value) ? value : undefined;
}

/** Only the params the screen knows, each of the right shape: a hand-edited
 *  link with a bad value falls back to the default for that value alone. The
 *  router's default parser JSON-decodes values, so a project named `42`
 *  arrives as a number and is turned back into its name. */
export function statsSearchOf(raw: Record<string, unknown>): StatsSearch {
  const project = typeof raw.project === "string" || typeof raw.project === "number" ? String(raw.project) : "";
  const search: StatsSearch = {
    ...(project ? { project } : {}),
    kind: oneOf(KINDS, raw.kind),
    source: oneOf(SOURCES, raw.source),
    scope: oneOf(SCOPES, raw.scope),
    from: day(raw.from),
    to: day(raw.to),
    sort: oneOf(COLUMNS, raw.sort),
    desc: typeof raw.desc === "boolean" ? raw.desc : undefined,
  };
  return Object.fromEntries(Object.entries(search).filter(([, value]) => value !== undefined)) as StatsSearch;
}

export function statsViewOf(search: StatsSearch): { filter: StatsFilter; sort: StatsSort } {
  return {
    filter: {
      project: search.project ?? DEFAULT_FILTER.project,
      kind: search.kind ?? DEFAULT_FILTER.kind,
      source: search.source ?? DEFAULT_FILTER.source,
      scope: search.scope ?? DEFAULT_FILTER.scope,
      from: search.from ?? DEFAULT_FILTER.from,
      to: search.to ?? DEFAULT_FILTER.to,
    },
    sort: { column: search.sort ?? DEFAULT_SORT.column, descending: search.desc ?? DEFAULT_SORT.descending },
  };
}

export function searchOfStatsView(filter: StatsFilter, sort: StatsSort): StatsSearch {
  const search: StatsSearch = {};
  if (filter.project !== DEFAULT_FILTER.project && filter.project !== null) search.project = filter.project;
  if (filter.kind !== DEFAULT_FILTER.kind && filter.kind !== null) search.kind = filter.kind;
  if (filter.source !== DEFAULT_FILTER.source) search.source = filter.source;
  if (filter.scope !== DEFAULT_FILTER.scope) search.scope = filter.scope;
  if (filter.from !== null) search.from = filter.from;
  if (filter.to !== null) search.to = filter.to;
  if (sort.column !== DEFAULT_SORT.column) search.sort = sort.column;
  if (sort.descending !== DEFAULT_SORT.descending) search.desc = sort.descending;
  return search;
}
