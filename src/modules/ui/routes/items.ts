// modules/ui/routes/items.ts
//
// `/api/items`: the inbox, one item's detail, the files of its work item, and
// one step of its run.
//
// A project and a ticket are never used to build a path here: the read model
// answers from the projects it lists itself, so an unlisted project or an
// unknown ticket is a 404 before any directory is opened, and a file path is
// resolved by the read model, which checks containment lexically and again
// after `realpath`.

import type { Item } from "../../read-model/index.js";
import type { UiDeps } from "../deps.js";
import { renderMarkdown } from "../markdown.js";
import { sendError, sendJson, sendNotFound } from "../http/respond.js";
import { actionable } from "../verbs.js";
import type { Route, RouteRequest } from "./route.js";

/** The item, or `undefined` once the 404 is sent. */
async function requireItem(
  { res }: RouteRequest,
  project: string,
  ticket: string,
  deps: UiDeps,
): Promise<Item | undefined> {
  const item = await deps.readModel.item(project, ticket);
  if (!item) sendError(res, 404, "unknown work item");
  return item;
}

/** The `path` query parameter, or `undefined` once the 400 is sent. */
function requirePath({ res, url }: RouteRequest): string | undefined {
  const path = url.searchParams.get("path");
  if (!path) sendError(res, 400, "query parameter `path` is required");
  return path ?? undefined;
}

/** One item, with everything the detail pane shows: the item, its folder tree,
 *  its run's steps, the run's recap, and its delivery report. Reads of the same
 *  work item, answered in one round-trip because the pane shows them together. */
async function handleItem(request: RouteRequest, project: string, ticket: string, deps: UiDeps): Promise<void> {
  const item = await requireItem(request, project, ticket, deps);
  if (!item) return;
  const { readModel } = deps;
  sendJson(request.res, 200, {
    item: actionable(item),
    tree: readModel.tree(project, ticket) ?? null,
    steps: readModel.steps(project, ticket) ?? null,
    recap: readModel.recap(project, ticket) ?? null,
    ...(readModel.report(project, ticket) ?? { report: null }),
  });
}

/**
 * One file of a work item.
 *
 * `render=html` turns a markdown file into HTML through the home-made renderer,
 * which escapes the source before rendering; the raw text is returned alongside,
 * so the browser can show either without a second request. Every other kind is
 * returned as the read model produced it — text, or base64 for an image.
 */
async function handleFile(request: RouteRequest, project: string, ticket: string, deps: UiDeps): Promise<void> {
  if (!(await requireItem(request, project, ticket, deps))) return;
  const path = requirePath(request);
  if (!path) return;

  const { res, url } = request;
  const file = deps.readModel.file(project, ticket, path);
  if (file.status === "denied") {
    sendError(res, 403, file.reason, { relativePath: file.relativePath });
    return;
  }
  if (file.status === "not-found") {
    sendError(res, 404, "file not found", { relativePath: file.relativePath });
    return;
  }
  if (file.status === "too-large" || file.contentKind !== "md" || url.searchParams.get("render") !== "html") {
    sendJson(res, 200, file);
    return;
  }
  sendJson(res, 200, { ...file, html: renderMarkdown(file.content) });
}

/**
 * One step of the item's run, opened from the timeline: `?id=<step>` and an
 * optional `&attempt=<n>`. Read on demand, never folded into the item detail:
 * it parses the whole journal, which the poll has no reason to pay for.
 */
async function handleStep(request: RouteRequest, project: string, ticket: string, deps: UiDeps): Promise<void> {
  if (!(await requireItem(request, project, ticket, deps))) return;
  const { res, url } = request;
  const stepId = url.searchParams.get("id");
  if (!stepId) {
    sendError(res, 400, "query parameter `id` is required");
    return;
  }
  const rawAttempt = url.searchParams.get("attempt");
  const attempt = rawAttempt === null ? undefined : Number(rawAttempt);
  if (attempt !== undefined && !(Number.isInteger(attempt) && attempt > 0)) {
    sendError(res, 400, "query parameter `attempt` must be a positive integer");
    return;
  }
  const detail = deps.readModel.step(project, ticket, stepId, attempt);
  if (!detail) {
    sendError(res, 404, "unknown step");
    return;
  }
  sendJson(res, 200, detail);
}

/**
 * One image of a work item, as raw bytes, for an `<img src>`.
 *
 * The one binary answer of the API. It may be cached privately for a short
 * while: a screenshot of a finished run does not change, and a gallery reloaded
 * on every poll of the sheet would fetch every image again.
 */
async function handleRaw(request: RouteRequest, project: string, ticket: string, deps: UiDeps): Promise<void> {
  if (!(await requireItem(request, project, ticket, deps))) return;
  const path = requirePath(request);
  if (!path) return;

  const { res } = request;
  const image = deps.readModel.image(project, ticket, path);
  if (image.status === "denied") {
    sendError(res, 403, image.reason, { relativePath: path });
    return;
  }
  if (image.status === "not-found") {
    sendError(res, 404, "file not found", { relativePath: path });
    return;
  }
  res.writeHead(200, {
    "Content-Type": image.mime,
    "Content-Length": String(image.bytes.byteLength),
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(image.bytes);
}

export const itemsRoute: Route = {
  access: "open",
  methods: ["GET"],
  async handle(request, deps) {
    const { res, rest } = request;
    if (rest.length === 0) {
      sendJson(res, 200, { items: (await deps.readModel.items()).map(actionable) });
      return;
    }
    // A ticket is one path segment: a nested work item gets no item of its own,
    // and its files are reachable through its parent's explorer.
    const [project, ticket, ...tail] = rest;
    if (!project || !ticket || tail.length > 1) {
      sendNotFound(res);
      return;
    }
    if (tail.length === 0) await handleItem(request, project, ticket, deps);
    else if (tail[0] === "file") await handleFile(request, project, ticket, deps);
    else if (tail[0] === "raw") await handleRaw(request, project, ticket, deps);
    else if (tail[0] === "step") await handleStep(request, project, ticket, deps);
    else sendNotFound(res);
  },
};
