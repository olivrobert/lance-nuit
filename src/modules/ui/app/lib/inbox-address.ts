// Where the reader is in the inbox, as the address names it, and what the
// inbox shows for that address.
//
// The address is the single owner of "which chip, which item, which tab": a
// reload or a pasted link lands on the same place, and no store keeps a second
// copy that could drift from it. Everything below is pure; `router.tsx` owns the
// routes and `InboxScreen` the one effect that writes a corrected address back.
//
//   #/                                every project, the first item that wants you
//   #/projects/<project>              one project
//   #/projects/<project>/tickets/<t>  one project, one item open
//   #/tickets/<project>/<t>           every project, one item open
//
// The sheet's tab and explorer file ride along as search params
// (`?tab=files&file=…`), which only make sense for the item they came with.

import type { Item, ProjectView, SheetTab } from "../api/types.js";
import { isWaiting } from "./items.js";

/** The route params an inbox address may carry, as `useParams({ strict: false })`
 *  hands them over. */
export interface InboxParams {
  project?: string;
  itemProject?: string;
  ticket?: string;
}

export interface InboxAddress {
  /** The project chip, or `null` for every project. */
  chip: string | null;
  /** `<project>/<ticket>` of the open item, or `null` to let the inbox pick. */
  item: string | null;
}

export function addressOf(params: InboxParams): InboxAddress {
  const chip = params.project ?? null;
  const itemProject = params.project ?? params.itemProject;
  const item = itemProject && params.ticket ? `${itemProject}/${params.ticket}` : null;
  return { chip, item };
}

/** The chip, if the server lists its project. A chip on a project it does not
 *  list — a stale link, a project removed since — would show an empty inbox that
 *  reads as "nothing to review", so it falls back to every project. */
export function knownChip(chip: string | null, projects: readonly ProjectView[]): string | null {
  return chip !== null && projects.some((project) => project.name === chip) ? chip : null;
}

/** The item the sheet opens: the one the address names while it is on screen,
 *  else the first row that wants the reader, else the first row. */
export function resolveSelection(rows: readonly Item[], requested: string | null): Item | null {
  return rows.find((item) => item.key === requested) ?? rows.find(isWaiting) ?? rows[0] ?? null;
}

/** Navigation options for an inbox address, typed against the route tree. An
 *  item outside the chip is not on screen, so it is not part of where the
 *  reader is: the address keeps the chip and drops the item. */
export type InboxTarget =
  | { to: "/" }
  | { to: "/projects/$project"; params: { project: string } }
  | { to: "/projects/$project/tickets/$ticket"; params: { project: string; ticket: string } }
  | { to: "/tickets/$itemProject/$ticket"; params: { itemProject: string; ticket: string } };

export function inboxTarget({ chip, item }: InboxAddress): InboxTarget {
  const cut = item === null ? -1 : item.indexOf("/");
  const itemProject = item !== null && cut > 0 ? item.slice(0, cut) : null;
  const ticket = item !== null && cut > 0 ? item.slice(cut + 1) : "";
  if (chip !== null) {
    return itemProject === chip && ticket
      ? { to: "/projects/$project/tickets/$ticket", params: { project: chip, ticket } }
      : { to: "/projects/$project", params: { project: chip } };
  }
  if (itemProject && ticket) return { to: "/tickets/$itemProject/$ticket", params: { itemProject, ticket } };
  return { to: "/" };
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
