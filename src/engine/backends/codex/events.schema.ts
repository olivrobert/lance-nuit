// engine/backends/codex/events.schema.ts
//
// Shape of ONE line of the `codex exec --json` NDJSON stream.
//
// Same diagnostic policy as the other two backends: nothing is ever rejected.
// Known events are `looseObject`s, every field is optional and self-catching
// (`lib/stream-values.schema.ts`), and the union ends on a fallback branch that
// accepts any object and reports `type: null`. A new provider event therefore
// costs nothing; a line that is not JSON never reaches here (`jsonRecords`).
//
// Codex specificity: `item` does not belong to one event type. The item-bearing
// events (`item.started`, `item.completed`, ...) are exactly the ones this module
// does not name, so `item` sits in the shape shared by every branch, fallback
// included — that is how `agentMessageFromEvent` can read an agent message off an
// event whose type this release has never seen.
//
// What stays out of the schema (and in code, in `events.ts`):
// - which item types map to which tool label (`Bash`, `FileChange`, `MCP`, ...);
// - the JSON sniffing of an agent message (`{...}` becomes `structuredOutput`);
// - the error-message precedence (`event.message` before `event.error.message`);
// - the cost estimation driven by `turn.completed`.
//
// zod v4 note: inside an object, a free-form field must be written
// `z.unknown().optional()` — a bare `z.unknown()` key is required.
//
// Types stay hand-written interfaces (`ParsedCodexEvents`, `CodexUsageTotals` in
// `events.ts`); nothing public is inferred from a schema, and nothing reachable
// from the installed DSL declarations imports this module. See
// `guide/architecture.md`, section "Persistence and observability".

import * as z from "zod";
import { looseNested, looseNumber, looseString } from "../../../lib/stream-values.schema.js";
import type { AssertAssignable } from "../../../lib/type-assertions.js";

/** A stream item, carried by the events this module does not name. */
const ItemSchema = z.looseObject({
  type: looseString,
  id: looseString,
  text: looseString,
  message: looseString,
});

// `item` is read on every event kind, so it belongs to the shared shape.
const base = { item: looseNested(ItemSchema) };

const ThreadStartedEventSchema = z.looseObject({
  ...base,
  type: z.literal("thread.started"),
  thread_id: looseString,
});

const TurnCompletedEventSchema = z.looseObject({
  ...base,
  type: z.literal("turn.completed"),
  model: looseString,
  usage: looseNested(
    z.looseObject({
      input_tokens: looseNumber,
      cached_input_tokens: looseNumber,
      output_tokens: looseNumber,
      reasoning_output_tokens: looseNumber,
    }),
  ),
});

const ErrorShape = {
  message: looseString,
  error: looseNested(z.looseObject({ message: looseString })),
};

const TurnFailedEventSchema = z.looseObject({ ...base, ...ErrorShape, type: z.literal("turn.failed") });
const ErrorEventSchema = z.looseObject({ ...base, ...ErrorShape, type: z.literal("error") });

/** The fallback branch: every item-bearing event, and any type added later. */
const UnknownEventSchema = z
  .looseObject({ ...base, type: looseString })
  .transform((event) => ({ type: null, item: event.item }));

export const CodexEventSchema = z.union([
  z.discriminatedUnion("type", [
    ThreadStartedEventSchema,
    TurnCompletedEventSchema,
    TurnFailedEventSchema,
    ErrorEventSchema,
  ]),
  UnknownEventSchema,
]);

export type CodexEvent = z.output<typeof CodexEventSchema>;

/** Reads one stream record. Never throws: an event this release does not know
 *  reads as `{ type: null }`, keeping only the fields shared by every event. */
export function parseCodexEvent(record: unknown): CodexEvent {
  const parsed = CodexEventSchema.safeParse(record);
  return parsed.success ? parsed.data : { type: null, item: null };
}

/* ------------------------------------------------------------------------- *
 * Compile-time proof, for the fields forwarded to a hand-written interface
 * without transformation. The rest is enforced by the declared return type of
 * `parseCodexEvents`.
 * ------------------------------------------------------------------------- */
type _ThreadId = AssertAssignable<z.output<typeof ThreadStartedEventSchema>["thread_id"], string | undefined>;
type _Model = AssertAssignable<z.output<typeof TurnCompletedEventSchema>["model"], string | undefined>;
