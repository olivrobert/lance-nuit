// The only place the front end talks to the server.
//
// Two call shapes, because the two kinds of caller want different things:
//
//   reads  (`fetch*`)  resolve with the answer or throw an `ApiError`. They are
//                      the query functions of `queries.ts`, and a thrown error is
//                      what TanStack Query records as the query's `error` while
//                      it keeps the last good data on screen.
//   writes (`post*`)   resolve with an `ApiResult` and never throw on a refusal:
//                      the server answers one with a JSON body carrying `error`,
//                      and the caller turns it into a toast or a form message.
//                      A thrown exception is then only a network failure.
//
// Paths are built with `encodeURIComponent` on every segment. A project name and
// a ticket token both come from disk, so neither is trusted to be URL-safe.

import type {
  ActionResponse,
  FileView,
  Item,
  ItemDetail,
  ItemsResponse,
  LaunchLog,
  MeResponse,
  PipelinesResponse,
  ProjectsResponse,
  RunResponse,
  StatsRead,
  RunJourney,
  StepDetail,
  TerminalInfo,
  TerminalsResponse,
} from "./types.js";

/** A read the server refused: its status, and the reason its body gave. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** The outcome of a write. A refusal keeps the body: a 409 on `POST /api/runs`
 *  still names the session already running, which is where the reader goes. */
export type ApiResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; error: string; body: Partial<T> };

type ErrorBody = { error?: unknown };

function reasonOf(status: number, body: ErrorBody): string {
  return typeof body.error === "string" && body.error !== "" ? body.error : `error ${status}`;
}

async function bodyOf(response: Response): Promise<ErrorBody> {
  const body: unknown = await response.json().catch(() => ({}));
  return typeof body === "object" && body !== null ? (body as ErrorBody) : {};
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const body = await bodyOf(response);
  if (!response.ok) throw new ApiError(response.status, reasonOf(response.status, body));
  return body as T;
}

async function postJson<T>(url: string, payload: unknown): Promise<ApiResult<T>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await bodyOf(response);
  return response.ok
    ? { ok: true, status: response.status, body: body as T }
    : { ok: false, status: response.status, error: reasonOf(response.status, body), body: body as Partial<T> };
}

function itemUrl(project: string, ticket: string, suffix = ""): string {
  return `/api/items/${encodeURIComponent(project)}/${encodeURIComponent(ticket)}${suffix}`;
}

export function fetchMe(): Promise<MeResponse> {
  return getJson<MeResponse>("/api/me");
}

export function chooseUser(user: string): Promise<ApiResult<MeResponse>> {
  return postJson<MeResponse>("/api/me", { user });
}

export function fetchProjects(): Promise<ProjectsResponse> {
  return getJson<ProjectsResponse>("/api/projects");
}

export function writeProject(action: "add" | "remove", path: string): Promise<ApiResult<ProjectsResponse>> {
  return postJson<ProjectsResponse>("/api/projects", { action, path });
}

export function fetchItems(): Promise<ItemsResponse> {
  return getJson<ItemsResponse>("/api/items");
}

/** Every ticket's cost and duration. Asked for by the stats screen when it
 *  opens and on a manual refresh, never by the poll. */
export function fetchStats(): Promise<StatsRead> {
  return getJson<StatsRead>("/api/stats");
}

export function fetchItemDetail(project: string, ticket: string): Promise<ItemDetail> {
  return getJson<ItemDetail>(itemUrl(project, ticket));
}

/** One file of a work item. `render: "html"` asks the server for the rendered
 *  markdown alongside the source; the raw text is only wanted for a file the
 *  front end parses itself, such as `assumptions.json`. */
export function fetchFile(
  item: Pick<Item, "project" | "ticket">,
  path: string,
  render: "html" | "raw" = "html",
): Promise<FileView> {
  const query = `?path=${encodeURIComponent(path)}${render === "html" ? "&render=html" : ""}`;
  return getJson<FileView>(itemUrl(item.project.name, item.ticket, `/file${query}`));
}

/** One step of the item's run, opened from the timeline. Without `attempt` the
 *  server picks the last one. */
export function fetchStepDetail(
  item: Pick<Item, "project" | "ticket">,
  stepId: string,
  attempt?: number,
): Promise<StepDetail> {
  const query = `?id=${encodeURIComponent(stepId)}${attempt !== undefined ? `&attempt=${attempt}` : ""}`;
  return getJson<StepDetail>(itemUrl(item.project.name, item.ticket, `/step${query}`));
}

/** Every attempt and pause of the item's run. */
export function fetchRunJourney(item: Pick<Item, "project" | "ticket">): Promise<RunJourney> {
  return getJson<RunJourney>(itemUrl(item.project.name, item.ticket, "/journey"));
}

/** Address of one image of a work item as raw bytes, for an `<img src>`: a
 *  gallery cannot afford one base64 JSON round-trip per screenshot. */
export function rawFileUrl(item: Pick<Item, "project" | "ticket">, path: string): string {
  return itemUrl(item.project.name, item.ticket, `/raw?path=${encodeURIComponent(path)}`);
}

export function fetchLaunchLog(id: string, lines: number): Promise<Omit<Extract<LaunchLog, { status: "ok" }>, "id">> {
  return getJson(`/api/launches/${encodeURIComponent(id)}/log?lines=${lines}`);
}

/** The payload of every action: the item, plus the pipeline and run id the sheet
 *  was showing. The server compares them with the disk and refuses the click
 *  when the item moved, so a verb is never applied to a run nobody saw. */
export interface ActionPayload {
  project: string;
  ticket: string;
  pipeline: string;
  runId: string;
  subject?: string;
  budget?: number;
  reason?: string;
}

export function postAction(verb: string, payload: ActionPayload): Promise<ApiResult<ActionResponse>> {
  return postJson<ActionResponse>(`/api/actions/${encodeURIComponent(verb)}`, payload);
}

/** Pipeline names a project can run, for the launch dialog's select. */
export function fetchPipelines(project: string): Promise<PipelinesResponse> {
  return getJson<PipelinesResponse>(`/api/projects/${encodeURIComponent(project)}/pipelines`);
}

/** What the launch dialog posts. The server builds the command from it; the
 *  browser never sends a command line. */
export interface RunPayload {
  project: string;
  ticket: string;
  pipeline: string;
  worktree: boolean;
}

export function postRun(payload: RunPayload): Promise<ApiResult<RunResponse>> {
  return postJson<RunResponse>("/api/runs", payload);
}

/** One attempt of a step, whose agent session is reopened. */
export interface StepAttemptTarget {
  step: string;
  attempt: number;
}

/** Reopen an agent session of an item's run in a terminal of its own: the
 *  coder's, or the one `target` left. */
export function postAgentSession(
  project: string,
  ticket: string,
  target?: StepAttemptTarget,
): Promise<ApiResult<RunResponse>> {
  return postJson<RunResponse>("/api/sessions", { project, ticket, ...target });
}

function terminalUrl(id: string, suffix = ""): string {
  return `/api/terminals/${encodeURIComponent(id)}${suffix}`;
}

export function fetchTerminals(): Promise<TerminalsResponse> {
  return getJson<TerminalsResponse>("/api/terminals");
}

export function fetchTerminal(id: string): Promise<TerminalInfo> {
  return getJson<TerminalInfo>(terminalUrl(id));
}

/** The SSE stream of one viewer, opened at the size xterm fitted to. */
export function terminalStreamUrl(id: string, cols: number, rows: number): string {
  return terminalUrl(id, `/stream?cols=${cols}&rows=${rows}`);
}

/** `viewer` is the token of the stream's `hello` event: input and resize are
 *  refused without the stream that owns them. */
export function postTerminalInput(id: string, viewer: string, data: string): Promise<ApiResult<unknown>> {
  return postJson<unknown>(terminalUrl(id, "/input"), { viewer, data });
}

export function postTerminalResize(
  id: string,
  viewer: string,
  cols: number,
  rows: number,
): Promise<ApiResult<unknown>> {
  return postJson<unknown>(terminalUrl(id, "/resize"), { viewer, cols, rows });
}

/** Kill the tmux session itself, not only this viewer. */
export function killTerminal(id: string): Promise<ApiResult<unknown>> {
  return postJson<unknown>(terminalUrl(id, "/kill"), {});
}
