// modules/ui/routes/runs.ts
//
// `POST /api/runs`: start an interactive run in a new tmux session.

import { readJsonBody } from "../http/body.js";
import { sendError, sendJson, sendNotFound } from "../http/respond.js";
import { startRun } from "../terminals.js";
import type { Route } from "./route.js";

/**
 * The route owns the HTTP shape — body, project lookup — and `startRun` owns
 * every other refusal, so the order of the checks lives in one place.
 */
export const runsRoute: Route = {
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
    if (payload.worktree !== undefined && typeof payload.worktree !== "boolean") {
      sendError(res, 400, "field `worktree` must be a boolean");
      return;
    }
    const project = deps.readModel.project(payload.project);
    if (!project) {
      sendError(res, 404, "unknown project");
      return;
    }

    const { terminals, readModel } = deps;
    const started = await startRun(
      { project, ticket: payload.ticket, pipeline: payload.pipeline, worktree: payload.worktree === true, by },
      {
        tmux: terminals.tmux,
        workItems: deps.workItems,
        listPipelines: terminals.listPipelines,
        findItem: (entry, ticket) => readModel.item(entry.name, ticket),
        paneCommand: terminals.paneCommand,
        shell: terminals.shell,
      },
    );
    if (!started.ok) {
      sendError(res, started.status, started.reason, started.terminal ? { terminal: started.terminal } : {});
      return;
    }
    sendJson(res, 201, { terminal: started.terminal });
  },
};
