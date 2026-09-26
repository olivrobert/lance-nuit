// modules/ui/http/body.ts
//
// Request bodies. A JSON body is a name or a path, never a document.

import type { IncomingMessage } from "node:http";

const MAX_BODY_BYTES = 64 * 1024;

export type JsonBody = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * Read a JSON body, bounded.
 *
 * The cap is enforced while the body arrives, not after: a client that keeps
 * sending is disconnected rather than allowed to fill memory first. An empty
 * body reads as `{}`.
 */
export async function readJsonBody(req: IncomingMessage): Promise<JsonBody> {
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
