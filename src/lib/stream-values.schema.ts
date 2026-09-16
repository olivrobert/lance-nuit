// lib/stream-values.schema.ts
//
// Scalar readers shared by the schemas of formats the runner only reads: the
// three agent-backend NDJSON streams (`engine/backends/*/events.schema.ts`) and
// the output of `docker compose ps` (`env/docker-stack.schema.ts`).
//
// Such a stream is untrusted and versioned by someone else: a field may be
// absent, may hold the wrong kind of value, or may not exist yet in the release
// the runner was written against. None of that is an error at this boundary — the
// runner must still report whatever the rest of the stream said. These helpers
// therefore never fail: they reproduce, as schemas, the semantics the hand-written
// probes in `lib/json-values.ts` had (`asString`, `asFiniteNumber`, `asRecord`).
//
// Types stay hand-written interfaces; the schemas are proved against them at
// compile time. See `guide/architecture.md`, section "Persistence and
// observability".

import * as z from "zod";

/** `asString`: a missing key or a non-string value reads as absent. */
export const looseString = z.string().optional().catch(undefined);

/** `asFiniteNumber`: `NaN`, `Infinity`, `null` and non-numbers read as absent. */
export const looseNumber = z
  .number()
  .refine((value) => Number.isFinite(value))
  .optional()
  .catch(undefined);

/** A boolean, or absent. Only a strict `true`/`false` counts. */
export const looseBoolean = z.boolean().optional().catch(undefined);

/** `asRecord`: a nested object that reads as `null` when absent or malformed. */
export function looseNested<T extends z.ZodType>(schema: T): z.ZodCatch<z.ZodNullable<T>> {
  return schema.nullable().catch(null);
}
