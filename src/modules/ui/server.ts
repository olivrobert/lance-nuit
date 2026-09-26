// modules/ui/server.ts
//
// The dashboard's HTTP surface: `node:http`, no server framework.
//
// Two rules shape everything below.
//
// First, the host is passed to `listen` EXPLICITLY. Omitting it makes Node bind
// the unspecified address, which on most systems means every interface — a
// dashboard that drives a runner would then be reachable from the network
// instead of only through the SSH tunnel it is designed for.
//
// Second, no path from a request ever reaches the filesystem on trust. A project
// and a ticket are looked up in the read model's own results, so an unknown pair
// is a 404 before any directory is opened; a file path is resolved by the read
// model, which checks containment lexically and again after `realpath`.
//
// The module never imports `src/state`: every fact it serves comes from
// `src/modules/read-model/`, and a Semgrep `ERROR` rule fails the build if that
// direction is ever reversed.

import { statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, resolve } from "node:path";
import type { WorkItemGatewayRegistry } from "../../contracts/registry.js";
import { listPipelineFiles } from "../../env/builtin-pipeline.js";
import { DEFAULT_UI_PORT, UI_HOST } from "../../lib/ui-defaults.js";
import {
  type Item,
  isTicketToken,
  type ProjectEntry,
  listItems,
  readFile,
  readImage,
  readItem,
  readLaunchesFor,
  readProjects,
  readRecap,
  readReport,
  readSteps,
  readTree,
  validateTicketRef,
} from "../read-model/index.js";
import { buildArgv, isVerb, launchVerb, readLaunchLogTail, reconcileLaunches } from "./actions.js";
import { clearedUserCookie, parseCookies, USER_COOKIE, userCookie } from "./cookies.js";
import { renderMarkdown } from "./markdown.js";
import { matchesEtag, readStaticAsset } from "./static-files.js";
import { addProject, ensureUiFiles, isKnownUser, isValidUserName, readUsers, removeProject } from "./store.js";
import { type AttachSpawner, bunAttachSpawner, ViewerRegistry } from "./terminal-viewers.js";
import {
  findTerminal,
  isSessionId,
  listTerminals,
  operatorCommand,
  type PaneCommandBuilder,
  paneShell,
  startRun,
} from "./terminals.js";
import { Tmux } from "./tmux.js";

export { DEFAULT_UI_PORT, UI_HOST } from "../../lib/ui-defaults.js";

/** A JSON request body is a name or a path, never a document. */
const MAX_BODY_BYTES = 64 * 1024;

export interface UiServerOptions {
  /** Work-item providers used to validate a ticket reference. The dashboard
   *  resolves providers, it does not compose them: the caller passes the
   *  registry it composed. */
  workItems: WorkItemGatewayRegistry;
  port?: number;
  host?: string;
  env?: NodeJS.ProcessEnv;
  /** Executable spawned by the actions; defaults to this installation's
   *  `bin/lancenuit`. Tests point it at a script of their own. */
  launcher?: string;
  /** tmux adapter of the interactive runs; defaults to the `lancenuit` socket.
   *  Tests pass one on a socket of their own, or over a fake runner. */
  tmux?: Tmux;
  /** How a viewer's tmux client is spawned; defaults to a Bun PTY. */
  attach?: AttachSpawner;
  /** What is typed into a new run's pane; defaults to the operator agent. */
  paneCommand?: PaneCommandBuilder;
  /** Pipeline names of a project; defaults to the kit chain's list. */
  listPipelines?: (project: ProjectEntry) => string[];
}

/** Everything the terminal routes share for the lifetime of the server. The
 *  viewer registry in particular is ONE per server: a token handed out by one
 *  request is looked up by the next. */
interface TerminalContext {
  tmux: Tmux;
  viewers: ViewerRegistry;
  paneCommand: PaneCommandBuilder;
  listPipelines: (project: ProjectEntry) => string[];
  shell: string;
}

/** What every route needs to know about the server it runs in. */
interface RouteContext {
  env: NodeJS.ProcessEnv;
  host: string;
  port: number;
  terminals: TerminalContext;
  launcher?: string;
  workItems: WorkItemGatewayRegistry;
}

/** Bounds of a terminal size, on each axis. */
const MAX_TERMINAL_SIZE = 500;

/** Comment line sent on an idle stream, so neither side times it out. */
const STREAM_HEARTBEAT_MS = 15_000;

/** Lines of a launch log shown for a failure before run (spec 5.2). */
const LOG_TAIL_LINES = 20;
const LOG_TAIL_MAX_LINES = 200;

export interface RunningUiServer {
  server: Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

interface Identity {
  /** The name the cookie carries, whether or not it is still declared. */
  claimed?: string;
  /** The same name, only when `users.json` still lists it. */
  user?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf-8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(payload.byteLength),
    // The dashboard's own answers are never cacheable: the morning box is the
    // state of the disk right now.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string, extra: Record<string, unknown> = {}): void {
  sendJson(res, status, { error: message, ...extra });
}

/**
 * Read a JSON body, bounded.
 *
 * The cap is enforced while the body arrives, not after: a client that keeps
 * sending is disconnected rather than allowed to fill memory first.
 */
async function readJsonBody(
  req: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.byteLength;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return { ok: false, reason: "request body is too large" };
      }
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, reason: "request body could not be read" };
  }
  if (size === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf-8")) };
  } catch {
    return { ok: false, reason: "request body is not valid JSON" };
  }
}

/**
 * Cross-origin guard for every state-changing request.
 *
 * `SameSite=Strict` already stops a third-party page from sending the identity
 * cookie, but the tunnel makes `127.0.0.1:<port>` reachable from any page the
 * browser happens to have open, so the request itself is refused too. Both
 * headers are optional in a non-browser client (curl, a test), and absent is
 * treated as same-origin: the check exists to stop a browser being used as a
 * confused deputy, not to authenticate.
 */
function isSameOrigin(req: IncomingMessage, host: string, port: number): boolean {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return false;

  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0 || origin === "null") return true;
  return [`http://${host}:${port}`, `http://localhost:${port}`].includes(origin);
}

/**
 * DNS-rebinding guard for every `/api/*` request.
 *
 * A page on `evil.example` whose name was rebound to 127.0.0.1 reaches this
 * server as same-origin for the browser, and the terminal routes are a shell.
 * What the browser cannot forge is the `Host` header, which still names the
 * attacker's domain: only the two names this server is reached by are accepted.
 */
function isExpectedHost(req: IncomingMessage, host: string, port: number): boolean {
  const header = req.headers.host;
  return typeof header === "string" && [`${host}:${port}`, `localhost:${port}`].includes(header.toLowerCase());
}

function identityOf(req: IncomingMessage, env: NodeJS.ProcessEnv): Identity {
  const claimed = parseCookies(req.headers.cookie).get(USER_COOKIE);
  if (!isValidUserName(claimed)) return {};
  return isKnownUser(claimed, env) ? { claimed, user: claimed } : { claimed };
}

/** Split a URL path into decoded segments; `undefined` when a segment is not
 *  valid percent-encoding or hides a separator or a NUL byte. */
function pathSegments(pathname: string): string[] | undefined {
  const raw = pathname.split("/").filter((segment) => segment.length > 0);
  const segments: string[] = [];
  for (const segment of raw) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (decoded.includes("\0") || decoded.includes("/") || decoded.includes("\\")) return undefined;
    segments.push(decoded);
  }
  return segments;
}

/** Item for `project/ticket`, or `undefined`. The pair is never used to build a
 *  path here: `readItem` answers from the projects the read model itself lists,
 *  so an unlisted project or an unknown ticket is simply not found. */
async function findItem(project: string, ticket: string, env: NodeJS.ProcessEnv): Promise<Item | undefined> {
  return readItem(project, ticket, { env });
}

async function handleItems(res: ServerResponse, env: NodeJS.ProcessEnv): Promise<void> {
  sendJson(res, 200, { items: await listItems({ env }) });
}

/** One item, with everything the detail pane shows: the item, its folder tree,
 *  its run's steps, the run's recap, and its delivery report. Reads of the same work item, answered
 *  in one round-trip because the pane shows them together. */
async function handleItem(res: ServerResponse, project: string, ticket: string, env: NodeJS.ProcessEnv): Promise<void> {
  const item = await findItem(project, ticket, env);
  if (!item) {
    sendError(res, 404, "unknown work item");
    return;
  }
  sendJson(res, 200, {
    item,
    tree: readTree(project, ticket, { env }) ?? null,
    steps: readSteps(project, ticket, { env }) ?? null,
    recap: readRecap(project, ticket, { env }) ?? null,
    ...(readReport(project, ticket, { env }) ?? { report: null }),
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
async function handleFile(
  res: ServerResponse,
  project: string,
  ticket: string,
  url: URL,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const item = await findItem(project, ticket, env);
  if (!item) {
    sendError(res, 404, "unknown work item");
    return;
  }

  const path = url.searchParams.get("path");
  if (!path) {
    sendError(res, 400, "query parameter `path` is required");
    return;
  }

  const file = readFile(project, ticket, path, { env });
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
 * One image of a work item, as raw bytes, for an `<img src>`.
 *
 * The one binary answer of the API. It may be cached privately for a short
 * while: a screenshot of a finished run does not change, and a gallery reloaded
 * on every poll of the sheet would fetch every image again.
 */
async function handleRaw(
  res: ServerResponse,
  project: string,
  ticket: string,
  url: URL,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const item = await findItem(project, ticket, env);
  if (!item) {
    sendError(res, 404, "unknown work item");
    return;
  }

  const path = url.searchParams.get("path");
  if (!path) {
    sendError(res, 400, "query parameter `path` is required");
    return;
  }

  const image = readImage(project, ticket, path, { env });
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

function handleProjects(res: ServerResponse, env: NodeJS.ProcessEnv): void {
  sendJson(res, 200, { projects: readProjects({ env }) });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Add or remove a project path.
 *
 * Adding refuses a path that is not a directory today: the reader typed it, so
 * a typo is worth reporting at once. Removing accepts anything, because the
 * whole point of the button is to drop a path that no longer exists.
 */
async function handleProjectWrite(req: IncomingMessage, res: ServerResponse, env: NodeJS.ProcessEnv): Promise<void> {
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

  const write = action === "add" ? addProject(absolute, env) : removeProject(absolute, env);
  if (write.status === "error") {
    sendError(res, 500, write.reason);
    return;
  }
  sendJson(res, 200, { projects: readProjects({ env }) });
}

/**
 * Who the reader is.
 *
 * A cookie naming someone who is no longer declared is answered with 401 AND
 * cleared: the browser drops it, and the choice page is what the reader gets
 * next instead of a name that silently does nothing.
 */
function handleMe(req: IncomingMessage, res: ServerResponse, env: NodeJS.ProcessEnv): void {
  const identity = identityOf(req, env);
  const users = readUsers(env);
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

async function handleMeWrite(req: IncomingMessage, res: ServerResponse, env: NodeJS.ProcessEnv): Promise<void> {
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
  const users = readUsers(env);
  const chosen = name.trim();
  if (!isKnownUser(chosen, env)) {
    sendJson(res, 401, { user: null, users, error: "unknown user" }, { "Set-Cookie": clearedUserCookie() });
    return;
  }
  sendJson(res, 200, { user: chosen, users }, { "Set-Cookie": userCookie(chosen) });
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  const asset = readStaticAsset(pathname);
  if (!asset) {
    sendError(res, 404, "not found");
    return;
  }

  const headers = {
    "Content-Type": asset.contentType,
    // Revalidate every time; the 304 below is what makes that cheap.
    "Cache-Control": "no-cache",
    ETag: asset.etag,
    "X-Content-Type-Options": "nosniff",
  };
  if (matchesEtag(req.headers["if-none-match"], asset.etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, "Content-Length": String(asset.body.byteLength) });
  res.end(req.method === "HEAD" ? undefined : asset.body);
}

/** Launches of one item, newest first: `GET /api/launches?item=<project>/<ticket>`. */
function handleLaunches(res: ServerResponse, url: URL, env: NodeJS.ProcessEnv): void {
  const key = url.searchParams.get("item");
  const cut = key ? key.indexOf("/") : -1;
  if (!key || cut <= 0 || cut === key.length - 1) {
    sendError(res, 400, "query parameter `item` must be `<project>/<ticket>`");
    return;
  }
  sendJson(res, 200, { launches: readLaunchesFor(key.slice(0, cut), key.slice(cut + 1), { env }) });
}

/** Tail of a launch log: `GET /api/launches/<id>/log?lines=20`. */
function handleLaunchLog(res: ServerResponse, id: string, url: URL, env: NodeJS.ProcessEnv): void {
  const requested = Number(url.searchParams.get("lines") ?? LOG_TAIL_LINES);
  const lines = Number.isInteger(requested) && requested > 0 ? Math.min(requested, LOG_TAIL_MAX_LINES) : LOG_TAIL_LINES;
  const tail = readLaunchLogTail(id, lines, env);
  if (tail.status === "not-found") {
    sendError(res, 404, "unknown launch");
    return;
  }
  sendJson(res, 200, tail);
}

/**
 * One verb on one item: `POST /api/actions/<verb>` (spec 5).
 *
 * The checks run in the order of spec 5.3 — identity, verb, project, ticket,
 * then the situation — and every one of them answers before a process exists.
 * The body names the item and may repeat the pipeline and run id the browser
 * saw: when either disagrees with the disk, the item moved under the reader's
 * cursor and the click is refused rather than applied to a run they never saw.
 */
async function handleAction(req: IncomingMessage, res: ServerResponse, verb: string, ctx: RouteContext): Promise<void> {
  const identity = identityOf(req, ctx.env);
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

  const project = readProjects({ env: ctx.env }).find((entry) => entry.name === payload.project);
  if (!project) {
    sendError(res, 404, "unknown project");
    return;
  }
  const ticket = payload.ticket;
  const reference = validateTicketRef(project, ticket, ctx.workItems);
  if (!reference.ok) {
    sendError(res, 400, reference.reason);
    return;
  }
  const item = await findItem(project.name, ticket, ctx.env);
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
  const launched = launchVerb({
    item,
    verb,
    argv: argv.argv,
    by: identity.user,
    env: ctx.env,
    ...(ctx.launcher ? { launcher: ctx.launcher } : {}),
  });
  if (!launched.ok) {
    sendError(res, launched.status, launched.reason);
    return;
  }
  sendJson(res, 202, { launch: launched.launch });
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end();
}

/** Pipeline names of a project: the basenames of the kit chain's files. */
export function projectPipelines(project: ProjectEntry): string[] {
  return [...new Set(listPipelineFiles(project.cwd).map((path) => basename(path, ".ts")))].sort();
}

/** `GET /api/projects/<name>/pipelines`. */
function handlePipelines(res: ServerResponse, name: string, ctx: RouteContext): void {
  const project = readProjects({ env: ctx.env }).find((entry) => entry.name === name);
  if (!project) {
    sendError(res, 404, "unknown project");
    return;
  }
  sendJson(res, 200, { pipelines: project.found ? ctx.terminals.listPipelines(project) : [] });
}

/**
 * Start an interactive run: `POST /api/runs`.
 *
 * The route owns the HTTP shape — body, project lookup — and `startRun` owns
 * every other refusal, so the order of the checks lives in one place.
 */
async function handleRunStart(req: IncomingMessage, res: ServerResponse, by: string, ctx: RouteContext): Promise<void> {
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
  const project = readProjects({ env: ctx.env }).find((entry) => entry.name === payload.project);
  if (!project) {
    sendError(res, 404, "unknown project");
    return;
  }

  const started = await startRun(
    { project, ticket: payload.ticket, pipeline: payload.pipeline, worktree: payload.worktree === true, by },
    {
      tmux: ctx.terminals.tmux,
      workItems: ctx.workItems,
      listPipelines: ctx.terminals.listPipelines,
      findItem: (entry, ticket) => findItem(entry.name, ticket, ctx.env),
      paneCommand: ctx.terminals.paneCommand,
      shell: ctx.terminals.shell,
    },
  );
  if (!started.ok) {
    sendError(res, started.status, started.reason, started.terminal ? { terminal: started.terminal } : {});
    return;
  }
  sendJson(res, 201, { terminal: started.terminal });
}

/** A size on one axis, or `undefined` when it is not an integer in range. */
function terminalSize(value: unknown, fallback?: number): number | undefined {
  if (value === undefined || value === null) return fallback;
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number >= 1 && number <= MAX_TERMINAL_SIZE
    ? number
    : undefined;
}

/**
 * The output of one terminal: `GET /api/terminals/<id>/stream?cols=&rows=`.
 *
 * One SSE event per chunk the client printed, the bytes in base64 because an
 * SSE frame is text and a terminal's output is not. `hello` carries the viewer
 * token; `exit` is sent when the tmux client ends — the session was killed or
 * its shell exited — right before the stream closes. The reader closing the
 * page closes the request, which detaches this viewer and nothing else.
 */
function handleStream(req: IncomingMessage, res: ServerResponse, id: string, url: URL, ctx: RouteContext): void {
  const cols = terminalSize(url.searchParams.get("cols"), 80);
  const rows = terminalSize(url.searchParams.get("rows"), 24);
  if (cols === undefined || rows === undefined) {
    sendError(res, 400, `cols and rows must be integers from 1 to ${MAX_TERMINAL_SIZE}`);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  let open = true;
  const send = (event: string, data: unknown): void => {
    if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (open) res.write(": ping\n\n");
  }, STREAM_HEARTBEAT_MS);
  const finish = (): void => {
    if (!open) return;
    send("exit", {});
    open = false;
    clearInterval(heartbeat);
    res.end();
  };

  const viewer = ctx.terminals.viewers.open({
    terminal: id,
    argv: ctx.terminals.tmux.attachArgv(id),
    cols,
    rows,
    onData: (bytes) => send("data", Buffer.from(bytes).toString("base64")),
    onExit: finish,
  });
  send("hello", { viewer: viewer.viewer });
  req.on("close", () => {
    open = false;
    clearInterval(heartbeat);
    viewer.close();
  });
}

async function handleTerminalInput(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  ctx: RouteContext,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendError(res, 400, body.reason);
    return;
  }
  const payload = (body.value ?? {}) as { viewer?: unknown; data?: unknown };
  if (typeof payload.data !== "string") {
    sendError(res, 400, "field `data` must be a string");
    return;
  }
  if (!ctx.terminals.viewers.input(id, payload.viewer, payload.data)) {
    sendError(res, 404, "unknown viewer");
    return;
  }
  sendNoContent(res);
}

async function handleTerminalResize(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  ctx: RouteContext,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendError(res, 400, body.reason);
    return;
  }
  const payload = (body.value ?? {}) as { viewer?: unknown; cols?: unknown; rows?: unknown };
  const cols = typeof payload.cols === "number" ? terminalSize(payload.cols) : undefined;
  const rows = typeof payload.rows === "number" ? terminalSize(payload.rows) : undefined;
  if (cols === undefined || rows === undefined) {
    sendError(res, 400, `cols and rows must be integers from 1 to ${MAX_TERMINAL_SIZE}`);
    return;
  }
  if (!ctx.terminals.viewers.resize(id, payload.viewer, cols, rows)) {
    sendError(res, 404, "unknown viewer");
    return;
  }
  sendNoContent(res);
}

/**
 * Every `/api/terminals` route. A terminal is a shell, so each one — reads
 * included — needs a declared name and a same-origin request; the id is checked
 * against the sessions tmux lists before it is used for anything.
 */
async function routeTerminals(
  req: IncomingMessage,
  res: ServerResponse,
  rest: string[],
  url: URL,
  ctx: RouteContext,
): Promise<void> {
  const method = req.method ?? "GET";
  const [id, action, ...tail] = rest;
  if (tail.length > 0) {
    sendError(res, 404, "not found");
    return;
  }
  if (id === undefined) {
    if (method !== "GET") {
      sendError(res, 405, "method not allowed");
      return;
    }
    const terminals = await listTerminals(ctx.terminals.tmux);
    if (!terminals) {
      sendError(res, 503, "tmux is not installed");
      return;
    }
    sendJson(res, 200, { terminals });
    return;
  }

  if (!isSessionId(id)) {
    sendError(res, 404, "unknown terminal");
    return;
  }
  const expected = action === undefined || action === "stream" ? "GET" : "POST";
  if (action !== undefined && !["stream", "input", "resize", "kill"].includes(action)) {
    sendError(res, 404, "not found");
    return;
  }
  if (method !== expected) {
    sendError(res, 405, "method not allowed");
    return;
  }

  // Input and resize answer from the viewer registry alone: the viewer token
  // already proves the terminal was found when its stream opened.
  if (action === "input") {
    await handleTerminalInput(req, res, id, ctx);
    return;
  }
  if (action === "resize") {
    await handleTerminalResize(req, res, id, ctx);
    return;
  }

  const lookup = await findTerminal(ctx.terminals.tmux, id);
  if (lookup.status === "no-tmux") {
    sendError(res, 503, "tmux is not installed");
    return;
  }
  if (lookup.status === "not-found") {
    sendError(res, 404, "unknown terminal");
    return;
  }
  if (action === undefined) {
    sendJson(res, 200, lookup.terminal);
    return;
  }
  if (action === "stream") {
    handleStream(req, res, id, url, ctx);
    return;
  }
  const killed = await ctx.terminals.tmux.killSession(id);
  if (!killed.ok) {
    sendError(res, killed.missing ? 503 : 500, killed.reason);
    return;
  }
  sendNoContent(res);
}

async function route(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
  const { env, host, port } = ctx;
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${UI_HOST}:${port}`);
  const segments = pathSegments(url.pathname);
  if (!segments) {
    sendError(res, 400, "malformed request path");
    return;
  }

  if (segments[0] !== "api") {
    if (method !== "GET" && method !== "HEAD") {
      sendError(res, 405, "method not allowed");
      return;
    }
    serveStatic(req, res, url.pathname);
    return;
  }

  if (!isExpectedHost(req, host, port)) {
    sendError(res, 403, "unexpected Host header");
    return;
  }
  if (method !== "GET" && method !== "POST") {
    sendError(res, 405, "method not allowed");
    return;
  }
  if (method === "POST" && !isSameOrigin(req, host, port)) {
    sendError(res, 403, "cross-origin request refused");
    return;
  }

  const [, resource, ...rest] = segments;
  if (resource === "me") {
    if (rest.length > 0) {
      sendError(res, 404, "not found");
      return;
    }
    if (method === "POST") await handleMeWrite(req, res, env);
    else handleMe(req, res, env);
    return;
  }

  if (resource === "projects") {
    if (rest.length === 2 && rest[1] === "pipelines" && rest[0] && method === "GET") {
      handlePipelines(res, rest[0], ctx);
      return;
    }
    if (rest.length > 0) {
      sendError(res, 404, "not found");
      return;
    }
    if (method === "GET") {
      handleProjects(res, env);
      return;
    }
    // Every write is attributed, so an anonymous browser cannot change what the
    // dashboard reads (spec 5.3).
    if (!identityOf(req, env).user) {
      sendError(res, 403, "choose a name before changing the project list");
      return;
    }
    await handleProjectWrite(req, res, env);
    return;
  }

  if (resource === "items" && method === "GET") {
    if (rest.length === 0) {
      await handleItems(res, env);
      return;
    }
    // A ticket is one path segment: a nested work item gets no item of its own,
    // and its files are reachable through its parent's explorer.
    const [project, ticket, ...tail] = rest;
    if (!project || !ticket || tail.length > 1) {
      sendError(res, 404, "not found");
      return;
    }
    if (tail.length === 0) {
      await handleItem(res, project, ticket, env);
      return;
    }
    if (tail[0] === "file") {
      await handleFile(res, project, ticket, url, env);
      return;
    }
    if (tail[0] === "raw") {
      await handleRaw(res, project, ticket, url, env);
      return;
    }
    sendError(res, 404, "not found");
    return;
  }

  if (resource === "launches" && method === "GET") {
    if (rest.length === 0) {
      handleLaunches(res, url, env);
      return;
    }
    if (rest.length === 2 && rest[1] === "log" && rest[0]) {
      handleLaunchLog(res, rest[0], url, env);
      return;
    }
    sendError(res, 404, "not found");
    return;
  }
  if (resource === "runs" || resource === "terminals") {
    const user = identityOf(req, env).user;
    if (!user) {
      sendError(res, 403, "choose a name before opening a terminal");
      return;
    }
    // Reads are guarded too: a terminal's output is as sensitive as its input.
    if (!isSameOrigin(req, host, port)) {
      sendError(res, 403, "cross-origin request refused");
      return;
    }
    if (resource === "terminals") {
      await routeTerminals(req, res, rest, url, ctx);
      return;
    }
    if (rest.length === 0 && method === "POST") {
      await handleRunStart(req, res, user, ctx);
      return;
    }
    sendError(res, 404, "not found");
    return;
  }
  if (resource === "actions" && method === "POST" && rest.length === 1 && rest[0]) {
    await handleAction(req, res, rest[0], ctx);
    return;
  }

  sendError(res, 404, "not found");
}

/**
 * Start the dashboard.
 *
 * The two files the dashboard owns are created — empty but valid — before the
 * socket is bound, so the first request finds a `users.json` to read and a
 * `projects.json` to write to, and a human can start editing them by hand right
 * away (H2). Launches left open by a previous server are closed and the old
 * ones purged at the same moment (spec 5.2, H1).
 */
export function startUiServer(options: UiServerOptions): Promise<RunningUiServer> {
  const env = options.env ?? process.env;
  const host = options.host ?? UI_HOST;
  const requestedPort = options.port ?? DEFAULT_UI_PORT;
  ensureUiFiles(env);
  reconcileLaunches(env);

  const tmux = options.tmux ?? new Tmux({ env });
  const terminals: TerminalContext = {
    tmux,
    viewers: new ViewerRegistry(options.attach ?? bunAttachSpawner(env)),
    paneCommand: options.paneCommand ?? operatorCommand,
    listPipelines: options.listPipelines ?? projectPipelines,
    shell: paneShell(env),
  };

  const server = createServer((req, res) => {
    const port = (server.address() as AddressInfo | null)?.port ?? requestedPort;
    const ctx: RouteContext = {
      env,
      host,
      port,
      terminals,
      workItems: options.workItems,
      ...(options.launcher ? { launcher: options.launcher } : {}),
    };
    route(req, res, ctx).catch((error: unknown) => {
      // A route that threw is a bug in this server, not something the reader can
      // act on: the request gets one honest line and the process keeps serving.
      // The cause goes to stderr for whoever maintains it — method and path
      // only, never the body, which may carry a budget or a project path.
      const path = (req.url ?? "").split("?")[0];
      console.error(
        `[ui] ${req.method ?? "?"} ${path} -> 500:`,
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      if (!res.headersSent) sendError(res, 500, "internal error");
      else res.end();
    });
  });

  return new Promise<RunningUiServer>((fulfil, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    // The host is explicit on purpose: without it Node binds every interface.
    server.listen(requestedPort, host, () => {
      server.removeListener("error", onError);
      const address = server.address() as AddressInfo;
      fulfil({
        server,
        host: address.address,
        port: address.port,
        url: `http://${host}:${address.port}`,
        close: () =>
          new Promise<void>((done) => {
            // Viewers detach; the tmux sessions themselves outlive the server.
            terminals.viewers.closeAll();
            server.close(() => done());
            // A browser polling every 15 s holds keep-alive sockets open; without
            // this, `close()` would wait for them and Ctrl+C would appear to hang.
            server.closeAllConnections();
          }),
      });
    });
  });
}
