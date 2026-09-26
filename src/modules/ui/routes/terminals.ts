// modules/ui/routes/terminals.ts
//
// `/api/terminals`: the tmux sessions of the interactive runs. A terminal is a
// shell, so the router lets these routes run — reads included — only for a
// declared name on a same-origin request; the id is checked against the
// sessions tmux lists before it is used for anything.

import type { UiDeps } from "../deps.js";
import { readJsonBody } from "../http/body.js";
import { sendError, sendJson, sendMethodNotAllowed, sendNoContent, sendNotFound } from "../http/respond.js";
import { findTerminal, isSessionId, listTerminals } from "../terminals.js";
import type { Route, RouteRequest } from "./route.js";

/** Bounds of a terminal size, on each axis. */
const MAX_TERMINAL_SIZE = 500;

/** Comment line sent on an idle stream, so neither side times it out. */
const STREAM_HEARTBEAT_MS = 15_000;

const ACTIONS = ["stream", "input", "resize", "kill"];

/** A size on one axis, or `undefined` when it is not an integer in range. */
function terminalSize(value: unknown, fallback?: number): number | undefined {
  if (value === undefined || value === null) return fallback;
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number >= 1 && number <= MAX_TERMINAL_SIZE
    ? number
    : undefined;
}

function sendBadSize(request: RouteRequest): void {
  sendError(request.res, 400, `cols and rows must be integers from 1 to ${MAX_TERMINAL_SIZE}`);
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
function handleStream(request: RouteRequest, id: string, deps: UiDeps): void {
  const { req, res, url } = request;
  const cols = terminalSize(url.searchParams.get("cols"), 80);
  const rows = terminalSize(url.searchParams.get("rows"), 24);
  if (cols === undefined || rows === undefined) {
    sendBadSize(request);
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

  const { viewers, tmux } = deps.terminals;
  const viewer = viewers.open({
    terminal: id,
    argv: tmux.attachArgv(id),
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

async function handleInput(request: RouteRequest, id: string, deps: UiDeps): Promise<void> {
  const { req, res } = request;
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
  if (!deps.terminals.viewers.input(id, payload.viewer, payload.data)) {
    sendError(res, 404, "unknown viewer");
    return;
  }
  sendNoContent(res);
}

async function handleResize(request: RouteRequest, id: string, deps: UiDeps): Promise<void> {
  const { req, res } = request;
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendError(res, 400, body.reason);
    return;
  }
  const payload = (body.value ?? {}) as { viewer?: unknown; cols?: unknown; rows?: unknown };
  const cols = typeof payload.cols === "number" ? terminalSize(payload.cols) : undefined;
  const rows = typeof payload.rows === "number" ? terminalSize(payload.rows) : undefined;
  if (cols === undefined || rows === undefined) {
    sendBadSize(request);
    return;
  }
  if (!deps.terminals.viewers.resize(id, payload.viewer, cols, rows)) {
    sendError(res, 404, "unknown viewer");
    return;
  }
  sendNoContent(res);
}

/** `GET /api/terminals`. */
async function handleList({ res }: RouteRequest, deps: UiDeps): Promise<void> {
  const terminals = await listTerminals(deps.terminals.tmux);
  if (!terminals) {
    sendError(res, 503, "tmux is not installed");
    return;
  }
  sendJson(res, 200, { terminals });
}

/** One terminal, its stream, or killing it: the three answers that need the
 *  session tmux lists, not only a viewer token. */
async function handleSession(
  request: RouteRequest,
  id: string,
  action: string | undefined,
  deps: UiDeps,
): Promise<void> {
  const { res } = request;
  const { tmux } = deps.terminals;
  const lookup = await findTerminal(tmux, id);
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
    handleStream(request, id, deps);
    return;
  }
  const killed = await tmux.killSession(id);
  if (!killed.ok) {
    sendError(res, killed.missing ? 503 : 500, killed.reason);
    return;
  }
  sendNoContent(res);
}

export const terminalsRoute: Route = {
  access: "operator",
  methods: ["GET", "POST"],
  async handle(request, deps) {
    const { res, method } = request;
    const [id, action, ...tail] = request.rest;
    if (tail.length > 0) {
      sendNotFound(res);
      return;
    }
    if (id === undefined) {
      if (method === "GET") await handleList(request, deps);
      else sendMethodNotAllowed(res);
      return;
    }

    if (!isSessionId(id)) {
      sendError(res, 404, "unknown terminal");
      return;
    }
    if (action !== undefined && !ACTIONS.includes(action)) {
      sendNotFound(res);
      return;
    }
    const expected = action === undefined || action === "stream" ? "GET" : "POST";
    if (method !== expected) {
      sendMethodNotAllowed(res);
      return;
    }

    // Input and resize answer from the viewer registry alone: the viewer token
    // already proves the terminal was found when its stream opened.
    if (action === "input") await handleInput(request, id, deps);
    else if (action === "resize") await handleResize(request, id, deps);
    else await handleSession(request, id, action, deps);
  },
};
