// The inbox in morning reading order: what needs you, what is running, then one
// section per night, and the time each row shows.

import type { Item, ItemCost } from "../api/types.js";
import { fmtAge } from "./format.js";
import { GROUPS, isWaiting } from "./items.js";

/** Local hour a night starts at: a run belongs to the night that began at the
 *  latest such hour at or before its `updatedAt`. A constant until the boundary
 *  proves wrong in practice. */
export const NIGHT_START_HOUR = 18;

/** Stable ids, so the jump chips and the open state of a `<details>` survive a
 *  poll that reshuffles the rows. */
export type TimelineSectionId = "needs" | "running" | "night-0" | "night-1" | "week" | "earlier";

export interface TimelineSection {
  id: TimelineSectionId;
  label: string;
  /** Dates the section covers (`Thu 24 → Fri 25`), so a relative label is never
   *  the only reference. Absent on `needs` and `running`. */
  range?: string;
  items: Item[];
  /** Sum of the rows' costs, for `fmtCost`: `unknown` when any row is a floor. */
  cost: ItemCost;
  /** Closed by default: only `earlier`. */
  collapsed: boolean;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Start of the night containing `date`, in local time. */
function nightStart(date: Date): Date {
  const start = new Date(date);
  start.setHours(NIGHT_START_HOUR, 0, 0, 0);
  if (start.getTime() > date.getTime()) start.setDate(start.getDate() - 1);
  return start;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** How many nights before `now`'s night the item's night started; `null` when
 *  its date does not parse. A date in the future counts as the current night. */
function nightIndex(item: Item, currentNight: Date): number | null {
  const at = new Date(item.updatedAt);
  if (!Number.isFinite(at.getTime())) return null;
  // Rounded: a daylight-saving change makes one night 23 or 25 hours long.
  return Math.max(0, Math.round((currentNight.getTime() - nightStart(at).getTime()) / DAY_MS));
}

function fmtDay(date: Date): string {
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function fmtClock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function byUpdatedDesc(a: Item, b: Item): number {
  const left = Date.parse(a.updatedAt);
  const right = Date.parse(b.updatedAt);
  return (Number.isFinite(right) ? right : -Infinity) - (Number.isFinite(left) ? left : -Infinity) || 0;
}

function sumCost(items: readonly Item[]): ItemCost {
  let usd: number | undefined;
  let estimated = false;
  let unknown = false;
  for (const item of items) {
    if (typeof item.cost.usd === "number") usd = (usd ?? 0) + item.cost.usd;
    estimated ||= item.cost.estimated;
    unknown ||= item.cost.unknown === true;
  }
  return { ...(usd === undefined ? {} : { usd }), estimated, ...(unknown ? { unknown: true } : {}) };
}

function section(
  id: TimelineSectionId,
  label: string,
  items: Item[],
  extra: { range?: string; collapsed?: boolean } = {},
): TimelineSection {
  return {
    id,
    label,
    ...(extra.range ? { range: extra.range } : {}),
    items,
    cost: sumCost(items),
    collapsed: extra.collapsed ?? false,
  };
}

/**
 * The list, in morning reading order: what needs you, what is running, then one
 * section per night (see the label table in the plan: the current night is
 * `Tonight` once it started today, `Last night` in the morning).
 *
 * `items` is already filtered by the project chip and the search. Empty sections
 * are omitted. Rows inside a section are newest first; `Needs you` keeps the
 * `GROUPS` order first. A date that does not parse lands in `Earlier`.
 */
export function timeline(items: readonly Item[], now: Date): TimelineSection[] {
  const currentNight = nightStart(now);
  const evening = now.getHours() >= NIGHT_START_HOUR;
  const needs: Item[] = [];
  const running: Item[] = [];
  const nights: Item[][] = [[], []];
  const week: Item[] = [];
  const earlier: Item[] = [];
  let weekOldest = 1;
  let weekNewest = 8;

  for (const item of items) {
    if (isWaiting(item)) needs.push(item);
    else if (item.group === "running") running.push(item);
    else {
      const index = nightIndex(item, currentNight);
      if (index === null || index > 7) earlier.push(item);
      else if (index <= 1) nights[index]?.push(item);
      else {
        week.push(item);
        weekOldest = Math.max(weekOldest, index);
        weekNewest = Math.min(weekNewest, index);
      }
    }
  }

  const groupRank = (item: Item): number => GROUPS.findIndex(([group]) => group === item.group);
  needs.sort((a, b) => groupRank(a) - groupRank(b) || byUpdatedDesc(a, b));
  for (const list of [running, ...nights, week, earlier]) list.sort(byUpdatedDesc);

  const nightRange = (index: number): string => {
    const start = addDays(currentNight, -index);
    return `${fmtDay(start)} → ${fmtDay(addDays(start, 1))}`;
  };
  const sections: TimelineSection[] = [];
  if (needs.length) sections.push(section("needs", "Needs you", needs));
  if (running.length) sections.push(section("running", "Running", running));
  const [current = [], previous = []] = nights;
  if (current.length) {
    sections.push(section("night-0", evening ? "Tonight" : "Last night", current, { range: nightRange(0) }));
  }
  if (previous.length) {
    sections.push(section("night-1", evening ? "Last night" : "Yesterday", previous, { range: nightRange(1) }));
  }
  if (week.length) {
    const from = addDays(currentNight, -weekOldest);
    const to = addDays(currentNight, 1 - weekNewest);
    sections.push(section("week", "This week", week, { range: `${fmtDay(from)} → ${fmtDay(to)}` }));
  }
  if (earlier.length) {
    const range = `before ${fmtDay(addDays(currentNight, -7))}`;
    sections.push(section("earlier", "Earlier", earlier, { range, collapsed: true }));
  }
  return sections;
}

/** A row carries a tag only for an exception: a plain PASS is what the night
 *  sections are made of, and saying it on every row was noise. The sheet header
 *  keeps the full status. */
export function rowShowsTag(item: Item): boolean {
  return item.launch?.alive === true || item.closed !== undefined || item.status !== "PASS";
}

/** The time a row shows. `Needs you` and `Running` keep the age, which is what
 *  matters there; a night shows the clock, `This week` the weekday too, and
 *  `Earlier` the date. */
export function rowTime(item: Item, sectionId: TimelineSectionId, now: Date): string {
  if (sectionId === "needs" || sectionId === "running") return fmtAge(item.updatedAt, now.getTime());
  const at = new Date(item.updatedAt);
  if (!Number.isFinite(at.getTime())) return "—";
  if (sectionId === "week") return `${WEEKDAYS[at.getDay()]} ${fmtClock(at)}`;
  if (sectionId === "earlier") return `${at.getDate()} ${MONTHS[at.getMonth()]}`;
  return fmtClock(at);
}
