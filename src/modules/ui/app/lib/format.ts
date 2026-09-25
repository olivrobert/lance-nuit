// Value formatting for the screen.
//
// Every function here is total: it takes whatever the API sent, including
// `undefined` and a date that does not parse, and returns something printable.
// A dashboard that throws while rendering a malformed timestamp is worse than
// one that shows an em dash.

import type { ItemCost } from "../api/types.js";

/** Placeholder for a value the API did not send. */
const ABSENT = "—";

/** Relative age, coarsening as it grows: minutes for the first hour, hours for
 *  two days, days beyond. A run's exact second is never the question. */
export function fmtAge(iso: string | undefined | null, now: number = Date.now()): string {
  if (!iso) return ABSENT;
  const minutes = Math.round((now - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(minutes)) return ABSENT;
  if (minutes < 60) return `${Math.max(minutes, 0)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Run cost. The trailing `~` says the figure came from a rate table rather than
 *  from the provider, which matters when a reader is deciding on a budget. A
 *  leading `≥` says an attempt could not be priced at all, so the figure is a
 *  floor: `≥ 0.00 $` is the honest reading of a run whose only spend was
 *  unpriceable, and printing it as `0.00 $` would claim it was free. */
export function fmtCost(cost: ItemCost | undefined | null): string {
  if (!cost || typeof cost.usd !== "number") return cost?.unknown ? "≥ ? $" : ABSENT;
  return `${cost.unknown ? "≥ " : ""}${cost.usd.toFixed(2)} $${cost.estimated ? " ~" : ""}`;
}

export function fmtSize(bytes: number | undefined | null): string {
  if (typeof bytes !== "number") return "";
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

/** An ISO timestamp cut to the minute, kept in UTC on purpose: the runner writes
 *  UTC, and reformatting it locally would make two timestamps in the same sheet
 *  disagree. */
export function fmtDate(iso: string | undefined | null): string {
  if (!iso) return ABSENT;
  return String(iso).slice(0, 16).replace("T", " ");
}

/** A duration, to the second under a minute and to the minute beyond: the
 *  recap compares steps, and `1h 04m` reads faster than `3842 s`. */
export function fmtDuration(ms: number | undefined | null): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return ABSENT;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}`;
}

/** A token count, in thousands or millions once it stops being readable whole. */
export function fmtTokens(count: number | undefined | null): string {
  if (typeof count !== "number" || !Number.isFinite(count)) return ABSENT;
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)} k`;
  return `${(count / 1_000_000).toFixed(2)} M`;
}
