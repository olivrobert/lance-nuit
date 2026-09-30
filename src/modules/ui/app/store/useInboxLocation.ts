// The inbox's address: its project chip and its open item, kept in the URL.
//
// The store stays the owner of `filter` and `selected`: the poll, a verb and a
// vanished item all move them without any URL involved, and the store knows
// nothing about the browser. The URL is where they are written down so a reload
// or a pasted link lands on the same chip and the same item. This hook is the
// only code that crosses between the two, in both directions:
//
//   URL -> store   once on mount, then on every `hashchange` (back button,
//                  edited address bar, a link to an item);
//   store -> URL   whenever the chip or the item moves while the inbox is on
//                  screen and the first read is done.
//
// A chip change pushes a history entry, so the back button returns to the
// previous project. An item change replaces the current one: `j` held down
// would otherwise bury the previous page under a hundred entries.

import { useEffect } from "react";
import { formatRoute, parseRoute } from "../lib/route.js";
import type { UiState } from "./state.js";
import { actions, useUiSelector } from "./store.js";

function inboxHrefOf(state: UiState): string {
  return formatRoute({ view: "inbox", project: state.filter, item: state.selected });
}

function followHash(): void {
  const route = parseRoute(window.location.hash);
  if (route.view === "inbox") actions.showInbox(route.project, route.item);
}

/** The address of the inbox as the reader left it, for a link that goes back
 *  to it from another screen. */
export function useInboxHref(): string {
  return useUiSelector(inboxHrefOf);
}

/** Mounted once, by `App`, ahead of the poll: the address must be in the store
 *  before the first read picks an item of its own. */
export function useInboxLocation(inboxShown: boolean): void {
  const href = useInboxHref();
  const ready = useUiSelector((state) => state.loaded && state.user !== null);

  useEffect(() => {
    followHash();
    window.addEventListener("hashchange", followHash);
    return () => window.removeEventListener("hashchange", followHash);
  }, []);

  useEffect(() => {
    if (!inboxShown || !ready || href === window.location.hash) return;
    const current = parseRoute(window.location.hash);
    const next = parseRoute(href);
    const sameChip = current.view === "inbox" && next.view === "inbox" && current.project === next.project;
    if (sameChip) window.history.replaceState(null, "", href);
    else window.location.hash = href;
  }, [inboxShown, ready, href]);
}
