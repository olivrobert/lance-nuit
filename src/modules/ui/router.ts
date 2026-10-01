// modules/ui/router.ts
//
// One request to one route. The router owns every check that does not depend
// on the resource — path decoding, Host, method, origin — and the operator
// guard of the routes that reach a shell. What lies below `/api/<resource>` is
// the route's business.

import type { IncomingMessage, ServerResponse } from "node:http";
import { UI_HOST } from "../../lib/ui-defaults.js";
import type { UiDeps } from "./deps.js";
import { isExpectedHost, isSameOrigin, pathSegments } from "./http/guards.js";
import { identityOf } from "./http/identity.js";
import { sendError, sendMethodNotAllowed, sendNotFound } from "./http/respond.js";
import { actionsRoute } from "./routes/actions.js";
import { itemsRoute } from "./routes/items.js";
import { launchesRoute } from "./routes/launches.js";
import { meRoute } from "./routes/me.js";
import { projectsRoute } from "./routes/projects.js";
import type { ApiMethod, Route } from "./routes/route.js";
import { runsRoute } from "./routes/runs.js";
import { sessionsRoute } from "./routes/sessions.js";
import { serveStatic } from "./routes/static.js";
import { statsRoute } from "./routes/stats.js";
import { terminalsRoute } from "./routes/terminals.js";

const ROUTES: Readonly<Record<string, Route>> = {
  me: meRoute,
  projects: projectsRoute,
  items: itemsRoute,
  stats: statsRoute,
  launches: launchesRoute,
  runs: runsRoute,
  sessions: sessionsRoute,
  terminals: terminalsRoute,
  actions: actionsRoute,
};

/** Where the server listens: the only names a request may arrive under. */
export interface Origin {
  host: string;
  port: number;
}

function isApiMethod(method: string): method is ApiMethod {
  return method === "GET" || method === "POST";
}

export async function route(req: IncomingMessage, res: ServerResponse, deps: UiDeps, origin: Origin): Promise<void> {
  const { host, port } = origin;
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${UI_HOST}:${port}`);
  const segments = pathSegments(url.pathname);
  if (!segments) {
    sendError(res, 400, "malformed request path");
    return;
  }

  if (segments[0] !== "api") {
    if (method !== "GET" && method !== "HEAD") {
      sendMethodNotAllowed(res);
      return;
    }
    serveStatic(req, res, url.pathname);
    return;
  }

  if (!isExpectedHost(req, host, port)) {
    sendError(res, 403, "unexpected Host header");
    return;
  }
  if (!isApiMethod(method)) {
    sendMethodNotAllowed(res);
    return;
  }
  if (method === "POST" && !isSameOrigin(req, host, port)) {
    sendError(res, 403, "cross-origin request refused");
    return;
  }

  const [, resource, ...rest] = segments;
  const target = resource !== undefined && Object.hasOwn(ROUTES, resource) ? ROUTES[resource] : undefined;
  if (!target?.methods.includes(method)) {
    sendNotFound(res);
    return;
  }
  const request = { req, res, method, url, rest };
  if (target.access === "open") {
    await target.handle(request, deps);
    return;
  }

  const user = identityOf(req, deps.home.users).user;
  if (!user) {
    sendError(res, 403, "choose a name before opening a terminal");
    return;
  }
  // Reads are guarded too: a terminal's output is as sensitive as its input.
  if (!isSameOrigin(req, host, port)) {
    sendError(res, 403, "cross-origin request refused");
    return;
  }
  await target.handle(request, deps, user);
}
