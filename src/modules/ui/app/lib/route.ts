// The screens of the dashboard, as the URL hash names them.
//
// Every screen has an address, because a reader who reloads the page, or pastes
// the link into another tab, must land back where they were rather than on an
// empty inbox. The inbox is addressed by its project chip and its open item:
//
//   #/                                every project, the first item that wants you
//   #/projects/<project>              one project
//   #/projects/<project>/tickets/<t>  one project, one item open
//   #/tickets/<project>/<t>           every project, one item open
//
// The stats screen has a fixed address (`#/stats`), a terminal one of its own
// (`#/terminal/<id>`). The hash is used rather than a path so the static handler
// keeps serving one `index.html` and the server needs no route of its own for a
// screen. Each segment is URI-encoded, so a ticket key holding a `/` stays one
// segment.
//
// Anything the parser does not recognise is the inbox on every project: a stale
// or hand-edited hash must never leave the reader on a blank page.

import { splitKey } from "./items.js";

export type InboxRoute = {
  view: "inbox";
  /** The project chip, or `null` for every project. */
  project: string | null;
  /** `<project>/<ticket>` of the open item, or `null` to let the inbox pick. */
  item: string | null;
};

export type Route = InboxRoute | { view: "stats" } | { view: "terminal"; id: string };

const STATS_HASH = "#/stats";
const ALL_PROJECTS: InboxRoute = { view: "inbox", project: null, item: null };

/** The decoded segments after `#/`, or `null` when one of them is empty or is
 *  not a valid escape — neither is an address anybody was given. */
function segmentsOf(hash: string): string[] | null {
  if (!hash.startsWith("#/")) return null;
  const rest = hash.slice(2);
  if (rest === "") return [];
  try {
    const segments = rest.split("/").map(decodeURIComponent);
    return segments.every(Boolean) ? segments : null;
  } catch {
    return null;
  }
}

function itemKey(project: string, ticket: string): string {
  return `${project}/${ticket}`;
}

export function parseRoute(hash: string): Route {
  if (hash === STATS_HASH) return { view: "stats" };
  const segments = segmentsOf(hash);
  if (!segments) return ALL_PROJECTS;
  const [head, first, second, third, ...extra] = segments;
  if (extra.length > 0 || first === undefined) return ALL_PROJECTS;

  if (head === "terminal" && second === undefined && !first.includes("/")) return { view: "terminal", id: first };
  if (head === "projects" && second === undefined) return { view: "inbox", project: first, item: null };
  if (head === "projects" && second === "tickets" && third !== undefined) {
    return { view: "inbox", project: first, item: itemKey(first, third) };
  }
  if (head === "tickets" && second !== undefined && third === undefined) {
    return { view: "inbox", project: null, item: itemKey(first, second) };
  }
  return ALL_PROJECTS;
}

export function formatRoute(route: Route): string {
  if (route.view === "terminal") return `#/terminal/${encodeURIComponent(route.id)}`;
  if (route.view === "stats") return STATS_HASH;

  const { project, item } = route;
  const [itemProject, ticket] = item ? splitKey(item) : [null, null];
  if (project !== null) {
    const base = `#/projects/${encodeURIComponent(project)}`;
    // An item outside the chip is not on screen, so it is not part of where the
    // reader is: the address keeps the chip and drops the item.
    return ticket && itemProject === project ? `${base}/tickets/${encodeURIComponent(ticket)}` : base;
  }
  if (itemProject && ticket) return `#/tickets/${encodeURIComponent(itemProject)}/${encodeURIComponent(ticket)}`;
  return "#/";
}
