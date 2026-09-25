// The only place the front end talks to the server.
//
// Every call goes through `getJson` / `postJson`, which never throw on a non-2xx
// answer: the server answers a refusal with a JSON body carrying `error`, and
// the caller wants that body as much as it wants the status. A thrown exception
// here would be a network failure, and it is the store — not this file — that
// decides what a reader is told about it.
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
  TerminalInfo,
  TerminalsResponse,
} from "./types.js";

/** What every call returns: the status, whether it was a success, and the body
 *  the server sent — an answer or an `{ error }`. */
export interface ApiResult<T> {
  ok: boolean;
  status: number;
  body: Partial<T> & { error?: string };
}

export async function getJson<T>(url: string): Promise<ApiResult<T>> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body: body as Partial<T> & { error?: string } };
}

export async function postJson<T>(url: string, payload: unknown): Promise<ApiResult<T>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body: body as Partial<T> & { error?: string } };
}

function itemUrl(project: string, ticket: string, suffix = ""): string {
  return `/api/items/${encodeURIComponent(project)}/${encodeURIComponent(ticket)}${suffix}`;
}

export function fetchMe(): Promise<ApiResult<MeResponse>> {
  return getJson<MeResponse>("/api/me");
}

export function chooseUser(user: string): Promise<ApiResult<MeResponse>> {
  return postJson<MeResponse>("/api/me", { user });
}

export function fetchProjects(): Promise<ApiResult<ProjectsResponse>> {
  return getJson<ProjectsResponse>("/api/projects");
}

export function writeProject(action: "add" | "remove", path: string): Promise<ApiResult<ProjectsResponse>> {
  return postJson<ProjectsResponse>("/api/projects", { action, path });
}

export function fetchItems(): Promise<ApiResult<ItemsResponse>> {
  return getJson<ItemsResponse>("/api/items");
}

export function fetchItemDetail(project: string, ticket: string): Promise<ApiResult<ItemDetail>> {
  return getJson<ItemDetail>(itemUrl(project, ticket));
}

/** One file of a work item. `render: "html"` asks the server for the rendered
 *  markdown alongside the source; the raw text is only wanted for a file the
 *  front end parses itself, such as `assumptions.json`. */
export function fetchFile(
  item: Pick<Item, "project" | "ticket">,
  path: string,
  render: "html" | "raw" = "html",
): Promise<ApiResult<FileView>> {
  const query = `?path=${encodeURIComponent(path)}${render === "html" ? "&render=html" : ""}`;
  return getJson<FileView>(itemUrl(item.project.name, item.ticket, `/file${query}`));
}

/** Address of one image of a work item as raw bytes, for an `<img src>`: a
 *  gallery cannot afford one base64 JSON round-trip per screenshot. */
export function rawFileUrl(item: Pick<Item, "project" | "ticket">, path: string): string {
  return itemUrl(item.project.name, item.ticket, `/raw?path=${encodeURIComponent(path)}`);
}

export function fetchLaunchLog(id: string, lines: number): Promise<ApiResult<LaunchLog>> {
  return getJson<LaunchLog>(`/api/launches/${encodeURIComponent(id)}/log?lines=${lines}`);
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
}

export function postAction(verb: string, payload: ActionPayload): Promise<ApiResult<ActionResponse>> {
  return postJson<ActionResponse>(`/api/actions/${encodeURIComponent(verb)}`, payload);
}

/** Pipeline names a project can run, for the launch dialog's select. */
export function fetchPipelines(project: string): Promise<ApiResult<PipelinesResponse>> {
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

function terminalUrl(id: string, suffix = ""): string {
  return `/api/terminals/${encodeURIComponent(id)}${suffix}`;
}

export function fetchTerminals(): Promise<ApiResult<TerminalsResponse>> {
  return getJson<TerminalsResponse>("/api/terminals");
}

export function fetchTerminal(id: string): Promise<ApiResult<TerminalInfo>> {
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
