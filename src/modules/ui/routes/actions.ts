// modules/ui/routes/actions.ts
//
// `POST /api/actions/<verb>`: one verb on one item (spec 5).

import { isTicketToken, validateTicketRef } from "../../read-model/index.js";
import type { UiDeps } from "../deps.js";
import { readJsonBody } from "../http/body.js";
import { identityOf } from "../http/identity.js";
import { sendError, sendJson, sendNotFound } from "../http/respond.js";
import { buildArgv, isVerb } from "../verbs.js";
import type { Route, RouteRequest } from "./route.js";

/**
 * The checks run in the order of spec 5.3 — identity, verb, project, ticket,
 * then the situation — and every one of them answers before a process exists.
 * The body names the item and may repeat the pipeline and run id the browser
 * saw: when either disagrees with the disk, the item moved under the reader's
 * cursor and the click is refused rather than applied to a run they never saw.
 */
async function handleAction({ req, res }: RouteRequest, verb: string, deps: UiDeps): Promise<void> {
  const identity = identityOf(req, deps.home.users);
  if (!identity.user) {
    sendError(res, 403, "choose a name before launching anything");
    return;
  }
  if (!isVerb(verb)) {
    sendError(res, 404, `unknown verb "${verb}"`);
    return;
  }

  const body = await readJsonBody(req);
  if (!body.ok) {
    sendError(res, 400, body.reason);
    return;
  }
  const payload = (body.value ?? {}) as Record<string, unknown>;
  if (typeof payload.project !== "string" || !isTicketToken(payload.ticket)) {
    sendError(res, 400, "fields `project` and `ticket` are required");
    return;
  }

  const project = deps.readModel.project(payload.project);
  if (!project) {
    sendError(res, 404, "unknown project");
    return;
  }
  const ticket = payload.ticket;
  const reference = validateTicketRef(project, ticket, deps.workItems);
  if (!reference.ok) {
    sendError(res, 400, reference.reason);
    return;
  }
  const item = await deps.readModel.item(project.name, ticket);
  if (!item) {
    sendError(res, 404, "unknown work item");
    return;
  }
  if (typeof payload.pipeline === "string" && payload.pipeline !== item.pipeline) {
    sendError(res, 409, "the item's pipeline changed; reload the page", { item });
    return;
  }
  if (typeof payload.runId === "string" && payload.runId !== item.runId) {
    sendError(res, 409, "the item's run changed; reload the page", { item });
    return;
  }

  const argv = buildArgv(item, verb, { subject: payload.subject, budget: payload.budget });
  if (!argv.ok) {
    sendError(res, argv.status, argv.reason, { item });
    return;
  }
  const launched = deps.launcher.launch({ item, verb, argv: argv.argv, by: identity.user });
  if (!launched.ok) {
    sendError(res, launched.status, launched.reason);
    return;
  }
  sendJson(res, 202, { launch: launched.launch });
}

export const actionsRoute: Route = {
  access: "open",
  methods: ["POST"],
  async handle(request, deps) {
    const [verb, ...tail] = request.rest;
    if (verb && tail.length === 0) await handleAction(request, verb, deps);
    else sendNotFound(request.res);
  },
};
