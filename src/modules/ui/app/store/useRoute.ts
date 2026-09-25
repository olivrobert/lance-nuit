// The screen the URL hash names, and the one way to move to another.
//
// The hash is browser state, not application state: it lives in
// `location.hash`, it changes on the back button as well as on a click, and
// nothing in the store needs to know which screen is up — the poll keeps
// running under the terminal so the inbox is fresh when the reader comes back.
// So it is read here, through `useSyncExternalStore` on `hashchange`, and never
// copied into the store where the two could disagree.

import { useSyncExternalStore } from "react";
import { formatRoute, parseRoute, type Route } from "../lib/route.js";

function subscribe(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

function readHash(): string {
  return window.location.hash;
}

/** The current screen. The raw hash is the snapshot, so an unchanged URL never
 *  yields a fresh object and never re-renders. */
export function useRoute(): Route {
  return parseRoute(useSyncExternalStore(subscribe, readHash, readHash));
}

/** Move to a screen. Assigning the hash pushes a history entry, so the browser's
 *  back button returns to where the reader came from. */
export function navigate(route: Route): void {
  window.location.hash = formatRoute(route);
}
