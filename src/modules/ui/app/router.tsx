// The route tree of the dashboard, on the hash so the server serves one page
// for every address.
//
// The inbox routes share one pathless layout, `InboxScreen`: moving between
// items or chips changes the params, not the screen, so the list keeps its
// scroll. The layout's children carry no component — they only name the params
// `lib/inbox-address.ts` reads. Search params are validated by pure functions
// (`sheetSearchOf`, `statsSearchOf`), so a hand-edited link cannot put a value
// of the wrong shape in front of a component.

import { createHashHistory, createRootRoute, createRoute, createRouter, Navigate } from "@tanstack/react-router";
import { ErrorScreen, Root, StatsPage, TerminalPage } from "./App.js";
import { InboxScreen } from "./components/InboxScreen.js";
import { sheetSearchOf } from "./lib/inbox-address.js";
import { statsSearchOf } from "./lib/stats-search.js";

const rootRoute = createRootRoute({
  component: Root,
  // An address nothing matches — an old bookmark, a typo — opens the inbox
  // rather than a blank page.
  notFoundComponent: () => <Navigate to="/" replace />,
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "inbox",
  component: InboxScreen,
  validateSearch: sheetSearchOf,
});

const inboxChildren = [
  createRoute({ getParentRoute: () => inboxRoute, path: "/" }),
  createRoute({ getParentRoute: () => inboxRoute, path: "projects/$project" }),
  createRoute({ getParentRoute: () => inboxRoute, path: "projects/$project/tickets/$ticket" }),
  createRoute({ getParentRoute: () => inboxRoute, path: "tickets/$itemProject/$ticket" }),
] as const;

const statsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "stats",
  component: StatsPage,
  validateSearch: statsSearchOf,
});

const terminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "terminal/$id",
  component: TerminalPage,
});

const routeTree = rootRoute.addChildren([inboxRoute.addChildren(inboxChildren), statsRoute, terminalRoute]);

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultErrorComponent: ErrorScreen,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
