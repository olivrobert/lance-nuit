//
// `/api/v1/`: the read API, version 1, for readers outside the dashboard.
//
//   GET /api/v1/runs?project=&ticket=&status=&since=&current=&limit=
//   GET /api/v1/runs/<project>/<ticket>/<runId>
//
// Unlike the rest of `/api/`, whose shapes follow the front end, these answers
// are a published contract (`read-model/read-api.schema.ts`). This route only
// turns a query string into filters and a filter error into a 400; what a run
// is comes from the read model. Every answer, errors included, carries the CORS
// headers of `http/cors.ts`, so a page allowed to read the API can also read
// why a request was refused.

import { parseAge } from "../../../shared/lib/durations.js";
import { API_RUN_STATUSES, type ApiRunFilters, type ApiRunStatus } from "../../read-model/index.js";
import { corsHeadersFor } from "../http/cors.js";
import { sendJson } from "../http/respond.js";
import type { Route } from "./route.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

type Parsed<T> = { value: T } | { error: string };

function isStatus(value: string): value is ApiRunStatus {
  return (API_RUN_STATUSES as readonly string[]).includes(value);
}

/** `status=PASS,FAIL` and `status=PASS&status=FAIL` mean the same. */
function parseStatuses(params: URLSearchParams): Parsed<ApiRunStatus[] | undefined> {
  const values = params
    .getAll("status")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value.length > 0);
  if (values.length === 0) return { value: undefined };
  const unknown = values.find((value) => !isStatus(value));
  if (unknown !== undefined) {
    return { error: `status: unknown value "${unknown}" (expected ${API_RUN_STATUSES.join(", ")})` };
  }
  return { value: values.filter(isStatus) };
}

/** A duration back from now (`30d`, `12h`) or an ISO 8601 instant. */
function parseSince(value: string | null, now: number): Parsed<number | undefined> {
  if (value === null || value.trim().length === 0) return { value: undefined };
  try {
    return { value: now - parseAge(value) };
  } catch {
    // Not a duration: an instant is the other accepted spelling.
    const instant = Date.parse(value);
    if (Number.isFinite(instant)) return { value: instant };
    return { error: `since: expected a duration such as 30d or 12h, or an ISO 8601 instant (received "${value}")` };
  }
}

function parseCurrent(value: string | null): Parsed<boolean | undefined> {
  if (value === null || value === "false") return { value: undefined };
  if (value === "true") return { value: true };
  return { error: `current: expected true or false (received "${value}")` };
}

function parseLimit(value: string | null): Parsed<number> {
  if (value === null) return { value: DEFAULT_LIMIT };
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return { error: `limit: expected an integer from 1 to ${MAX_LIMIT} (received "${value}")` };
  }
  return { value: limit };
}

function text(value: string | null): string | undefined {
  return value !== null && value.length > 0 ? value : undefined;
}

/** The filters of a `GET /api/v1/runs` query. Unknown parameters are ignored, so
 *  a reader written for a later version still gets an answer. */
export function parseRunFilters(params: URLSearchParams, now = Date.now()): Parsed<ApiRunFilters> {
  const statuses = parseStatuses(params);
  if ("error" in statuses) return statuses;
  const since = parseSince(params.get("since"), now);
  if ("error" in since) return since;
  const current = parseCurrent(params.get("current"));
  if ("error" in current) return current;
  const limit = parseLimit(params.get("limit"));
  if ("error" in limit) return limit;
  const project = text(params.get("project"));
  const ticket = text(params.get("ticket"));
  return {
    value: {
      ...(project ? { project } : {}),
      ...(ticket ? { ticket } : {}),
      ...(statuses.value ? { statuses: statuses.value } : {}),
      ...(since.value !== undefined ? { sinceMs: since.value } : {}),
      ...(current.value ? { currentOnly: true } : {}),
      limit: limit.value,
    },
  };
}

export const v1Route: Route = {
  access: "open",
  methods: ["GET"],
  async handle({ req, res, url, rest }, deps) {
    const headers = corsHeadersFor(req, deps.corsOrigins);
    const notFound = (): void => sendJson(res, 404, { error: "not found" }, headers);
    const [resource, ...path] = rest;
    if (resource !== "runs") {
      notFound();
      return;
    }

    if (path.length === 0) {
      const filters = parseRunFilters(url.searchParams);
      if ("error" in filters) {
        sendJson(res, 400, { error: filters.error }, headers);
        return;
      }
      sendJson(res, 200, await deps.readModel.apiRuns(filters.value), headers);
      return;
    }

    const [project, ticket, runId] = path;
    if (path.length !== 3 || !project || !ticket || !runId) {
      notFound();
      return;
    }
    const run = await deps.readModel.apiRun(project, ticket, runId);
    if (run) sendJson(res, 200, run, headers);
    else notFound();
  },
};
