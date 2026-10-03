// Where the reader is in the inbox, as the address names it, and what the
// inbox shows for that address.
//
// The address is the single owner of "which view, which chip, which item, which tab": a
// reload or a pasted link lands on the same place, and no store keeps a second
// copy that could drift from it. Everything below is pure; `router.tsx` owns the
// routes and `InboxScreen` the one effect that writes a corrected address back.
//
//   #/                                every project, the first item that wants you
//   #/projects/<project>              one project
//   #/projects/<project>/tickets/<t>  one project, one item open
//   #/tickets/<project>/<t>           every project, one item open
//
// Each of them also exists under `#/history`, the view of the finished runs;
// without that prefix the address names the inbox view.
//
// The sheet's tab and explorer file ride along as search params
// (`?tab=files&file=…`), which only make sense for the item they came with.

import type { Item, ProjectView, SheetTab } from "../api/types.js";
import { type InboxView, viewOf } from "./inbox.js";
import { isWaiting } from "./items.js";

/** The route params an inbox address may carry, as `useParams({ strict: false })`
 *  hands them over. */
export interface InboxParams {
  project?: string;
  itemProject?: string;
  ticket?: string;
}

export interface InboxAddress {
  view: InboxView;
  /** The project chip, or `null` for every project. */
  chip: string | null;
  /** `<project>/<ticket>` of the open item, or `null` to let the inbox pick. */
  item: string | null;
}

const HISTORY = "/history";

/** The address of an inbox route: its params, and its path for the view. */
export function addressOf(params: InboxParams, pathname: string): InboxAddress {
  const view = pathname === HISTORY || pathname.startsWith(`${HISTORY}/`) ? "history" : "inbox";
  const chip = params.project ?? null;
  const itemProject = params.project ?? params.itemProject;
  const item = itemProject && params.ticket ? `${itemProject}/${params.ticket}` : null;
  return { view, chip, item };
}

/** The chip, if the server lists its project. A chip on a project it does not
 *  list — a stale link, a project removed since — would show an empty inbox that
 *  reads as "nothing to review", so it falls back to every project. */
export function knownChip(chip: string | null, projects: readonly ProjectView[]): string | null {
  return chip !== null && projects.some((project) => project.name === chip) ? chip : null;
}

/** What the inbox shows for an address: the view, and the item the sheet opens.
 *
 *  `rows` are the rows the chip and the search leave, in both views. The item
 *  the address names stays open while it is among them, and the view follows
 *  it: a link from another screen does not know where the item is filed, and a
 *  run that finishes under the reader's eyes moves to the history without
 *  closing. Otherwise the view picks its first row that wants the reader, else
 *  its first row. */
export function resolveSelection(
  rows: readonly Item[],
  view: InboxView,
  requested: string | null,
): { view: InboxView; item: Item | null } {
  const named = rows.find((item) => item.key === requested);
  if (named) return { view: viewOf(named), item: named };
  const shown = rows.filter((item) => viewOf(item) === view);
  return { view, item: shown.find(isWaiting) ?? shown[0] ?? null };
}

/** Navigation options for an inbox address, typed against the route tree. An
 *  item outside the chip is not on screen, so it is not part of where the
 *  reader is: the address keeps the chip and drops the item. */
export type InboxTarget =
  | { to: "/" | "/history" }
  | { to: "/projects/$project" | "/history/projects/$project"; params: { project: string } }
  | {
      to: "/projects/$project/tickets/$ticket" | "/history/projects/$project/tickets/$ticket";
      params: { project: string; ticket: string };
    }
  | {
      to: "/tickets/$itemProject/$ticket" | "/history/tickets/$itemProject/$ticket";
      params: { itemProject: string; ticket: string };
    };

export function inboxTarget({ view, chip, item }: InboxAddress): InboxTarget {
  const history = view === "history";
  const cut = item === null ? -1 : item.indexOf("/");
  const itemProject = item !== null && cut > 0 ? item.slice(0, cut) : null;
  const ticket = item !== null && cut > 0 ? item.slice(cut + 1) : "";
  if (chip !== null) {
    if (itemProject === chip && ticket) {
      const to = history ? "/history/projects/$project/tickets/$ticket" : "/projects/$project/tickets/$ticket";
      return { to, params: { project: chip, ticket } };
    }
    return { to: history ? "/history/projects/$project" : "/projects/$project", params: { project: chip } };
  }
  if (itemProject && ticket) {
    const to = history ? "/history/tickets/$itemProject/$ticket" : "/tickets/$itemProject/$ticket";
    return { to, params: { itemProject, ticket } };
  }
  return { to: history ? "/history" : "/" };
}

/** The search params of the sheet, as `validateSearch` keeps them. */
export interface SheetSearch {
  tab?: SheetTab;
  file?: string;
}

const SHEET_TABS: readonly SheetTab[] = ["diagnostic", "report", "run", "document", "files"];

/** Only the params the sheet knows, each of the right shape. The router's
 *  default parser JSON-decodes values, so a file named `1` arrives as a number
 *  and is turned back into the string it was. */
export function sheetSearchOf(raw: Record<string, unknown>): SheetSearch {
  const tab = SHEET_TABS.find((entry) => entry === raw.tab);
  const file = typeof raw.file === "string" || typeof raw.file === "number" ? String(raw.file) : "";
  return { ...(tab ? { tab } : {}), ...(file ? { file } : {}) };
}
