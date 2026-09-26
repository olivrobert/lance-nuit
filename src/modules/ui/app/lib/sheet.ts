// Which sheet tab an item shows, and what a delivered run offers ahead of its
// verbs.

import type { Item, ItemDetail, RequestedSheetTab, RunReport, SheetTab } from "../api/types.js";
import { isDelivered } from "./items.js";
import { linkableUrl } from "./url.js";

/** What a delivered run offers ahead of the verbs: its report's primary link
 *  (the merge request) and a copy button for the value the report marks as
 *  copyable (the branch). */
export interface DeliveryActions {
  link?: { label: string; url: string };
  copy?: { label: string; value: string };
}

/**
 * The delivery actions of an item, or `null` when it has none — then the
 * action row is exactly the item's verbs.
 *
 * Only a delivered run (`isDelivered`) with a report has them. The link must be
 * one this dashboard links to (`linkableUrl`), even though the read model
 * already filters: an `href` is checked where it is made. The first `delivered`
 * entry with `copy` is the copy button, labelled after its entry ("Copy
 * branch").
 */
export function deliveryActions(item: Item, report: RunReport | null | undefined): DeliveryActions | null {
  if (!report || !isDelivered(item)) return null;
  const primary = report.links?.find((link) => link.primary);
  const url = linkableUrl(primary?.url);
  const copyable = report.delivered?.find((entry) => entry.copy && entry.value);
  const actions: DeliveryActions = {
    ...(primary && url ? { link: { label: primary.label, url } } : {}),
    ...(copyable ? { copy: { label: `Copy ${copyable.label.toLowerCase()}`, value: copyable.value } } : {}),
  };
  return actions.link || actions.copy ? actions : null;
}

/** The tab an item opens on when the reader has expressed no preference. A
 *  finished run opens on its report when it wrote one for this run. */
export function defaultSheetTab(item: Item, detail?: Pick<ItemDetail, "report"> | null): SheetTab {
  if (item.group === "failure") return "diagnostic";
  if (item.group === "done" && detail?.report) return "report";
  if (item.group === "running" || item.group === "done") return "run";
  return "document";
}

/**
 * The tab actually shown.
 *
 * A tab whose content does not exist is never rendered empty: it falls back,
 * once, to the item's default — and `document` falls back further, to `files`
 * when there is a tree and to `diagnostic` when there is none. The chain is
 * shallow on purpose; a second-level fallback that could itself fall back would
 * be a loop waiting to happen. `run` is the one tab placed before that chain:
 * with neither a recap nor steps it reads as a request for `document`, and goes
 * no further than `document` itself would. `report` exists only with a valid
 * report of the current run; without one it is the item's default instead.
 */
export function currentSheetTab(item: Item, detail: ItemDetail | null, requested: RequestedSheetTab): SheetTab {
  const fallback = defaultSheetTab(item, detail);
  const requestedTab = requested === "auto" ? fallback : requested;
  const asked = requestedTab === "report" && !detail?.report ? fallback : requestedTab;
  const wanted = asked === "run" && !detail?.recap && !detail?.steps ? "document" : asked;
  const tree = detail?.tree;
  if (wanted === "document" && !tree?.gatePath && !tree?.defaultPath) return tree ? "files" : "diagnostic";
  if (wanted === "files" && !tree) return fallback;
  if (wanted === "diagnostic" && item.group !== "failure" && !item.launch) return fallback;
  return wanted;
}
