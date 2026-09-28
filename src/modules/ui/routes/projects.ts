// modules/ui/routes/projects.ts
//
// `/api/projects`: the project list, its edits, and each project's pipelines.

import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { listPipelineFiles } from "../../../env/builtin-pipeline.js";
import { type ProjectEntry, ticketPrefixOf } from "../../read-model/index.js";
import type { UiDeps } from "../deps.js";
import { readJsonBody } from "../http/body.js";
import { identityOf } from "../http/identity.js";
import { sendError, sendJson, sendNotFound } from "../http/respond.js";
import type { Route, RouteRequest } from "./route.js";

/** A project as `/api/projects` answers it. The ticket prefix comes from the
 *  project's provider, which the read model does not compose. */
export interface ProjectView extends ProjectEntry {
  ticketPrefix?: string;
}

function projectViews(deps: UiDeps): ProjectView[] {
  return deps.readModel.projects().map((project) => {
    const ticketPrefix = ticketPrefixOf(project, deps.workItems);
    return ticketPrefix ? { ...project, ticketPrefix } : project;
  });
}

/** Pipeline names of a project: the basenames of the kit chain's files. */
export function projectPipelines(project: ProjectEntry): string[] {
  return [...new Set(listPipelineFiles(project.cwd).map((path) => basename(path, ".ts")))].sort();
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `GET /api/projects/<name>/pipelines`. */
function handlePipelines({ res }: RouteRequest, name: string, deps: UiDeps): void {
  const project = deps.readModel.project(name);
  if (!project) {
    sendError(res, 404, "unknown project");
    return;
  }
  sendJson(res, 200, { pipelines: project.found ? deps.terminals.listPipelines(project) : [] });
}

/**
 * Add or remove a project path.
 *
 * Adding refuses a path that is not a directory today: the reader typed it, so
 * a typo is worth reporting at once. Removing accepts anything, because the
 * whole point of the button is to drop a path that no longer exists.
 */
async function handleProjectWrite({ req, res }: RouteRequest, deps: UiDeps): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendError(res, 400, body.reason);
    return;
  }
  const payload = (body.value ?? {}) as { action?: unknown; path?: unknown };
  const action = payload.action === undefined ? "add" : payload.action;
  if (action !== "add" && action !== "remove") {
    sendError(res, 400, "field `action` must be `add` or `remove`");
    return;
  }
  if (typeof payload.path !== "string" || payload.path.trim().length === 0) {
    sendError(res, 400, "field `path` is required");
    return;
  }

  const absolute = resolve(payload.path.trim());
  if (action === "add" && !isDirectory(absolute)) {
    sendError(res, 400, `not a directory: ${absolute}`);
    return;
  }

  const { projects } = deps.home;
  const write = action === "add" ? projects.add(absolute) : projects.remove(absolute);
  if (write.status === "error") {
    sendError(res, 500, write.reason);
    return;
  }
  sendJson(res, 200, { projects: projectViews(deps) });
}

export const projectsRoute: Route = {
  access: "open",
  methods: ["GET", "POST"],
  async handle(request, deps) {
    const { req, res, method, rest } = request;
    if (rest.length === 2 && rest[1] === "pipelines" && rest[0] && method === "GET") {
      handlePipelines(request, rest[0], deps);
      return;
    }
    if (rest.length > 0) {
      sendNotFound(res);
      return;
    }
    if (method === "GET") {
      sendJson(res, 200, { projects: projectViews(deps) });
      return;
    }
    // Every write is attributed, so an anonymous browser cannot change what the
    // dashboard reads (spec 5.3).
    if (!identityOf(req, deps.home.users).user) {
      sendError(res, 403, "choose a name before changing the project list");
      return;
    }
    await handleProjectWrite(request, deps);
  },
};
