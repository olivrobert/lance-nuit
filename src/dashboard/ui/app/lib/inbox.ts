// The inbox as a list: which view a row is filed in, which rows show, how many
// wait for the reader, and which ones started waiting since the previous poll.

import type { Item } from "../api/types.js";
import { isWaiting, reasonOf } from "./items.js";

/** The two views of the list: `inbox` holds what needs the reader or is still
 *  running, `history` every finished run. Finished runs are most of the rows,
 *  and they buried the few that ask for something. */
export type InboxView = "inbox" | "history";

/** The view a row is filed in. A live launch already puts its item in the
 *  `running` group, and a closed run in `done`. */
export function viewOf(item: Item): InboxView {
  return item.group === "done" ? "history" : "inbox";
}

/** What the sidebar filters on: a project chip and the search box. */
export interface ItemFilters {
  filter: string | null;
  query: string;
}

/** The rows the list shows. Both filters are cumulative, and the search
 *  matches the fields the row itself displays. */
export function visibleItems(items: readonly Item[], filters: ItemFilters): Item[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (filters.filter && item.project.name !== filters.filter) return false;
    if (!query) return true;
    return [item.ticket, item.title, item.pipeline, item.project.name, reasonOf(item)]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(query));
  });
}

/** Items waiting for a decision, for one project or for all of them. */
export function waitingCount(items: readonly Item[], projectName: string | null): number {
  return items.filter((item) => (!projectName || item.project.name === projectName) && isWaiting(item)).length;
}

/**
 * Items that started waiting for the reader since the previous poll.
 *
 * `previous` is the set of waiting keys the last poll saw, or `null` before the
 * first one: what was already waiting when the page opened is on screen, and
 * announcing it again would be noise. A run that leaves `Needs you` and comes back
 * — a rerun that stopped again — is announced again, because it is a new stop.
 */
export function newlyWaiting(previous: ReadonlySet<string> | null, items: readonly Item[]): Item[] {
  if (previous === null) return [];
  return items.filter((item) => isWaiting(item) && !previous.has(item.key));
}

/** Keys of the items waiting for the reader, for the next `newlyWaiting`. */
export function waitingKeys(items: readonly Item[]): Set<string> {
  return new Set(items.filter(isWaiting).map((item) => item.key));
}
