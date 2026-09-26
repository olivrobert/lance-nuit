// modules/ui/http/respond.ts
//
// How the dashboard answers. Its own JSON answers are never cacheable: the
// morning box is the state of the disk right now.

import type { ServerResponse } from "node:http";

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf-8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(payload.byteLength),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(payload);
}

export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  sendJson(res, status, { error: message, ...extra });
}

export function sendNotFound(res: ServerResponse, message = "not found"): void {
  sendError(res, 404, message);
}

export function sendMethodNotAllowed(res: ServerResponse): void {
  sendError(res, 405, "method not allowed");
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end();
}
