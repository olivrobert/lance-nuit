// modules/ui/routes/route.ts
//
// The shape of one `/api/<resource>` route. The router owns what every route
// shares — Host, origin, method, and the operator guard — and hands a route the
// segments after its resource; the route owns everything below that.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { UiDeps } from "../deps.js";

export type ApiMethod = "GET" | "POST";

export interface RouteRequest {
  req: IncomingMessage;
  res: ServerResponse;
  method: ApiMethod;
  url: URL;
  /** Decoded path segments after `/api/<resource>`. */
  rest: string[];
}

type Answer = void | Promise<void>;

/**
 * An `open` route answers anyone the router let through. An `operator` route
 * reaches a shell: the router lets it run only for a declared name on a
 * same-origin request, reads included, and hands it that name.
 */
export type Route =
  | { access: "open"; methods: readonly ApiMethod[]; handle(request: RouteRequest, deps: UiDeps): Answer }
  | {
      access: "operator";
      methods: readonly ApiMethod[];
      handle(request: RouteRequest, deps: UiDeps, user: string): Answer;
    };
