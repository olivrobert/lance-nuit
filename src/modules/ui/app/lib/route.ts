// The screens of the dashboard, as the URL hash names them.
//
// The inbox needs no address: it is what the page opens on. The stats screen
// has a fixed one (`#/stats`). A terminal needs one of its own,
// because a reader who reloads the page, or pastes the link into another tab,
// must land back on the same tmux session rather than on the inbox. The hash is
// used rather than a path so the static handler keeps serving one `index.html`
// and the server needs no route of its own for a screen.
//
// Anything the parser does not recognise is the inbox: a stale or hand-edited
// hash must never leave the reader on a blank page.

export type Route = { view: "inbox" } | { view: "stats" } | { view: "terminal"; id: string };

const TERMINAL_PREFIX = "#/terminal/";
const STATS_HASH = "#/stats";

export function parseRoute(hash: string): Route {
  if (hash === STATS_HASH) return { view: "stats" };
  if (!hash.startsWith(TERMINAL_PREFIX)) return { view: "inbox" };
  const raw = hash.slice(TERMINAL_PREFIX.length);
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // A malformed escape is not an id anybody was given.
    return { view: "inbox" };
  }
  return id && !id.includes("/") ? { view: "terminal", id } : { view: "inbox" };
}

export function formatRoute(route: Route): string {
  if (route.view === "terminal") return `${TERMINAL_PREFIX}${encodeURIComponent(route.id)}`;
  return route.view === "stats" ? STATS_HASH : "#/";
}
