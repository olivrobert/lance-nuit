// modules/ui/routes/sessions.ts
//
// `POST /api/sessions`: reopen the coder session of an item's run in a new tmux
// session.

import { readJsonBody } from "../http/body.js";
import { sendError, sendJson, sendNotFound } from "../http/respond.js";
import { openCoderSession } from "../terminals.js";
import type { Route } from "./route.js";

/** As for `/api/runs`: the route owns the HTTP shape, `openCoderSession` every
 *  other refusal. */
export const sessionsRoute: Route = {
  access: "operator",
  methods: ["GET", "POST"],
  async handle({ req, res, method, rest }, deps, by) {
    if (rest.length > 0 || method !== "POST") {
      sendNotFound(res);
      return;
    }
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendError(res, 400, body.reason);
      return;
    }
    const payload = (body.value ?? {}) as Record<string, unknown>;
    if (typeof payload.project !== "string") {
      sendError(res, 400, "field `project` is required");
      return;
    }
    const project = deps.readModel.project(payload.project);
    if (!project) {
      sendError(res, 404, "unknown project");
      return;
    }

    const { terminals, readModel } = deps;
    const opened = await openCoderSession(
      { project, ticket: payload.ticket, by },
      {
        tmux: terminals.tmux,
        findSession: (entry, ticket) => readModel.coderSession(entry.name, ticket),
        findItem: (entry, ticket) => readModel.item(entry.name, ticket),
        sessionCommand: terminals.sessionCommand,
        shell: terminals.shell,
      },
    );
    if (!opened.ok) {
      sendError(res, opened.status, opened.reason, opened.terminal ? { terminal: opened.terminal } : {});
      return;
    }
    sendJson(res, 201, { terminal: opened.terminal });
  },
};
