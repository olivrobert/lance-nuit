// modules/ui/routes/me.ts
//
// `/api/me`: who the reader is, and choosing a name.

import { clearedUserCookie, userCookie } from "../cookies.js";
import type { UiDeps } from "../deps.js";
import { readJsonBody } from "../http/body.js";
import { identityOf } from "../http/identity.js";
import { sendError, sendJson, sendNotFound } from "../http/respond.js";
import type { Route, RouteRequest } from "./route.js";

/**
 * Who the reader is.
 *
 * A cookie naming someone who is no longer declared is answered with 401 AND
 * cleared: the browser drops it, and the choice page is what the reader gets
 * next instead of a name that silently does nothing.
 */
function handleMe({ req, res }: RouteRequest, { home }: UiDeps): void {
  const identity = identityOf(req, home.users);
  const users = home.users.list();
  if (identity.user) {
    sendJson(res, 200, { user: identity.user, users });
    return;
  }
  if (identity.claimed) {
    sendJson(res, 401, { user: null, users, error: "unknown user" }, { "Set-Cookie": clearedUserCookie() });
    return;
  }
  sendJson(res, 200, { user: null, users });
}

async function handleMeWrite({ req, res }: RouteRequest, { home }: UiDeps): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendError(res, 400, body.reason);
    return;
  }
  const name = (body.value as { user?: unknown } | null)?.user;
  if (typeof name !== "string" || name.trim().length === 0) {
    sendError(res, 400, "field `user` is required");
    return;
  }
  const users = home.users.list();
  const chosen = name.trim();
  if (!home.users.isKnown(chosen)) {
    sendJson(res, 401, { user: null, users, error: "unknown user" }, { "Set-Cookie": clearedUserCookie() });
    return;
  }
  sendJson(res, 200, { user: chosen, users }, { "Set-Cookie": userCookie(chosen) });
}

export const meRoute: Route = {
  access: "open",
  methods: ["GET", "POST"],
  async handle(request, deps) {
    if (request.rest.length > 0) {
      sendNotFound(request.res);
      return;
    }
    if (request.method === "POST") await handleMeWrite(request, deps);
    else handleMe(request, deps);
  },
};
