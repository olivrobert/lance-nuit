// env/docker-stack.schema.ts
//
// Shape of ONE service entry of `docker compose ps --format json` — a JSONL
// stream since Compose v2.21, a single JSON array before that. Both forms hold
// the same entry shape, which is what this module describes.
//
// Diagnostic policy for this boundary: an entry is never an error. Docker prints
// its own fields (`ID`, `Publishers`, `ExitCode`, ...) and adds more between
// releases, so the entry is a `looseObject` whose every field is optional and
// self-catching. An entry that is not an object, or that names no service, is
// SKIPPED — it never reaches `unreadyServices`.
//
// Consequence, and it is the behavior the preflight already had: a malformed
// entry does not crash and does not count as ready either. A required service
// whose entry could not be read is simply not in the list, so `unreadyServices`
// reports it as `<name> (absent)` and the preflight fails on it by name. A
// malformed entry for a service nobody required stays invisible, exactly like a
// Docker warning mixed into the stream.
//
// What stays out of the schema (and in code, in `docker-stack.ts`):
// - the `Service` before `Name` precedence, `Name` being a container name kept
//   only as a fallback for older Compose formats;
// - the readiness rule itself (`isServiceReady`: running, and healthy or without
//   a healthcheck) and the wording of `unreadyServices`.
//
// `ComposeService` is the hand-written interface below, next to the schema that
// feeds it: the reader owns the shape it produces, and `docker-stack.ts`
// re-exports it for its callers. The agreement between the two is proved at
// compile time at the end of this file. See `guide/architecture.md`, section
// "Persistence and observability".

import * as z from "zod";
import { looseString } from "../lib/stream-values.schema.js";
import type { AssertAssignable, Plain } from "../lib/type-assertions.js";

export interface ComposeService {
  /** Logical service name as declared in the compose file. */
  service: string;
  /** `running`, `exited`, `created`, ... as reported by Docker. */
  state: string;
  /** `healthy`, `unhealthy`, `starting`; empty when the service has no healthcheck. */
  health: string;
}

const ComposeEntrySchema = z.looseObject({
  Service: looseString,
  Name: looseString,
  State: looseString,
  Health: looseString,
});

/** One `docker compose ps` entry, or `null` when it carries no usable service name. */
export function readComposeService(raw: unknown): ComposeService | null {
  const parsed = ComposeEntrySchema.safeParse(raw);
  if (!parsed.success) return null;
  const entry = parsed.data;
  // `Service` is the logical name; `Name` (the container name, prefixed by the
  // compose project) is only a fallback for older formats that omit it.
  const service = entry.Service || entry.Name || "";
  if (!service) return null;
  return { service, state: entry.State ?? "", health: entry.Health ?? "" };
}

/* ------------------------------------------------------------------------- *
 * Compile-time proof that the schema and the interface describe the same data
 * (see `lib/type-assertions.ts`). The entry is Docker's shape, not ours, so the
 * proof is on `readComposeService`'s output and on the forwarded fields.
 * ------------------------------------------------------------------------- */

type _Output = AssertAssignable<NonNullable<ReturnType<typeof readComposeService>>, ComposeService>;
type _Service = AssertAssignable<
  NonNullable<z.output<typeof ComposeEntrySchema>["Service"]>,
  ComposeService["service"]
>;
type _State = AssertAssignable<NonNullable<z.output<typeof ComposeEntrySchema>["State"]>, ComposeService["state"]>;
type _Health = AssertAssignable<NonNullable<z.output<typeof ComposeEntrySchema>["Health"]>, ComposeService["health"]>;
type _Input = AssertAssignable<
  Plain<{ Service: string; State: string; Health: string }>,
  z.input<typeof ComposeEntrySchema>
>;
