// modules/ui/routes/launches.ts
//
// `/api/launches`: the verbs the dashboard triggered for one item, and the tail
// of one launch's log.

import type { UiDeps } from "../deps.js";
import { sendError, sendJson, sendNotFound } from "../http/respond.js";
import type { Route, RouteRequest } from "./route.js";

/** Lines of a launch log shown for a failure before run (spec 5.2). */
const LOG_TAIL_LINES = 20;
const LOG_TAIL_MAX_LINES = 200;

/** Launches of one item, newest first: `GET /api/launches?item=<project>/<ticket>`. */
function handleLaunches({ res, url }: RouteRequest, deps: UiDeps): void {
  const key = url.searchParams.get("item");
  const cut = key ? key.indexOf("/") : -1;
  if (!key || cut <= 0 || cut === key.length - 1) {
    sendError(res, 400, "query parameter `item` must be `<project>/<ticket>`");
    return;
  }
  sendJson(res, 200, { launches: deps.readModel.launches(key.slice(0, cut), key.slice(cut + 1)) });
}

/** Tail of a launch log: `GET /api/launches/<id>/log?lines=20`. */
function handleLaunchLog({ res, url }: RouteRequest, id: string, deps: UiDeps): void {
  const requested = Number(url.searchParams.get("lines") ?? LOG_TAIL_LINES);
  const lines = Number.isInteger(requested) && requested > 0 ? Math.min(requested, LOG_TAIL_MAX_LINES) : LOG_TAIL_LINES;
  const tail = deps.home.launches.logTail(id, lines);
  if (tail.status === "not-found") {
    sendError(res, 404, "unknown launch");
    return;
  }
  sendJson(res, 200, tail);
}

export const launchesRoute: Route = {
  access: "open",
  methods: ["GET"],
  handle(request, deps) {
    const { rest } = request;
    if (rest.length === 0) handleLaunches(request, deps);
    else if (rest.length === 2 && rest[1] === "log" && rest[0]) handleLaunchLog(request, rest[0], deps);
    else sendNotFound(request.res);
  },
};
