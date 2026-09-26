// modules/ui/routes/static.ts
//
// Every path outside `/api/`: the bundled front, revalidated on every request.

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendNotFound } from "../http/respond.js";
import { matchesEtag, readStaticAsset } from "../static-files.js";

export function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  const asset = readStaticAsset(pathname);
  if (!asset) {
    sendNotFound(res);
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
